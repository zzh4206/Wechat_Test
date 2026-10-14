/**
 * sender.ts：filehelper 发送 worker（红线升级 2026-10-14 用户批准：no-send → 仅 filehelper 一个受控出口）。
 *
 * 边界（本文件是项目里**唯一**允许发起微信发送的模块）：
 * - 通道白名单**代码级硬编码** ALLOWED_CHANNELS = ['filehelper']——其他 channel 的
 *   outbox 条目永远不发（直接 skip 并 error 日志），绝不发群聊；
 * - 消费 outbox 中 status='pending' && channel='filehelper' 的条目，经外部工具
 *   wechat-ui send（spawn 参数数组，绝不 shell 拼接）发送到"文件传输助手"；
 * - 文本策略：wechat-ui 限短文本（≤200 字符单行）——发送内容 = `【lurker】<title>` +
 *   至多 160 字摘要，绝不发全文（全文在本地 reports/，指针在 evidence_ref）；
 *   换行替换为空格（单行约束）；
 * - 三重闸门（全过才发）：
 *   ① 总闸：Config senderEnabled（默认 false）+ sendDryRun（默认 true，只记日志不调 send）；
 *   ② 通道闸：仅 ALLOWED_CHANNELS；
 *   ③ 交互闸：osascript 查微信是否前台，非前台跳过本轮并计数，连续 N 次后 warn；
 * - 失败重试 ≤3 次（attempts 落盘 outbox 行），超限 status='failed' 不再重试（防风暴）；
 *   wechat-ui --id 用 outbox 条目唯一 id（幂等：工具侧重复 id 不重发）；
 * - 频控：maxSendsPerDay（默认 20）超限的当日 pending 标 'skipped_quota'；
 * - 审计纪律：audit/sender.jsonl 只记元数据（outbox id / 结果 / attempts），绝不记正文；
 * - 零第三方依赖；定时器 start() → 清理函数约定，dispose 无残留。
 */
import { execFile } from 'node:child_process'
import type { Outbox, OutboxEntry } from './outbox.js'

/** 通道白名单：硬编码，唯一出口 */
export const ALLOWED_CHANNELS: readonly string[] = ['filehelper']
/** wechat-ui 目标聊天（唯一白名单目标） */
export const FILEHELPER_CHAT = '文件传输助手'
/** wechat-ui 单行文本上限（UI_GUIDE：最多 200 字符） */
export const MAX_TEXT_CHARS = 200
/** 摘要上限（正文截断） */
export const SUMMARY_CHARS = 160
/** 失败重试上限（≥3 次 → status='failed' 不再重试） */
export const MAX_ATTEMPTS = 3
/** 发送审计落盘相对路径（只写元数据行） */
export const SENDER_AUDIT_REL = 'audit/sender.jsonl'

export interface SenderLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** 截断：超长取前 n 字 */
function clamp(value: string, n: number): string {
  return value.length > n ? value.slice(0, n) : value
}

/**
 * 构造发送文本：`【lurker】<title>` + 至多 160 字摘要（单行、≤MAX_TEXT_CHARS）。
 * 换行/回车/控制字符统一替换为空格；绝不包含全文。
 */
export function buildSendText(title: string, body: string): string {
  const single = (s: string) => s.replace(/[\r\n\t\x00-\x1f]+/g, ' ').trim()
  const head = `【lurker】${single(title)}`
  const summary = clamp(single(body), SUMMARY_CHARS)
  const text = summary !== '' ? `${head} ${summary}` : head
  return clamp(text, MAX_TEXT_CHARS)
}

/** 单次命令执行结果（mock 注入点形状） */
export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface SenderOptions {
  outbox: Outbox
  logger: SenderLogger
  store: import('./store.js').Store
  /** Config.senderEnabled：总闸，默认 false = 零活动 */
  enabled?: boolean
  /** Config.sendDryRun：默认 true = 只记日志/落审计，绝不调 wechat-ui send */
  dryRun?: boolean
  /** Config.maxSendsPerDay（默认 20） */
  maxSendsPerDay?: number
  /** Config.wechatUiPath（默认 'wechat-ui'，PATH 解析；建议绝对路径） */
  wechatUiPath?: string
  /** Config.composerTop（默认 0.70；必须按 UI_GUIDE 实测校准） */
  composerTop?: number
  /** Config.sendIntervalSec（默认 300） */
  intervalSec?: number
  /** 交互闸连续非前台 N 次后 warn（默认 3） */
  frontmostWarnAfter?: number
  /** 命令执行注入（测试 mock；默认 node:child_process execFile） */
  runCommand?: (file: string, args: string[]) => Promise<CommandResult>
  /** 微信前台检测注入（测试 mock；默认 osascript 查询） */
  isFrontmost?: () => Promise<boolean>
  /** 时钟注入（测试） */
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  /** 心跳毫秒（测试可调小；生产按 intervalSec 换算） */
  tickMs?: number
}

export interface SendRoundResult {
  /** 本轮动作：disabled/empty/not_frontmost/dry_run/sent/failed/quota */
  action: string
  processed: number
}

function defaultRunCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(file, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      resolvePromise({
        code: error && typeof (error as NodeJS.ErrnoException).code === 'number' ? (error as unknown as { code: number }).code : (error ? 1 : 0),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      })
    })
    child.on('error', () => {/* 已在回调里给非零 code，不再抛出 */})
  })
}

function defaultIsFrontmost(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('osascript', ['-e', 'application "WeChat" is frontmost'], (error, stdout) => {
      resolvePromise(!error && String(stdout).trim() === 'true')
    })
  })
}

export class SenderService {
  private readonly enabled: boolean
  private readonly dryRun: boolean
  private readonly maxSendsPerDay: number
  private readonly wechatUiPath: string
  private readonly composerTop: number
  private readonly frontmostWarnAfter: number
  private readonly intervalSec: number
  private readonly now: () => number
  private readonly setIntervalFn: typeof setInterval
  private readonly clearIntervalFn: typeof clearInterval
  private readonly tickMs: number
  private readonly runCommandFn: (file: string, args: string[]) => Promise<CommandResult>
  private readonly isFrontmostFn: () => Promise<boolean>
  /** 交互闸：连续非前台轮数（发送成功/前台重置） */
  private consecutiveNotFront = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: SenderOptions) {
    this.enabled = options.enabled ?? false
    this.dryRun = options.dryRun ?? true
    this.maxSendsPerDay = Math.max(0, Math.floor(options.maxSendsPerDay ?? 20))
    this.wechatUiPath = options.wechatUiPath ?? 'wechat-ui'
    this.composerTop = options.composerTop ?? 0.7
    this.frontmostWarnAfter = Math.max(1, Math.floor(options.frontmostWarnAfter ?? 3))
    this.intervalSec = Math.max(1, Math.floor(options.intervalSec ?? 300))
    this.now = options.now ?? (() => Date.now())
    this.setIntervalFn = options.setInterval ?? setInterval
    this.clearIntervalFn = options.clearInterval ?? clearInterval
    this.tickMs = options.tickMs ?? this.intervalSec * 1000
    this.runCommandFn = options.runCommand ?? defaultRunCommand
    this.isFrontmostFn = options.isFrontmost ?? defaultIsFrontmost
  }

  /** 本地自然日 key（与 person-digest.localDayKey 同口径，避免跨模块依赖自实现） */
  private dayKey(ts: number): string {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  /** 审计一行：只记元数据（outbox id / 结果 / attempts），绝不记正文 */
  private audit(entry: Record<string, unknown>): void {
    this.options.store.ensureDir('audit')
    this.options.store.appendJsonl(SENDER_AUDIT_REL, { ts: new Date(this.now()).toISOString(), ...entry })
  }

  /**
   * 发送单条 outbox 条目（与消费循环完全同一路径：dry_run / 幂等 --id / 状态机 / 审计）。
   * 闸门（总闸/通道闸/交互闸/频控）由调用方先过；这里只负责"怎么发"。
   */
  private async sendEntry(entry: OutboxEntry): Promise<{ action: string }> {
    const id = entry.id ?? ''
    if (id === '') {
      this.options.logger.error('sender: entry without id — skipped (cannot send idempotently)')
      return { action: 'failed' }
    }
    // 文本策略：短文本单行，绝不发全文
    const text = buildSendText(entry.title ?? '', entry.body ?? '')
    // dry_run：只记日志/审计，不调 send（条目标记 dry_run 消费掉，避免反复扫描）
    if (this.dryRun) {
      this.options.outbox.updateSendState(id, { status: 'dry_run' })
      this.audit({ id, kind: entry.kind, result: 'dry_run' })
      this.options.logger.info(`sender[dry_run] would send id=${id} kind=${entry.kind} (content not logged)`)
      return { action: 'dry_run' }
    }
    const result = await this.runCommandFn(this.wechatUiPath, [
      'send',
      '--chat', FILEHELPER_CHAT,
      '--text', text,
      '--id', id, // outbox 唯一 id：工具侧幂等，重复不重发
      '--composer-top', String(this.composerTop),
    ])
    const ok = result.code === 0 && result.stdout.includes('sent_ui_verified')
    const attempts = (entry.attempts ?? 0) + 1
    if (ok) {
      this.options.outbox.updateSendState(id, { status: 'sent', attempts })
      this.audit({ id, kind: entry.kind, result: 'sent', attempts })
      this.options.logger.info(`sender: sent id=${id} kind=${entry.kind} (ui_verified, content not logged)`)
      return { action: 'sent' }
    }
    const status: OutboxEntry['status'] = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
    this.options.outbox.updateSendState(id, { status, attempts })
    this.audit({ id, kind: entry.kind, result: 'send_failed', attempts })
    this.options.logger.error(`sender: send failed id=${id} attempts=${attempts}${status === 'failed' ? ' — marked failed, no more retries' : ''}`)
    return { action: 'failed' }
  }

  /**
   * 样例发送（与真实日报解耦的链路验证入口，挂 groupLurker.sender）：
   * 向 outbox 插入一条合成样例（channel='filehelper'、kind='test_sample'、body 带时间戳），
   * 然后立即走与真实条目完全相同的发送链路（三重闸门/频控/幂等/状态机全一致），
   * 不触碰任何真实 pending 条目。绝不抛出；返回 { action, id }。
   */
  async sendTestSample(): Promise<{ action: string; id: string }> {
    if (!this.enabled) {
      this.options.logger.info('sender disabled (senderEnabled=false) — sendTestSample refused (zero send activity)')
      return { action: 'disabled', id: '' }
    }
    const appended = this.options.outbox.appendOutbox({
      kind: 'test_sample',
      title: '【测试样例】发送链路验证',
      body: `发送链路样例，时间戳 ${new Date(this.now()).toISOString()}。收到即链路通，全文不影响任何真实报告。`,
      evidence_ref: 'test',
    })
    if (!appended?.id) return { action: 'failed', id: '' }
    const id = appended.id
    // ② 通道闸（样例恒为 filehelper，但走同一硬编码白名单检查）
    if (!ALLOWED_CHANNELS.includes(appended.channel)) {
      this.options.outbox.updateSendState(id, { status: 'skipped_channel' })
      return { action: 'skipped_channel', id }
    }
    // 频控：样例同样占用当日配额（超限标 skipped_quota，不开后门）
    const all = this.options.outbox.listOutbox()
    const today = this.dayKey(this.now())
    const sentToday = all.filter((e) => e.status === 'sent' && e.ts !== undefined && this.dayKey(Date.parse(e.ts) || 0) === today).length
    if (sentToday >= this.maxSendsPerDay) {
      this.options.outbox.updateSendState(id, { status: 'skipped_quota' })
      this.audit({ id, result: 'skipped_quota' })
      this.options.logger.warn(`sender: daily quota ${this.maxSendsPerDay} reached — test sample marked skipped_quota`)
      return { action: 'quota', id }
    }
    // ③ 交互闸：微信必须前台（文件传输助手窗口可见）
    let frontmost = true
    try {
      frontmost = await this.isFrontmostFn()
    } catch {
      frontmost = false
    }
    if (!frontmost) {
      this.consecutiveNotFront += 1
      if (this.consecutiveNotFront >= this.frontmostWarnAfter) {
        this.options.logger.warn('sender: WeChat not frontmost — 请手动打开微信"文件传输助手"窗口后重试 sendTestSample')
      }
      this.audit({ id, result: 'not_frontmost', streak: this.consecutiveNotFront })
      return { action: 'not_frontmost', id }
    }
    this.consecutiveNotFront = 0
    const r = await this.sendEntry(this.options.outbox.listOutbox().find((e) => e.id === id) ?? appended)
    return { action: r.action, id }
  }

  /**
   * 消费一轮 pending 的 filehelper 条目。三重闸门按序检查，绝不抛出（不拖垮宿主）。
   */
  async processOnce(): Promise<SendRoundResult> {
    // ① 总闸：未启用 = 零活动
    if (!this.enabled) return { action: 'disabled', processed: 0 }

    const all = this.options.outbox.listOutbox()
    // ② 通道闸：白名单外条目直接 skip 并 error 日志（硬编码红线，永不发送）
    for (const entry of all) {
      if (entry.status === 'pending' && !ALLOWED_CHANNELS.includes(entry.channel)) {
        this.options.logger.error(`sender: channel "${entry.channel}" not in allowlist — skipped, never sent (id=${entry.id ?? '?'})`)
        this.options.outbox.updateSendState(entry.id ?? '', { status: 'skipped_channel' })
        this.audit({ id: entry.id ?? '', result: 'skipped_channel', channel: entry.channel })
      }
    }

    const pending = all.filter((e) => e.status === 'pending' && e.channel === 'filehelper')
    if (pending.length === 0) return { action: 'empty', processed: 0 }

    // 频控：今日已发送条数 → 预算外的当日 pending 标 skipped_quota
    const today = this.dayKey(this.now())
    const sentToday = all.filter((e) => e.status === 'sent' && e.ts !== undefined && this.dayKey(Date.parse(e.ts) || 0) === today).length
    let budget = Math.max(0, this.maxSendsPerDay - sentToday)
    if (budget === 0) {
      for (const entry of pending) {
        this.options.outbox.updateSendState(entry.id ?? '', { status: 'skipped_quota' })
        this.audit({ id: entry.id ?? '', result: 'skipped_quota' })
      }
      this.options.logger.warn(`sender: daily quota ${this.maxSendsPerDay} reached — ${pending.length} pending marked skipped_quota`)
      return { action: 'quota', processed: 0 }
    }
    const overQuota = pending.slice(budget)
    for (const entry of overQuota) {
      this.options.outbox.updateSendState(entry.id ?? '', { status: 'skipped_quota' })
      this.audit({ id: entry.id ?? '', result: 'skipped_quota' })
    }
    const batch = pending.slice(0, budget)

    // ③ 交互闸：微信必须前台（文件传输助手窗口可见）
    let frontmost = true
    try {
      frontmost = await this.isFrontmostFn()
    } catch {
      frontmost = false
    }
    if (!frontmost) {
      this.consecutiveNotFront += 1
      if (this.consecutiveNotFront >= this.frontmostWarnAfter) {
        this.options.logger.warn(`sender: WeChat not frontmost ${this.consecutiveNotFront} rounds — 请手动打开微信"文件传输助手"窗口（本轮 ${batch.length} 条暂缓）`)
      }
      this.audit({ result: 'not_frontmost', streak: this.consecutiveNotFront, deferred: batch.length })
      return { action: 'not_frontmost', processed: 0 }
    }
    this.consecutiveNotFront = 0

    let sent = 0
    let failed = 0
    for (const entry of batch) {
      const r = await this.sendEntry(entry)
      if (r.action === 'sent' || r.action === 'dry_run') sent += 1
      else failed += 1
    }
    return { action: failed > 0 ? 'failed' : 'sent', processed: sent + failed }
  }

  /**
   * 启动消费心跳。senderEnabled=false 时返回 noop（零活动）。
   * 返回清理函数（clearInterval 唯一释放点），由 index.ts 挂进 ctx.effect。
   */
  start(): () => void {
    if (!this.enabled) {
      this.options.logger.info('sender disabled (senderEnabled=false) — outbox stays local, zero send activity')
      return () => {}
    }
    this.timer = this.setIntervalFn(() => {
      void this.processOnce().catch((error: unknown) => {
        this.options.logger.error(`sender tick failed: ${String(error)}`)
      })
    }, this.tickMs)
    this.options.logger.info(`sender started (interval=${this.intervalSec}s, dryRun=${this.dryRun}, maxPerDay=${this.maxSendsPerDay}, chat=${FILEHELPER_CHAT})`)
    void this.processOnce().catch((error: unknown) => {
      this.options.logger.error(`sender first tick failed: ${String(error)}`)
    })
    return () => {
      if (this.timer !== null) {
        this.clearIntervalFn(this.timer)
        this.timer = null
      }
      this.consecutiveNotFront = 0
    }
  }
}

/** Config 侧组装用：intervalSec → SenderOptions */
export interface SenderConfigInput {
  senderEnabled: boolean
  sendDryRun: boolean
  sendIntervalSec: number
  maxSendsPerDay: number
  wechatUiPath: string
  composerTop: number
}

export function senderOptionsFromConfig(options: {
  config: SenderConfigInput
  outbox: Outbox
  store: import('./store.js').Store
  logger: SenderLogger
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  tickMs?: number
}): SenderOptions {
  return {
    outbox: options.outbox,
    store: options.store,
    logger: options.logger,
    enabled: options.config.senderEnabled,
    dryRun: options.config.sendDryRun,
    maxSendsPerDay: options.config.maxSendsPerDay,
    wechatUiPath: options.config.wechatUiPath,
    composerTop: options.config.composerTop,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    tickMs: options.tickMs,
  }
}
