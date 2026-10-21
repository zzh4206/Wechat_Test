/**
 * action-inbox.ts：前端动作收件箱消费（confirm-loop 设计 §2.2，前端设计 §4.3 行格式）。
 *
 * 数据流：前端进程唯一写入 <stateDir>/web/actions.jsonl → 本消费器只读该文件，
 * 经水位 web/actions.offset（Store.writeText，跨重启续读）逐行处理：
 *   校验（R2: chatId ∈ groups / type 白名单 / targetId 正整数 / actionId 幂等）
 *   → 调 ApprovalActions / MarkActions（单入口，双通道同源）
 *   → web/action-results.jsonl（{actionId, ok, code, ts}，不含语句原文）
 *   → audit/web-actions.jsonl（只记元数据）。
 *
 * 总闸 Config.webActionsEnabled（默认 false，关闭不消费）；轮询 Config.webActionsPollSec（默认 5s）。
 */
import type { Store } from './store.js'
import type { StoreLogger } from './store.js'
import type { ApprovalActions, ReportKind } from './approval-actions.js'

export const ACTIONS_REL = 'web/actions.jsonl'
export const ACTIONS_OFFSET_REL = 'web/actions.offset'
export const ACTION_RESULTS_REL = 'web/action-results.jsonl'
export const WEB_ACTIONS_AUDIT_REL = 'audit/web-actions.jsonl'

/** 动作白名单（前端设计 §5 + 审批标记设计 §5 增补） */
export const ACTION_TYPES = [
  'task.confirm', 'task.cancel', 'task.complete', 'task.set_deadline', 'task.rewrite', 'task.postpone',
  'event.confirm',
  'promise.confirm', 'promise.cancel', 'promise.fulfilled', 'promise.close',
  'person.follow', 'person.unfollow',
  'report.regen',
  'task.mark', 'promise.mark',
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

/** 前端动作行（§4.3）：actionId 幂等键；targetId 正整数（person/report 用 params 携带） */
export interface ActionLine {
  actionId: string
  ts: number
  chatId: string
  type: string
  targetId: number
  params?: Record<string, unknown>
}

export interface ActionInboxDeps {
  store: Store
  actions: ApprovalActions
  /** 标记动作（阶段四 MarkActions；未注入 = task.mark/promise.mark 拒绝 unsupported） */
  marks?: { markTarget: (chatId: string, kind: 'task' | 'promise', targetId: number, status: 'completed' | 'incomplete' | 'deleted', source: 'chat' | 'web') => Promise<boolean> }
  /** 白名单群（R2：chatId ∈ groups，白名单外拒绝） */
  groups: readonly string[]
  /** W-8 stale 细分用：目标存在性解析（缺省 = 一律 status_conflict） */
  resolveTarget?: (chatId: string, targetKind: 'task' | 'promise', targetId: number) => { createdAt: number } | null
  /** W-1：操作者标识（web token 哈希前缀；审计元数据） */
  operator?: string
  logger: StoreLogger
  pollSec?: number
  now?: () => number
}

export type ActionCode =
  | 'ok' | 'duplicate'
  | 'not_found' | 'status_conflict' // W-8：stale 细分
  | 'chat_not_allowed' | 'type_not_allowed' // W-8：forbidden 细分
  | 'unsupported' | 'bad_request' | 'error'

export interface ActionOutcome {
  actionId: string
  ok: boolean
  code: ActionCode
  /** 失败原因（bad_request 时细化：kind_not_allowed/date_format/not_monday/not_month_start/…） */
  reason?: string
}

/** 解析一行（坏行返回 null——跳过并计数，不中断水位） */
export function parseActionLine(line: string): ActionLine | null {
  try {
    const v = JSON.parse(line) as Record<string, unknown>
    if (typeof v.actionId !== 'string' || v.actionId === '') return null
    if (typeof v.chatId !== 'string' || v.chatId === '') return null
    if (typeof v.type !== 'string' || v.type === '') return null
    return {
      actionId: v.actionId,
      ts: typeof v.ts === 'number' ? v.ts : 0,
      chatId: v.chatId,
      type: v.type,
      targetId: typeof v.targetId === 'number' ? v.targetId : NaN,
      params: (typeof v.params === 'object' && v.params !== null ? v.params : undefined) as Record<string, unknown> | undefined,
    }
  } catch {
    return null
  }
}

/** W-7：report.regen params 校验（kind 枚举 + dateKey GLOB + 按-kind 有效性）。非法返回原因 */
export function validateRegenParams(params: Record<string, unknown> | undefined): string | null {
  const kind = params?.kind
  const dateKey = params?.dateKey
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'monthly') return 'kind_not_allowed'
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return 'date_format'
  const d = new Date(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)))
  if (Number.isNaN(d.getTime()) || p(d) !== dateKey) return 'date_format'
  if (kind === 'weekly' && (d.getDay() + 6) % 7 !== 0) return 'not_monday'
  if (kind === 'monthly' && d.getDate() !== 1) return 'not_month_start'
  return null
  function p(x: Date): string {
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  }
}

/** W-8：stale 细分——目标不存在 → not_found；存在但状态不符 → status_conflict */
function staleOf(deps: Pick<ActionInboxDeps, 'resolveTarget'>, a: ActionLine): { code: ActionOutcome['code']; reason?: string } {
  const t = deps.resolveTarget?.(a.chatId, a.type === 'promise.mark' || a.type.startsWith('promise.') ? 'promise' : 'task', a.targetId)
  if (!t) return { code: 'not_found' }
  return { code: 'status_conflict' }
}

/** 前端动作 → ApprovalActions / MarkActions 单入口分发。返回 code（stale = 服务返回 false） */
export async function dispatchAction(
  deps: Pick<ActionInboxDeps, 'actions' | 'marks' | 'resolveTarget'>,
  a: ActionLine,
): Promise<{ code: ActionOutcome['code']; reason?: string }> {
  const A = deps.actions
  const id = a.targetId
  switch (a.type) {
    case 'task.confirm': return (await A.taskConfirm(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'task.cancel': return (await A.taskCancel(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'task.complete': return (await A.taskComplete(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'task.set_deadline': {
      const dl = a.params?.deadline
      if (typeof dl !== 'number' || !Number.isFinite(dl)) return { code: 'bad_request', reason: 'deadline_required' }
      return (await A.taskSetDeadline(a.chatId, id, dl)) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'task.postpone': {
      const dl = a.params?.deadline
      if (typeof dl !== 'number' || !Number.isFinite(dl)) return { code: 'bad_request', reason: 'deadline_required' }
      return (await A.taskPostpone(a.chatId, id, dl)) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'task.rewrite': {
      const text = a.params?.text
      if (typeof text !== 'string' || text.trim() === '') return { code: 'bad_request', reason: 'text_required' }
      return (await A.taskRewrite(a.chatId, id, text)) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'event.confirm': return (await A.eventConfirm(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.confirm': return (await A.promiseConfirm(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.cancel': return (await A.promiseCancel(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.fulfilled': return (await A.promiseFulfilled(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.close': return (await A.promiseClose(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'person.follow': {
      const pid = a.params?.pid
      if (typeof pid !== 'string' || pid === '') return { code: 'bad_request', reason: 'pid_required' }
      return (await A.personFollow(a.chatId, pid)) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'person.unfollow': {
      const pid = a.params?.pid
      if (typeof pid !== 'string' || pid === '') return { code: 'bad_request', reason: 'pid_required' }
      return (await A.personUnfollow(a.chatId, pid)) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'report.regen': {
      const dateKey = a.params?.dateKey
      const kind = (a.params?.kind ?? 'daily') as ReportKind
      if (typeof dateKey !== 'string' || dateKey === '') return { code: 'bad_request', reason: 'dateKey_required' }
      return (await A.reportRegen(a.chatId, dateKey, kind)) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'task.mark':
    case 'promise.mark': {
      if (!deps.marks) return { code: 'unsupported' }
      const status = a.params?.status
      if (status !== 'completed' && status !== 'incomplete' && status !== 'deleted') return { code: 'bad_request', reason: 'status_required' }
      const kind = a.type === 'task.mark' ? 'task' : 'promise'
      return (await deps.marks.markTarget(a.chatId, kind, id, status, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    }
    default:
      return { code: 'unsupported' }
  }
}

/** ActionInbox：轮询消费（start/dispose 挂接线层生命周期；dispose 无残留） */
export class ActionInbox {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly pollMs: number
  private readonly seen = new Set<string>() // actionId 幂等（运行时；结果文件是持久幂等源）
  private readonly now: () => number

  constructor(private readonly deps: ActionInboxDeps) {
    this.pollMs = Math.max(1, Math.floor((deps.pollSec ?? 5) * 1000))
    this.now = deps.now ?? (() => Date.now())
    this.loadOffsetSeen()
  }

  /** 水位 = 已处理行数（按行计）；seen 载入本会话处理过的 actionId（防同文件重放） */
  private loadOffsetSeen(): void {
    const offRaw = this.deps.store.readText(ACTIONS_OFFSET_REL)
    const offset = offRaw ? Number(offRaw.trim()) || 0 : 0
    this.offset = Number.isFinite(offset) && offset >= 0 ? offset : 0
    const raw = this.deps.store.readText(ACTIONS_REL)
    if (!raw) return
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    for (let i = 0; i < Math.min(this.offset, lines.length); i++) {
      const a = parseActionLine(lines[i])
      if (a) this.seen.add(a.actionId)
    }
  }

  private offset = 0
  private lastError: string | null = null

  /** 单轮消费：读 actions.jsonl，从水位行起逐行处理。返回处理条数 */
  async poll(): Promise<number> {
    const raw = this.deps.store.readText(ACTIONS_REL)
    if (!raw) return 0
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    let processed = 0
    while (this.offset < lines.length) {
      const line = lines[this.offset]
      this.offset += 1 // 无论成败都推进水位（坏行跳过不卡队列；结果文件承载失败）
      const a = parseActionLine(line)
      if (!a) {
        this.writeResult('bad-line', false, 'bad_request')
        continue
      }
      if (this.seen.has(a.actionId)) continue // 幂等：重复 actionId 跳过（不重复执行）
      this.seen.add(a.actionId)
      const outcome = await this.process(a)
      this.writeResult(a.actionId, outcome.ok, outcome.code)
      this.audit(a, outcome)
      if (!outcome.ok) this.lastError = `${a.actionId}:${outcome.code}`
      processed += 1
    }
    this.deps.store.writeText(ACTIONS_OFFSET_REL, `${this.offset}\n`)
    return processed
  }

  private async process(a: ActionLine): Promise<ActionOutcome> {
    if (!ACTION_TYPES.includes(a.type as ActionType)) {
      return { actionId: a.actionId, ok: false, code: 'type_not_allowed' }
    }
    if (!this.deps.groups.includes(a.chatId)) {
      return { actionId: a.actionId, ok: false, code: 'chat_not_allowed' }
    }
    if (a.type !== 'person.follow' && a.type !== 'person.unfollow' && a.type !== 'report.regen') {
      if (!Number.isInteger(a.targetId) || a.targetId <= 0) {
        return { actionId: a.actionId, ok: false, code: 'bad_request', reason: 'targetId_required' }
      }
    }
    // W-7：report.regen 入队前校验（kind/dateKey 按-kind 有效性）——队列零污染
    if (a.type === 'report.regen') {
      const bad = validateRegenParams(a.params)
      if (bad) return { actionId: a.actionId, ok: false, code: 'bad_request', reason: bad }
    }
    try {
      const out = await dispatchAction(this.deps, a)
      return { actionId: a.actionId, ok: out.code === 'ok', code: out.code, reason: out.reason }
    } catch (error) {
      this.deps.logger.error(`action-inbox: ${a.actionId} failed: ${String(error).slice(0, 120)}`)
      return { actionId: a.actionId, ok: false, code: 'error' }
    }
  }

  private writeResult(actionId: string, ok: boolean, code: string): void {
    this.deps.store.ensureDir('web')
    this.deps.store.appendJsonl(ACTION_RESULTS_REL, { actionId, ok, code, ts: this.now() })
  }

  private audit(a: ActionLine, outcome: ActionOutcome): void {
    this.deps.store.ensureDir('audit')
    // 只记元数据：actionId/type/chatId/code——绝无语句原文
    this.deps.store.appendJsonl(WEB_ACTIONS_AUDIT_REL, { ts: this.now(), actionId: a.actionId, type: a.type, chatId: a.chatId, code: outcome.code, ok: outcome.ok })
  }

  /** 启动轮询（接线层 ctx.effect 挂 dispose） */
  start(): () => void {
    this.timer = setInterval(() => {
      void this.poll().catch((error) => this.deps.logger.error(`action-inbox poll failed: ${String(error).slice(0, 120)}`))
    }, this.pollMs)
    void this.poll().catch(() => {})
    return () => this.dispose()
  }

  /** W-6：只读运行状态（积压/水位/最近错误） */
  status(): { enabled: boolean; ready: { taskRecognition: boolean; promiseRecognition: boolean }; backlog: number; offset: number; lastError: string | null } {
    const raw = this.deps.store.readText(ACTIONS_REL)
    const backlog = raw ? raw.split('\n').filter((l) => l.trim() !== '').length - this.offset : 0
    return {
      enabled: true,
      ready: { taskRecognition: true, promiseRecognition: true },
      backlog: Math.max(0, backlog),
      offset: this.offset,
      lastError: this.lastError,
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
