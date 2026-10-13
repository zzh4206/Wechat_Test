/**
 * scheduler.ts：cron 式触达调度器（M1-T1.3）。
 *
 * 触达时点（PRD / 实施计划 §4-T1.3 默认值，均可配置覆盖）：
 * - daily   每日 20:30（日报）
 * - weekly  每周日 20:40（周报）
 * - monthly 每月 1 日 08:00（月报）
 *
 * 错峰（回答功能文档 §14.2）：默认按白名单顺序，每群错开 5 分钟——
 * kind 基准时点 base + 群序号 × staggerMinutes 即该群的实际触达时刻。
 *
 * 补跑（catchup）：触发点持久化到 <stateDir>/scheduler/state.json。
 * 重启后恢复：错过的时点若在 catchupWindow（默认 30 分钟，含错峰总时长）内
 * → 补跑并标注 catchup=true；超窗 → 放弃并 warn（不补做陈旧报告）。
 *
 * 时间与定时器全部可注入（now / setInterval / clearInterval），离线 mock 测试。
 * 只有一个心跳 interval；stop() 是唯一释放点——沿用 distiller.start() 约定：
 * start() 返回清理函数，由 index.ts 挂进 ctx.effect，dispose 无定时器残留。
 *
 * 本文件只做调度骨架 + 事件回调接口 onTick(kind, chatId, meta)；
 * 报告生成回调（onReport）为空实现占位，M3 接入。
 */
import type { Store } from './store.js'

/** 调度日志走宿主 logger（ctx.logger，含 info）；比 StoreLogger 多 info 一档 */
export interface SchedulerLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

export type TickKind = 'daily' | 'weekly' | 'monthly'
export const TICK_KINDS: readonly TickKind[] = ['daily', 'weekly', 'monthly']

export interface TickMeta {
  /** true = 重启后错过窗口内补跑（非实时到点） */
  catchup: boolean
  /** 该群本次触达的基准时点（kind 基准，未加错峰），毫秒时间戳 */
  scheduledAt: number
}

export type TickHandler = (kind: TickKind, chatId: string, meta: TickMeta) => void

export interface SchedulerOptions {
  /** 白名单群（错峰顺序 = 数组顺序） */
  groups: readonly string[]
  logger: SchedulerLogger
  /** 持久化经 store（唯一 fs 写入点）；缺省 = 不持久化（纯内存，测试用） */
  store?: Store
  /** 各 kind 的每日/每周/每月时点，"HH:MM"（本地时区） */
  dailyTime?: string
  weeklyTime?: string
  monthlyTime?: string
  /** 按群错峰间隔分钟（默认 5） */
  staggerMinutes?: number
  /** 重启补跑窗口分钟（默认 30） */
  catchupWindowMin?: number
  /** 触达回调（M3 前由 index.ts 接通知/日志；报告生成留空） */
  onTick?: TickHandler
  /** 时钟注入（测试 mock）；返回毫秒时间戳 */
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  /** 心跳毫秒（默认 30s；测试可调小） */
  tickMs?: number
}

interface KindState {
  /** 当前待触发 occurrence 的基准时点 */
  base: number
  /** 本 occurrence 内已触达/已放弃的群 */
  fired: Set<string>
  /** true = 从持久化恢复的错过时点（窗口内补跑），触达标注 catchup=true */
  missed: boolean
}

/** 解析 "HH:MM" 为 {h, m}；非法输入抛错（fail-fast，不静默回退） */
export function parseTimeOfDay(spec: string): { h: number; m: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(spec)
  if (!m) throw new Error(`invalid time-of-day "${spec}" (expected "HH:MM")`)
  return { h: Number(m[1]), m: Number(m[2]) }
}

function atTime(day: Date, h: number, m: number): Date {
  const d = new Date(day)
  d.setHours(h, m, 0, 0)
  return d
}

/**
 * 下一次 kind 时点（严格大于 after，本地时区）。
 * weekly = 周日；monthly = 每月 1 日。
 */
export function nextOccurrence(kind: TickKind, after: number, spec: string): number {
  const { h, m } = parseTimeOfDay(spec)
  const d = new Date(after)
  let candidate = atTime(d, h, m)
  if (kind === 'daily') {
    if (candidate.getTime() <= after) candidate = atTime(new Date(after + 86_400_000), h, m)
  } else if (kind === 'weekly') {
    while (candidate.getTime() <= after || candidate.getDay() !== 0) {
      candidate = atTime(new Date(candidate.getTime() + 86_400_000), h, m)
    }
  } else {
    // monthly：每月 1 日；当前月已过则下月 1 日
    while (candidate.getTime() <= after || candidate.getDate() !== 1) {
      candidate = atTime(new Date(d.getFullYear(), d.getMonth() + 1, 1, h, m, 0, 0), h, m)
    }
  }
  return candidate.getTime()
}

const STATE_REL = 'scheduler/state.json'

interface PersistedState {
  [kind: string]: { base: number; fired: string[] } | undefined
}

export class Scheduler {
  private readonly timeSpecs: Record<TickKind, string>
  private readonly staggerMs: number
  private readonly catchupMs: number
  private readonly now: () => number
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval
  private readonly tickMs: number
  private readonly onTickFn: TickHandler
  private readonly states = new Map<TickKind, KindState>()
  private timer: ReturnType<typeof setInterval> | undefined
  private _stopped = true

  constructor(private readonly options: SchedulerOptions) {
    this.timeSpecs = {
      daily: options.dailyTime ?? '20:30',
      weekly: options.weeklyTime ?? '20:40',
      monthly: options.monthlyTime ?? '08:00',
    }
    this.staggerMs = (options.staggerMinutes ?? 5) * 60_000
    this.catchupMs = (options.catchupWindowMin ?? 30) * 60_000
    this.now = options.now ?? (() => Date.now())
    this.setIntervalFn = options.setInterval ?? setInterval
    this.clearIntervalFn = options.clearInterval ?? clearInterval
    this.tickMs = options.tickMs ?? 30_000
    this.onTickFn = options.onTick ?? (() => {}) // 报告生成留空（M3 接）
  }

  /**
   * 启动心跳。返回清理函数（唯一释放点），由 index.ts 挂进 ctx.effect——
   * dispose 时 clearInterval，无定时器残留。
   */
  start(): () => void {
    if (this.timer) return () => this.stop()
    this.restore()
    this._stopped = false
    this.timer = this.setIntervalFn(() => this.tick(), this.tickMs)
    this.timer.unref?.()
    return () => this.stop()
  }

  /** 停止并清空全部内存状态（dispose 调用；唯一 interval 释放点） */
  stop(): void {
    this._stopped = true
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer)
      this.timer = undefined
    }
    this.states.clear()
  }

  /**
   * 心跳一步：推进每个 kind 的触发/补跑/放弃判定。
   * 公开以便测试用注入时钟手工驱动（生产由 start() 的心跳调用）。
   */
  tick(): void {
    if (this._stopped) return
    const t = this.now()
    for (const kind of TICK_KINDS) {
      this.advance(kind, t)
    }
  }

  /** 运行可见性：各 kind 当前基准时点（getStatus 用） */
  status(): Record<TickKind, number | null> {
    const out = {} as Record<TickKind, number | null>
    for (const kind of TICK_KINDS) out[kind] = this.states.get(kind)?.base ?? null
    return out
  }

  // —————————————————— 内部 ——————————————————

  /** 从持久化状态恢复；超窗 occurrence 直接放弃（不补做陈旧触达） */
  private restore(): void {
    const t = this.now()
    let persisted: PersistedState = {}
    const raw = this.options.store?.readText(STATE_REL)
    if (raw) {
      try {
        persisted = JSON.parse(raw) as PersistedState
      } catch {
        this.options.logger.warn(`scheduler: corrupt state file, starting fresh`)
      }
    }
    for (const kind of TICK_KINDS) {
      const saved = persisted[kind]
      if (saved && typeof saved.base === 'number') {
        const deadline = saved.base + this.totalStagger()
        if (t - deadline <= this.catchupMs) {
          // 窗口内：恢复 occurrence，剩余群补跑（catchup=true）
          this.states.set(kind, { base: saved.base, fired: new Set(saved.fired ?? []), missed: true })
          this.options.logger.info(`scheduler[${kind}]: restored occurrence base=${saved.base} (catchup window)`)
        } else {
          this.options.logger.warn(`scheduler[${kind}]: missed occurrence base=${saved.base} beyond catchup window, abandoned`)
          this.states.set(kind, { base: nextOccurrence(kind, saved.base, this.timeSpecs[kind]), fired: new Set(), missed: false })
        }
      } else {
        // 首次运行：只安排未来时点，绝不把历史时点当错过来补。
        // t-1：nextOccurrence 语义是"严格大于 after"，-1ms 让"启动时刻恰好是时点"也照常触发。
        this.states.set(kind, { base: nextOccurrence(kind, t - 1, this.timeSpecs[kind]), fired: new Set(), missed: false })
      }
    }
  }

  /** 错峰总时长（全部群错开完） */
  private totalStagger(): number {
    return Math.max(0, this.options.groups.length - 1) * this.staggerMs
  }

  /** 推进一个 kind：到点触达（含错峰逐群）、窗口内补跑、超窗放弃 */
  private advance(kind: TickKind, t: number): void {
    const st = this.states.get(kind)
    if (!st) return
    if (t < st.base) return

    // occurrence 整体超窗（连第一群都来不及补）→ 放弃整个时点
    if (t - (st.base + this.totalStagger()) > this.catchupMs && st.fired.size < this.options.groups.length) {
      this.options.logger.warn(
        `scheduler[${kind}]: occurrence base=${st.base} beyond catchup window, ${this.options.groups.length - st.fired.size} group(s) abandoned`,
      )
      this.finish(kind, st, t)
      return
    }

    for (const chatId of this.options.groups) {
      if (st.fired.has(chatId)) continue
      const idx = this.options.groups.indexOf(chatId)
      const deadline = st.base + idx * this.staggerMs
      if (t < deadline) continue // 还没轮到该群的错峰时刻
      try {
        this.onTickFn(kind, chatId, { catchup: st.missed, scheduledAt: st.base })
      } catch (error) {
        // 回调异常不拖垮调度循环
        this.options.logger.error(`scheduler[${kind}] onTick(${chatId}) failed: ${String(error)}`)
      }
      st.fired.add(chatId)
      this.persist() // 逐群落盘：部分触发后重启也能续上剩余群（catchup）
    }
    if (st.fired.size >= this.options.groups.length) this.finish(kind, st, t)
  }

  /** occurrence 完成：记基准、排下一次、持久化 */
  private finish(kind: TickKind, st: KindState, t: number): void {
    const next = nextOccurrence(kind, Math.max(st.base, t), this.timeSpecs[kind])
    st.base = next
    st.fired = new Set()
    st.missed = false
    this.persist()
  }

  /** 持久化当前各 kind 状态（写失败只记日志，不阻断调度） */
  private persist(): void {
    const store = this.options.store
    if (!store) return
    const out: PersistedState = {}
    for (const kind of TICK_KINDS) {
      const st = this.states.get(kind)
      if (st) out[kind] = { base: st.base, fired: [...st.fired] }
    }
    store.ensureDir('scheduler')
    store.writeText(STATE_REL, JSON.stringify(out))
  }
}
