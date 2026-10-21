/**
 * action-inbox.ts：前端动作收件箱消费（confirm-loop 设计 §2.2，前端设计 §4.3 行格式）。
 *
 * 数据流：前端进程唯一写入 <stateDir>/web/actions.jsonl → 本消费器只读该文件，
 * 经水位 web/actions.offset（JSON {byteOffset, lastActionId}，W-3：水位=字节偏移，
 * 每行处理后立即落盘；轮转/截断→resync + error；连续性不符→resync + warn）逐行处理：
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
import { AGGREGATE_CHAT_ID } from './regen-processor.js'

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
  'report.regen', 'report.finalize', 'report.toOutbox',
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
  /** 提交方 token 的 sha256 前 8 位（web 进程写入）；插件配置了 token 时必须与之一致（审计对齐） */
  operator?: string
}

export interface ActionInboxDeps {
  store: Store
  actions: ApprovalActions
  /** 标记动作（阶段四 MarkActions；未注入 = task.mark/promise.mark 拒绝 unsupported） */
  marks?: { markTarget: (chatId: string, kind: 'task' | 'promise', targetId: number, status: 'completed' | 'incomplete' | 'deleted', source: 'chat' | 'web') => Promise<boolean> }
  /** 白名单群（R2：chatId ∈ groups，白名单外拒绝） */
  groups: readonly string[]
  /** W-8 stale 细分用：目标存在性解析（缺省 = 一律 status_conflict） */
  resolveTarget?: (chatId: string, targetKind: 'task' | 'promise' | 'event', targetId: number) => { createdAt: number } | null
  /**
   * 「排入发件箱」入队（FE-3 report.toOutbox）。**仅当插件配置 webOutboxEnabled=true 时由接线层注入**——
   * 未注入 = 开关关闭，report.toOutbox 一律回执 unsupported（outbox_disabled），零入队。
   * 入队后走既有 sender 链路（四道闸 + 配额 + 回读验证），本模块不碰发送。
   */
  reportOutbox?: (chatId: string, kind: ReportKind, dateKey: string) => 'ok' | 'not_found' | 'duplicate'
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
  | 'operator_mismatch' // 动作行的 operator 与插件 webActionsToken 指纹不一致（审计标签对不上真实 token）
  | 'unsupported' | 'bad_request' | 'error'

export interface ActionOutcome {
  actionId: string
  ok: boolean
  code: ActionCode
  /** 失败原因（bad_request 时细化：kind_not_allowed/date_format/not_monday/not_month_start/…） */
  reason?: string
}

/**
 * W-3 连续性校验辅助：取 buf 前 end 字节里最后一条完整行的 actionId。
 * 无完整行 / 行不可解析 → null（校验不过 → resync）。
 */
function lastCompleteLineActionId(buf: Buffer, end: number): string | null {
  if (end <= 0 || end > buf.length) return null
  const text = buf.slice(0, end).toString('utf8')
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop() // 偏移恒在 '\n' 之后 → 末元素为空串
  if (lines.length === 0) return null
  return parseActionLine(lines[lines.length - 1])?.actionId ?? null
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
      operator: typeof v.operator === 'string' ? v.operator : undefined,
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
  const kind = a.type.startsWith('promise.') ? 'promise' : a.type.startsWith('event.') ? 'event' : 'task'
  const t = deps.resolveTarget?.(a.chatId, kind, a.targetId)
  if (!t) return { code: 'not_found' }
  return { code: 'status_conflict' }
}

/** 水位文件（W-3：字节偏移制，设计前端 §5「水位=字节偏移」）：JSON 一行落盘 */
export interface ActionOffsetFile {
  /** 已消费到的字节偏移（下一行起点；行尾 '\n' 之后） */
  byteOffset: number
  /** 偏移前最后一条已处理行的 actionId（连续性校验锚点；坏行为 ''） */
  lastActionId: string
}

/** W-9：writeResult 写失败时的内存墓碑行（有界，下轮 poll 先行补写） */
interface ResultTombstone { actionId: string; ok: boolean; code: string }

/** W-9 墓碑队列上限（防磁盘长期满时无界增长） */
export const RESULT_TOMBSTONE_MAX = 100

/**
 * 前端动作 → ApprovalActions / MarkActions 单入口分发。返回 code（stale = 服务返回 false）。
 * 带 source 的门面方法一律显式传 'web'——缺省值是 'chat'，漏传会把前端审批记成「来源：对话框」。
 */
export async function dispatchAction(
  deps: Pick<ActionInboxDeps, 'actions' | 'marks' | 'resolveTarget' | 'reportOutbox'>,
  a: ActionLine,
): Promise<{ code: ActionOutcome['code']; reason?: string }> {
  const A = deps.actions
  const id = a.targetId
  switch (a.type) {
    case 'task.confirm': return (await A.taskConfirm(a.chatId, id, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    case 'task.cancel': return (await A.taskCancel(a.chatId, id, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    case 'task.complete': return (await A.taskComplete(a.chatId, id, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    case 'task.set_deadline': {
      const dl = a.params?.deadline
      if (typeof dl !== 'number' || !Number.isFinite(dl)) return { code: 'bad_request', reason: 'deadline_required' }
      return (await A.taskSetDeadline(a.chatId, id, dl, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'task.postpone': {
      const dl = a.params?.deadline
      if (typeof dl !== 'number' || !Number.isFinite(dl)) return { code: 'bad_request', reason: 'deadline_required' }
      return (await A.taskPostpone(a.chatId, id, dl, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'task.rewrite': {
      const text = a.params?.text
      if (typeof text !== 'string' || text.trim() === '') return { code: 'bad_request', reason: 'text_required' }
      return (await A.taskRewrite(a.chatId, id, text, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    }
    case 'event.confirm': return (await A.eventConfirm(a.chatId, id, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.confirm': return (await A.promiseConfirm(a.chatId, id, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.cancel': return (await A.promiseCancel(a.chatId, id, 'web')) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.fulfilled': return (await A.promiseFulfilled(a.chatId, id)) ? { code: 'ok' } : staleOf(deps, a)
    case 'promise.close': return (await A.promiseClose(a.chatId, id, 'web')) ? { code: 'ok' } : staleOf(deps, a)
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
      // false = 同一 (chatId, dateKey, kind) 已在重跑队列（去重）；不是目标不存在，不能走 staleOf
      return (await A.reportRegen(a.chatId, dateKey, kind)) ? { code: 'ok' } : { code: 'duplicate', reason: 'already_queued' }
    }
    case 'report.finalize': {
      // 参数已在 process() 经 validateRegenParams 校验（kind 枚举 + dateKey 为周期起点）
      const r = await A.reportFinalize(a.chatId, String(a.params?.dateKey), a.params?.kind as ReportKind, 'web')
      if (r === 'ok') return { code: 'ok' }
      if (r === 'already_final') return { code: 'status_conflict', reason: 'already_final' }
      if (r === 'not_found') return { code: 'not_found' }
      if (r === 'unavailable') return { code: 'unsupported', reason: 'knowledge_db_off' }
      return { code: 'error' }
    }
    case 'report.toOutbox': {
      if (!deps.reportOutbox) return { code: 'unsupported', reason: 'outbox_disabled' }
      const r = deps.reportOutbox(a.chatId, a.params?.kind as ReportKind, String(a.params?.dateKey))
      if (r === 'ok') return { code: 'ok' }
      if (r === 'duplicate') return { code: 'duplicate', reason: 'recently_queued' }
      return { code: 'not_found' }
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

  /**
   * 水位载入（W-3 字节偏移制）：
   * - seen 预载自 web/action-results.jsonl（持久幂等源：重启/轮转后重复 actionId 也不会重复执行）；
   * - 水位文件 JSON {byteOffset, lastActionId}；旧版行计数格式无法映射到字节 → 从头 resync（seen 兜底防重放）；
   * - 连续性校验：byteOffset 前最后一条完整行的 actionId ≠ lastActionId → 水位失效，resync + warn。
   */
  private loadOffsetSeen(): void {
    // 持久幂等源：结果文件里出现过的 actionId 一律视为已处理
    const results = this.deps.store.readText(ACTION_RESULTS_REL)
    if (results) {
      for (const line of results.split('\n')) {
        try {
          const v = JSON.parse(line) as { actionId?: unknown }
          if (typeof v.actionId === 'string' && v.actionId !== '') this.seen.add(v.actionId)
        } catch { /* 损坏行跳过 */ }
      }
    }
    const offRaw = this.deps.store.readText(ACTIONS_OFFSET_REL)
    if (!offRaw) return
    let parsed: ActionOffsetFile | null = null
    try { parsed = JSON.parse(offRaw) as ActionOffsetFile } catch { parsed = null }
    if (!parsed || typeof parsed.byteOffset !== 'number' || !Number.isFinite(parsed.byteOffset) || parsed.byteOffset < 0 || typeof parsed.lastActionId !== 'string') {
      this.deps.logger.warn('action-inbox: 水位文件为旧版行计数/损坏格式——从头 resync（结果文件幂等兜底）')
      this.byteOffset = 0
      this.lastActionId = ''
      return
    }
    this.byteOffset = Math.floor(parsed.byteOffset)
    this.lastActionId = parsed.lastActionId
    // 连续性校验：偏移前的最后一条完整行必须就是记录的 lastActionId
    const buf = this.deps.store.readBuffer(ACTIONS_REL)
    if (this.byteOffset === 0) return
    if (!buf || this.byteOffset > buf.length) {
      this.deps.logger.warn('action-inbox: 水位字节偏移超过文件长度（文件被轮转/截断）——从头 resync')
      this.byteOffset = 0
      this.lastActionId = ''
      return
    }
    const anchor = lastCompleteLineActionId(buf, this.byteOffset)
    if (anchor === null || anchor !== this.lastActionId) {
      this.deps.logger.warn(`action-inbox: 水位连续性校验失败（offset 前 actionId=${anchor ?? '无'} ≠ 记录 ${this.lastActionId}）——从头 resync`)
      this.byteOffset = 0
      this.lastActionId = ''
    }
  }

  private byteOffset = 0
  private lastActionId = ''
  private lastError: string | null = null
  /** W-9：写失败的回执墓碑（FIFO 有界；下轮 poll 先补写再消费新行） */
  private tombstones: ResultTombstone[] = []
  private writeFailStreak = 0

  /** 落盘水位（每行处理后立即调用——中途崩溃不重放已执行动作） */
  private persistOffset(): void {
    const file: ActionOffsetFile = { byteOffset: this.byteOffset, lastActionId: this.lastActionId }
    if (!this.deps.store.writeText(ACTIONS_OFFSET_REL, `${JSON.stringify(file)}\n`)) {
      this.deps.logger.error('action-inbox: 水位落盘失败——重启可能重放（结果文件幂等兜底防重复执行）')
    }
  }

  /** W-9：poll 开头先补写上一轮失败的回执墓碑（连续失败计数 error 告警） */
  private flushTombstones(): void {
    while (this.tombstones.length > 0) {
      const t = this.tombstones[0]
      if (this.appendResult(t.actionId, t.ok, t.code)) {
        this.tombstones.shift()
        this.writeFailStreak = 0
      } else {
        this.writeFailStreak += 1
        this.alertWriteStreak()
        return
      }
    }
  }

  private alertWriteStreak(): void {
    // 连续失败 3 次起 error 告警，此后每 20 次再提一次（磁盘满/权限类持续故障不刷屏）
    if (this.writeFailStreak === 3 || (this.writeFailStreak > 3 && this.writeFailStreak % 20 === 0)) {
      this.deps.logger.error(`action-inbox: 回执写失败连续 ${this.writeFailStreak} 次（含 ${this.tombstones.length} 条墓碑待补）——前端将等不到 actionId 回执`)
    }
  }

  /** 单轮消费：按字节扫描 actions.jsonl，从水位字节偏移起逐行处理，每行处理后立即落盘水位。返回处理条数 */
  async poll(): Promise<number> {
    this.flushTombstones() // W-9：先补上轮失败的回执
    const buf = this.deps.store.readBuffer(ACTIONS_REL)
    if (!buf) return 0
    // 轮转/截断检测：水位超出当前文件字节长度 → 文件被前端轮转或截断 → 从头 resync（seen 兜底防重复执行）
    if (this.byteOffset > buf.length) {
      this.deps.logger.error(`action-inbox: actions.jsonl 字节长度 ${buf.length} < 水位 ${this.byteOffset}——文件被轮转/截断，从头 resync`)
      this.byteOffset = 0
      this.lastActionId = ''
      this.persistOffset()
    }
    let processed = 0
    let pos = this.byteOffset
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos)
      if (nl === -1) break // 尾部无换行的半行（前端写一半）→ 留待下轮，绝不消费残行
      const lineEnd = nl + 1
      const text = buf.slice(pos, nl).toString('utf8')
      pos = lineEnd
      const a = parseActionLine(text)
      if (!a) {
        this.writeResult('bad-line', false, 'bad_request')
        this.byteOffset = lineEnd // 坏行也推进水位（不卡队列；结果文件承载失败）
        this.lastActionId = ''
        this.persistOffset()
        continue
      }
      if (this.seen.has(a.actionId)) { // 幂等：重复 actionId 跳过（不重复执行）
        this.byteOffset = lineEnd
        this.lastActionId = a.actionId
        this.persistOffset()
        continue
      }
      this.seen.add(a.actionId)
      const outcome = await this.process(a)
      this.writeResult(a.actionId, outcome.ok, outcome.code)
      this.audit(a, outcome)
      if (!outcome.ok) this.lastError = `${a.actionId}:${outcome.code}`
      processed += 1
      this.byteOffset = lineEnd // 每行处理后立即落盘（中途崩溃不重放）
      this.lastActionId = a.actionId
      this.persistOffset()
    }
    return processed
  }

  private async process(a: ActionLine): Promise<ActionOutcome> {
    // 审计对齐：配置了 token 时，动作行必须带同一 token 的指纹——否则审计里的 operator
    // 对应的不是浏览器实际使用的 token，无法据此核对是谁提交的。未配置 token 时维持原行为（记 unknown）。
    if (this.deps.operator && a.operator !== this.deps.operator) {
      return { actionId: a.actionId, ok: false, code: 'operator_mismatch' }
    }
    if (!ACTION_TYPES.includes(a.type as ActionType)) {
      return { actionId: a.actionId, ok: false, code: 'type_not_allowed' }
    }
    // 跨群汇总不是群、不在白名单里：只放行 report.* 三个报告操作（且只有日报，见下方参数校验）
    const aggregate = a.chatId === AGGREGATE_CHAT_ID && a.type.startsWith('report.')
    if (!aggregate && !this.deps.groups.includes(a.chatId)) {
      return { actionId: a.actionId, ok: false, code: 'chat_not_allowed' }
    }
    if (a.type !== 'person.follow' && a.type !== 'person.unfollow' && !a.type.startsWith('report.')) {
      if (!Number.isInteger(a.targetId) || a.targetId <= 0) {
        return { actionId: a.actionId, ok: false, code: 'bad_request', reason: 'targetId_required' }
      }
    }
    // W-7：report.regen / report.finalize / report.toOutbox 执行前校验（kind/dateKey 按-kind 有效性）——队列零污染
    if (a.type.startsWith('report.')) {
      const bad = validateRegenParams(a.params) ?? (aggregate && a.params?.kind !== 'daily' ? 'aggregate_daily_only' : null)
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

  /** W-9：写回执；失败入内存墓碑（有界），下轮 poll 补写；连续失败计数 error 告警 */
  private writeResult(actionId: string, ok: boolean, code: string): void {
    if (this.appendResult(actionId, ok, code)) {
      this.writeFailStreak = 0
      return
    }
    this.writeFailStreak += 1
    this.alertWriteStreak()
    this.tombstones.push({ actionId, ok, code })
    if (this.tombstones.length > RESULT_TOMBSTONE_MAX) {
      const dropped = this.tombstones.shift()
      this.deps.logger.error(`action-inbox: 回执墓碑队列溢出丢弃最旧 ${JSON.stringify(dropped)}——该 actionId 前端将永远等不到回执`)
    }
  }

  private appendResult(actionId: string, ok: boolean, code: string): boolean {
    this.deps.store.ensureDir('web')
    return this.deps.store.appendJsonl(ACTION_RESULTS_REL, { actionId, ok, code, ts: this.now() })
  }

  private audit(a: ActionLine, outcome: ActionOutcome): void {
    this.deps.store.ensureDir('audit')
    // 只记元数据：actionId/type/chatId/code/operator（W-1：操作者=web token 哈希前缀，绝不落原 token/语句原文）
    // operator_mismatch 时另记动作行自称的指纹（claimedOperator，同为哈希前缀），便于排查是哪个 web 进程配错了
    const claimed = outcome.code === 'operator_mismatch' ? { claimedOperator: a.operator ?? 'none' } : {}
    this.deps.store.appendJsonl(WEB_ACTIONS_AUDIT_REL, { ts: this.now(), actionId: a.actionId, type: a.type, chatId: a.chatId, code: outcome.code, ok: outcome.ok, operator: this.deps.operator ?? 'unknown', ...claimed })
  }

  /** 启动轮询（接线层 ctx.effect 挂 dispose） */
  start(): () => void {
    this.timer = setInterval(() => {
      void this.poll().catch((error) => this.deps.logger.error(`action-inbox poll failed: ${String(error).slice(0, 120)}`))
    }, this.pollMs)
    void this.poll().catch(() => {})
    return () => this.dispose()
  }

  /** W-6：只读运行状态（积压/水位/最近错误）。水位=字节偏移（W-3）；积压按未消费完整行数计 */
  status(): { enabled: boolean; ready: { taskRecognition: boolean; promiseRecognition: boolean }; backlog: number; offset: number; lastError: string | null } {
    const buf = this.deps.store.readBuffer(ACTIONS_REL)
    let backlog = 0
    if (buf && this.byteOffset <= buf.length) {
      let pos = this.byteOffset
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos)
        if (nl === -1) break
        backlog += 1
        pos = nl + 1
      }
    }
    return {
      enabled: true,
      ready: { taskRecognition: true, promiseRecognition: true },
      backlog,
      offset: this.byteOffset,
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
