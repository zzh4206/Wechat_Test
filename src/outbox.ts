/**
 * outbox.ts：发件箱日志替身（M3 提前落地 M4-T4.4 的最小版）。
 *
 * 边界（实施计划 §4-M4-T4.4 / §6 决策 1）：
 * - 所有"本应发往文件传输助手"的内容统一 **追加写** <stateDir>/outbox.jsonl，
 *   schema：{ts, channel:'filehelper', kind, title, body, evidence_ref, status:'pending'}；
 * - **零发送调用**：本模块不 import 任何发送接口，不做网络/子进程调用；
 *   2026-10-14 红线升级后，发送由 src/sender.ts（SenderService，唯一发送出口）消费本箱；
 * - tailOutbox(n) 只读（读文件尾部 n 条），供 `outbox tail` 查看辅助；
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
  /** 证据指针（报告 md 路径 / msg_id 等，透传调用方） */
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
      id: randomUUID(),
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

  /** 只读：全量解析（sender worker 扫 pending/统计当日已发用）；损坏行跳过。 */
  listOutbox(): OutboxEntry[] {
    return this.tailOutbox(Number.MAX_SAFE_INTEGER)
  }

  /**
   * 发送 worker 专用：按 id 推进条目生命周期状态（pending → sent / dry_run / skipped / failed）。
   * 原地重写 outbox.jsonl（逐行 JSON，命中行打补丁）；找不到 id / 写失败返回 false。
   */
  updateSendState(id: string, patch: { status: OutboxStatus; attempts?: number; transmittedAt?: number; verifyAttempts?: number; serverId?: string; sentAt?: number }): boolean {
    if (id === '') return false
    const raw = this.options.store.readText(OUTBOX_REL)
    if (!raw) return false
    const lines = raw.split('\n')
    let hit = false
    const updated = lines.map((line) => {
      if (hit || line.trim() === '') return line
      try {
        const v = JSON.parse(line) as OutboxEntry
        if (v && typeof v === 'object' && v.id === id) {
          hit = true
          return JSON.stringify({ ...v, ...patch })
        }
      } catch {
        /* 损坏行原样保留 */
      }
      return line
    })
    if (!hit) return false
    return this.options.store.writeText(OUTBOX_REL, updated.join('\n'))
  }
}
