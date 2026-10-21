/**
 * regen-queue.ts：错号空报告补发队列（FIFO，两段式——见 index.ts 接线注释）。
 *
 * 场景：报告触发时刻活跃账号 ∉ accountWhitelist → 空骨架报告仅落盘存档 + 本队列压入
 * pending_regen 条目（**绝不进发送链路**）。正号（白名单账号）回归后 → 每轮从队首 pop
 * 一个元素重生成（end=处理时刻，覆盖已同步消息）：
 * - 有内容 → 报告落盘 + outbox 条目（进发送队列）→ 条目 done 出队；
 * - 空 → 重试 ≤2 次（共 3 次生成尝试，regenAttempts 跨重启保留）；3 次全空 → 如实定稿：
 *   空报告照常落盘 + outbox 正常创建发送（此时已确认账号在线且确实无消息）→ empty_confirmed；
 * - 环境类失败 → 放回队首，不消耗重试次数，下轮再处理（与熄屏 deferred 同语义）。
 *
 * 持久化：stateDir/regen-queue.json（跨重启）；同键 (chatId, dateKey, kind) 去重；
 * 上限 31 条，超限丢弃最旧并 warn。审计零正文（调用方只记元数据）。
 *
 * 两种来源分开消费（regen-processor.ts）：
 * - reason='wrong_account'（错号补发）：日报调度 tick 内、账号闸放行时按 FIFO 处理，生成后进发送链路；
 * - reason='manual'（对话框/前端「重新生成」）：独立轮询处理，只重新生成、**不进 outbox**——
 *   要推送须另走「排入发件箱」（单一发送入口）。
 */
import type { Store } from './store.js'
import type { StoreLogger } from './store.js'

export const REGEN_QUEUE_REL = 'regen-queue.json'
/** 上限 31 条（一个月的日报量），超限丢弃最旧 */
export const REGEN_QUEUE_MAX = 31

export type RegenKind = 'daily' | 'weekly' | 'monthly'
export type RegenReason = 'wrong_account' | 'manual'

export interface RegenEntry {
  dateKey: string
  kind: RegenKind
  chatId: string
  reason: RegenReason
  queuedAt: number
  /** 生命周期：pending_regen → done（出队）；empty_confirmed 终态（出队） */
  status: 'pending_regen'
  /** FIFO pop 元素的重试计数（空产出 ≤2 次重试；跨重启保留） */
  regenAttempts?: number
}

export type RegenEnqueueResult = 'queued' | 'deduped' | 'evicted_oldest'

export class RegenQueue {
  private readonly max: number
  private entries: RegenEntry[] = []

  constructor(private readonly options: { store: Store; logger: StoreLogger; maxEntries?: number }) {
    this.max = Math.max(1, options.maxEntries ?? REGEN_QUEUE_MAX)
    this.load()
  }

  private load(): void {
    try {
      const raw = this.options.store.readText(REGEN_QUEUE_REL)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        // kind 三选一须整体加括号：原写法 `a && b && kind==='daily' || kind==='weekly' || …` 会放行
        // 缺 dateKey/chatId 的 weekly/monthly 坏行
        this.entries = parsed.filter(
          (e): e is RegenEntry =>
            typeof e === 'object' && e !== null &&
            typeof (e as RegenEntry).dateKey === 'string' &&
            typeof (e as RegenEntry).chatId === 'string' &&
            ((e as RegenEntry).kind === 'daily' || (e as RegenEntry).kind === 'weekly' || (e as RegenEntry).kind === 'monthly'),
        )
        for (const e of this.entries) {
          if (e.status === undefined) e.status = 'pending_regen'
          // 旧版条目无 reason：当时只有错号补发一种来源
          if (e.reason !== 'manual') e.reason = 'wrong_account'
        }
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

  has(chatId: string, dateKey: string, kind: RegenKind = 'daily'): boolean {
    return this.entries.some((e) => e.chatId === chatId && e.dateKey === dateKey && e.kind === kind)
  }

  /** 同键去重；超限丢弃最旧并 warn */
  enqueue(chatId: string, dateKey: string, now: number, kind: RegenKind = 'daily', reason: RegenReason = 'wrong_account'): RegenEnqueueResult {
    if (this.has(chatId, dateKey, kind)) return 'deduped'
    this.entries.push({ chatId, dateKey, kind, reason, queuedAt: now, status: 'pending_regen', regenAttempts: 0 })
    let result: RegenEnqueueResult = 'queued'
    while (this.entries.length > this.max) {
      const dropped = this.entries.shift()
      this.options.logger.warn(`regen-queue: 超上限（${this.max}）丢弃最旧补发条目 ${dropped?.chatId}/${dropped?.dateKey}`)
      result = 'evicted_oldest'
    }
    this.persist()
    return result
  }


  /** FIFO 队首（不改队列）；空 → null */
  peek(): RegenEntry | null {
    return this.entries[0] ?? null
  }

  /** 某来源的最早一条（不改队列）；两种来源各自 FIFO、互不阻塞 */
  firstOf(reason: RegenReason): RegenEntry | null {
    return this.entries.find((e) => e.reason === reason) ?? null
  }

  /** 移除指定条目（按 chatId + dateKey + kind 定位）；返回是否移除 */
  remove(entry: Pick<RegenEntry, 'chatId' | 'dateKey' | 'kind'>): boolean {
    const i = this.entries.findIndex((e) => e.chatId === entry.chatId && e.dateKey === entry.dateKey && e.kind === entry.kind)
    if (i === -1) return false
    this.entries.splice(i, 1)
    this.persist()
    return true
  }

  /** 记录空产出重试计数（跨重启保留） */
  setRegenAttempts(chatId: string, dateKey: string, n: number, kind: RegenKind = 'daily'): void {
    const e = this.entries.find((x) => x.chatId === chatId && x.dateKey === dateKey && x.kind === kind)
    if (!e) return
    e.regenAttempts = n
    this.persist()
  }

  /** FIFO 出队（队首 pop） */
  pop(): RegenEntry | null {
    const e = this.entries.shift() ?? null
    this.persist()
    return e
  }

  /** 移除指定条目（环境失败放回队首时用：unshift 保位） */
  unshift(entry: RegenEntry): void {
    this.entries.unshift(entry)
    this.persist()
  }
}
