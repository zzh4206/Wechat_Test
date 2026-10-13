/**
 * bus.ts：订阅 im-connect 补丁广播的 `im-connect/message` 事件（只读）。
 *
 * 约定（PRD F2 / §8 / TECH-DESIGN §2）：
 * - 只消费，不产生任何出站 IM 动作；不持有 channel 发送句柄；
 * - 仅处理 kind === 'group' 的消息；chatId 不在 Config.groups 白名单内直接忽略；
 * - channel 缺失或 channel.id 不在白名单内同样忽略（双保险）；
 * - 每条先 guard.sanitize() 再过该群 TokenBucket，超限丢弃并计数；
 * - 监听经 ctx.on 注册，随插件 dispose 自动回收。
 */
import type { Context } from '@deepseek-ai/cordis'
import { sanitize, TokenBucket } from './guard.js'
import type { BufferPool } from './buffer.js'

/** 补丁事件 payload（见 patches/ 与 docs/SPIKE-bus.md） */
export interface ImConnectMessage {
  chatId: string
  userId?: string
  username?: string
  text: string
  kind?: 'group' | 'dm'
  addressed?: boolean
  messageId?: string
  media?: unknown
}

export interface ImConnectMessageEvent {
  channel?: { id?: string } & Record<string, unknown>
  message: ImConnectMessage
}

/** 本地库适配器（W2 wechat-db.ts）产出的消息：经 ingest 进同一消毒/限流/缓冲下游 */
export interface IngestibleMessage {
  chatId: string
  sender: string
  senderName?: string
  text: string
  messageId?: string
  /** 消息自身时间戳（适配器传 create_time；事件路径传 Date.now()） */
  ts: number
}

export interface BusOptions {
  /** 允许旁听的 chatId 白名单（空 = 不监听任何人） */
  groups: readonly string[]
  buffer: BufferPool
  bucket: TokenBucket
  /** 消息入缓冲后的回调（供 distiller 计数触发提炼） */
  onAccepted: (chatId: string) => void
}

export interface BusStats {
  /** 各群已入缓冲条数 */
  accepted: Map<string, number>
  /** 各群被限流丢弃条数（也含被白名单外忽略前的统计仅针对白名单内群） */
  dropped: Map<string, number>
}

export class MessageBus {
  private readonly groups: Set<string>
  private readonly buffer: BufferPool
  private readonly bucket: TokenBucket
  private readonly onAccepted: (chatId: string) => void
  private readonly stats: BusStats = { accepted: new Map(), dropped: new Map() }
  private _handled = 0

  constructor(options: BusOptions) {
    this.groups = new Set(options.groups)
    this.buffer = options.buffer
    this.bucket = options.bucket
    this.onAccepted = options.onAccepted
  }

  /** 白名单内群数量（测试/状态用） */
  get whitelistSize(): number {
    return this.groups.size
  }

  /** 累计进入完整处理管线（通过白名单）的事件数 */
  get handled(): number {
    return this._handled
  }

  /** 单条事件处理（独立方法便于直接测试，不必起 Cordis 总线） */
  handle(event: ImConnectMessageEvent): boolean {
    const { message } = event
    // 双白名单：chatId 与 channel.id 都必须在 Config.groups 内，否则零处理。
    if (!message || message.kind !== 'group') return false
    if (!this.groups.has(message.chatId)) return false
    const channelId = event.channel?.id
    if (typeof channelId !== 'string' || !this.groups.has(channelId)) return false

    this._handled++
    return this.accept(message.chatId, {
      ts: Date.now(),
      sender: message.username ?? message.userId ?? 'unknown',
      text: String(message.text ?? ''),
      messageId: message.messageId,
    })
  }

  /**
   * 适配器消息入口（W2）：白名单 → 消毒 → 限流 → 缓冲 → onAccepted，
   * 与事件路径 handle() 完全同款下游；ts 保留消息自身时间戳。
   */
  ingest(message: IngestibleMessage): boolean {
    if (!this.groups.has(message.chatId)) return false
    this._handled++
    return this.accept(message.chatId, {
      ts: message.ts,
      sender: message.sender,
      text: String(message.text ?? ''),
      messageId: message.messageId,
    })
  }

  /** 共用下游：消毒 → 限流 → 缓冲（调用方已过白名单并累计 _handled） */
  private accept(
    chatId: string,
    message: { ts: number; sender: string; text: string; messageId?: string },
  ): boolean {
    // 先消毒：原文 → JSON 数据字段（指令区永不出现原文）。
    const sanitized = sanitize(message.text)
    // 再限流：超限丢弃并计数。
    if (!this.bucket.take(chatId)) return false

    this.buffer.push(chatId, {
      ts: message.ts,
      sender: message.sender,
      text: sanitized.data,
      messageId: message.messageId,
    })
    this.stats.accepted.set(chatId, (this.stats.accepted.get(chatId) ?? 0) + 1)
    this.onAccepted(chatId)
    return true
  }

  /** 丢弃计数（限流） */
  dropped(chatId: string): number {
    return this.stats.dropped.get(chatId) ?? this.bucket.dropped(chatId)
  }

  /** 在宿主上下文注册监听；ctx.on 随插件 dispose 自动回收。 */
  attach(ctx: Context, eventName = 'im-connect/message'): void {
    const on = ctx.on as unknown as (name: string, listener: (event: ImConnectMessageEvent) => void) => unknown
    on(eventName, (event) => {
      try {
        this.handle(event)
      } catch (error) {
        ctx.logger?.('group-lurker').warn?.(`bus handle error: ${String(error)}`)
      }
    })
  }
}
