/**
 * cursor.ts（W4）：持久化增量游标。
 *
 * 问题：server_id 是字符串且不保证数值单调（不同消息库分片），不能只存"最大 id"。
 * 方案：每群维护"已读 id 集合的尾部窗口"——
 *   { chatId: { recent: string[]（按读取顺序追加，最多 WINDOW=500，超窗裁最旧）, total: number } }
 * readOnce 去重先查 recent（内存 Set 加速）；未命中视为新消息，读取成功后追加进 recent。
 *
 * 持久化：
 * - 文件 <stateDir>/cursor.json，经 store（项目唯一 fs 写入点，自动过 assertInsideState 围栏）；
 * - 每轮 pollOnce 结束后一次写盘（不是每条消息写盘）；
 * - 写失败 logger.warn 不中断（下次轮询再写）；
 * - 恢复：构造/启动时 load()；文件损坏（JSON 解析失败）→ 空游标降级 + warn，不抛错。
 *   注意：损坏/首次启动时无游标可用，首轮会重投最近 readLimit 条历史消息——可接受的降级，
 *   代价有限（readLimit 上限），且下游 buffer/distiller 幂等消化。
 *
 * backfillOnStart（默认 0，受监管原则——默认不回灌）：
 * - >0 时 load() 会把每群 recent 的"最新 N 个 id"移出游标，使首轮可回灌最多 N 条最近历史
 *   （仍受 readLimit 约束：read 返回窗口内的最新条数）。
 */
import type { Store } from '../store.js'

export interface GroupCursorLogger {
  warn(message: string): unknown
}

export interface GroupCursorOptions {
  store: Store
  logger: GroupCursorLogger
  /** 尾部窗口大小（默认 500） */
  window?: number
  /** 启动回灌条数（默认 0 = 不回灌） */
  backfillOnStart?: number
}

/** 每群 recent 窗口的磁盘/内存形态 */
interface GroupEntry {
  recent: string[]
  total: number
}

/** 内存态：recent 数组 + 同步 Set（O(1) 查询） */
interface GroupState {
  recent: string[]
  set: Set<string>
  total: number
  dirty: boolean
}

export const DEFAULT_CURSOR_WINDOW = 500
const CURSOR_FILE = 'cursor.json'

export class GroupCursor {
  private readonly store: Store
  private readonly logger: GroupCursorLogger
  private readonly window: number
  private readonly backfillOnStart: number
  private readonly groups = new Map<string, GroupState>()

  constructor(options: GroupCursorOptions) {
    this.store = options.store
    this.logger = options.logger
    this.window = options.window ?? DEFAULT_CURSOR_WINDOW
    this.backfillOnStart = options.backfillOnStart ?? 0
  }

  /**
   * 从 <stateDir>/cursor.json 恢复。文件不存在 → 空游标（正常首启）；
   * JSON 解析失败/结构异常 → 空游标降级 + warn（首轮会重投最近 readLimit 条，可接受）。
   */
  load(): void {
    const raw = this.store.readText(CURSOR_FILE)
    if (raw === null) return // 首次启动：无游标文件
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.logger.warn(
        `group-cursor: ${CURSOR_FILE} corrupt (${String(error)}) — starting empty (首轮会重投最近 readLimit 条，属可接受降级)`,
      )
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.logger.warn(`group-cursor: ${CURSOR_FILE} has unexpected shape — starting empty`)
      return
    }
    for (const [chatId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        !Array.isArray((entry as { recent?: unknown }).recent) ||
        typeof (entry as { total?: unknown }).total !== 'number'
      ) {
        continue // 单群条目异常：跳过该群（降级为空），不影响其他群
      }
      const recent = (entry as { recent: unknown[] }).recent.filter(
        (id): id is string => typeof id === 'string',
      )
      const state = this.stateOf(chatId, recent)
      state.total = (entry as { total: number }).total
    }
    // 回灌：>0 时移出每群最新 N 个 id，使这些消息首轮可重新进入管线（受 readLimit 约束）
    if (this.backfillOnStart > 0) {
      for (const [chatId, state] of this.groups) {
        const drop = Math.min(this.backfillOnStart, state.recent.length)
        if (drop <= 0) continue
        const keep = state.recent.slice(0, state.recent.length - drop)
        this.groups.set(chatId, this.stateOf(chatId, keep))
      }
    }
  }

  /** 该 id 是否已读（窗口内） */
  has(chatId: string, id: string): boolean {
    return this.groups.get(chatId)?.set.has(id) ?? false
  }

  /** 记录一个已读 id（读取成功路径调用；超窗裁最旧） */
  add(chatId: string, id: string): void {
    const state = this.groups.get(chatId) ?? this.stateOf(chatId, [])
    if (state.set.has(id)) return
    state.recent.push(id)
    state.set.add(id)
    state.total += 1
    state.dirty = true
    while (state.recent.length > this.window) {
      const evicted = state.recent.shift()
      if (evicted !== undefined) state.set.delete(evicted)
    }
  }

  /** 当前窗口内条数（测试可见性） */
  recentCount(chatId: string): number {
    return this.groups.get(chatId)?.recent.length ?? 0
  }

  /** 是否有未落盘变更（测试可见性） */
  isDirty(): boolean {
    for (const state of this.groups.values()) if (state.dirty) return true
    return false
  }

  /** 持久化到 cursor.json（每轮 pollOnce 一次）；写失败 warn 不中断 */
  persist(): void {
    const out: Record<string, GroupEntry> = {}
    for (const [chatId, state] of this.groups) {
      out[chatId] = { recent: state.recent, total: state.total }
    }
    const ok = this.store.writeText(CURSOR_FILE, `${JSON.stringify(out)}\n`)
    if (!ok) {
      // store.writeText 已 warn；这里补一条语义说明，下次 pollOnce 会重写
      this.logger.warn('group-cursor: persist failed — will retry on next poll')
      return
    }
    for (const state of this.groups.values()) state.dirty = false
  }

  private stateOf(chatId: string, recent: string[]): GroupState {
    const state: GroupState = {
      recent,
      set: new Set(recent),
      total: recent.length,
      dirty: false,
    }
    this.groups.set(chatId, state)
    return state
  }
}
