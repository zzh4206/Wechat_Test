/**
 * wechat-db.ts（W2）：微信本地库只读消息源适配器。
 *
 * 管控三原则（REPORT-wechat-db-plan §0）在本文件内的落点：
 * 1. 默认全拒：白名单（Config.groups，chatId 数组）为空 → 构造即抛错（fail-closed）；
 *    不在白名单的 chatId，任何子进程调用（read/resolve）都不发出——gate() 是每个读取路径的第一行；
 * 2. 白名单 = 用户手工维护的显式 chatId 清单，本适配器不做任何"发现新群"类操作；
 * 3. 可审计：每次读取经 store 写 <stateDir>/audit.log，仅 {ts, chatId, count, ok}，绝不记消息内容。
 *
 * 其他约定：
 * - 读取经外部工具 CLI（macos-wechat-export 的 wechat_db.py）子进程完成，本插件不重写解密层、
 *   不读取/不拷贝 keys.json、绝不动 WeChat 进程/窗口；
 * - 子进程带超时，连续失败按指数退避；
 * - 定时器经 start() 返回清理函数（clearInterval），由宿主包进 ctx.effect()（沿用 distiller 约定）；
 * - 单实例：stateDir 下独占创建锁文件（fs.open 'wx' 简化 flock），重复启动拒绝；
 * - 消息结构对齐管线：{chatId, sender(=sender_id), senderName(=sender_id，W3 映射昵称),
 *   text, messageId(=server_id), ts(=create_time)}，经 onMessages 交给 bus 同款下游
 *   （sanitize → 令牌桶 → buffer → distiller）。
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store.js'
import { redactHexRuns } from '../guard.js'
import type { NicknameResolver } from './nickname.js'
import { GroupCursor } from './cursor.js'

/**
 * W3 normalize：local_type → 占位标签。
 * 1=文本保留原文；10000 附近的系统通知类型在 SYSTEM_TYPES，直接跳过不入管线。
 * 热修：类型映射统一走 mapRawType（打包值解包 + 友好占位）。
 */
/**
 * 系统通知类（撤回/拍一拍/入群退群等提示行）：不入管线。
 * 微信 4.x 的 local_type 可能是"打包值"：(scene << 32) | type。
 * 实测例：25769803825 = (6 << 32) | 49 → 真实类型码取低 32 位 = 49（app/链接类）。
 * 解包纯函数：>2^32-1 时取低 32 位，否则原值返回。
 */
export function decodePackedType(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return raw
  return raw > 0xffff_ffff ? raw % 0x1_0000_0000 : raw
}

/** 类型归类结果：友好占位 + 管线 kind（kind 取值与 store MESSAGE_KINDS 扩展集对齐） */
export interface MappedType {
  /** 消息列表里展示的占位文本 */
  label: string
  /** 归类：image/voice/file/video/link/other（文本/引用不经过此函数） */
  kind: 'image' | 'voice' | 'file' | 'video' | 'link' | 'other'
}

/**
 * 热修：微信 raw_type 数值 → 友好占位 + kind 归类（纯函数，带单测）。
 * 覆盖常见类型码（低 32 位）；未知的显示 `[消息:类型码]` 保持可调试。
 * 1=文本不在本表（normalizeRowText 前置处理）；10000/10002 系统类型在 SYSTEM_TYPES。
 */
const RAW_TYPE_MAP: Readonly<Record<number, MappedType>> = Object.freeze({
  3: { label: '[图片]', kind: 'image' },
  34: { label: '[语音]', kind: 'voice' },
  36: { label: '[语音]', kind: 'voice' },
  43: { label: '[视频]', kind: 'video' },
  62: { label: '[视频]', kind: 'video' },
  47: { label: '[表情]', kind: 'other' },
  48: { label: '[位置]', kind: 'other' },
  42: { label: '[名片]', kind: 'other' },
  49: { label: '[链接]', kind: 'link' }, // appmsg：链接/文件/小程序统称，XML 凭据不导出时按链接占位
  50: { label: '[语音/视频通话]', kind: 'other' },
  51: { label: '[状态]', kind: 'other' },
  52: { label: '[语音通话]', kind: 'voice' },
  53: { label: '[视频通话]', kind: 'video' },
})

/** 热修导出：类型码（含打包值）→ 占位 + kind。未知类型 `[消息:N]` 保留可调试性。 */
export function mapRawType(rawType: number): MappedType {
  const type = decodePackedType(rawType)
  return RAW_TYPE_MAP[type] ?? { label: `[消息:${type}]`, kind: 'other' }
}

/**
 * 热修：create_time 解析纯函数（带单测）。CLI 实测返回字符串秒（"1791946486"），
 * 旧实现 `typeof === 'number'` 判断直接落 0。此处兼容：
 * - number / 纯数字字符串；秒（< 1e12）×1000 换算毫秒，毫秒（≥ 1e12）原值保留；
 * - 无法解析（NaN/负数/空/非数字）返回 null，由调用方用当前轮询时间兜底并 warn 计数。
 *
 * 统一口径：返回值一律毫秒（Date.now() 体系）——下游 report/person-digest/reminder/
 * task-recognition 的窗口比较全按毫秒。旧实现返回秒，秒级 ts 恒小于毫秒窗口起点，
 * 实测导致报告/摘要过滤不到任何消息。
 */
export function parseCreateTime(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) n = Number(value.trim())
  else return null
  if (!Number.isFinite(n) || n <= 0) return null
  return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000)
}

/** 系统通知类（撤回/拍一拍/入群退群等提示行）：不入管线（判定前先解包，见 SYSTEM_TYPES 用点） */
const SYSTEM_TYPES: ReadonlySet<number> = new Set([10000, 10002])

/** text 为系统/媒体 XML（以 '<' 开头且含特征标记）→ 按系统消息处理（跳过） */
const XML_SYSTEM_PATTERN = /<(sysmsg|emoji|emojijson|recordinfo|videomsg|voicemsg|newxmlmsg|newmsg)\b/i

/** M2-T1.2：引用消息特征（appmsg 内嵌 <refermsg> 块，local_type 49） */
const REFERMSG_PATTERN = /<refermsg[\s>]/i

// ============================== M2-T1.2 引用消息解析 ==============================
//
// 解析隔离约定（D2 风险表）：refermsg XML 结构随微信版本可能变化，全部解析收拢在
// 下面这几个独立纯函数里，mapRows 只消费其结果；任何异常/缺字段一律降级为纯文本
// （warn，不抛错），绝不阻塞消息管线。零第三方依赖：手写正则 + 实体解码。

/** refermsg 块中提取出的被引用消息信息 */
export interface ParsedReferMsg {
  /** 被引用消息的 server id（<svrid>）——引用链关联键 */
  refMsgId: string
  /** 被引用者群内显示名（<displayname>） */
  refDisplayName: string
  /** 被引用原文（<content>，已解码实体/CDATA） */
  refContent: string
  /** 引用者自己的回复文本（外层 appmsg <title>） */
  selfText: string
}

/** 解析基础 XML 实体与 CDATA 包裹（refermsg 字段常见形态） */
function decodeXmlText(raw: string): string {
  let s = raw.trim()
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)
  if (cdata) s = cdata[1]
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 取第一个 <tag>text</tag>（含可选属性与 CDATA）；无则 null */
function firstTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decodeXmlText(m[1]) : null
}

/** text 是否为引用消息（含 <refermsg> 块）。独立导出便于测试。 */
export function isQuoteMessage(text: string): boolean {
  return REFERMSG_PATTERN.test(text)
}

/**
 * 拆解 refermsg XML（M2-T1.2 核心解析函数，解析隔离点）。
 * 返回 null = 无法可靠提取（缺 svrid 等）→ 调用方降级为纯文本。
 * 内部不抛错：任何意外都折返 null（try/catch 兜底）。
 */
export function parseReferMsgXml(xml: string): ParsedReferMsg | null {
  try {
    const block = xml.match(/<refermsg[^>]*>([\s\S]*?)<\/refermsg>/i)
    if (!block) return null
    const inner = block[1]
    const refMsgId = firstTag(inner, 'svrid') ?? firstTag(inner, 'msgid')
    if (!refMsgId || !/^\d{1,24}$/.test(refMsgId)) return null // 无稳定关联键 → 降级
    return {
      refMsgId,
      refDisplayName: firstTag(inner, 'displayname') ?? '',
      refContent: firstTag(inner, 'content') ?? '',
      // 引用者的回复在外层 appmsg <title>（refermsg 块之前的那个 title）
      selfText: firstTag(xml.slice(0, block.index ?? 0), 'title') ?? '',
    }
  } catch {
    return null
  }
}

/**
 * FNV-1a 32bit → 8 位 hex。占位 id 生成用（确定性、可测试、零依赖）。
 */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 被引用原文不在已读消息中时的占位 msgId（格式 `qref-<fnv1a8>`，由
 * 被引用者显示名 + 原文派生，同一条引用重复出现得到同一占位 id，可测试）。
 */
export function quotePlaceholderId(refDisplayName: string, refContent: string): string {
  return `qref-${fnv1aHex(`${refDisplayName}\u0000${refContent}`)}`
}

/** 占位引用的正文前缀格式：[引用|显示名|原文] （保留原文便于溯源） */
export function quotePrefix(refDisplayName: string, refContent: string): string {
  return `[引用|${refDisplayName}|${refContent}]`
}

/**
 * 引用行规范化（mapRows 消费）：返回 null = 解析失败/缺 svrid，调用方按纯文本降级。
 * knownIds：被引用原文可能落在其中的"已读消息" id 集（本轮批次 ∪ 持久化游标）。
 * 占位情形额外带回 quoteRefName/quoteRefText：落库侧用它们建 qref-* 占位行，
 * 满足 quote_of_msg_id 外键约束，原文得以沿链溯源。
 */
export function normalizeQuoteRow(
  rawText: string,
  knownIds: ReadonlySet<string>,
): {
  text: string
  kind: 'quote'
  quoteOfMsgId: string
  quoteRefName?: string
  quoteRefText?: string
} | null {
  const parsed = parseReferMsgXml(rawText)
  if (!parsed) return null
  if (knownIds.has(parsed.refMsgId)) {
    // 被引用原文已在库里：quoteOfMsgId 直接指向它，正文只留回复（原文可沿链溯源）
    return { text: parsed.selfText, kind: 'quote', quoteOfMsgId: parsed.refMsgId }
  }
  // 原文不在库（未读历史/已过期清理）：占位 id + 原文保留于 text 前缀
  return {
    text: `${quotePrefix(parsed.refDisplayName, parsed.refContent)}${parsed.selfText}`,
    kind: 'quote',
    quoteOfMsgId: quotePlaceholderId(parsed.refDisplayName, parsed.refContent),
    quoteRefName: parsed.refDisplayName,
    quoteRefText: parsed.refContent,
  }
}

/** 发送者剥离：群消息 text 可能带 "wxid_xxx:\n正文" 前缀 */
const SENDER_PREFIX_PATTERN = /^[A-Za-z0-9_@.-]{4,64}:\n/

/**
 * 单行规范化。返回 null = 跳过（系统消息/XML）；否则返回应入管线的 text。
 * 导出供测试直接构造假 db 行做快照断言。
 */
export function normalizeRowText(
  text: string,
  localType: number | undefined,
  sender: string,
): string | null {
  const trimmed = text.trim()
  // XML 系统消息（sysmsg/emoji 等特征）→ 跳过
  if (trimmed.startsWith('<') && XML_SYSTEM_PATTERN.test(trimmed)) return null
  const type = decodePackedType(localType ?? 1) // 无 local_type 的行按文本处理（兼容旧 CLI 输出）
  if (SYSTEM_TYPES.has(type)) return null
  if (type === 1) {
    // 发送者剥离："wxid_xxx:\n正文"（前缀须匹配 sender 或形如 wxid）
    if (sender !== 'unknown' && text.startsWith(`${sender}:\n`)) return text.slice(sender.length + 2)
    if (SENDER_PREFIX_PATTERN.test(text) && text.split(':\n', 1)[0].startsWith('wxid')) {
      const idx = text.indexOf(':\n')
      return text.slice(idx + 2)
    }
    return text
  }
  // 热修：走统一类型映射表（解包打包值 + 友好占位；未知 → '[消息:N]'）
  return mapRawType(type).label
}

export interface WechatDbSourceLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** 适配器产出的消息（结构对齐 bus/ingest 下游） */
export interface WechatDbMessage {
  chatId: string
  sender: string
  senderName: string
  text: string
  messageId: string
  ts: number
  /** M2-T1.2：'quote' = 引用回复消息；热修扩展：非文本消息按 mapRawType 归类（缺省 'text'） */
  kind?:
    | 'text'
    | 'quote'
    | 'image'
    | 'voice'
    | 'file'
    | 'video'
    | 'link'
    | 'other'
  /** M2-T1.2：被引用消息的 msgId（被引用原文在库内为真实 server_id，否则为 qref-* 占位） */
  quoteOfMsgId?: string
  /** M2-T1.2：仅占位情形带回（落库侧建 qref-* 占位行用）：被引用者显示名 / 原文 */
  quoteRefName?: string
  quoteRefText?: string
}

/** 子进程运行结果（可注入 mock） */
export interface CliRunResult {
  code: number
  stdout: string
  stderr: string
}

/** 子进程运行器：接收 wechat_db.py 的子命令参数（不含 python/脚本路径本身） */
export type CliRunner = (args: readonly string[]) => Promise<CliRunResult>

/** M6-T2：wechat_db.py files 子命令的单条输出（只保留插件关心的字段） */
export interface ToolFileEntry {
  msg_id: string
  name: string | null
  path: string | null
  available: boolean
}

export interface WechatDbSourceOptions {
  /** 白名单（chatId，xxx@chatroom）。空 = fail-closed，构造抛错 */
  groups: readonly string[]
  /** 外部工具的 --db-root（微信 db_storage 绝对路径） */
  dbRoot: string
  /** 项目内唯一 fs 写入点（审计日志经它落盘） */
  store: Store
  /** stateDir 绝对路径（锁文件放这里） */
  stateDir: string
  logger: WechatDbSourceLogger
  /** 子进程运行器（测试注入 mock；默认 spawn 真实 CLI） */
  runner?: CliRunner
  /** 外部工具目录（含 wechat_db.py） */
  toolDir?: string
  /** python 解释器路径 */
  pythonPath?: string
  /** 子进程超时 ms（默认 runner 用） */
  timeoutMs?: number
  /** 轮询间隔 ms，默认 10_000 */
  pollIntervalMs?: number
  /** 每次 read 的 --limit，默认 50 */
  readLimit?: number
  /** T1.5：单轮追赶补读上限条数，默认 2000（触顶 warn 并建议人工 backfill） */
  catchUpLimit?: number
  /** 退避基数 ms（默认取 pollIntervalMs） */
  backoffBaseMs?: number
  /** 退避上限 ms，默认 5 分钟 */
  backoffMaxMs?: number
  /** 可注入时钟（测试） */
  now?: () => number
  /** W4：启动回灌条数（默认 0 不回灌；>0 首轮可回灌最多该条数最近历史，受 readLimit 约束） */
  backfillOnStart?: number
  /** W3：wxid→昵称解析器（可选；缺省 senderName 回退 sender 原值） */
  nicknameResolver?: NicknameResolver
  /** 产出消息的下游回调（index.ts 里接 bus.ingest） */
  onMessages: (messages: WechatDbMessage[]) => void
}

/** wechat_db.py read 输出的单行 JSON（只取我们关心的字段） */
interface RawReadMessage {
  server_id?: unknown
  create_time?: unknown
  sender_id?: unknown
  text?: unknown
  local_type?: unknown
  /** T1.5：分库局部 id（跨库不可比，仅用于同分片内向前翻页锚点） */
  local_id?: unknown
  /** T1.5：消息所在分片名（message_*.db），用于判断翻页是否跨分片 */
  database?: unknown
}

const DEFAULT_POLL_INTERVAL_MS = 10_000
const DEFAULT_READ_LIMIT = 50
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 30_000
/** T1.5：单轮追赶补读上限（条）；触顶即 warn 并建议人工 backfill */
export const DEFAULT_CATCHUP_LIMIT = 2000

/**
 * 默认子进程运行器：spawn(python, [wechat_db.py, ...args])，超时 SIGKILL。
 * 只读 CLI，不传 --key-file（密钥由工具在自身目录 .wechat-local/ 解析，本插件零接触）。
 */
export function createCliRunner(options: {
  pythonPath: string
  toolDir: string
  timeoutMs: number
}): CliRunner {
  const { pythonPath, toolDir, timeoutMs } = options
  const script = join(toolDir, 'wechat_db.py')
  return (args) =>
    new Promise<CliRunResult>((resolveRun) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const child = spawn(pythonPath, [script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // wechat_db.py 的 --key-file 默认是相对路径 .wechat-local/keys.json，按 cwd 解析；
        // 不设 cwd 会继承宿主进程 cwd，导致密钥找不到。这里固定到工具目录（仍不接触密钥内容）。
        cwd: toolDir,
      })
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveRun({ code: timedOut ? 124 : code, stdout, stderr })
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        stderr += String(error)
        finish(-1)
      })
      child.on('close', (code) => {
        finish(code ?? -1)
      })
    })
}

export class WechatDbSource {
  private readonly whitelist: Set<string>
  private readonly dbRoot: string
  private readonly store: Store
  private readonly stateDir: string
  private readonly logger: WechatDbSourceLogger
  private readonly runner: CliRunner
  private readonly pollIntervalMs: number
  private readonly readLimit: number
  private readonly catchUpLimit: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly now: () => number
  private readonly onMessages: (messages: WechatDbMessage[]) => void
  private readonly nicknameResolver: NicknameResolver | null

  /** W4：持久化增量游标（每群已读 id 尾部窗口，防重启重投递；见 cursor.ts） */
  private readonly cursor: GroupCursor
  /** 单实例锁文件 fd（start 时获取，stop 释放） */
  private lockFd: number | null = null
  private _running = false
  private consecutiveFailures = 0
  private lastPollAt: number | null = null
  private nextAttemptAt = 0

  constructor(options: WechatDbSourceOptions) {
    // —— 白名单硬闸门：适配器第一行 ——
    if (!options.groups || options.groups.length === 0) {
      throw new Error(
        'wechat-db source: whitelist (groups) is empty — fail-closed, refusing to start',
      )
    }
    if (typeof options.onMessages !== 'function') {
      throw new Error('wechat-db source: onMessages callback is required')
    }
    this.whitelist = new Set(options.groups)
    this.dbRoot = options.dbRoot
    this.store = options.store
    this.stateDir = options.stateDir
    this.logger = options.logger
    this.runner =
      options.runner ??
      createCliRunner({
        pythonPath: options.pythonPath ?? 'python3.14',
        toolDir: options.toolDir ?? join(process.cwd(), 'macos-wechat-export'),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.readLimit = options.readLimit ?? DEFAULT_READ_LIMIT
    this.catchUpLimit = options.catchUpLimit ?? DEFAULT_CATCHUP_LIMIT
    this.backoffBaseMs = options.backoffBaseMs ?? this.pollIntervalMs
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.now = options.now ?? (() => Date.now())
    this.onMessages = options.onMessages
    this.nicknameResolver = options.nicknameResolver ?? null
    // W4：持久化游标——构造时恢复；损坏降级空游标 + warn（cursor.ts 内处理）
    this.cursor = new GroupCursor({
      store: this.store,
      logger: this.logger,
      backfillOnStart: options.backfillOnStart ?? 0,
    })
    this.cursor.load()
  }

  /** 闸门：白名单外的 chatId 一律抛错，且不产生任何子进程调用 */
  private gate(chatId: string): void {
    if (!this.whitelist.has(chatId)) {
      throw new Error(
        `wechat-db source: chatId ${chatId} is not in the whitelist — read refused (fail-closed)`,
      )
    }
  }

  /**
   * 单次读取（只导出给测试/显式调用；白名单外抛错、零子进程调用）。
   * 返回本次新见（去重后）的消息；失败抛错。无论成败都写审计行。
   *
   * T1.5 追赶补读：首轮不带 --before-id（不传时行为与旧版完全一致）；当该群游标已有
   * 历史且本轮读出的消息全部是新消息（cursor 未见过）时，用本轮最旧消息的 local_id
   * 作为 --before-id 向前翻页，直到：翻页读空 / 撞到已见消息 / 达到单轮追赶上限
   * （触顶 warn 并建议人工 backfill）。local_id 是分库局部 id、跨库不可比：一页横跨
   * 多个 message_*.db 分片或分片名未知时停止翻页并 warn（宁少读不可错读）。
   */
  async readOnce(chatId: string, limit = this.readLimit): Promise<WechatDbMessage[]> {
    this.gate(chatId) // 读取路径第一行：先过闸门再谈子进程
    const collected: RawReadMessage[] = []
    let ok = true
    // —— 首轮：参数与旧版完全一致（不带 --before-id） ——
    const first = await this.runner([
      '--db-root',
      this.dbRoot,
      'read',
      '--chat-id',
      chatId,
      '--limit',
      String(limit),
    ])
    let page: RawReadMessage[] = []
    ok = first.code === 0
    if (ok) {
      try {
        page = this.parseRows(first.stdout)
      } catch (error) {
        ok = false
        this.logger.warn(`wechat-db parse failed for ${chatId}: ${String(error)}`)
      }
    } else {
      this.logger.warn(
        `wechat_db read failed for ${chatId} (code=${first.code}): ${redactHexRuns(first.stderr.slice(0, 200))}`,
      )
    }
    if (ok) collected.push(...page)
    // 本轮内已见的 server_id 集：游标只在 readOnce 结束时统一落账，
    // 追赶循环的"撞到已见"判定必须同时看本轮早前各页的 id。
    const roundIds = new Set<string>()
    for (const row of collected) {
      const id = this.serverIdOf(row)
      if (id !== null) roundIds.add(id)
    }
    // —— 追赶循环：仅当游标已有该群历史（掉线重登后的积压场景）。首次接触该群
    // （游标为空）不追赶：旧历史按基线处理（old_messages_are_not_new，不回灌）。 ——
    if (ok && page.length > 0 && this.cursor.recentCount(chatId) > 0 && this.pageFullyNew(chatId, page)) {
      /** "已读"判定：持久化游标 ∪ 本轮早前页面 */
      const isSeen = (row: RawReadMessage): boolean => {
        const id = this.serverIdOf(row)
        return id !== null && (this.cursor.has(chatId, id) || roundIds.has(id))
      }
      while (collected.length < this.catchUpLimit) {
        if (page.length === 0) break // 读空：翻到头了
        // 翻出的页含无法判重的行（server_id 缺失）→ 无法确认边界：保守停止（宁少读）
        if (page.some((row) => this.serverIdOf(row) === null)) break
        const anchor = this.paginationAnchor(chatId, page)
        if (anchor === null) break // 锚点不可用 / 跨分片：宁少读（内部已 warn）
        const res = await this.runner([
          '--db-root',
          this.dbRoot,
          'read',
          '--chat-id',
          chatId,
          '--limit',
          String(limit),
          '--before-id',
          String(anchor),
        ])
        if (res.code !== 0) {
          ok = false
          this.logger.warn(
            `wechat_db catch-up read failed for ${chatId} (code=${res.code}): ${redactHexRuns(res.stderr.slice(0, 200))}`,
          )
          break
        }
        try {
          page = this.parseRows(res.stdout)
        } catch (error) {
          ok = false
          this.logger.warn(`wechat-db catch-up parse failed for ${chatId}: ${String(error)}`)
          break
        }
        const touchedSeen = page.some(isSeen)
        // 本页全部新见：记入本轮已见集，继续向前翻页
        for (const row of page) {
          const id = this.serverIdOf(row)
          if (id !== null) roundIds.add(id)
        }
        // 本页混有已见消息：收下其中的新消息后停止（追上游标窗口）
        collected.push(...page)
        if (touchedSeen) break
      }
      if (collected.length >= this.catchUpLimit) {
        this.logger.warn(
          `wechat-db catch-up hit the per-round limit (${this.catchUpLimit}) for ${chatId} — ` +
            '停止本轮追赶，剩余积压建议人工 backfill',
        )
      }
    }
    // —— 汇总去重并落游标（全部页成功后才 add：中途失败不误标已读、不静默丢消息） ——
    const fresh = ok ? this.mapRows(chatId, collected) : []
    this.audit(chatId, fresh.length, ok)
    if (!ok) throw new Error(`wechat_db read failed for ${chatId} (code ${first.code})`)
    // W3：senderName 填昵称（resolver 内部自带降级——失败回原 id 并 warn，不中断主流程）
    if (this.nicknameResolver && fresh.length > 0) {
      const map = await this.nicknameResolver.resolveGroup(chatId)
      for (const message of fresh) {
        message.senderName = map.get(message.sender) ?? message.sender
      }
    }
    return fresh
  }

  /**
   * M6-T2：文件路径定位——调工具 `files` 子命令，按会话返回文件类消息的本地存储路径。
   * 只读查询；失败（非 0 退出 / JSON 解析失败 / 闸门外）返回 []（上层保持"待下载"占位）。
   */
  async locateFiles(chatId: string, limit = 200): Promise<ToolFileEntry[]> {
    this.gate(chatId)
    const res = await this.runner([
      '--db-root',
      this.dbRoot,
      'files',
      '--chat-id',
      chatId,
      '--limit',
      String(Math.max(1, Math.min(200, Math.floor(limit)))),
    ])
    if (res.code !== 0) {
      this.logger.warn(
        `wechat_db files failed for ${chatId} (code=${res.code}): ${redactHexRuns(res.stderr.slice(0, 200))}`,
      )
      return []
    }
    try {
      const parsed: unknown = JSON.parse(res.stdout)
      const files = (parsed as { files?: unknown }).files
      if (!Array.isArray(files)) return []
      return files
        .filter((f): f is ToolFileEntry =>
          typeof f === 'object' && f !== null && typeof (f as ToolFileEntry).msg_id === 'string')
        .map((f) => ({
          msg_id: f.msg_id,
          name: typeof f.name === 'string' ? f.name : null,
          path: typeof f.path === 'string' ? f.path : null,
          available: f.available === true,
        }))
    } catch (error) {
      this.logger.warn(`wechat_db files parse failed for ${chatId}: ${String(error)}`)
      return []
    }
  }

  /** server_id → 去重键；缺失（未上服务器的本地行）返回 null（无法稳定判重） */
  private serverIdOf(row: RawReadMessage): string | null {
    return row.server_id === null || row.server_id === undefined ? null : String(row.server_id)
  }

  /** 一页是否全部为新消息（含无法判重的行 → 保守视为不全新，宁少读） */
  private pageFullyNew(chatId: string, page: RawReadMessage[]): boolean {
    for (const row of page) {
      const id = this.serverIdOf(row)
      if (id === null) return false
      if (this.cursor.has(chatId, id)) return false
    }
    return true
  }

  /**
   * 翻页锚点：本轮最旧消息的 local_id（作为 --before-id）。
   * local_id 跨分片不可比：一页横跨多个 message_*.db、分片名未知或 local_id 非法时
   * 返回 null 并 warn（宁少读不可错读）。
   */
  private paginationAnchor(chatId: string, page: RawReadMessage[]): number | null {
    const shards = new Set<string>()
    let oldest: number | null = null
    for (const row of page) {
      if (typeof row.database !== 'string' || row.database === '') {
        this.logger.warn(
          `wechat-db catch-up: read row without database shard for ${chatId} — pagination stopped (宁少读)`,
        )
        return null
      }
      const localId = Number(row.local_id)
      if (!Number.isInteger(localId) || localId <= 0) {
        this.logger.warn(
          `wechat-db catch-up: read row without valid local_id for ${chatId} — pagination stopped (宁少读)`,
        )
        return null
      }
      shards.add(row.database)
      if (oldest === null || localId < oldest) oldest = localId
    }
    if (shards.size > 1) {
      this.logger.warn(
        `wechat-db catch-up: page spans ${shards.size} message shards for ${chatId} — ` +
          'local_id 跨分片不可比，停止翻页（宁少读不可错读）',
      )
      return null
    }
    return oldest
  }

  /** 解析 wechat_db.py read 的 JSON 输出为原始行（结构异常抛错） */
  private parseRows(stdout: string): RawReadMessage[] {
    const parsed = JSON.parse(stdout) as { messages?: RawReadMessage[] }
    const rows = parsed.messages
    if (!Array.isArray(rows)) throw new Error('read output missing messages array')
    return rows
  }

  /** 原始行 → 管线消息（server_id 去重 + 落游标 + W3 normalize + M2-T1.2 引用拆解） */
  private mapRows(chatId: string, rows: RawReadMessage[]): WechatDbMessage[] {
    const fresh: WechatDbMessage[] = []
    // 热修：create_time 解析失败的行数（本批），用当前轮询时间兜底后统一 warn 一条
    let tsFallbackCount = 0
    const now = this.now()
    // M2-T1.2："已读消息" id 集 = 本轮批次全部 server_id ∪ 持久化游标（引用关联用）。
    // 先扫一遍批次 id：同批内 A→B→C 多级引用可互相指到真实 server_id。
    const knownIds = new Set<string>()
    for (const row of rows) {
      const id = this.serverIdOf(row)
      if (id !== null) knownIds.add(id)
    }
    for (const row of rows) {
      // server_id 缺失（未上服务器的本地行）无法稳定去重，跳过
      const id = this.serverIdOf(row)
      if (id === null) continue
      // W4：持久化游标去重（重启后同 id 不再入管线）；未命中 → 记为已读并投递
      if (this.cursor.has(chatId, id)) continue
      this.cursor.add(chatId, id)
      const sender = row.sender_id === undefined ? 'unknown' : String(row.sender_id)
      // 热修：local_type 兼容字符串与打包值（实测 CLI 返回字符串 "25769803825"）
      const localType =
        typeof row.local_type === 'number' ? row.local_type : Number(row.local_type) || undefined
      const decodedType = localType === undefined ? undefined : decodePackedType(localType)
      if (decodedType !== undefined && SYSTEM_TYPES.has(decodedType)) continue // 系统消息过滤
      // 热修：ts 解析——CLI 实测 create_time 为字符串秒；解析失败用当前轮询时间兜底（不丢数据），warn 计数
      const parsedTs = parseCreateTime(row.create_time)
      let ts: number
      if (parsedTs === null) {
        ts = now
        tsFallbackCount++
      } else {
        ts = parsedTs
      }
      // W3 normalize：local_type 过滤/占位；系统消息与 XML → 跳过不入管线
      const rawText = row.text === null || row.text === undefined ? '' : String(row.text)
      // M2-T1.2：引用消息（<refermsg> XML）先于普通 normalize 拆解；
      // 解析失败 → 降级为纯文本（原文进 text）继续入管线，只 warn 不阻塞。
      if (isQuoteMessage(rawText)) {
        knownIds.add(id) // 自身也可被后续引用行指到
        const quote = normalizeQuoteRow(rawText, knownIds)
        if (quote) {
          fresh.push({
            chatId,
            sender,
            senderName: sender,
            text: quote.text,
            messageId: id,
            ts,
            kind: quote.kind,
            quoteOfMsgId: quote.quoteOfMsgId,
            quoteRefName: quote.quoteRefName,
            quoteRefText: quote.quoteRefText,
          })
          continue
        }
        this.logger.warn(
          `wechat-db quote parse failed for ${chatId} msg ${id} — degraded to plain text`,
        )
      }
      const text = normalizeRowText(rawText, localType, sender)
      if (text === null) continue
      // 热修：非文本消息 kind 按映射表归类（文本行 decodedType === 1 → 'text'）
      const kind: WechatDbMessage['kind'] =
        decodedType === undefined || decodedType === 1 ? 'text' : mapRawType(decodedType).kind
      fresh.push({
        chatId,
        sender, // wxid（原值保留；senderName 才是显示名）
        senderName: sender, // readOnce 尾部若有 resolver 会覆写为昵称
        text,
        messageId: id,
        ts,
        kind,
      })
    }
    if (tsFallbackCount > 0) {
      this.logger.warn(
        `wechat-db ts mapping failed for ${tsFallbackCount}/${rows.length} rows in ${chatId} — ` +
          'create_time 无法解析，已用当前轮询时间兜底（不丢数据）',
      )
    }
    return fresh
  }

  /** 审计：仅元数据 {ts, chatId, count, ok}，绝不记内容 */
  private audit(chatId: string, count: number, ok: boolean): void {
    this.store.appendJsonl('audit.log', { ts: this.now(), chatId, count, ok })
  }

  /**
   * 一轮轮询：顺序读白名单内每个群；处于退避窗口则整轮跳过。
   * 任一群失败 → 连续失败计数 +1 并按指数退避；全成功 → 复位。
   */
  async pollOnce(): Promise<void> {
    const now = this.now()
    if (now < this.nextAttemptAt) return
    let allOk = true
    for (const chatId of this.whitelist) {
      try {
        const fresh = await this.readOnce(chatId)
        if (fresh.length > 0) this.onMessages(fresh)
      } catch {
        allOk = false // readOnce 已 warn + 审计
      }
    }
    this.lastPollAt = now
    // W4：每轮轮询结束持久化一次游标（不是每条消息写盘）；失败在 cursor 内 warn，不中断
    this.cursor.persist()
    if (allOk) {
      this.consecutiveFailures = 0
      this.nextAttemptAt = now + this.pollIntervalMs
    } else {
      this.consecutiveFailures += 1
      const backoff = Math.min(
        this.backoffBaseMs * 2 ** (this.consecutiveFailures - 1),
        this.backoffMaxMs,
      )
      this.nextAttemptAt = now + backoff
      this.logger.error(
        `wechat-db poll failed x${this.consecutiveFailures}, backing off ${backoff}ms`,
      )
    }
  }

  /** 单实例锁：stateDir 下独占创建；已存在则拒绝启动 */
  private acquireLock(): void {
    const lockPath = join(this.stateDir, 'wechat-db.lock')
    try {
      this.lockFd = openSync(lockPath, 'wx')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        throw new Error(
          `wechat-db source: another instance holds ${lockPath} — refusing to start`,
        )
      }
      throw error
    }
  }

  private releaseLock(): void {
    if (this.lockFd === null) return
    try {
      closeSync(this.lockFd)
      unlinkSync(join(this.stateDir, 'wechat-db.lock'))
    } catch (error) {
      this.logger.warn(`wechat-db release lock failed: ${String(error)}`)
    } finally {
      this.lockFd = null
    }
  }

  /**
   * 启动轮询。返回清理函数：clearInterval + 释放锁（沿用 distiller.start() 约定，
   * 由 index.ts 包进 ctx.effect()）。锁被占时抛错（单实例拒绝）。
   */
  start(): () => void {
    if (this._running) return () => undefined
    this.acquireLock()
    this._running = true
    const timer = setInterval(() => {
      void this.pollOnce()
    }, this.pollIntervalMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      this._running = false
      this.releaseLock()
    }
  }

  /** 运行可见性（接入 getStatus；纯元数据） */
  status(): {
    running: boolean
    groups: string[]
    consecutiveFailures: number
    lastPollAt: number | null
    nextAttemptAt: number
  } {
    return {
      running: this._running,
      groups: [...this.whitelist],
      consecutiveFailures: this.consecutiveFailures,
      lastPollAt: this.lastPollAt,
      nextAttemptAt: this.nextAttemptAt,
    }
  }
}
