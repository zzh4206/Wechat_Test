/**
 * sender.ts：filehelper 发送 worker（红线升级 2026-10-14 用户批准：no-send → 仅 filehelper 一个受控出口）。
 *
 * 2026-10-15 发送原语替换（用户否决 wechat-ui UI 校准方案——要求常驻聊天窗口太麻烦）：
 * - 发送原语抽为可替换接口 SendPrimitive；两实现：
 *   · KeyboardSender（默认）：wx-chatbot 式键盘模拟（2026-10-15 二次实测简化）——
 *     **搜索定位整段删除**（实测：Cmd+F 开的是搜一搜面板；点击搜索框时灵时不灵；而
 *     "前台 + 粘贴 + 回车"直接把文本发进当前会话一次成功）。键序 = activate + 前台确认 →
 *     剪贴板写消息 → Cmd+V → Return 发送 → 恢复剪贴板。目标会话由"用户当前打开的会话"
 *     决定（运行前提：文件传输助手是当前会话，发送期间勿切换）；中文走剪贴板避开输入法；
 *     TCC 只需"辅助功能"；
 *   · WechatUiSender：原 wechat-ui send 实现（Config sendMethod='wechat-ui' 可切回）。
 * - 验证（KeyboardSender 真发后）：延迟 2s 用 wechat_db.py read --chat-id filehelper --limit 3
 *   （只读）确认文件传输助手最新消息包含本次文本特征串（#l<id 前 8 位），验证通过才置 sent；
 * - 边界（本文件仍是项目里**唯一**允许发起微信发送的模块）：
 *   · 通道白名单**代码级硬编码** ALLOWED_CHANNELS = ['filehelper']——其他 channel 永远不发；
 *   · 文本策略：单行 ≤200 字符 = `【lurker】<title>` + ≤160 字摘要 + 特征串，绝不发全文；
 * - 闸门（全部保留并强化）：
 *   ① 总闸：Config senderEnabled（默认 false）+ sendDryRun（默认 true）。
 *      keyboard 模式 dry_run = activate + 前台确认后直接结束（不碰输入框不回车——实测教训：
 *      干跑时的粘贴也可能落进当前会话输入框被误发）；wechat-ui 模式 dry_run 照旧只记日志；
 *   ② 通道闸：仅 ALLOWED_CHANNELS；
 *   ③ 交互闸：微信前台（osascript）+ 系统空闲秒数（ioreg IOHIDSystem），空闲 <10s 视为用户
 *      正在操作 → 跳过本轮防按键串扰；连续 N 次非前台 warn；
 *      allowTakeFocus=true（抢前台模式，默认 false）：跳过前台检查（键序第 1 步 activate 本就
 *      会激活微信），但**保留用户空闲检测**（空闲 <10s 仍跳过并计数——允许抢前台，绝不抢
 *      正在打字的手）；抢前台模式发送成功审计记 result='take_focus_sent'，与普通模式可区分。
 * - 失败重试 ≤3 次（attempts 落盘 outbox 行），超限 status='failed' 不再重试（防风暴）；
 *   wechat-ui 模式 --id 用 outbox 唯一 id（工具侧幂等）；
 * - 发送前合规闸（路线 A，2026-10-15）：keyboard 模式在"粘贴+Return"之前 spawn
 *   `wechat-ui read --chat '文件传输助手'`（只读 OCR 标题核验，dry_run 照常执行）——
 *   当前会话不是文件传输助手 / wechat-ui 缺失 / TCC 屏幕录制缺失 → deferred 不发不计
 *   attempts（审计 result='wrong_chat_open' + reason 字段，Config.chatVerifyRetries 默认 2）；
 * - 频控：maxSendsPerDay（默认 20）超限的当日 pending 标 'skipped_quota'；
 * - 审计纪律：audit/sender.jsonl 只记元数据（outbox id / 结果 / attempts），绝不记正文；
 * - 剪贴板恢复失败不阻塞（warn）；
 * - 零第三方依赖；定时器 start() → 清理函数约定，dispose 无残留。
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { Outbox, OutboxEntry } from './outbox.js'

/** 通道白名单：硬编码，唯一出口 */
export const ALLOWED_CHANNELS: readonly string[] = ['filehelper']
/** 唯一白名单目标聊天（文件传输助手） */
export const FILEHELPER_CHAT = '文件传输助手'
/** 单行文本上限 */
export const MAX_TEXT_CHARS = 200
/** 摘要上限（正文截断） */
export const SUMMARY_CHARS = 160
/** 失败重试上限（≥3 次 → status='failed' 不再重试） */
export const MAX_ATTEMPTS = 3
/** 发送审计落盘相对路径（只写元数据行） */
export const SENDER_AUDIT_REL = 'audit/sender.jsonl'
/** 粘贴消息后、回车发送前的缓冲（ms） */
export const KEY_DELAY_PASTE_MS = 300
/** 真发后 DB 回读验证每次尝试前的延迟（ms；Config.verifyDelaySec 可配，默认 3000） */
export const VERIFY_DELAY_MS = 3000
/** DB 回读验证默认尝试次数（Config.verifyRetries 可配；4 次 × 3s ≈ 12s 总重试窗口） */
export const VERIFY_RETRIES = 4
/** sent_pending_verify 回读 CLI 连续失败轮数达到该值 → error 级人工介入告警 */
export const VERIFY_MANUAL_ALERT_ATTEMPTS = 5
/** 系统空闲低于该秒数视为用户正在操作（跳过防按键串扰） */
export const IDLE_SKIP_BELOW_SEC = 10
/** 发送前合规闸：每次失败重试之间的间隔（ms） */
export const CHAT_VERIFY_RETRY_DELAY_MS = 1000

/**
 * 合规闸失败原因枚举（审计 reason 字段；result 恒为 'wrong_chat_open'，deferred=true，不计 attempts）：
 * - wrong_chat_open：OCR 标题核验 3 次全失败（当前会话不是文件传输助手 / 读不到标题）——用户环境状态；
 * - ui_tool_missing：wechat-ui 二进制缺失 / 无法执行（spawn ENOENT/EACCES）——部署问题；
 * - tcc_denied：DSH 宿主缺「屏幕录制」权限（wechat-ui 截图被 TCC 拦截）——权限问题。
 */
export type ChatVerifyReason = 'wrong_chat_open' | 'ui_tool_missing' | 'tcc_denied'

export type ChatVerifyOutcome =
  | { ok: true; attempts: number }
  | { ok: false; reason: ChatVerifyReason; attempts: number }

/** wechat-ui read 输出/错误分类：二进制缺失 vs TCC 屏幕录制缺失 vs 普通不匹配 */
function classifyChatVerifyFailure(r: CommandResult): ChatVerifyReason {
  const blob = `${r.error ?? ''} ${r.stderr} ${r.stdout}`.toLowerCase()
  if (/enoent|eacces|eperm|spawn /.test(blob)) return 'ui_tool_missing'
  if (/screen|record|permission|tcc|屏幕|录制|隐私|授权/.test(blob)) return 'tcc_denied'
  return 'wrong_chat_open'
}

/**
 * 发送前合规闸（路线 A，防误发核心）：spawn `wechat-ui read --chat '文件传输助手'`（只读）——
 * 截取微信窗口 + OCR 读当前聊天标题 + 与参数核对（工具内置 WeChat 4.x 空白截图修复）。
 * 退出码 0 = 当前会话确为文件传输助手 → 放行键序；OCR 误读抖动防御：失败重试 chatVerifyRetries
 * 次（间隔 1s）；全失败 → deferred（不计 attempts——用户环境状态不是发送失败）。
 * 二进制缺失 / TCC 屏幕录制缺失是确定性失败，不重试直接返回对应 reason。
 * 红线：--chat 参数与发送目标同源同常量 FILEHELPER_CHAT（filehelper 硬编码不变）。
 */
export async function verifyChatOpen(options: {
  wechatUiPath: string
  retries: number
  runCommand: (file: string, args: string[]) => Promise<CommandResult>
  sleepMs: (ms: number) => Promise<void>
}): Promise<ChatVerifyOutcome> {
  const retries = Math.max(0, Math.floor(options.retries))
  let reason: ChatVerifyReason = 'wrong_chat_open'
  for (let attempt = 1; attempt <= 1 + retries; attempt++) {
    const r = await options.runCommand(options.wechatUiPath, ['read', '--chat', FILEHELPER_CHAT])
    if (r.code === 0) return { ok: true, attempts: attempt }
    reason = classifyChatVerifyFailure(r)
    // 二进制缺失 / TCC 缺失是确定性问题：重试也不会变，立即 deferred 并给出精确 reason
    if (reason !== 'wrong_chat_open') return { ok: false, reason, attempts: attempt }
    if (attempt <= retries) await options.sleepMs(CHAT_VERIFY_RETRY_DELAY_MS) // OCR 误读抖动：间隔 1s 重试
  }
  return { ok: false, reason, attempts: 1 + retries }
}

export interface SenderLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** 截断：超长取前 n 字 */
function clamp(value: string, n: number): string {
  return value.length > n ? value.slice(0, n) : value
}

/**
 * 构造发送文本：`【lurker】<title>` + 至多 160 字摘要（单行、≤MAX_TEXT_CHARS）。
 * 换行/回车/控制字符统一替换为空格；绝不包含全文。
 */
export function buildSendText(title: string, body: string): string {
  const single = (s: string) => s.replace(/[\r\n\t\x00-\x1f]+/g, ' ').trim()
  const head = `【lurker】${single(title)}`
  const summary = clamp(single(body), SUMMARY_CHARS)
  const text = summary !== '' ? `${head} ${summary}` : head
  return clamp(text, MAX_TEXT_CHARS)
}

/**
 * 追加 DB 回读验证用的特征串（#l + outbox id 前 8 位，十六进制安全字符）。
 * 总长仍 ≤ MAX_TEXT_CHARS：先按余量截断正文再拼特征串，保证特征串永远在场。
 */
export function appendFeature(text: string, id: string): { text: string; feature: string } {
  const feature = `#l${id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  return { text: `${clamp(text, MAX_TEXT_CHARS - feature.length - 1)} ${feature}`, feature }
}

/** 单次命令执行结果（mock 注入点形状；error = spawn 层错误消息，如 'spawn wechat-ui ENOENT'） */
export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

/** 发送原语入参（id/text 供 wechat-ui 幂等；feature 供 keyboard DB 回读验证） */
export interface PrimitiveSendInput {
  id: string
  text: string
  feature: string
  dryRun: boolean
}

export interface PrimitiveSendResult {
  ok: boolean
  /**
   * located = 已定位会话（dry_run 终点）；sent = 已发送；error = 真实失败（计 attempts）；
   * env_unavailable = 环境不可用（熄屏/锁屏/窗口读不到——不计 attempts，本轮挂起下轮重试）
   */
  stage: 'located' | 'sent' | 'error' | 'env_unavailable'
  detail: string
}

/** 可替换发送原语接口 */
export interface SendPrimitive {
  readonly method: SendMethod
  transmit(input: PrimitiveSendInput): Promise<PrimitiveSendResult>
}

export type SendMethod = 'keyboard' | 'wechat-ui'

export interface SenderOptions {
  outbox: Outbox
  logger: SenderLogger
  store: import('./store.js').Store
  /** Config.senderEnabled：总闸，默认 false = 零活动 */
  enabled?: boolean
  /** Config.sendDryRun：默认 true = 只定位/记日志/落审计，绝不发送 */
  dryRun?: boolean
  /** Config.sendMethod：发送原语（默认 'keyboard' = 键盘模拟；'wechat-ui' 可切回旧实现） */
  sendMethod?: SendMethod
  /** Config.maxSendsPerDay（默认 20） */
  maxSendsPerDay?: number
  /** Config.wechatUiPath（默认 'wechat-ui'，仅 sendMethod='wechat-ui' 用） */
  wechatUiPath?: string
  /** Config.composerTop（默认 0.70，仅 sendMethod='wechat-ui' 用） */
  composerTop?: number
  /** Config.sourceToolDir：wechat_db.py 所在目录（keyboard 真发后 DB 回读验证必需，缺失 fail-closed 不发） */
  sourceToolDir?: string
  /** Config.sourceDbRoot：微信本地库根目录（多账号环境 CLI 必需 --db-root，缺失 fail-closed 不发） */
  sourceDbRoot?: string
  /** Config.sourcePython（默认 'python3'） */
  sourcePython?: string
  /** Config.verifyDelaySec：回读验证每次尝试前的等待秒数（默认 3） */
  verifyDelaySec?: number
  /** Config.verifyRetries：回读验证尝试次数（默认 4；总窗口 ≈ verifyDelaySec × verifyRetries） */
  verifyRetries?: number
  /** Config.chatVerifyRetries：发送前合规闸（wechat-ui read）失败重试次数（默认 2，即总尝试 3 次） */
  chatVerifyRetries?: number
  /** Config.sendIntervalSec（默认 300） */
  intervalSec?: number
  /** Config.allowTakeFocus：抢前台模式（默认 false = 微信非前台跳过本轮）。true = 跳过前台闸（仍保留用户空闲检测） */
  allowTakeFocus?: boolean
  /** 交互闸连续非前台 N 次后 warn（默认 3） */
  frontmostWarnAfter?: number
  /** Config.idleSkipBelowSec：空闲低于该秒数视为用户正在操作→让路跳过（默认 10 = 现行为；0 = 不让路直接发） */
  idleSkipBelowSec?: number
  /** 系统空闲秒数注入（默认 Infinity = 闸不生效；生产由 index.ts 注入 defaultSystemIdleSec） */
  systemIdleSec?: () => Promise<number>
  /** 命令执行注入（测试 mock；默认 node:child_process execFile） */
  runCommand?: (file: string, args: string[]) => Promise<CommandResult>
  /** 微信前台检测注入（测试 mock；默认 osascript 查询） */
  isFrontmost?: () => Promise<boolean>
  /** 睡眠注入（测试 mock 键序延迟/验证延迟；默认 setTimeout） */
  sleepMs?: (ms: number) => Promise<void>
  /** 时钟注入（测试） */
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  /** 心跳毫秒（测试可调小；生产按 intervalSec 换算） */
  tickMs?: number
}

export interface SendRoundResult {
  /** 本轮动作：disabled/empty/not_frontmost/user_active/dry_run/sent/failed/quota */
  action: string
  processed: number
}

function defaultRunCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(file, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      resolvePromise({
        code: error && typeof (error as NodeJS.ErrnoException).code === 'number' ? (error as unknown as { code: number }).code : (error ? 1 : 0),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        error: error ? error.message : undefined,
      })
    })
    child.on('error', () => {/* 已在回调里给非零 code，不再抛出 */})
  })
}

function defaultIsFrontmost(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('osascript', ['-e', 'application "WeChat" is frontmost'], (error, stdout) => {
      resolvePromise(!error && String(stdout).trim() === 'true')
    })
  })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 读系统空闲秒数（ioreg -c IOHIDSystem 的 HIDIdleTime，纳秒）。
 * 读取失败返回 0 = 视为"用户正在操作"（fail-safe：跳过本轮，绝不在用户手边抢键盘）。
 * 注意：本函数只读 ioreg，不发按键；未注入到 SenderOptions 前不会被调用。
 */
export function defaultSystemIdleSec(): Promise<number> {
  return new Promise((resolvePromise) => {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], (error, stdout) => {
      if (error) { resolvePromise(0); return }
      const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout))
      resolvePromise(m ? Number(m[1]) / 1e9 : 0)
    })
  })
}

/** 秒级字符串时间戳 → ms（非法返回 null）；兼容 number / 数字字符串 / 'YYYY-MM-DD HH:MM:SS' 本地时间 */
function parseCreateTimeMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.round(v) : Math.round(v * 1000)
  if (typeof v === 'string') {
    const n = Number(v)
    if (v.trim() !== '' && Number.isFinite(n)) return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v)
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
  }
  return null
}

/**
 * 回读候选判定（抗干扰双重过滤）：签名（#l<id8>）+ 时间窗（create_time ≥ transmittedAt-60s）。
 * - 宽窗口 --limit 30 下，用户随后的消息/文件不会挤出签名；
 * - 用户更早的历史消息/文件（无签名或时间早于发送时刻）天然排除；
 * - CLI 未返回可解析 create_time 时退化为纯签名匹配（旧版 CLI 兼容）。
 * 返回命中消息的 server_id（缺失则 undefined），未命中返回 null。
 */
function matchVerifyCandidate(stdout: string, feature: string, transmittedAt: number): string | undefined | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // 纯文本输出兜底：含签名即命中（无法做时间窗过滤）
    return stdout.includes(feature) ? undefined : null
  }
  const msgs = (parsed as { messages?: unknown })?.messages
  if (!Array.isArray(msgs)) return stdout.includes(feature) ? undefined : null
  const floor = transmittedAt > 0 ? transmittedAt - 60_000 : 0
  for (const m of msgs) {
    if (typeof m !== 'object' || m === null) continue
    const rec = m as Record<string, unknown>
    const content = typeof rec.content === 'string' ? rec.content : typeof rec.text === 'string' ? rec.text : ''
    if (!content.includes(feature)) continue
    const ct = parseCreateTimeMs(rec.create_time ?? rec.createTime ?? rec.ts)
    if (ct !== null && ct < floor) continue // 陈旧误配：签名在但消息早于发送时刻
    const sid = rec.server_id ?? rec.serverId ?? rec.msgSvrId
    return typeof sid === 'string' || typeof sid === 'number' ? String(sid) : undefined
  }
  return null
}

const OSC_ACTIVATE = 'tell application "WeChat" to activate'
const OSC_KEY_CMD_V = 'tell application "System Events" to keystroke "v" using command down'
const OSC_KEY_RETURN = 'tell application "System Events" to key code 36'

/**
 * KeyboardSender：wx-chatbot 式键盘模拟原语（macOS 键位，实测简化版键序——无搜索定位）。
 * 全部经 osascript/System Events；消息文本一律走剪贴板，避开输入法。
 * 目标会话 = 用户当前打开的会话（前提：文件传输助手是当前会话）；发送正确性由发送后
 * DB 回读验证兜底（未命中 → failed_wrong_target 终态 + P0 warn）。
 */
export class KeyboardSender implements SendPrimitive {
  readonly method: SendMethod = 'keyboard'
  private readonly runCommandFn: (file: string, args: string[]) => Promise<CommandResult>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly isFrontmostFn: () => Promise<boolean>
  private readonly allowTakeFocus: boolean
  private readonly warn?: (message: string) => void

  constructor(options: {
    runCommand: (file: string, args: string[]) => Promise<CommandResult>
    sleepMs: (ms: number) => Promise<void>
    isFrontmost: () => Promise<boolean>
    /** 抢前台模式：activate 后不做前台中止检查（微信不在前台也继续键序） */
    allowTakeFocus?: boolean
    warn?: (message: string) => void
  }) {
    this.runCommandFn = options.runCommand
    this.sleep = options.sleepMs
    this.isFrontmostFn = options.isFrontmost
    this.allowTakeFocus = options.allowTakeFocus ?? false
    this.warn = options.warn
  }

  private async run(script: string): Promise<CommandResult> {
    return this.runCommandFn('osascript', ['-e', script])
  }

  private async setClipboard(text: string): Promise<boolean> {
    const r = await this.run(`set the clipboard to ${JSON.stringify(text)}`)
    return r.code === 0
  }

  /** 保存剪贴板原内容（文本类可完整恢复；非文本/读取失败返回 null） */
  private async saveClipboard(): Promise<string | null> {
    const r = await this.run('the clipboard as «class UTF8»')
    if (r.code !== 0) return null
    const m = /«class UTF8»"((?:[^"\\]|\\.)*)"/.exec(r.stdout)
    if (!m) return null
    return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }

  async transmit(input: PrimitiveSendInput): Promise<PrimitiveSendResult> {
    // 1. 激活微信 + 确认前台（抢前台模式跳过确认——activate 本就是抢前台动作）
    await this.run(OSC_ACTIVATE)
    if (!this.allowTakeFocus) {
      let front = false
      try { front = await this.isFrontmostFn() } catch { front = false }
      if (!front) return { ok: false, stage: 'error', detail: 'WeChat activate 后仍非前台——放弃键序（防按键落到别的应用）' }
    }
    // 2. 保存剪贴板（发送后恢复——礼貌且防用户数据丢失）
    const saved = await this.saveClipboard()
    // 3. dry_run：确认前台后直接结束——绝不碰输入框不回车（实测教训：干跑时的粘贴也可能落进当前会话输入框被误发）
    if (input.dryRun) {
      await this.restoreClipboard(saved)
      return { ok: true, stage: 'located', detail: 'dry_run 已确认微信前台，跳过输入（不粘贴不回车）——目标会话由"当前打开的会话"决定，请人工确认是文件传输助手' }
    }
    // 4. 剪贴板设为消息文本 → Cmd+V → 延迟 → Return 发送（无搜索定位——目标会话 = 用户当前打开的会话）
    await this.setClipboard(input.text)
    await this.run(OSC_KEY_CMD_V)
    await this.sleep(KEY_DELAY_PASTE_MS)
    await this.run(OSC_KEY_RETURN)
    // 5. 恢复剪贴板（失败不阻塞，warn）
    await this.restoreClipboard(saved)
    return { ok: true, stage: 'sent', detail: '键盘序列发送完成（目标=当前会话；待 DB 回读验证兜底）' }
  }

  private async restoreClipboard(saved: string | null): Promise<void> {
    if (saved === null) return // 无可恢复内容（读取失败/非文本），静默跳过
    const ok = await this.setClipboard(saved)
    if (!ok) this.warn?.('sender[keyboard]: 剪贴板恢复失败（不阻塞发送流程）')
  }
}

/** WechatUiSender：原 wechat-ui send 实现（sendMethod='wechat-ui' 时用，将来可切回） */
export class WechatUiSender implements SendPrimitive {
  readonly method: SendMethod = 'wechat-ui'
  constructor(private readonly options: {
    wechatUiPath: string
    composerTop: number
    runCommand: (file: string, args: string[]) => Promise<CommandResult>
  }) {}

  async transmit(input: PrimitiveSendInput): Promise<PrimitiveSendResult> {
    if (input.dryRun) {
      // 保留旧语义：dry_run 绝不 spawn
      return { ok: true, stage: 'located', detail: 'dry_run (wechat-ui)：不调用工具，只记日志/审计' }
    }
    const result = await this.options.runCommand(this.options.wechatUiPath, [
      'send',
      '--chat', FILEHELPER_CHAT,
      '--text', input.text,
      '--id', input.id, // outbox 唯一 id：工具侧幂等，重复不重发
      '--composer-top', String(this.options.composerTop),
    ])
    const ok = result.code === 0 && result.stdout.includes('sent_ui_verified')
    return ok
      ? { ok: true, stage: 'sent', detail: 'wechat-ui sent_ui_verified' }
      : { ok: false, stage: 'error', detail: `wechat-ui send failed code=${result.code}` }
  }
}

export class SenderService {
  private readonly enabled: boolean
  private readonly dryRun: boolean
  private readonly method: SendMethod
  private readonly allowTakeFocus: boolean
  private readonly maxSendsPerDay: number
  private readonly frontmostWarnAfter: number
  private readonly intervalSec: number
  private readonly sourceToolDir: string
  private readonly sourceDbRoot: string
  private readonly sourcePython: string
  private readonly now: () => number
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval
  private readonly tickMs: number
  private readonly runCommandFn: (file: string, args: string[]) => Promise<CommandResult>
  private readonly isFrontmostFn: () => Promise<boolean>
  private readonly idleSecFn: () => Promise<number>
  private readonly idleSkipBelowSec: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly verifyDelayMs: number
  private readonly verifyRetries: number
  private readonly chatVerifyRetries: number
  private readonly primitive: SendPrimitive
  /** 交互闸：连续非前台轮数（发送成功/前台重置） */
  private consecutiveNotFront = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: SenderOptions) {
    this.enabled = options.enabled ?? false
    this.dryRun = options.dryRun ?? true
    this.method = options.sendMethod === 'wechat-ui' ? 'wechat-ui' : 'keyboard'
    this.allowTakeFocus = options.allowTakeFocus ?? false
    this.maxSendsPerDay = Math.max(0, Math.floor(options.maxSendsPerDay ?? 20))
    this.frontmostWarnAfter = Math.max(1, Math.floor(options.frontmostWarnAfter ?? 3))
    this.intervalSec = Math.max(1, Math.floor(options.intervalSec ?? 300))
    this.verifyDelayMs = Math.max(0, Math.floor((options.verifyDelaySec ?? 3) * 1000))
    this.verifyRetries = Math.max(1, Math.floor(options.verifyRetries ?? VERIFY_RETRIES))
    this.chatVerifyRetries = Math.max(0, Math.floor(options.chatVerifyRetries ?? 2))
    this.now = options.now ?? (() => Date.now())
    this.setIntervalFn = options.setInterval ?? setInterval
    this.clearIntervalFn = options.clearInterval ?? clearInterval
    this.tickMs = options.tickMs ?? this.intervalSec * 1000
    this.runCommandFn = options.runCommand ?? defaultRunCommand
    this.isFrontmostFn = options.isFrontmost ?? defaultIsFrontmost
    this.idleSecFn = options.systemIdleSec ?? (async () => Number.POSITIVE_INFINITY) // 未注入 = 闸不生效（测试离线）
    this.idleSkipBelowSec = Math.max(0, options.idleSkipBelowSec ?? IDLE_SKIP_BELOW_SEC)
    this.sleep = options.sleepMs ?? defaultSleep
    this.sourceToolDir = options.sourceToolDir ?? ''
    this.sourceDbRoot = options.sourceDbRoot ?? ''
    this.sourcePython = options.sourcePython ?? 'python3'
    this.primitive = this.method === 'wechat-ui'
      ? new WechatUiSender({ wechatUiPath: options.wechatUiPath ?? 'wechat-ui', composerTop: options.composerTop ?? 0.7, runCommand: this.runCommandFn })
      : new KeyboardSender({ runCommand: this.runCommandFn, sleepMs: this.sleep, isFrontmost: this.isFrontmostFn, allowTakeFocus: this.allowTakeFocus, warn: (m) => this.options.logger.warn(m) })
  }

  /** 本地自然日 key（与 person-digest.localDayKey 同口径，避免跨模块依赖自实现） */
  private dayKey(ts: number): string {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  /** 审计一行：只记元数据（outbox id / 结果 / attempts），绝不记正文 */
  private audit(entry: Record<string, unknown>): void {
    this.options.store.ensureDir('audit')
    this.options.store.appendJsonl(SENDER_AUDIT_REL, { ts: new Date(this.now()).toISOString(), ...entry })
  }

  /** ③ 交互闸（后半）：系统空闲 <10s 视为用户正在操作 → 跳过本轮防按键串扰 */
  private async userBusy(): Promise<boolean> {
    try {
      return (await this.idleSecFn()) < this.idleSkipBelowSec
    } catch {
      return true // 读不到空闲时间 = fail-safe 跳过
    }
  }

  /**
   * ④ 发送前合规闸（路线 A，keyboard 模式专用；dry_run 照常执行——只读核验，
   * 正好用于上线前验证 TCC「屏幕录制」授权与当前会话定位）。
   * 未通过 → deferred：审计 result='wrong_chat_open' + reason 字段，attempts 不增
   * （用户环境/部署状态不是发送失败），保持 pending 下轮自动重试。
   */
  private async chatVerifyGate(entry: OutboxEntry): Promise<{ action: 'deferred' } | { action: 'pass' }> {
    if (this.method !== 'keyboard') return { action: 'pass' } // wechat-ui 原语自带发送验证
    const id = entry.id ?? ''
    const gate = await verifyChatOpen({
      wechatUiPath: this.options.wechatUiPath ?? 'wechat-ui',
      retries: this.chatVerifyRetries,
      runCommand: this.runCommandFn,
      sleepMs: this.sleep,
    })
    if (gate.ok) return { action: 'pass' }
    this.audit({ id, kind: entry.kind, result: 'wrong_chat_open', reason: gate.reason, attempts: entry.attempts ?? 0, deferred: true, method: this.method })
    if (gate.reason === 'ui_tool_missing') {
      this.options.logger.warn(`sender: 合规闸不可用 id=${id}（wechat-ui 二进制缺失/无法执行）— deferred 不发送不计 attempts，请检查 wechatUiPath`)
    } else if (gate.reason === 'tcc_denied') {
      this.options.logger.warn(`sender: 合规闸不可用 id=${id}（DSH 宿主缺「屏幕录制」TCC 权限）— deferred 不发送不计 attempts，请到 系统设置→隐私与安全性→屏幕录制 授权`)
    } else {
      this.options.logger.warn(`sender: 合规闸未通过 id=${id}（当前会话不是文件传输助手，${gate.attempts} 次核验全失败）— 请将微信当前会话切换到文件传输助手（不计 attempts，下轮重试）`)
    }
    return { action: 'deferred' }
  }

  /**
   * 发送单条 outbox 条目（与消费循环完全同一路径：dry_run / 状态机 / 审计 / 验证）。
   * 闸门（总闸/通道闸/交互闸/频控）由调用方先过；这里只负责"怎么发 + 怎么验"。
   */
  private async sendEntry(entry: OutboxEntry, tookFocus = false): Promise<{ action: string }> {
    const id = entry.id ?? ''
    if (id === '') {
      this.options.logger.error('sender: entry without id — skipped (cannot send idempotently)')
      return { action: 'failed' }
    }
    // 文本策略：短文本单行，绝不发全文 + 回读验证特征串
    const base = buildSendText(entry.title ?? '', entry.body ?? '')
    const { text, feature } = appendFeature(base, id)
    const attempts = (entry.attempts ?? 0) + 1

    // dry_run：keyboard 模式 activate + 前台确认后即停——不碰输入框不回车（防干跑误发）；
    //          wechat-ui 模式照旧只记日志/审计，不调工具。条目标 dry_run 消费掉，避免反复扫描。
    if (this.dryRun) {
      if (this.method === 'keyboard') {
        // ④ 合规闸照常执行（dry_run 也只读核验——上线前验证 TCC 与定位）
        const gate = await this.chatVerifyGate(entry)
        if (gate.action === 'deferred') return { action: 'deferred' }
        const r = await this.primitive.transmit({ id, text, feature, dryRun: true })
        if (!r.ok && r.stage === 'env_unavailable') {
          // 熄屏/锁屏/窗口不可读 = 环境等待：不计 attempts、保持 pending，下轮自动重试（不熔断）
          this.audit({ id, kind: entry.kind, result: 'screen_locked_deferred', attempts: entry.attempts ?? 0, deferred: true })
          this.options.logger.info(`sender[dry_run] 环境不可用挂起 id=${id} (${r.detail}) — 不计 attempts，下轮重试`)
          return { action: 'deferred' }
        }
        if (!r.ok) {
          const status: OutboxEntry['status'] = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
          this.options.outbox.updateSendState(id, { status, attempts })
          this.audit({ id, kind: entry.kind, result: 'dry_run_locate_failed', attempts })
          this.options.logger.error(`sender[dry_run] locate failed id=${id} (${r.detail}) attempts=${attempts}`)
          return { action: 'failed' }
        }
      }
      this.options.outbox.updateSendState(id, { status: 'dry_run' })
      this.audit({ id, kind: entry.kind, result: 'dry_run' })
      this.options.logger.info(`sender[dry_run] id=${id} kind=${entry.kind} — dry_run 已定位会话，停在发送前 (content not logged)`)
      return { action: 'dry_run' }
    }

    // keyboard 模式 fail-closed：没有 wechat_db.py 就无法做 DB 回读验证，宁可不发
    if (this.method === 'keyboard' && (this.sourceToolDir === '' || this.sourceDbRoot === '')) {
      const status: OutboxEntry['status'] = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
      this.options.outbox.updateSendState(id, { status, attempts })
      const missing = this.sourceToolDir === '' ? 'sourceToolDir' : 'sourceDbRoot'
      this.audit({ id, kind: entry.kind, result: 'unverified_no_db_tool', attempts, missing })
      this.options.logger.error(`sender: keyboard 模式缺 ${missing}（无法 DB 回读验证）— fail-closed 不发送 id=${id} attempts=${attempts}`)
      return { action: 'failed' }
    }

    // ④ 发送前合规闸：wechat-ui read 标题核验通过才执行"粘贴+Return"键序（防误发核心）
    const gate = await this.chatVerifyGate(entry)
    if (gate.action === 'deferred') return { action: 'deferred' }

    const r = await this.primitive.transmit({ id, text, feature, dryRun: false })
    if (!r.ok && r.stage === 'env_unavailable') {
      // 熄屏/锁屏等环境不可用 = 等待而非失败：不计 attempts、保持 pending，解锁后自动恢复
      this.audit({ id, kind: entry.kind, result: 'screen_locked_deferred', attempts: entry.attempts ?? 0, deferred: true, method: this.method })
      this.options.logger.info(`sender: 环境不可用挂起 id=${id} (${r.detail}) — 不计 attempts，下轮重试`)
      return { action: 'deferred' }
    }
    const transmitted = r.ok && r.stage === 'sent'
    if (!transmitted) {
      // 发送前失败（activate 失败等）→ 保持 pending 重试整条发送（现行为不变）
      const status: OutboxEntry['status'] = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
      this.options.outbox.updateSendState(id, { status, attempts })
      this.audit({ id, kind: entry.kind, result: 'send_failed', attempts, method: this.method })
      this.options.logger.error(`sender: send failed id=${id} attempts=${attempts}${status === 'failed' ? ' — marked failed, no more retries' : ''}`)
      return { action: 'failed' }
    }
    // ★ 发送/验证解耦关键点：键序已执行到 Return，消息已打出去——先落盘
    //   sent_pending_verify + transmittedAt，**再**做回读验证。后续周期见到该状态绝不重发。
    this.options.outbox.updateSendState(id, { status: 'sent_pending_verify', attempts, transmittedAt: this.now() })
    this.audit({ id, kind: entry.kind, result: 'transmitted', attempts, method: this.method })
    if (this.method !== 'keyboard') {
      // wechat-ui：spawn 已带 sent_ui_verified 校验，无回读阶段 → 直接终态 sent
      this.options.outbox.updateSendState(id, { status: 'sent' })
      this.audit({ id, kind: entry.kind, result: tookFocus ? 'take_focus_sent' : 'sent', attempts, method: this.method })
      return { action: 'sent' }
    }
    return this.verifyTransmitted(entry, id, feature, attempts, tookFocus, this.now())
  }

  /**
   * 回读验证阶段（只验证、绝不重发）：对 sent_pending_verify 条目跑 verifyRetries × verifyDelaySec
   * 回读窗口。命中 → sent；穷尽未命中 → failed_wrong_target（P0 终态）；CLI 报错 → 保持
   * sent_pending_verify + verifyAttempts++（≥5 转人工告警），下轮只重试验证。
   */
  private async verifyTransmitted(
    entry: OutboxEntry,
    id: string,
    feature: string,
    attempts: number,
    tookFocus = false,
    transmittedAt = 0,
  ): Promise<{ action: 'sent' | 'failed' | 'deferred' }> {
    let verified = false
    let readBroken = false
    let serverId: string | undefined
    for (let attempt = 1; attempt <= this.verifyRetries; attempt++) {
      await this.sleep(this.verifyDelayMs)
      const v = await this.runCommandFn(this.sourcePython, [
        join(this.sourceToolDir, 'wechat_db.py'),
        '--db-root', this.sourceDbRoot,
        '--key-file', join(this.sourceToolDir, '.wechat-local/keys.json'),
        'read', '--chat-id', 'filehelper', '--limit', '30', // 宽窗口：用户随后的消息不会把签名挤出 top-3
      ])
      if (v.code !== 0) { readBroken = true; break }
      const hit = matchVerifyCandidate(v.stdout, feature, transmittedAt)
      if (hit !== null) { verified = true; serverId = hit; break }
    }
    if (readBroken) {
      // 回读 CLI 失败 = 验证环境问题：保持 sent_pending_verify 绝不重发，只累计验证轮数
      const verifyAttempts = (entry.verifyAttempts ?? 0) + 1
      this.options.outbox.updateSendState(id, { status: 'sent_pending_verify', verifyAttempts })
      this.audit({ id, kind: entry.kind, result: 'verify_read_deferred', attempts, verifyAttempts, deferred: true, method: this.method })
      if (verifyAttempts >= VERIFY_MANUAL_ALERT_ATTEMPTS) {
        this.options.logger.error(`sender: [人工介入] id=${id} 已 ${verifyAttempts} 轮回读失败（CLI 报错）——消息可能已发出但无法验证，请人工检查文件传输助手`)
      } else {
        this.options.logger.warn(`sender: DB 回读本身失败 id=${id}（第 ${verifyAttempts} 轮）— 保持 sent_pending_verify 只重试验证，绝不重发`)
      }
      return { action: 'deferred' }
    }
    if (verified) {
      // 证据链：#l<id8> 签名（自造）+ server_id（官方送达回执）+ transmittedAt + sentAt
      this.options.outbox.updateSendState(id, { status: 'sent', serverId, sentAt: this.now() })
      this.audit({ id, kind: entry.kind, result: tookFocus ? 'take_focus_sent' : 'sent', attempts, method: this.method, serverId })
      this.options.logger.info(`sender: sent id=${id} kind=${entry.kind}${tookFocus ? ' (take_focus)' : ''} (method=${this.method}, db_verified${serverId ? ', server_id recorded' : ''}, content not logged)`)
      return { action: 'sent' }
    }
    // P0：回读穷尽未命中——消息可能发进了非 filehelper 会话。终态不再重试（重试可能再次误发）。
    this.options.outbox.updateSendState(id, { status: 'failed_wrong_target', attempts })
    this.audit({ id, kind: entry.kind, result: 'failed_wrong_target', attempts, method: this.method, p0: true })
    this.options.logger.warn(`sender: [P0] DB 回读未命中特征串 id=${id}——消息可能发进了非 filehelper 会话，已标 failed_wrong_target 终态（不重试），请立即人工检查微信当前会话与已发内容`)
    return { action: 'failed' }
  }

  /** 验证-only 轮：处理历史 sent_pending_verify 条目（绝不重发，只重试回读验证） */
  private async verifyOnlyPass(): Promise<{ action: string; processed: number }> {
    if (this.method !== 'keyboard') return { action: 'empty', processed: 0 } // wechat-ui 无回读阶段
    const all = this.options.outbox.listOutbox()
    const spv = all.filter((e) => e.status === 'sent_pending_verify' && e.channel === 'filehelper' && e.id)
    let deferred = 0
    let failed = 0
    let sent = 0
    for (const entry of spv) {
      const feature = `#l${(entry.id ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
      const r = await this.verifyTransmitted(entry, entry.id ?? '', feature, entry.attempts ?? 0)
      if (r.action === 'sent') sent += 1
      else if (r.action === 'deferred') deferred += 1
      else failed += 1
    }
    return { action: failed > 0 ? 'failed' : deferred > 0 ? 'deferred' : sent > 0 ? 'sent' : 'empty', processed: sent + deferred + failed }
  }

  /**
   * 样例发送（与真实日报解耦的链路验证入口，挂 groupLurker.sender）：
   * 向 outbox 插入一条合成样例（channel='filehelper'、kind='test_sample'、body 带时间戳），
   * 然后立即走与真实条目完全相同的发送链路（全部闸门/频控/状态机/验证一致），
   * 不触碰任何真实 pending 条目。绝不抛出；返回 { action, id }。
   */
  async sendTestSample(): Promise<{ action: string; id: string }> {
    if (!this.enabled) {
      this.options.logger.info('sender disabled (senderEnabled=false) — sendTestSample refused (zero send activity)')
      return { action: 'disabled', id: '' }
    }
    const appended = this.options.outbox.appendOutbox({
      kind: 'test_sample',
      title: '【测试样例】发送链路验证',
      body: `发送链路样例，时间戳 ${new Date(this.now()).toISOString()}。收到即链路通，全文不影响任何真实报告。`,
      evidence_ref: 'test',
    })
    if (!appended?.id) return { action: 'failed', id: '' }
    const id = appended.id
    // ② 通道闸（样例恒为 filehelper，但走同一硬编码白名单检查）
    if (!ALLOWED_CHANNELS.includes(appended.channel)) {
      this.options.outbox.updateSendState(id, { status: 'skipped_channel' })
      return { action: 'skipped_channel', id }
    }
    // 频控：样例同样占用当日配额（超限标 skipped_quota，不开后门）
    const all = this.options.outbox.listOutbox()
    const today = this.dayKey(this.now())
    const sentToday = all.filter((e) => e.status === 'sent' && e.ts !== undefined && this.dayKey(Date.parse(e.ts) || 0) === today).length
    if (sentToday >= this.maxSendsPerDay) {
      this.options.outbox.updateSendState(id, { status: 'skipped_quota' })
      this.audit({ id, result: 'skipped_quota' })
      this.options.logger.warn(`sender: daily quota ${this.maxSendsPerDay} reached — test sample marked skipped_quota`)
      return { action: 'quota', id }
    }
    // ③ 交互闸：微信前台 + 用户空闲（防按键串扰）
    const gate = await this.interactionGate('test sample')
    if (gate.blocked !== null) return { action: gate.blocked, id }
    const r = await this.sendEntry(this.options.outbox.listOutbox().find((e) => e.id === id) ?? appended, gate.tookFocus)
    return { action: r.action, id }
  }

  /**
   * ③ 交互闸（共用）：
   * - 默认模式：微信必须前台 + 系统空闲 ≥ IDLE_SKIP_BELOW_SEC；
   * - 抢前台模式（allowTakeFocus=true）：跳过前台检查（键序第 1 步 activate 抢前台），
   *   但保留用户空闲检测（<10s 仍跳过并计数——绝不抢正在打字的手）。
   * 返回 { blocked, tookFocus }：blocked 为动作名（'not_frontmost' | 'user_active'）或 null；
   * tookFocus=true 表示本轮是抢前台放行（审计据此区分）。
   */
  private async interactionGate(what: string): Promise<{ blocked: 'not_frontmost' | 'user_active' | null; tookFocus: boolean }> {
    // 抢前台模式：跳过前台检查，直接看用户空闲
    if (this.allowTakeFocus) {
      if (await this.userBusy()) {
        this.consecutiveNotFront += 1
        if (this.consecutiveNotFront >= this.frontmostWarnAfter) {
          this.options.logger.warn(`sender: 用户持续操作中（系统空闲 <${this.idleSkipBelowSec}s）连续 ${this.consecutiveNotFront} 轮 — 抢前台模式也让路，绝不打断打字（${what} 暂缓）`)
        }
        this.audit({ result: 'user_active', takeFocus: true, streak: this.consecutiveNotFront })
        return { blocked: 'user_active', tookFocus: false }
      }
      this.consecutiveNotFront = 0
      return { blocked: null, tookFocus: true }
    }
    let frontmost = true
    try {
      frontmost = await this.isFrontmostFn()
    } catch {
      frontmost = false
    }
    if (!frontmost) {
      this.consecutiveNotFront += 1
      if (this.consecutiveNotFront >= this.frontmostWarnAfter) {
        this.options.logger.warn(`sender: WeChat not frontmost ${this.consecutiveNotFront} rounds — 键盘模拟要求微信可被激活为前台（${what} 暂缓）`)
      }
      this.audit({ result: 'not_frontmost', streak: this.consecutiveNotFront })
      return { blocked: 'not_frontmost', tookFocus: false }
    }
    if (await this.userBusy()) {
      this.consecutiveNotFront += 1
      this.audit({ result: 'user_active' })
      this.options.logger.info(`sender: 用户正在操作（系统空闲 <${this.idleSkipBelowSec}s）— 跳过本轮防按键串扰（${what}）`)
      return { blocked: 'user_active', tookFocus: false }
    }
    this.consecutiveNotFront = 0
    return { blocked: null, tookFocus: false }
  }

  /**
   * 消费一轮 pending 的 filehelper 条目。闸门按序检查，绝不抛出（不拖垮宿主）。
   */
  async processOnce(): Promise<SendRoundResult> {
    // ① 总闸：未启用 = 零活动
    if (!this.enabled) return { action: 'disabled', processed: 0 }

    const all = this.options.outbox.listOutbox()
    // ② 通道闸：白名单外条目直接 skip 并 error 日志（硬编码红线，永不发送）
    for (const entry of all) {
      if (entry.status === 'pending' && !ALLOWED_CHANNELS.includes(entry.channel)) {
        this.options.logger.error(`sender: channel "${entry.channel}" not in allowlist — skipped, never sent (id=${entry.id ?? '?'})`)
        this.options.outbox.updateSendState(entry.id ?? '', { status: 'skipped_channel' })
        this.audit({ id: entry.id ?? '', result: 'skipped_channel', channel: entry.channel })
      }
    }

    // ②' 验证-only 轮：sent_pending_verify 条目绝不重发，只重试回读验证（发送/验证解耦）
    const vpass = await this.verifyOnlyPass()

    const pending = all.filter((e) => e.status === 'pending' && e.channel === 'filehelper')
    if (pending.length === 0) {
      if (vpass.processed > 0) return { action: vpass.action, processed: vpass.processed }
      return { action: 'empty', processed: 0 }
    }

    // 频控：今日已发送条数 → 预算外的当日 pending 标 skipped_quota
    const today = this.dayKey(this.now())
    const sentToday = all.filter((e) => e.status === 'sent' && e.ts !== undefined && this.dayKey(Date.parse(e.ts) || 0) === today).length
    let budget = Math.max(0, this.maxSendsPerDay - sentToday)
    if (budget === 0) {
      for (const entry of pending) {
        this.options.outbox.updateSendState(entry.id ?? '', { status: 'skipped_quota' })
        this.audit({ id: entry.id ?? '', result: 'skipped_quota' })
      }
      this.options.logger.warn(`sender: daily quota ${this.maxSendsPerDay} reached — ${pending.length} pending marked skipped_quota`)
      return { action: 'quota', processed: 0 }
    }
    const overQuota = pending.slice(budget)
    for (const entry of overQuota) {
      this.options.outbox.updateSendState(entry.id ?? '', { status: 'skipped_quota' })
      this.audit({ id: entry.id ?? '', result: 'skipped_quota' })
    }
    const batch = pending.slice(0, budget)

    // ③ 交互闸：微信前台 + 用户空闲
    const gate = await this.interactionGate(`${batch.length} 条`)
    if (gate.blocked !== null) return { action: gate.blocked, processed: 0 }

    let sent = 0
    let failed = 0
    let deferred = 0
    for (const entry of batch) {
      const r = await this.sendEntry(entry, gate.tookFocus)
      if (r.action === 'sent' || r.action === 'dry_run') sent += 1
      else if (r.action === 'deferred') deferred += 1
      else failed += 1
    }
    if (deferred > 0 && failed === 0) return { action: 'deferred', processed: sent + deferred + vpass.processed }
    return { action: failed > 0 ? 'failed' : 'sent', processed: sent + failed + deferred + vpass.processed }
  }

  /**
   * 启动消费心跳。senderEnabled=false 时返回 noop（零活动）。
   * 返回清理函数（clearInterval 唯一释放点），由 index.ts 挂进 ctx.effect。
   */
  start(): () => void {
    if (!this.enabled) {
      this.options.logger.info('sender disabled (senderEnabled=false) — outbox stays local, zero send activity')
      return () => {}
    }
    this.timer = this.setIntervalFn(() => {
      void this.processOnce().catch((error: unknown) => {
        this.options.logger.error(`sender tick failed: ${String(error)}`)
      })
    }, this.tickMs)
    this.options.logger.info(`sender started (method=${this.method}, interval=${this.intervalSec}s, dryRun=${this.dryRun}, maxPerDay=${this.maxSendsPerDay}, chat=${FILEHELPER_CHAT})`)
    void this.processOnce().catch((error: unknown) => {
      this.options.logger.error(`sender first tick failed: ${String(error)}`)
    })
    return () => {
      if (this.timer !== null) {
        this.clearIntervalFn(this.timer)
        this.timer = null
      }
      this.consecutiveNotFront = 0
    }
  }
}

/** Config 侧组装用：intervalSec → SenderOptions */
export interface SenderConfigInput {
  senderEnabled: boolean
  sendDryRun: boolean
  sendMethod: string
  sendIntervalSec: number
  maxSendsPerDay: number
  wechatUiPath: string
  composerTop: number
  sourceToolDir: string
  sourceDbRoot: string
  sourcePython: string
  allowTakeFocus: boolean
  idleSkipBelowSec: number
  chatVerifyRetries: number
}

export function senderOptionsFromConfig(options: {
  config: SenderConfigInput
  outbox: Outbox
  store: import('./store.js').Store
  logger: SenderLogger
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  tickMs?: number
}): SenderOptions {
  return {
    outbox: options.outbox,
    store: options.store,
    logger: options.logger,
    enabled: options.config.senderEnabled,
    dryRun: options.config.sendDryRun,
    sendMethod: options.config.sendMethod === 'wechat-ui' ? 'wechat-ui' : 'keyboard',
    maxSendsPerDay: options.config.maxSendsPerDay,
    wechatUiPath: options.config.wechatUiPath,
    composerTop: options.config.composerTop,
    sourceToolDir: options.config.sourceToolDir,
    sourceDbRoot: options.config.sourceDbRoot,
    sourcePython: options.config.sourcePython,
    allowTakeFocus: options.config.allowTakeFocus,
    idleSkipBelowSec: options.config.idleSkipBelowSec,
    chatVerifyRetries: options.config.chatVerifyRetries,
    systemIdleSec: defaultSystemIdleSec,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    tickMs: options.tickMs,
  }
}
