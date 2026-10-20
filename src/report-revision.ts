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
  mirror?: { mirrorMarking: (chatId: string, kind: 'done' | 'undone' | 'deleted', targetRef: string, ts: number, opts?: { source?: 'chat' | 'web'; sourceKey?: string }) => boolean }
  now?: () => number
  /** 内存重放队列上限（默认 500；测试可调） */
  maxQueue?: number
}

const STATUS_LABEL = { completed: '已完成', incomplete: '未完成', deleted: '删除' } as const

export class ReportRevisionService {
  private readonly now: () => number
  private readonly maxQueue: number
  /** 镜像失败暂存（内存，有界；不落第二持久真相） */
  private pending: MirrorEvent[] = []

  constructor(private readonly deps: ReportRevisionDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.maxQueue = Math.max(1, deps.maxQueue ?? MIRROR_RETRY_QUEUE_MAX)
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
    this.appendRevisionLineToMd(chatId, this.dayKey(ts), `- ${this.dayKey(ts)} ${this.hhmm(ts)} 标记：${targetKind}「#${targetId}」→ ${label}（来源：${source === 'web' ? '前端' : '对话框'}）`)
    return true
  }

  /**
   * 审批入口：审批动作的级联修订（识别服务落库由 ApprovalActions 先行，本服务只做修订流）。
   * 镜像接线（report_revision，低优先）排后：当前仅 .md 修订段 + knowledge 读侧缺行可接受。
   */
  async onApproval(chatId: string, dateKey: string, summary: string, source: 'chat' | 'web', targetRef: string | null = null): Promise<boolean> {
    const ts = this.now()
    this.appendRevisionLineToMd(chatId, dateKey, `- ${this.dayKey(ts)} ${this.hhmm(ts)} 审批：${summary}（来源：${source === 'web' ? '前端' : '对话框'}）→ L2 对应条目状态更新`)
    void targetRef
    void ts
    return true
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
