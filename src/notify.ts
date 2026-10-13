/**
 * notify.ts：macOS 系统通知通道（M1-T1.4）。
 *
 * 边界（TECH-DESIGN / 实施计划红线）：
 * - 仅 macOS 通知中心：osascript `display notification`，只弹给本机当前用户，
 *   不触碰任何微信通道、不发送任何消息（no-send 红线不动）；
 * - 经 child_process.execFile 调用（参数数组，绝不 shell 拼接——标题/正文
 *   任何内容都不会被 shell 解释，注入文本无法逃逸成命令）；
 * - title/body 截断（MAX_TITLE_CHARS / MAX_BODY_CHARS），超长取前段；
 * - dry_run（配置或构造参数）：只记日志不弹通知，供离线测试与灰度开启；
 * - 审计纪律：日志只记元数据（时间 + kind），绝不记标题/正文内容。
 */
import { execFile } from 'node:child_process'
import type { Store } from './store.js'

/** 通知日志走宿主 logger（ctx.logger，含 info）；比 StoreLogger 多 info 一档 */
export interface NotifyLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

export const MAX_TITLE_CHARS = 40
export const MAX_BODY_CHARS = 200

/** 通知审计落盘的相对路径（只写元数据行） */
export const NOTIFY_AUDIT_REL = 'notify/audit.jsonl'

/** 截断：超长取前 n 字 */
export function clampText(value: string, n: number): string {
  return value.length > n ? value.slice(0, n) : value
}

export interface NotifyOptions {
  logger: NotifyLogger
  /** dry_run：true = 只记日志不弹通知（配置 notifyDryRun 或测试注入） */
  dryRun?: boolean
  /** 持久化审计行（可缺省 = 只记 logger） */
  store?: import('./store.js').Store
  /** 时钟注入（测试） */
  now?: () => number
  /** execFile 注入（测试 mock；默认 node:child_process.execFile） */
  execFileFn?: typeof execFile
}

export interface NotifyResult {
  shown: boolean
  dryRun: boolean
}

export class SystemNotifier {
  private readonly dryRun: boolean
  private readonly now: () => number
  private readonly execFileFn: typeof execFile

  constructor(private readonly options: NotifyOptions) {
    this.dryRun = options.dryRun ?? false
    this.now = options.now ?? (() => Date.now())
    this.execFileFn = options.execFileFn ?? execFile
  }

  /**
   * 发一条系统通知。kind 是调度/业务种类（daily/weekly/monthly/remind...），
   * 只进审计元数据，不与标题正文一起落盘。
   * 返回 shown（dry_run / 失败均为 false），绝不抛出（不拖垮宿主）。
   */
  async notify(kind: string, title: string, body: string): Promise<NotifyResult> {
    const t = this.now()
    const ts = new Date(t).toISOString()
    // 审计：只记元数据（时间 + kind），不记标题/正文
    this.options.store?.ensureDir('notify')
    this.options.store?.appendJsonl(NOTIFY_AUDIT_REL, { ts, kind, dryRun: this.dryRun })

    if (this.dryRun) {
      this.options.logger.info(`notify[${kind}] dry_run at ${ts} (content not logged)`)
      return { shown: false, dryRun: true }
    }

    const safeTitle = clampText(title, MAX_TITLE_CHARS)
    const safeBody = clampText(body, MAX_BODY_CHARS)
    // execFile：参数数组直接传 osascript，无 shell，无拼接
    const script =
      `display notification ${JSON.stringify(safeBody)} with title ${JSON.stringify(safeTitle)}`
    try {
      await new Promise<void>((resolve, reject) => {
        this.execFileFn('osascript', ['-e', script], (error) => (error ? reject(error) : resolve()))
      })
      this.options.logger.info(`notify[${kind}] shown at ${ts}`)
      return { shown: true, dryRun: false }
    } catch (error) {
      this.options.logger.warn(`notify[${kind}] failed at ${ts}: ${String(error)}`)
      return { shown: false, dryRun: false }
    }
  }
}
