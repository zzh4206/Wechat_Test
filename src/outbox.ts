/**
 * outbox.ts：发件箱日志替身（M3 提前落地 M4-T4.4 的最小版）。
 *
 * 边界（实施计划 §4-M4-T4.4 / §6 决策 1）：
 * - 所有"本应发往文件传输助手"的内容统一 **追加写** <stateDir>/outbox.jsonl，
 *   schema：{ts, channel:'filehelper', kind, title, body, evidence_ref, status:'pending'}；
 * - **零发送调用**：本模块不 import 任何发送接口，不做网络/子进程调用；
 *   2026-10-14 红线升级后，发送由 src/sender.ts（SenderService，唯一发送出口）消费本箱；
 * - tailOutbox(n) 只读（补丁行按 id fold 归并，W-4），供 `outbox tail` 查看辅助；
 * - updateSendState 追加补丁行（W-4，2026-10-20 审查）：不再整文件读-改-写，避免与 appendOutbox 并发丢追加；
 * - 写入经 Store.appendJsonl（assertInsideState 围栏 + 单一 fs 入口）。
 */
import { randomUUID } from 'node:crypto'
import type { Store } from './store.js'

/** 发件箱落盘相对路径（相对 stateDir） */
export const OUTBOX_REL = 'outbox.jsonl'

/** 目标通道：M3/M4 阶段恒为文件传输助手（暂不发送，仅占位归档） */
export type OutboxChannel = 'filehelper'

/** outbox.jsonl 单行（落盘形状） */
export interface OutboxEntry {
  /** ISO8601 时间戳 */
  ts: string
  channel: OutboxChannel
  /** 业务种类（daily/weekly/monthly/remind/task-digest...） */
  kind: string
  title: string
  body: string
  /** 证据指针（报告 md 路径 / outbox 条目 id / msg_id 等，透传调用方） */
  evidence_ref: string
  status: OutboxStatus
  /** 唯一 id（sender worker 幂等 --id 用；appendOutbox 自动生成；旧条目可能缺失） */
  id?: string
  /** 发送 worker 已尝试次数（sender 维护；≥3 转 failed 不再重试） */
  attempts?: number
  /** 键序已把消息打出去的时间戳（发送/验证解耦：>0 即绝不整条重发，只重试验证） */
  transmittedAt?: number
  /** sent_pending_verify 状态下的回读验证轮数（CLI 报错累计；≥5 转人工告警） */
  verifyAttempts?: number
  /** 送达回执：微信服务器消息 id（回读验证命中时抓取；比自造 uuid 更硬的送达证据） */
  serverId?: string
  /** 回读验证命中（置 sent）的时刻 */
  sentAt?: number
}

/** 生命周期状态：pending → sent_pending_verify → sent 或 failed_wrong_target；dry_run、skipped、failed 为旁路终态（sender worker 推进） */
export type OutboxStatus = 'pending' | 'sent_pending_verify' | 'sent' | 'dry_run' | 'skipped_quota' | 'skipped_channel' | 'failed' | 'failed_wrong_target'

/** appendOutbox 的入参（ts/channel/status 由本模块补全，调用方不给篡改口） */
export interface OutboxAppendInput {
  kind: string
  title: string
  body: string
  evidence_ref: string
  /** W-11：调用方可预生成 id（让 evidence_ref 能指向本条目自身，如 outbox/<id>）；缺省自动生成 */
  id?: string
}

/** W-4：状态补丁行（追加写文件尾；读取侧按 id fold 归并——并发 appendOutbox 不再丢追加） */
export interface OutboxPatchLine {
  /** 补丁行标记（与完整条目行区分：完整条目恒有 kind/ts，无 patch 字段） */
  patch: true
  id: string
  status: OutboxEntry['status']
  attempts?: number
  transmittedAt?: number
  verifyAttempts?: number
  serverId?: string
  sentAt?: number
}

/** 读侧 fold：把补丁行归并进既有条目（按文件行序，后写覆盖先写） */
function foldOutboxLines(raw: string): OutboxEntry[] {
  const entries: OutboxEntry[] = []
  const byId = new Map<string, OutboxEntry>()
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const v = JSON.parse(t) as OutboxEntry & Partial<OutboxPatchLine>
      if (!v || typeof v !== 'object') continue
      if ((v as Partial<OutboxPatchLine>).patch === true && typeof v.id === 'string') {
        const prev = byId.get(v.id)
        if (prev) {
          const { patch: _p, id: _i, ...rest } = v as object as Partial<OutboxPatchLine> & Partial<OutboxEntry>
          Object.assign(prev, rest)
        }
        continue // 未知 id 的补丁行（条目行已不在尾部窗口等）→ 丢弃
      }
      if (typeof v.kind !== 'string') continue
      entries.push(v)
      if (typeof v.id === 'string') byId.set(v.id, v)
    } catch {
      /* 损坏行跳过（追加写被截断的尾行等） */
    }
  }
  return entries
}

export interface OutboxOptions {
  /** 项目内唯一 fs 写入点（appendJsonl 内置围栏） */
  store: Store
  now?: () => number
}

export class Outbox {
  private readonly now: () => number

  constructor(private readonly options: OutboxOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  /** 追加一条入箱记录（只落盘，零发送）。失败返回 null（不拖垮调用方）。 */
  appendOutbox(input: OutboxAppendInput): OutboxEntry | null {
    const entry: OutboxEntry = {
      ts: new Date(this.now()).toISOString(),
      channel: 'filehelper',
      kind: String(input.kind ?? ''),
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      evidence_ref: String(input.evidence_ref ?? ''),
      status: 'pending',
      id: input.id ?? randomUUID(),
    }
    return this.options.store.appendJsonl(OUTBOX_REL, entry) ? entry : null
  }

  /** 只读：取末尾 n 条（n<=0 返回 []）；补丁行按 id fold 归并（W-4）；损坏行跳过，不抛出。 */
  tailOutbox(n: number): OutboxEntry[] {
    const limit = Math.max(0, Math.floor(n))
    if (limit === 0) return []
    const raw = this.options.store.readText(OUTBOX_REL)
    if (!raw) return []
    return foldOutboxLines(raw).slice(-limit)
  }

  /** 只读：全量解析（sender worker 扫 pending/统计当日已发用）；损坏行跳过。 */
  listOutbox(): OutboxEntry[] {
    return this.tailOutbox(Number.MAX_SAFE_INTEGER)
  }

  /**
   * 发送 worker 专用：按 id 推进条目生命周期状态（pending → sent / dry_run / skipped / failed）。
   * W-4：改追加补丁行（{patch:true, id, ...patch} 追加文件尾），不再整文件读-改-写——
   * 与 appendOutbox 并发时零丢失（追加互不覆盖）；读取侧按 id fold 归并。
   * 找不到 id / 写失败返回 false。
   */
  updateSendState(id: string, patch: { status: OutboxStatus; attempts?: number; transmittedAt?: number; verifyAttempts?: number; serverId?: string; sentAt?: number }): boolean {
    if (id === '') return false
    const raw = this.options.store.readText(OUTBOX_REL)
    if (!raw) return false
    const known = foldOutboxLines(raw).some((e) => e.id === id)
    if (!known) return false
    const line: OutboxPatchLine = { patch: true, id, status: patch.status }
    if (patch.attempts !== undefined) line.attempts = patch.attempts
    if (patch.transmittedAt !== undefined) line.transmittedAt = patch.transmittedAt
    if (patch.verifyAttempts !== undefined) line.verifyAttempts = patch.verifyAttempts
    if (patch.serverId !== undefined) line.serverId = patch.serverId
    if (patch.sentAt !== undefined) line.sentAt = patch.sentAt
    return this.options.store.appendJsonl(OUTBOX_REL, line)
  }
}
