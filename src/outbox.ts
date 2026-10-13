/**
 * outbox.ts：发件箱日志替身（M3 提前落地 M4-T4.4 的最小版）。
 *
 * 边界（实施计划 §4-M4-T4.4 / §6 决策 1）：
 * - 所有"本应发往文件传输助手"的内容统一 **追加写** <stateDir>/outbox.jsonl，
 *   schema：{ts, channel:'filehelper', kind, title, body, evidence_ref, status:'pending'}；
 * - **零发送调用**：本模块不 import 任何发送接口，不做网络/子进程调用——
 *   将来接入发送 worker 时另行评审（no-send 红线原样保留）；
 * - tailOutbox(n) 只读（读文件尾部 n 条），供 `outbox tail` 查看辅助；
 * - 写入经 Store.appendJsonl（assertInsideState 围栏 + 单一 fs 入口）。
 */
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
  /** 证据指针（报告 md 路径 / msg_id 等，透传调用方） */
  evidence_ref: string
  status: 'pending'
}

/** appendOutbox 的入参（ts/channel/status 由本模块补全，调用方不给篡改口） */
export interface OutboxAppendInput {
  kind: string
  title: string
  body: string
  evidence_ref: string
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
    }
    return this.options.store.appendJsonl(OUTBOX_REL, entry) ? entry : null
  }

  /** 只读：取末尾 n 条（n<=0 返回 []）；文件不存在/损坏行跳过，不抛出。 */
  tailOutbox(n: number): OutboxEntry[] {
    const limit = Math.max(0, Math.floor(n))
    if (limit === 0) return []
    const raw = this.options.store.readText(OUTBOX_REL)
    if (!raw) return []
    const out: OutboxEntry[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try {
        const v = JSON.parse(t) as OutboxEntry
        if (v && typeof v === 'object' && typeof v.kind === 'string') out.push(v)
      } catch {
        /* 损坏行跳过（追加写被截断的尾行等） */
      }
    }
    return out.slice(-limit)
  }
}
