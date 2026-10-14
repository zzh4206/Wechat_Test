/**
 * retention.ts：messages 保留期滚动清理（T1.1 遗留，M6-T1）。
 *
 * 安全约定：
 * - 只删 messages 行（ts < now - retentionDays）；events/tasks/promises/files/
 *   topic_clusters/person_digests 等长期保留数据（只含摘要与 ≤50 字引用）一律不动；
 * - 被长期表引用的 message 行（evidence/quote/files.msg_id 等）不删——保留期不破坏引用完整性；
 * - 清理动作只记 audit 元数据（时间、群、删除条数），绝不记任何消息内容；
 * - 每日一次（注入时钟 + setInterval 24h），start() 返回清理函数 → dispose 无定时器残留。
 */
import type { GroupStoreService } from './group-store.js'
import type { Store } from './store.js'

export interface RetentionLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** 清理审计落盘相对路径（元数据 only：无内容字段） */
export const RETENTION_AUDIT_REL = 'retention/audit.jsonl'

export interface RetentionOptions {
  groupStore: GroupStoreService
  /** 项目内唯一 fs 写入点（audit 元数据经它落盘） */
  store: Store
  /** 白名单群（只清理这些群的桶；与读取面同界，绝不越界） */
  groups: readonly string[]
  /** Config.retentionDays：messages 滚动保留天数（默认 90） */
  retentionDays?: number
  logger: RetentionLogger
  /** 注入时钟（测试） */
  now?: () => number
  /** 心跳间隔 ms（默认 24h；测试可注入小值） */
  intervalMs?: number
}

export interface RetentionRunResult {
  ran: boolean
  /** chatId → 本次删除条数（仅成功群计入） */
  deleted: Record<string, number>
}

const DAY_MS = 86_400_000

export class RetentionService {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly retentionMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: RetentionOptions) {
    this.now = options.now ?? (() => Date.now())
    this.intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? DAY_MS))
    const days = Math.max(1, Math.floor(options.retentionDays ?? 90))
    this.retentionMs = days * DAY_MS
  }

  /**
   * 执行一轮清理：对白名单每个群删除 cutoff 之前、且未被长期表引用的 messages 行。
   * 单群失败只 warn，不影响其他群；审计元数据逐群落盘。
   */
  async run(): Promise<RetentionRunResult> {
    const cutoff = this.now() - this.retentionMs
    this.options.store.ensureDir('retention') // 审计目录（appendJsonl 不建父目录）
    const deleted: Record<string, number> = {}
    for (const chatId of this.options.groups) {
      try {
        deleted[chatId] = await this.options.groupStore.deleteMessagesBefore(chatId, cutoff)
        this.options.store.appendJsonl(RETENTION_AUDIT_REL, {
          ts: this.now(),
          chatId,
          beforeTs: cutoff,
          deleted: deleted[chatId],
        })
      } catch (error) {
        this.options.logger.warn(`retention cleanup failed for ${chatId}: ${String(error)}`)
      }
    }
    return { ran: true, deleted }
  }

  /** 启动：先立即跑一轮，再按 intervalMs 心跳（默认每日一次）。返回清理函数。 */
  start(): () => void {
    if (this.timer) return () => this.stop()
    void this.run().catch((error: unknown) =>
      this.options.logger.warn(`retention initial run failed: ${String(error)}`),
    )
    this.timer = setInterval(() => {
      void this.run().catch((error: unknown) =>
        this.options.logger.warn(`retention scheduled run failed: ${String(error)}`),
      )
    }, this.intervalMs)
    this.options.logger.info(`retention started (days=${Math.round(this.retentionMs / DAY_MS)})`)
    return () => this.stop()
  }

  /** 停止心跳（幂等；dispose 无定时器残留保证点） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
