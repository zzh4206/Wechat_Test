/**
 * message-wire.ts：送给 LLM 的消息 wire 格式（成本治理 C3，docs/COST-ANALYSIS-2026-10-21.md §4 C3）。
 *
 * 动机：旧 prompt 把 buffer 里的消息对象整体 JSON.stringify —— 每条带 `ts/sender/text/messageId`
 * 全字段，且 `text` 本身已是 `JSON.stringify(原文)` 的字符串，外层再序列化一次 → 引号/反斜杠
 * 双重转义、messageId 等 LLM 用不上的字段白烧 token。本模块把任意消息数组压成紧凑 wire 行：
 *
 *   {n, name, ts, text}          必选字段（n = 1 起始全局序号，ts = 秒级整数）
 *   {q}                          可选：被引用消息在本窗口内的行序号（窗口外引用忽略）
 *   {trunc: true}                可选：text 超过 WIRE_TRUNCATE_THRESHOLD，已截断保留首尾
 *
 * 契约（与 report/distiller/refine 的解析逻辑共同锁定）：
 * - wire 行数组与输入消息数组**同序同长**，n 与数组下标一一对应（n = startIndex + i + 1，
 *   或由 nOf 显式给出）——evidence/quotes 的序号映射（messages[n-1]）完全不变；
 * - 截断/折叠只影响送给 LLM 的表示，**不影响落库与 L3 溯源原文**（pickQuotes 仍从 store 取）；
 * - text 为「原文」，不是 JSON 字符串（`textEncoding: 'json'` 时先解一层 JSON 字符串）。
 *
 * 纯函数、无副作用、不引入依赖；不发送任何消息。
 */
import type { MessageKind } from './group-store.js'

/** wire 格式版本（指令区提示词里带版本号，便于输出侧排查/回滚） */
export const WIRE_FORMAT_VERSION = 1

/** 长文本截断阈值（字符数；超过即截断） */
export const WIRE_TRUNCATE_THRESHOLD = 400
/** 截断后保留的头部字符数（公告类长文的首要点） */
export const WIRE_TRUNCATE_HEAD = 280
/** 截断后保留的尾部字符数（公告类长文的尾要点） */
export const WIRE_TRUNCATE_TAIL = 100

/** 截断占位符（U+2026 单字符省略号，1 字符成本） */
const ELLIPSIS = '…'

/**
 * wire 行的输入消息最小结构：`group-store.StoredMessage` 与 `buffer.BufferedMessage`
 * 均结构兼容（前者 senderName/msgId/kind/quoteOfMsgId，后者 sender/messageId）。
 */
export interface WireMessageInput {
  /** 毫秒时间戳（wire 输出为秒级整数） */
  ts: number
  /** 发送者群昵称（StoredMessage.senderName） */
  senderName?: string
  /** 发送者代号/昵称（BufferedMessage.sender；senderName 缺省时的兜底） */
  sender?: string
  /** 消息类型（缺省视为 text） */
  kind?: MessageKind
  /** 消息原文（`textEncoding: 'json'` 时传 JSON 字符串化原文） */
  text?: string
  /** 引用链：被引用消息 id（窗口内引用转成 q） */
  quoteOfMsgId?: string | null
  /** 消息 id（StoredMessage.msgId；q 映射的键） */
  msgId?: string
  /** 消息 id（BufferedMessage.messageId；msgId 缺省时的兜底键） */
  messageId?: string
}

/** 紧凑 wire 行（字段顺序固定；可选字段仅在命中时出现） */
export interface WireLine {
  /** 1 起始全局序号（与输入数组下标一一对应） */
  n: number
  /** 发送者名 */
  name: string
  /** 秒级 Unix 时间戳 */
  ts: number
  /** 聊天原文（非文本消息为占位符） */
  text: string
  /** 被引用消息在本窗口内的行序号（窗口外引用不写） */
  q?: number
  /** 长文本已截断（保留首尾） */
  trunc?: true
}

/** toWireMessages 选项 */
export interface ToWireMessagesOptions {
  /** 首条消息的全局序号 - 1（默认 0 → 首条 n=1；report 分批传批起点下标） */
  startIndex?: number
  /** 自定义序号映射（优先级高于 startIndex；refine 段带重叠带时用） */
  nOf?: (message: WireMessageInput, index: number) => number
  /**
   * text 编码（默认 'raw'）：
   * - 'raw'：text 已是原文（group-store / report / refine）；
   * - 'json'：text 是 JSON 字符串化原文（bus sanitize 后的 buffer），先解一层。
   */
  textEncoding?: 'raw' | 'json'
}

/**
 * 非文本消息占位符（MessageKind 全枚举；`text` 但原文为空时也用占位符）。
 * 只折叠表示、不剔除行——时间线与参与者信息必须保留。
 */
const KIND_PLACEHOLDER: Record<MessageKind, string> = {
  text: '[空消息]',
  image: '[图片]',
  voice: '[语音]',
  file: '[文件]',
  system: '[系统消息]',
  quote: '[引用]',
  video: '[视频]',
  link: '[链接]',
  other: '[其他消息]',
}

/**
 * 携带正文的类型：text 是普通聊天，quote 是「引用回复」——回复正文本身就是聊天内容
 * （wechat-db 把 local_type 49/引用消息标 kind='quote'，text=selfText），折叠成
 * `[引用]` 会丢正文。故这两种按文本处理；只有媒体/系统类才折叠为占位符。
 */
const TEXT_BEARING_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(['text', 'quote'])

/** JSON 字符串化原文 → 原文（只解一层；非字符串形态原样返回，绝不抛错） */
function decodeJsonText(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"')) return raw
  try {
    const v: unknown = JSON.parse(trimmed)
    return typeof v === 'string' ? v : raw
  } catch {
    return raw
  }
}

/** 长文本截断：≤400 原样；>400 取头部 280 + … + 尾部 100（共 381 字符） */
function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= WIRE_TRUNCATE_THRESHOLD) return { text, truncated: false }
  return {
    text: text.slice(0, WIRE_TRUNCATE_HEAD) + ELLIPSIS + text.slice(text.length - WIRE_TRUNCATE_TAIL),
    truncated: true,
  }
}

/** 输入消息的 id（q 映射键）：msgId 优先，messageId 兜底 */
function idOf(m: WireMessageInput): string {
  const id = m.msgId ?? m.messageId
  return typeof id === 'string' ? id : ''
}

/**
 * 消息数组 → 紧凑 wire 行数组（同序同长；纯函数）。
 *
 * 处理顺序：先建「窗口内 id → n」索引（q 只能指向本数组内消息），再逐条产出：
 * ① 非文本/空文本 → 占位符（kind 枚举映射）；
 * ② 文本 → 解一层 JSON（textEncoding='json'）→ 超 400 字截断（280+…+100）；
 * ③ quoteOfMsgId 命中窗口内 id → q = 被引行 n（窗口外/自引用/未知 id 一律忽略）。
 */
export function toWireMessages(
  messages: readonly WireMessageInput[],
  options: ToWireMessagesOptions = {},
): WireLine[] {
  const startIndex = Number.isFinite(options.startIndex) ? Math.floor(options.startIndex as number) : 0
  const nOf = options.nOf
  const encoding = options.textEncoding ?? 'raw'
  // 第一遍：窗口内 id → 行序号（n 可能来自 nOf，故与第二遍同规则计算）
  const nById = new Map<string, number>()
  messages.forEach((m, i) => {
    const n = nOf ? nOf(m, i) : startIndex + i + 1
    const id = idOf(m)
    if (id !== '' && !nById.has(id)) nById.set(id, n)
  })
  const out: WireLine[] = []
  messages.forEach((m, i) => {
    const n = nOf ? nOf(m, i) : startIndex + i + 1
    const kind: MessageKind = m.kind ?? 'text'
    const raw = typeof m.text === 'string' ? m.text : ''
    let text: string
    let truncated = false
    if (!TEXT_BEARING_KINDS.has(kind)) {
      text = KIND_PLACEHOLDER[kind] ?? KIND_PLACEHOLDER.other
    } else {
      const original = encoding === 'json' ? decodeJsonText(raw) : raw
      if (original === '') {
        text = KIND_PLACEHOLDER[kind]
      } else {
        const t = truncateText(original)
        text = t.text
        truncated = t.truncated
      }
    }
    const line: WireLine = {
      n,
      name: m.senderName || m.sender || '（未知成员）',
      ts: Math.floor(m.ts / 1000),
      text,
    }
    // 引用关系：只保留窗口内引用（窗口外信息价值低，忽略以省 token）
    const quoteId = m.quoteOfMsgId
    if (typeof quoteId === 'string' && quoteId !== '') {
      const target = nById.get(quoteId)
      if (target !== undefined && target !== n) line.q = target
    }
    if (truncated) line.trunc = true
    out.push(line)
  })
  return out
}

/**
 * 指令区格式说明（固定文本，逐字节稳定 → 可被供应商上下文缓存命中）：
 * 明确「text 是原文、不是 JSON 字符串」，以及 n/q/trunc 的语义。
 */
export const WIRE_FORMAT_HINT =
  `数据区格式（wire v${WIRE_FORMAT_VERSION}）：JSON 数组，每行 {n,name,ts,text}，可选 q/trunc。` +
  'n = 1 起始全局消息序号（evidence/quotes 一律用它映射）；name = 发送者；ts = 秒级 Unix 时间戳；' +
  'text = 聊天原文（纯文本，不是 JSON 字符串）；q = 被引用消息的行序号（仅窗口内引用）；' +
  'trunc=true 表示该条长文已截断（保留头部 280 + 尾部 100 字）；非文本消息以 [图片]/[语音] 等占位保留。'
