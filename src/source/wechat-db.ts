/**
 * wechat-db.ts（W2）：微信本地库只读消息源适配器。
 *
 * 管控三原则（REPORT-wechat-db-plan §0）在本文件内的落点：
 * 1. 默认全拒：白名单（Config.groups，chatId 数组）为空 → 构造即抛错（fail-closed）；
 *    不在白名单的 chatId，任何子进程调用（read/resolve）都不发出——gate() 是每个读取路径的第一行；
 * 2. 白名单 = 用户手工维护的显式 chatId 清单，本适配器不做任何"发现新群"类操作；
 * 3. 可审计：每次读取经 store 写 <stateDir>/audit.log，仅 {ts, chatId, count, ok}，绝不记消息内容。
 *
 * 其他约定：
 * - 读取经外部工具 CLI（macos-wechat-export 的 wechat_db.py）子进程完成，本插件不重写解密层、
 *   不读取/不拷贝 keys.json、绝不动 WeChat 进程/窗口；
 * - 子进程带超时，连续失败按指数退避；
 * - 定时器经 start() 返回清理函数（clearInterval），由宿主包进 ctx.effect()（沿用 distiller 约定）；
 * - 单实例：stateDir 下独占创建锁文件（fs.open 'wx' 简化 flock），重复启动拒绝；
 * - 消息结构对齐管线：{chatId, sender(=sender_id), senderName(=sender_id，W3 映射昵称),
 *   text, messageId(=server_id), ts(=create_time)}，经 onMessages 交给 bus 同款下游
 *   （sanitize → 令牌桶 → buffer → distiller）。
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store.js'

export interface WechatDbSourceLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** 适配器产出的消息（结构对齐 bus/ingest 下游） */
export interface WechatDbMessage {
  chatId: string
  sender: string
  senderName: string
  text: string
  messageId: string
  ts: number
}

/** 子进程运行结果（可注入 mock） */
export interface CliRunResult {
  code: number
  stdout: string
  stderr: string
}

/** 子进程运行器：接收 wechat_db.py 的子命令参数（不含 python/脚本路径本身） */
export type CliRunner = (args: readonly string[]) => Promise<CliRunResult>

export interface WechatDbSourceOptions {
  /** 白名单（chatId，xxx@chatroom）。空 = fail-closed，构造抛错 */
  groups: readonly string[]
  /** 外部工具的 --db-root（微信 db_storage 绝对路径） */
  dbRoot: string
  /** 项目内唯一 fs 写入点（审计日志经它落盘） */
  store: Store
  /** stateDir 绝对路径（锁文件放这里） */
  stateDir: string
  logger: WechatDbSourceLogger
  /** 子进程运行器（测试注入 mock；默认 spawn 真实 CLI） */
  runner?: CliRunner
  /** 外部工具目录（含 wechat_db.py） */
  toolDir?: string
  /** python 解释器路径 */
  pythonPath?: string
  /** 子进程超时 ms（默认 runner 用） */
  timeoutMs?: number
  /** 轮询间隔 ms，默认 10_000 */
  pollIntervalMs?: number
  /** 每次 read 的 --limit，默认 50 */
  readLimit?: number
  /** 退避基数 ms（默认取 pollIntervalMs） */
  backoffBaseMs?: number
  /** 退避上限 ms，默认 5 分钟 */
  backoffMaxMs?: number
  /** 可注入时钟（测试） */
  now?: () => number
  /** 产出消息的下游回调（index.ts 里接 bus.ingest） */
  onMessages: (messages: WechatDbMessage[]) => void
}

/** wechat_db.py read 输出的单行 JSON（只取我们关心的字段） */
interface RawReadMessage {
  server_id?: unknown
  create_time?: unknown
  sender_id?: unknown
  text?: unknown
}

const DEFAULT_POLL_INTERVAL_MS = 10_000
const DEFAULT_READ_LIMIT = 50
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 30_000
/** 每群 in-memory 去重上限（W4 会换成持久化游标，这里只防轮询重复投递） */
const DEDUPE_CAP = 2000

/**
 * 默认子进程运行器：spawn(python, [wechat_db.py, ...args])，超时 SIGKILL。
 * 只读 CLI，不传 --key-file（密钥由工具在自身目录 .wechat-local/ 解析，本插件零接触）。
 */
export function createCliRunner(options: {
  pythonPath: string
  toolDir: string
  timeoutMs: number
}): CliRunner {
  const { pythonPath, toolDir, timeoutMs } = options
  const script = join(toolDir, 'wechat_db.py')
  return (args) =>
    new Promise<CliRunResult>((resolveRun) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const child = spawn(pythonPath, [script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveRun({ code: timedOut ? 124 : code, stdout, stderr })
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        stderr += String(error)
        finish(-1)
      })
      child.on('close', (code) => {
        finish(code ?? -1)
      })
    })
}

export class WechatDbSource {
  private readonly whitelist: Set<string>
  private readonly dbRoot: string
  private readonly store: Store
  private readonly stateDir: string
  private readonly logger: WechatDbSourceLogger
  private readonly runner: CliRunner
  private readonly pollIntervalMs: number
  private readonly readLimit: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly now: () => number
  private readonly onMessages: (messages: WechatDbMessage[]) => void

  /** 每群已见 messageId（防轮询重复投递；W4 换持久化游标） */
  private readonly seen = new Map<string, Set<string>>()
  /** 单实例锁文件 fd（start 时获取，stop 释放） */
  private lockFd: number | null = null
  private _running = false
  private consecutiveFailures = 0
  private lastPollAt: number | null = null
  private nextAttemptAt = 0

  constructor(options: WechatDbSourceOptions) {
    // —— 白名单硬闸门：适配器第一行 ——
    if (!options.groups || options.groups.length === 0) {
      throw new Error(
        'wechat-db source: whitelist (groups) is empty — fail-closed, refusing to start',
      )
    }
    if (typeof options.onMessages !== 'function') {
      throw new Error('wechat-db source: onMessages callback is required')
    }
    this.whitelist = new Set(options.groups)
    this.dbRoot = options.dbRoot
    this.store = options.store
    this.stateDir = options.stateDir
    this.logger = options.logger
    this.runner =
      options.runner ??
      createCliRunner({
        pythonPath: options.pythonPath ?? 'python3.14',
        toolDir: options.toolDir ?? join(process.cwd(), 'macos-wechat-export'),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.readLimit = options.readLimit ?? DEFAULT_READ_LIMIT
    this.backoffBaseMs = options.backoffBaseMs ?? this.pollIntervalMs
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.now = options.now ?? (() => Date.now())
    this.onMessages = options.onMessages
  }

  /** 闸门：白名单外的 chatId 一律抛错，且不产生任何子进程调用 */
  private gate(chatId: string): void {
    if (!this.whitelist.has(chatId)) {
      throw new Error(
        `wechat-db source: chatId ${chatId} is not in the whitelist — read refused (fail-closed)`,
      )
    }
  }

  /**
   * 单次读取（只导出给测试/显式调用；白名单外抛错、零子进程调用）。
   * 返回本次新见（去重后）的消息；失败抛错。无论成败都写审计行。
   */
  async readOnce(chatId: string, limit = this.readLimit): Promise<WechatDbMessage[]> {
    this.gate(chatId) // 读取路径第一行：先过闸门再谈子进程
    const result = await this.runner([
      '--db-root',
      this.dbRoot,
      'read',
      '--chat-id',
      chatId,
      '--limit',
      String(limit),
    ])
    let fresh: WechatDbMessage[] = []
    let ok = result.code === 0
    if (ok) {
      try {
        fresh = this.parse(chatId, result.stdout)
      } catch (error) {
        ok = false
        this.logger.warn(`wechat-db parse failed for ${chatId}: ${String(error)}`)
      }
    } else {
      this.logger.warn(
        `wechat_db read failed for ${chatId} (code=${result.code}): ${result.stderr.slice(0, 200)}`,
      )
    }
    this.audit(chatId, fresh.length, ok)
    if (!ok) throw new Error(`wechat_db read failed for ${chatId} (code ${result.code})`)
    return fresh
  }

  /** 解析 wechat_db.py read 的 JSON 输出并映射为管线消息（去重） */
  private parse(chatId: string, stdout: string): WechatDbMessage[] {
    const parsed = JSON.parse(stdout) as { messages?: RawReadMessage[] }
    const rows = Array.isArray(parsed.messages) ? parsed.messages : []
    let known = this.seen.get(chatId)
    if (!known) {
      known = new Set()
      this.seen.set(chatId, known)
    }
    const fresh: WechatDbMessage[] = []
    for (const row of rows) {
      // server_id 缺失（未上服务器的本地行）无法稳定去重，跳过
      const messageId = row.server_id
      if (messageId === null || messageId === undefined) continue
      const id = String(messageId)
      if (known.has(id)) continue
      known.add(id)
      const sender = row.sender_id === undefined ? 'unknown' : String(row.sender_id)
      fresh.push({
        chatId,
        sender, // W3 再映射昵称
        senderName: sender,
        text: row.text === null || row.text === undefined ? '' : String(row.text),
        messageId: id,
        ts: typeof row.create_time === 'number' ? row.create_time : 0,
      })
    }
    if (known.size > DEDUPE_CAP) {
      // 粗暴上限：防止长跑内存增长；W4 持久化游标上线后移除
      this.seen.set(chatId, new Set())
    }
    return fresh
  }

  /** 审计：仅元数据 {ts, chatId, count, ok}，绝不记内容 */
  private audit(chatId: string, count: number, ok: boolean): void {
    this.store.appendJsonl('audit.log', { ts: this.now(), chatId, count, ok })
  }

  /**
   * 一轮轮询：顺序读白名单内每个群；处于退避窗口则整轮跳过。
   * 任一群失败 → 连续失败计数 +1 并按指数退避；全成功 → 复位。
   */
  async pollOnce(): Promise<void> {
    const now = this.now()
    if (now < this.nextAttemptAt) return
    let allOk = true
    for (const chatId of this.whitelist) {
      try {
        const fresh = await this.readOnce(chatId)
        if (fresh.length > 0) this.onMessages(fresh)
      } catch {
        allOk = false // readOnce 已 warn + 审计
      }
    }
    this.lastPollAt = now
    if (allOk) {
      this.consecutiveFailures = 0
      this.nextAttemptAt = now + this.pollIntervalMs
    } else {
      this.consecutiveFailures += 1
      const backoff = Math.min(
        this.backoffBaseMs * 2 ** (this.consecutiveFailures - 1),
        this.backoffMaxMs,
      )
      this.nextAttemptAt = now + backoff
      this.logger.error(
        `wechat-db poll failed x${this.consecutiveFailures}, backing off ${backoff}ms`,
      )
    }
  }

  /** 单实例锁：stateDir 下独占创建；已存在则拒绝启动 */
  private acquireLock(): void {
    const lockPath = join(this.stateDir, 'wechat-db.lock')
    try {
      this.lockFd = openSync(lockPath, 'wx')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        throw new Error(
          `wechat-db source: another instance holds ${lockPath} — refusing to start`,
        )
      }
      throw error
    }
  }

  private releaseLock(): void {
    if (this.lockFd === null) return
    try {
      closeSync(this.lockFd)
      unlinkSync(join(this.stateDir, 'wechat-db.lock'))
    } catch (error) {
      this.logger.warn(`wechat-db release lock failed: ${String(error)}`)
    } finally {
      this.lockFd = null
    }
  }

  /**
   * 启动轮询。返回清理函数：clearInterval + 释放锁（沿用 distiller.start() 约定，
   * 由 index.ts 包进 ctx.effect()）。锁被占时抛错（单实例拒绝）。
   */
  start(): () => void {
    if (this._running) return () => undefined
    this.acquireLock()
    this._running = true
    const timer = setInterval(() => {
      void this.pollOnce()
    }, this.pollIntervalMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      this._running = false
      this.releaseLock()
    }
  }

  /** 运行可见性（接入 getStatus；纯元数据） */
  status(): {
    running: boolean
    groups: string[]
    consecutiveFailures: number
    lastPollAt: number | null
    nextAttemptAt: number
  } {
    return {
      running: this._running,
      groups: [...this.whitelist],
      consecutiveFailures: this.consecutiveFailures,
      lastPollAt: this.lastPollAt,
      nextAttemptAt: this.nextAttemptAt,
    }
  }
}
