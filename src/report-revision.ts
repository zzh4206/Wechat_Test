/**
 * report-revision.ts：审批/标记 → 报告修订流（DESIGN-approval-marking §4 + 架构约束修订版）。
 *
 * **约束 1（单一查询副本，数据负责人 REPLY-PM-v0.6）**：marking 的唯一查询副本是
 * knowledge.db——本服务**不落任何每群库表/第二持久真相**；标记事件直接走镜像通道
 * （store.mirrorMarking → dao.insertMarking，不可变事实：source_key 冲突返回已有 id，
 * 非 UPDATE——已核实与裁定一致）。镜像失败 → 事件入**插件内存队列**（有界 500 条，
 * 溢出丢最旧）+ error 日志（含完整事件 JSON 供日志重放）；重启丢失可接受
 * （标记可由用户重标；web/actions.jsonl 动作日志本身就是重放源）。
 *
 * 修订流：镜像成功后，报告 .md 尾部「修订记录」段照常追加（即使镜像暂时失败也追加——
 * 修订段可能暂时缺行，可接受；revised 事件重放后由报告 upsert 补齐时间线）。
 *
 * 红线：source 只含通道名（'chat' | 'web'）无正文；不触发 LLM；不重发 filehelper。
 */
import type { Store } from './store.js'
import type { StoreLogger } from './store.js'
import { reportRelPath } from './report.js'

/** 标记状态 → knowledge.db marking.kind 映射（同名不同义换算：每群库状态语义 → knowledge 事件语义） */
export function markingStatusToKnowledgeKind(status: 'completed' | 'incomplete' | 'deleted'): 'done' | 'undone' | 'deleted' {
  if (status === 'completed') return 'done'
  if (status === 'incomplete') return 'undone'
  return 'deleted'
}

/** 内存重放队列上限（溢出丢最旧 + error 日志；不落盘） */
export const MIRROR_RETRY_QUEUE_MAX = 500

interface MirrorEvent {
  chatId: string
  kind: 'done' | 'undone' | 'deleted'
  targetRef: string
  ts: number
  source: 'chat' | 'web'
  sourceKey: string
}

export interface ReportRevisionDeps {
  store: Store
  logger: StoreLogger
  /** 存在性校验 + origin 解析（tasks/promises 行：created_at = 条目出身时刻）。返回 null = 不存在 */
  resolveTarget: (chatId: string, targetKind: 'task' | 'event' | 'promise', targetId: number) => { createdAt: number } | null
  mirror?: {
    mirrorMarking: (chatId: string, kind: 'done' | 'undone' | 'deleted', targetRef: string, ts: number, opts?: { source?: 'chat' | 'web'; sourceKey?: string }) => boolean
    mirrorReportRevision: (chatId: string, periodType: 'daily' | 'weekly' | 'monthly', periodStart: string, ts: number, type: string, opts?: { targetRef?: string | null; summary?: string | null; source?: 'chat' | 'web'; sourceKey?: string }) => boolean
  }
  now?: () => number
  /** 内存重放队列上限（默认 500；测试可调） */
  maxQueue?: number
}

const STATUS_LABEL = { completed: '已完成', incomplete: '未完成', deleted: '删除' } as const

export class ReportRevisionService {
  private readonly now: () => number
  private readonly maxQueue: number
  private readonly mirror?: { mirrorMarking: (chatId: string, kind: 'done' | 'undone' | 'deleted', targetRef: string, ts: number, opts?: { source?: 'chat' | 'web'; sourceKey?: string }) => boolean; mirrorReportRevision: (chatId: string, periodType: 'daily' | 'weekly' | 'monthly', periodStart: string, ts: number, type: string, opts?: { targetRef?: string | null; summary?: string | null; source?: 'chat' | 'web'; sourceKey?: string }) => boolean }
  /** 镜像失败暂存（内存，有界；不落第二持久真相） */
  private pending: MirrorEvent[] = []

  constructor(private readonly deps: ReportRevisionDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.maxQueue = Math.max(1, deps.maxQueue ?? MIRROR_RETRY_QUEUE_MAX)
    this.mirror = deps.mirror
  }

  private dayKey(ts: number): string {
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  private hhmm(ts: number): string {
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /** 排空内存队列（新标记到达时顺带重试；成功即出队） */
  private drainPending(): void {
    while (this.pending.length > 0) {
      const ev = this.pending[0]
      const ok = this.deps.mirror
        ? this.deps.mirror.mirrorMarking(ev.chatId, ev.kind, ev.targetRef, ev.ts, { source: ev.source, sourceKey: ev.sourceKey })
        : false
      if (!ok) return // 仍失败：停止排空（保序）
      this.pending.shift()
      this.deps.logger.warn(`report-revision: 重放成功的镜像事件 ${ev.sourceKey}（队列余 ${this.pending.length}）`)
    }
  }

  /**
   * 标记入口（MarkActions/task.mark/promise.mark 唯一通道）：
   * 构造标记事件 → 镜像通道（不可变事实）→ 失败入内存队列 + error 日志（完整事件 JSON）；
   * .md 修订段照常追加。返回是否完成（镜像成功或已定稿）。
   */
  async markTarget(chatId: string, targetKind: 'task' | 'promise' | 'event', targetId: number, status: 'completed' | 'incomplete' | 'deleted', source: 'chat' | 'web'): Promise<boolean> {
    // 存在性校验：目标不存在 → 整链零副作用（无镜像/无修订行/无级联），返回 false
    if (targetKind === 'event') {
      this.deps.logger.warn('report-revision: event 暂不可标记——拒绝')
      return false
    }
    const target = this.deps.resolveTarget(chatId, targetKind, targetId)
    if (!target) {
      this.deps.logger.warn(`report-revision: 标记目标不存在 ${chatId}/${targetKind}#${targetId}——整链零副作用`)
      return false
    }
    // origin 归属（2026-10-21 用户裁定）：修订归属条目最初出现的日报（created_at 本地日），
    // 级联周报=origin 所在周周一、月报=origin 当月 1 号——出身日报永远反映最新状态。
    const originDateKey = this.dayKey(target.createdAt)
    this.drainPending()
    const ts = this.now()
    const targetRef = `${chatId}:${targetKind}:${targetId}` // 全局唯一（防 v_marking_latest 跨群串号）
    const kKind = markingStatusToKnowledgeKind(status)
    const sourceKey = `mark:${targetRef}:${ts}`
    const ev: MirrorEvent = { chatId, kind: kKind, targetRef, ts, source: source === 'web' ? 'web' : 'chat', sourceKey }
    const ok = this.deps.mirror
      ? this.deps.mirror.mirrorMarking(ev.chatId, ev.kind, ev.targetRef, ev.ts, { source: ev.source, sourceKey: ev.sourceKey })
      : false
    if (!ok) {
      this.pending.push(ev)
      while (this.pending.length > this.maxQueue) {
        const dropped = this.pending.shift()
        this.deps.logger.error(`report-revision: 内存队列溢出丢弃最旧事件 ${JSON.stringify(dropped)}`)
      }
      // 完整事件 JSON 进日志（供日志重放）
      this.deps.logger.error(`report-revision: 镜像失败——事件入内存队列（${this.pending.length}/${this.maxQueue}） ${JSON.stringify(ev)}`)
    }
    const label = STATUS_LABEL[status]
    const mdLine = `- ${this.dayKey(ts)} ${this.hhmm(ts)} 标记：${targetKind}「#${targetId}」→ ${label}（来源：${source === 'web' ? '前端' : '对话框'}）`
    // 特例：origin 日报告文件不存在 → 跳过 .md 追加，修订行（revisions+镜像）照记、级联照常
    const originFileExists = this.deps.store.readText(reportRelPath(chatId, originDateKey)) !== null
    if (originFileExists) this.appendRevisionLineToMd(chatId, originDateKey, mdLine)
    else this.deps.logger.warn(`report-revision: origin 日（${originDateKey}）无报告文件——修订行照记、跳过 .md 追加 ${chatId}/${targetKind}#${targetId}`)
    this.appendRevisionRow(chatId, originDateKey, { revType: 'marking', targetKind, targetRef: ev.targetRef, summary: `标记：${targetKind} #${targetId} → ${label}`, source: ev.source })
    this.cascadeAggregates(chatId, originDateKey, { revType: 'marking', targetRef: ev.targetRef, summary: `标记：${targetKind} #${targetId} → ${label}`, source: ev.source, mdLine })
    return true
  }

  /** 修订行落档：knowledge.db report_revision 经镜像（单一查询副本；每群库不落表——约束 1） */
  private appendRevisionRow(chatId: string, dateKey: string, ev: { revType: string; targetKind?: string | null; targetRef: string | null; summary: string; source: string }): void {
    this.deps.mirror?.mirrorReportRevision?.(chatId, 'daily', dateKey, this.now(), ev.revType, { targetRef: ev.targetRef, summary: ev.summary, source: ev.source === 'web' ? 'web' : 'chat' })
  }

  /**
   * 审批入口：审批动作的级联修订（识别服务落库由 ApprovalActions 先行，本服务只做修订流）。
   * 镜像接线（report_revision，低优先）排后：当前仅 .md 修订段 + knowledge 读侧缺行可接受。
   */
  async onApproval(chatId: string, targetKind: 'task' | 'event' | 'promise', targetId: number, summary: string, source: 'chat' | 'web'): Promise<boolean> {
    // onApproval 同修：origin 归属改条目出身日报（dateKey 不再由调用方传当天）
    const target = this.deps.resolveTarget(chatId, targetKind, targetId)
    if (!target) {
      this.deps.logger.warn(`report-revision: 审批目标不存在 ${chatId}/${targetKind}#${targetId}——整链零副作用`)
      return false
    }
    const originDateKey = this.dayKey(target.createdAt)
    const ts = this.now()
    const targetRef = `${chatId}:${targetKind}:${targetId}`
    const mdLine = `- ${this.dayKey(ts)} ${this.hhmm(ts)} 审批：${summary}（来源：${source === 'web' ? '前端' : '对话框'}）→ L2 对应条目状态更新`
    this.appendRevisionRow(chatId, originDateKey, { revType: 'approval', targetKind, targetRef, summary: `审批：${summary}`, source })
    this.mirror?.mirrorReportRevision(chatId, 'daily', originDateKey, ts, 'approval', { targetRef, summary: `审批：${summary}`, source: source === 'web' ? 'web' : 'chat' })
    if (this.deps.store.readText(reportRelPath(chatId, originDateKey)) !== null) {
      this.appendRevisionLineToMd(chatId, originDateKey, mdLine)
    }
    this.cascadeAggregates(chatId, originDateKey, { revType: 'approval', targetRef, summary: `审批：${summary}`, source, mdLine })
    return true
  }

  /** 级联（§1 逐级向上）：周报（dateKey 所在周的周一）/月报（当月 1 号）文件已存在才动作 */
  private cascadeAggregates(chatId: string, dateKey: string, ev: { revType: string; targetRef: string | null; summary: string; source: string; mdLine: string }): void {
    const day = this.parseDay(dateKey)
    if (day === null) return
    const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7))
    const first = new Date(day.getFullYear(), day.getMonth(), 1)
    const p = (x: Date): string => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
    const targets: Array<['weekly' | 'monthly', string]> = [['weekly', p(monday)], ['monthly', p(first)]]
    for (const [kind, key] of targets) {
      const rel = reportRelPath(chatId, key, kind)
      if (this.deps.store.readText(rel) === null) continue // 聚合报告不存在 → 什么都不做
      this.appendRevisionLineToMd(chatId, key, ev.mdLine, kind)
      this.mirror?.mirrorReportRevision?.(chatId, kind, key, this.now(), ev.revType, { targetRef: ev.targetRef, summary: ev.summary, source: ev.source === 'web' ? 'web' : 'chat' })
    }
  }

  private parseDay(dateKey: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
    if (!m) return null
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }

  /** 报告 .md 尾部修订段：已存在则追加一行，否则新建段。写入经 store.writeText（围栏内）。 */
  private appendRevisionLineToMd(chatId: string, dateKey: string, mdLine: string, kind: 'daily' | 'weekly' | 'monthly' = 'daily'): void {
    const rel = reportRelPath(chatId, dateKey, kind)
    const cur = this.deps.store.readText(rel)
    if (cur === null) return // 报告不存在 → 什么都不做（生成时自然读到修订段）
    const section = '## 修订记录'
    const next = cur.includes(section)
      ? `${cur.replace(/\n*$/, '\n')}${mdLine}\n`
      : `${cur.replace(/\n*$/, '\n')}\n${section}\n\n${mdLine}\n`
    this.deps.store.writeText(rel, next)
  }
}
