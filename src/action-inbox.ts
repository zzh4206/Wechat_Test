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
  'task.confirm', 'task.cancel', 'task.complete', 'task.set_deadline',
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
  logger: StoreLogger
  pollSec?: number
  now?: () => number
}

export interface ActionOutcome {
  actionId: string
  ok: boolean
  code: 'ok' | 'stale' | 'unsupported' | 'bad_request' | 'forbidden' | 'duplicate' | 'error'
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

/** 前端动作 → ApprovalActions / MarkActions 单入口分发。返回 code（stale = 服务返回 false） */
export async function dispatchAction(deps: Pick<ActionInboxDeps, 'actions' | 'marks'>, a: ActionLine): Promise<ActionOutcome['code']> {
  const A = deps.actions
  const id = a.targetId
  switch (a.type) {
    case 'task.confirm': return (await A.taskConfirm(a.chatId, id)) ? 'ok' : 'stale'
    case 'task.cancel': return (await A.taskCancel(a.chatId, id)) ? 'ok' : 'stale'
    case 'task.complete': return (await A.taskComplete(a.chatId, id)) ? 'ok' : 'stale'
    case 'task.set_deadline': {
      const dl = a.params?.deadline
      if (typeof dl !== 'number' || !Number.isFinite(dl)) return 'bad_request'
      return (await A.taskSetDeadline(a.chatId, id, dl)) ? 'ok' : 'stale'
    }
    case 'event.confirm': return (await A.eventConfirm(a.chatId, id)) ? 'ok' : 'stale'
    case 'promise.confirm': return (await A.promiseConfirm(a.chatId, id)) ? 'ok' : 'stale'
    case 'promise.cancel': return (await A.promiseCancel(a.chatId, id)) ? 'ok' : 'stale'
    case 'promise.fulfilled': return (await A.promiseFulfilled(a.chatId, id)) ? 'ok' : 'stale'
    case 'promise.close': return (await A.promiseClose(a.chatId, id)) ? 'ok' : 'stale'
    case 'person.follow': {
      const pid = a.params?.pid
      if (typeof pid !== 'string' || pid === '') return 'bad_request'
      return (await A.personFollow(a.chatId, pid)) ? 'ok' : 'stale'
    }
    case 'person.unfollow': {
      const pid = a.params?.pid
      if (typeof pid !== 'string' || pid === '') return 'bad_request'
      return (await A.personUnfollow(a.chatId, pid)) ? 'ok' : 'stale'
    }
    case 'report.regen': {
      const dateKey = a.params?.dateKey
      const kind = (a.params?.kind ?? 'daily') as ReportKind
      if (typeof dateKey !== 'string' || dateKey === '') return 'bad_request'
      return (await A.reportRegen(a.chatId, dateKey, kind)) ? 'ok' : 'stale'
    }
    case 'task.mark':
    case 'promise.mark': {
      if (!deps.marks) return 'unsupported'
      const status = a.params?.status
      if (status !== 'completed' && status !== 'incomplete' && status !== 'deleted') return 'bad_request'
      const kind = a.type === 'task.mark' ? 'task' : 'promise'
      return (await deps.marks.markTarget(a.chatId, kind, id, status, 'web')) ? 'ok' : 'stale'
    }
    default:
      return 'unsupported'
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
      processed += 1
    }
    this.deps.store.writeText(ACTIONS_OFFSET_REL, `${this.offset}\n`)
    return processed
  }

  private async process(a: ActionLine): Promise<ActionOutcome> {
    if (!ACTION_TYPES.includes(a.type as ActionType)) return { actionId: a.actionId, ok: false, code: 'unsupported' }
    if (!this.deps.groups.includes(a.chatId)) return { actionId: a.actionId, ok: false, code: 'forbidden' }
    if (a.type !== 'person.follow' && a.type !== 'person.unfollow' && a.type !== 'report.regen') {
      if (!Number.isInteger(a.targetId) || a.targetId <= 0) return { actionId: a.actionId, ok: false, code: 'bad_request' }
    }
    try {
      const code = await dispatchAction(this.deps, a)
      return { actionId: a.actionId, ok: code === 'ok', code }
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

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
