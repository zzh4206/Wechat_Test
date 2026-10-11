/**
 * buffer.ts：每群独立环形缓冲（内存，不落盘——原始消息永不持久化，PRD F4）。
 *
 * - 容量 Config.bufferSize，满后淘汰最旧；
 * - 内存上限保护：总条目数超过 bufferSize × 20 时，
 *   从「最久未活跃」的群开始淘汰其最旧条目（刷屏 DoS 防护，TECH-DESIGN §3）；
 * - 存储的 text 是已 sanitize 的 JSON 数据字段（见 guard.ts）。
 */

/** 一条缓冲消息（text 已是 JSON.stringify 后的数据字段） */
export interface BufferedMessage {
  ts: number
  sender: string
  /** 已 sanitize：JSON 字符串化的原文 */
  text: string
  messageId?: string
}

/** 单群环形缓冲：定长数组 + 写指针，满则覆盖最旧 */
export class RingBuffer {
  private readonly items: (BufferedMessage | undefined)[]
  private head = 0 // 下一个写入位置
  private _size = 0
  private _lastActive = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`invalid capacity: ${capacity}`)
    this.items = new Array(capacity)
  }

  get size(): number {
    return this._size
  }

  get lastActive(): number {
    return this._lastActive
  }

  push(msg: BufferedMessage): void {
    this.items[this.head] = msg
    this.head = (this.head + 1) % this.capacity
    if (this._size < this.capacity) this._size++
    this._lastActive = msg.ts
  }

  /** 时间序快照（旧 → 新）。起点永远是逻辑最旧槽位 (head - size)，与淘汰/回绕无关 */
  snapshot(): BufferedMessage[] {
    const out: BufferedMessage[] = []
    const start = (this.head - this._size + this.capacity) % this.capacity
    for (let i = 0; i < this._size; i++) {
      const item = this.items[(start + i) % this.capacity]
      if (item) out.push(item)
    }
    return out
  }

  /** 淘汰最旧 n 条（内存上限保护用） */
  evictOldest(n: number): number {
    let removed = 0
    while (removed < n && this._size > 0) {
      const oldestIndex = (this.head - this._size + this.capacity * 2) % this.capacity
      this.items[oldestIndex] = undefined
      this._size--
      removed++
    }
    return removed
  }

  clear(): void {
    this.items.fill(undefined)
    this.head = 0
    this._size = 0
  }
}

export interface BufferPoolOptions {
  /** 每群容量（Config.bufferSize） */
  bufferSize: number
  /** 总条目上限倍数（默认 20） */
  maxTotalMultiplier?: number
  now?: () => number
}

/** 群 → 环形缓冲的管理器，负责总量上限与 LRU 群淘汰 */
export class BufferPool {
  private readonly pools = new Map<string, RingBuffer>()
  private readonly bufferSize: number
  private readonly maxTotal: number
  private readonly now: () => number
  /** 累计因内存上限被淘汰的条数 */
  private _evictedTotal = 0

  constructor(options: BufferPoolOptions) {
    this.bufferSize = options.bufferSize
    this.maxTotal = this.bufferSize * (options.maxTotalMultiplier ?? 20)
    this.now = options.now ?? (() => Date.now())
  }

  /** 取（或建）某群的缓冲 */
  of(chatId: string): RingBuffer {
    let buf = this.pools.get(chatId)
    if (!buf) {
      buf = new RingBuffer(this.bufferSize)
      this.pools.set(chatId, buf)
    }
    return buf
  }

  push(chatId: string, msg: BufferedMessage): void {
    this.of(chatId).push(msg)
    this.enforceMemoryCap()
  }

  snapshot(chatId: string): BufferedMessage[] {
    return this.pools.get(chatId)?.snapshot() ?? []
  }

  /** 某群当前水位 */
  size(chatId: string): number {
    return this.pools.get(chatId)?.size ?? 0
  }

  /** 群数量 */
  get groupCount(): number {
    return this.pools.size
  }

  /** 总条目数 */
  get total(): number {
    let n = 0
    for (const buf of this.pools.values()) n += buf.size
    return n
  }

  get evictedTotal(): number {
    return this._evictedTotal
  }

  /**
   * 内存上限保护：总条目超 (bufferSize × 20) 时，
   * 反复淘汰「最久未活跃」群的最旧条目，直到回到上限内。
   */
  private enforceMemoryCap(): void {
    while (this.total > this.maxTotal) {
      // 找最久未活跃的非空群
      let victim: RingBuffer | undefined
      for (const buf of this.pools.values()) {
        if (buf.size === 0) continue
        if (!victim || buf.lastActive < victim.lastActive) {
          victim = buf
        }
      }
      if (!victim) break
      const removed = victim.evictOldest(Math.max(1, Math.floor(this.bufferSize / 4)))
      if (removed === 0) break
      this._evictedTotal += removed
    }
    // 顺带清理空群，避免 Map 无限增长
    for (const [chatId, buf] of this.pools) {
      if (buf.size === 0 && buf.lastActive === 0) this.pools.delete(chatId)
    }
  }

  /** dispose 清理 */
  clear(): void {
    this.pools.clear()
  }
}
