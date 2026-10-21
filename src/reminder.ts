/**
 * reminder.ts（M4-T4.3 提醒计划器）。
 *
 * 时点表（功能文档 §6.3；Config 全默认保守）：
 * | 时点          | 系统通知 | outbox 详情 |
 * | 识别时        | ✅（识别端回调触发，不归本模块） | ✅ |
 * | 截止前 1 天    | ✅ | ✅ |
 * | 截止前 1 小时  | ✅ | ✅（Config.deadline1hRemind，默认关） |
 * | 逾期未完成    | ✅（标题加【逾期】升级样式） | ✅ |
 *
 * - 每日 07:50「今日待办速览」：合并当日到期任务一次性推送——notify 一条 +
 *   outbox 一条（合并正文，绝不逐任务多条）；同日只推一次（持久化去重，
 *   reminder_log(task_id=0, point='digest-<dateKey>')）；
 * - 到期计算基于 deadline + status='active'（未完成）；deadline=null 的任务按
 *   识别时刻 +3 天软提醒（功能文档 §6.1 默认时限），速览中标注「无明确 deadline」；
 * - 逾期自动标记：tasks.overdue_marked_at 记时刻（不删条目、不改状态）；
 * - 触发去重：每任务每时点只触发一次——reminder_log (task_id, point) 主键
 *   INSERT OR IGNORE，重启后不重复骚扰；
 * - 时间与定时器全部可注入（now / setInterval / clearInterval），离线 mock 测试；
 *   start() 返回清理函数（scheduler.ts / distiller.ts 同约定），dispose 无定时器残留；
 * - enabled=false（Config.reminderEnabled 默认 false）= 零活动：不启动心跳、零通知。
 *
 * 红线：不发消息（notify = 本机系统通知；outbox = 只落盘），零第三方依赖。
 */
import type { StoreLogger } from './store.js'
import type { Store } from './store.js'
import type { GroupStoreService, TaskRow } from './group-store.js'
import type { Outbox } from './outbox.js'
import type { SystemNotifier } from './notify.js'
import { randomUUID } from 'node:crypto'
import { localDayKey } from './person-digest.js'

/** 无明确 deadline 的默认软提醒时限（毫秒；功能文档 §6.1：默认 3 天） */
export const SOFT_DEADLINE_MS = 3 * 86_400_000

/** 通知 logger 口径（与 scheduler 一致，多 info 一档） */
export interface ReminderLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

export interface ReminderTaskView {
  taskId: number
  statement: string
  /** 有效截止（deadline ?? created_at + 3 天软时限）；null = created_at 缺失 */
  effectiveDeadline: number | null
  hasExplicitDeadline: boolean
  overdue: boolean
}

export interface ReminderOptions {
  groupStore: GroupStoreService
  notifier: Pick<SystemNotifier, 'notify'>
  outbox: Outbox
  logger: ReminderLogger
  /** 持久化（速览同日去重存 reminder/state.json）；缺省 = 纯内存去重（测试用） */
  store?: Store
  /** Config.reminderEnabled：false = 零活动 */
  enabled: boolean
  /** Config.deadline1hRemind：截止前 1 小时时点（默认关） */
  deadline1hRemind?: boolean
  /** 白名单群（扫描范围） */
  groups?: readonly string[]
  /** 每日速览时点 "HH:MM"（默认 07:50） */
  digestTime?: string
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  /** 心跳毫秒（默认 60s；测试可调小） */
  tickMs?: number
}

/** 解析 "HH:MM"（scheduler.parseTimeOfDay 同口径，本处独立实现避免跨模块依赖顺序） */
function parseHm(spec: string): { h: number; m: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(spec)
  if (!m) throw new Error(`reminder: invalid digestTime "${spec}"`)
  return { h: Number(m[1]), m: Number(m[2]) }
}

export class ReminderService {
  private readonly now: () => number
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval
  private readonly tickMs: number
  private readonly groups: readonly string[]
  private readonly digestHm: { h: number; m: number }
  private readonly oneHour: boolean
  private timer: ReturnType<typeof setInterval> | undefined
  private _stopped = true
  private lastDigestDay: string | null = null

  constructor(private readonly options: ReminderOptions) {
    this.now = options.now ?? (() => Date.now())
    this.setIntervalFn = options.setInterval ?? setInterval
    this.clearIntervalFn = options.clearInterval ?? clearInterval
    this.tickMs = options.tickMs ?? 60_000
    this.groups = options.groups ?? []
    this.digestHm = parseHm(options.digestTime ?? '07:50')
    this.oneHour = options.deadline1hRemind ?? false
  }

  /** 启动心跳。返回清理函数（唯一释放点），dispose 无定时器残留。 */
  start(): () => void {
    if (!this.options.enabled) {
      this.options.logger.info('reminder: disabled, zero-activity')
      return () => this.stop()
    }
    if (this.timer) return () => this.stop()
    this.restoreDigestDay()
    this._stopped = false
    this.timer = this.setIntervalFn(() => this.tick(), this.tickMs)
    this.timer.unref?.()
    return () => this.stop()
  }

  /** 停止并清空内存状态（dispose 调用；唯一 interval 释放点） */
  stop(): void {
    this._stopped = true
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer)
      this.timer = undefined
    }
    this.lastDigestDay = null // 内存态清空；重启由 restoreDigestDay 从 state.json 恢复
  }

  /**
   * 心跳一步：逐群做时点表触发 + 判断是否到每日速览时点。
   * 公开以便测试用注入时钟手工驱动（生产由 start() 的心跳调用）。
   */
  async tick(): Promise<void> {
    if (this._stopped) return
    const t = this.now()
    for (const chatId of this.groups) {
      await this.tickChat(chatId, t)
    }
    await this.maybeDigest(t)
  }

  /** 单群时点表触发。async 以串行 await 落库/落箱；单群异常不拖垮其它群。 */
  private async tickChat(chatId: string, t: number): Promise<void> {
    try {
      const tasks = this.options.groupStore.getTasks(chatId, { status: 'active', limit: 200 })
      for (const task of tasks) {
        const view = this.viewOf(task, t)
        if (view.effectiveDeadline === null) continue
        const dl = view.effectiveDeadline
        // 截止前 1 天（含软时限；进入 [dl-1d, dl) 区间即触发一次）
        if (t >= dl - 86_400_000 && t < dl) {
          await this.fire(chatId, task, 'due-1d', t, `【提醒】明天截止：${task.statement}`, '任务将于 24 小时内到期')
        }
        // 截止前 1 小时（Config 默认关）
        if (this.oneHour && t >= dl - 3_600_000 && t < dl) {
          await this.fire(chatId, task, 'due-1h', t, `【提醒】1 小时内截止：${task.statement}`, '任务将于 1 小时内到期')
        }
        // 逾期未完成：自动标记 + 升级样式（只触发一次；条目不删）
        if (t >= dl) {
          await this.options.groupStore.markTaskOverdue(chatId, task.taskId, t) // 幂等：只首次生效
          await this.fire(chatId, task, 'overdue', t, `【逾期】任务未完成：${task.statement}`, '任务已逾期，请处理或手动关闭')
        }
      }
    } catch (error) {
      this.options.logger.error(`reminder[${chatId}] tick failed: ${String(error)}`)
    }
  }

  /** 每日 07:50 速览：当日首次心跳越过时点后合并推送一次（同日只推一次） */
  private async maybeDigest(t: number): Promise<void> {
    const d = new Date(t)
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), this.digestHm.h, this.digestHm.m, 0, 0).getTime()
    if (t < at) return
    const day = localDayKey(t)
    if (this.lastDigestDay === day) return
    this.lastDigestDay = day
    this.persistDigestDay(day)
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const dayEnd = dayStart + 86_400_000
    const lines: string[] = []
    let count = 0
    for (const chatId of this.groups) {
      const active = this.options.groupStore.getTasks(chatId, { status: 'active', limit: 200 })
      const pending = this.options.groupStore.getTasks(chatId, { status: 'pending_confirm', limit: 100 })
      for (const task of active) {
        const view = this.viewOf(task, t)
        const dueToday = view.effectiveDeadline !== null && view.effectiveDeadline < dayEnd
        const overdue = view.overdue
        if (!dueToday && !overdue) continue
        const dlText = view.effectiveDeadline === null
          ? '无明确 deadline'
          : new Date(view.effectiveDeadline).toLocaleString('zh-CN', { hour12: false })
        lines.push(`- ${overdue ? '【逾期】' : ''}${task.statement}（截止 ${dlText}${view.hasExplicitDeadline ? '' : '，软提醒'} · 群 ${chatId}）`)
        count++
      }
      for (const task of pending) {
        lines.push(`- （待确认）${task.statement} · 群 ${chatId}`)
        count++
      }
    }
    const title = count > 0 ? `今日待办速览（${count} 项）` : '今日待办速览（无）'
    const body = count > 0 ? lines.join('\n') : '今天没有到期任务，也没有待确认项。'
    await this.options.notifier.notify('digest', title, '今日待办速览已生成，详情见存档')
    // W-11：evidence_ref 指向本条 outbox 条目自身（详情就在 body；不再指向从未写入的 reminder/digest/<day>.txt）
    const digestId = randomUUID()
    this.options.outbox.appendOutbox({ kind: 'digest', title, body, evidence_ref: `outbox/${digestId}`, id: digestId })
    this.options.logger.info(`reminder: digest ${day} pushed (${count} items)`)
  }

  /** 速览去重状态持久化（写失败只记日志，不阻断；重启后同日不重复推） */
  private persistDigestDay(day: string): void {
    const store = this.options.store
    if (!store) return
    store.ensureDir('reminder')
    store.writeText('reminder/state.json', JSON.stringify({ lastDigestDay: day }))
  }

  private restoreDigestDay(): void {
    const store = this.options.store
    if (!store) return
    try {
      const raw = store.readText('reminder/state.json')
      if (!raw) return
      const v = JSON.parse(raw) as { lastDigestDay?: string }
      if (typeof v.lastDigestDay === 'string') this.lastDigestDay = v.lastDigestDay
    } catch {
      /* 损坏状态文件：按未推处理 */
    }
  }

  /** 单任务单时点触发：去重登记 + notify 短句（不含正文）+ outbox 落详情 */
  private async fire(chatId: string, task: TaskRow, point: string, t: number, title: string, outline: string): Promise<void> {
    const first = await this.options.groupStore.appendReminderLog(chatId, task.taskId, point, t)
    if (!first) return
    await this.options.notifier.notify(`remind:${point}`, title, outline)
    this.options.outbox.appendOutbox({
      kind: `remind:${point}`,
      title,
      body: [
        `任务：${task.statement}`,
        `群：${chatId}`,
        `指派：${task.assignerPid ?? '（未知）'}`,
        task.deadline === null ? 'deadline：无明确 deadline（软提醒）' : `deadline：${new Date(task.deadline).toLocaleString('zh-CN', { hour12: false })}`,
        `证据：${task.evidenceMsgId ?? ''}`,
      ].join('\n'),
      evidence_ref: task.evidenceMsgId ?? `task:${task.taskId}`,
    })
    this.options.logger.info(`reminder[${chatId}]: fired ${point} for task#${task.taskId}`)
  }

  /** 任务 → 视图（有效截止/逾期判定；deadline=null 时软时限 = created_at + 3 天） */
  viewOf(task: TaskRow, t: number): ReminderTaskView {
    const hasExplicit = task.deadline !== null
    const effective = hasExplicit
      ? (task.deadline as number)
      : task.createdAt > 0
        ? task.createdAt + SOFT_DEADLINE_MS
        : null
    return {
      taskId: task.taskId,
      statement: task.statement,
      effectiveDeadline: effective,
      hasExplicitDeadline: hasExplicit,
      overdue: hasExplicit ? (task.deadline as number) <= t : task.overdueMarkedAt > 0,
    }
  }
}
