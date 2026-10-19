/**
 * regen-queue.ts：错号空报告补发队列。
 *
 * 场景：报告触发时刻若活跃账号 ∉ accountWhitelist → 照常生成空报告（empty 骨架）+ 压入
 * 本队列——「无消息」并非真的没消息，而是错误账号在线（其会话消息不在库中）。正确账号
 * 登录回去（消息同步入库）后 → 自动逐条补生成：窗口按条目 dateKey 的日报规则（前一日
 * 20:20 起），end = 再生成时刻（覆盖登录后同步进库的全部消息）→ 覆盖写报告 + report_meta
 * 同键覆盖 → 走正常 outbox+发送链路。
 *
 * 持久化：stateDir/regen-queue.json（跨重启）；同键 (chatId, dateKey, kind) 去重；
 * 上限 31 条（一个月），超限丢弃最旧并 warn。审计零正文（只记 id/dateKey/kind/result）。
 */
import type { Store } from './store.js'
import type { StoreLogger } from './store.js'

export const REGEN_QUEUE_REL = 'regen-queue.json'
/** 上限 31 条（一个月的日报量），超限丢弃最旧 */
export const REGEN_QUEUE_MAX = 31

export interface RegenEntry {
  dateKey: string
  kind: 'daily'
  chatId: string
  reason: 'wrong_account'
  queuedAt: number
}

export type RegenEnqueueResult = 'queued' | 'deduped' | 'evicted_oldest'

export class RegenQueue {
  private readonly max: number
  private entries: RegenEntry[] = []

  constructor(
    private readonly options: { store: Store; logger: StoreLogger; maxEntries?: number },
  ) {
    this.max = Math.max(1, options.maxEntries ?? REGEN_QUEUE_MAX)
    this.load()
  }

  private load(): void {
    try {
      const raw = this.options.store.readText(REGEN_QUEUE_REL)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(
          (e): e is RegenEntry =>
            typeof e === 'object' && e !== null &&
            typeof (e as RegenEntry).dateKey === 'string' &&
            typeof (e as RegenEntry).chatId === 'string' &&
            (e as RegenEntry).kind === 'daily',
        )
      }
    } catch (error) {
      this.options.logger.warn(`regen-queue: load failed (ignored): ${String(error).slice(0, 120)}`)
      this.entries = []
    }
  }

  private persist(): boolean {
    return this.options.store.writeText(REGEN_QUEUE_REL, `${JSON.stringify(this.entries, null, 2)}\n`)
  }

  list(): ReadonlyArray<RegenEntry> {
    return this.entries
  }

  has(chatId: string, dateKey: string, kind: 'daily' = 'daily'): boolean {
    return this.entries.some((e) => e.chatId === chatId && e.dateKey === dateKey && e.kind === kind)
  }

  /** 同键去重；超限丢弃最旧并 warn。返回入队结果 */
  enqueue(chatId: string, dateKey: string, now: number, kind: 'daily' = 'daily'): RegenEnqueueResult {
    if (this.has(chatId, dateKey, kind)) return 'deduped'
    this.entries.push({ chatId, dateKey, kind, reason: 'wrong_account', queuedAt: now })
    let result: RegenEnqueueResult = 'queued'
    while (this.entries.length > this.max) {
      const dropped = this.entries.shift()
      this.options.logger.warn(`regen-queue: 超上限（${this.max}）丢弃最旧补发条目 ${dropped?.chatId}/${dropped?.dateKey}`)
      result = 'evicted_oldest'
    }
    this.persist()
    return result
  }

  /** 移除一条（补生成完成/satisfied） */
  remove(chatId: string, dateKey: string, kind: 'daily' = 'daily'): void {
    this.entries = this.entries.filter((e) => !(e.chatId === chatId && e.dateKey === dateKey && e.kind === kind))
    this.persist()
  }
}
