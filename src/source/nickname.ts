/**
 * nickname.ts（W3）：wxid → 群内显示昵称解析器。
 *
 * ## 映射链结论（spikes/contact-schema.mjs 实测，WeChat 4.x macOS contact.db）
 *
 * chatroom_member(room_id INTEGER, member_id INTEGER) 两列都是整数：
 *   - room_id   = contact.id（该 @chatroom 在 contact 表的主键）；
 *   - member_id = name2id.rowid（name2id(username TEXT PRIMARY KEY) 的隐式 rowid，
 *     **不是** contact.username 本身——直接按 username join 会得到空集）；
 *   - encrypt_name2id 在实测库为空表，无需中转。
 * 正确 join：chatroom_member.member_id → name2id.rowid → name2id.username → contact.username。
 *
 * ## 密钥纪律（红线）
 *
 * - enc_key 从工具的 keys.json（keys["contact/contact.db"].enc_key，64 hex）读取后
 *   仅存于实例私有字段 #encKey；绝不进 logger / 异常消息 / 测试快照 / git；
 * - 密钥经 **stdin**（PRAGMA key="x'…'"）传给 sqlcipher 子进程，不出现在 argv（防 ps 泄露）；
 * - 打开方式只读：URI `file:…?mode=ro` + `PRAGMA query_only=ON`。
 *
 * ## 降级
 *
 * contact.db 打不开 / 查不到 / 输出解析失败 → 返回原 sender_id 并 logger.warn，
 * 读取主流程不因此中断（WechatDbSource 侧也兜底）。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { redactHexRuns } from '../guard.js'

export interface NicknameLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

/** 子进程执行结果（可注入 mock） */
export interface SqlRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * sqlcipher 执行器：spawn(sqlcipherPath, argv)，把 stdin 全文写给子进程。
 * 测试注入 mock 以断言 argv 无密钥、stdin 含 PRAGMA。
 */
export type SqlRunner = (argv: readonly string[], stdin: string) => Promise<SqlRunResult>

/** keys.json 读取器（测试可注入；默认同步读文件并取 enc_key） */
export type KeyReader = (keysJsonPath: string) => string

export interface NicknameResolverOptions {
  /** contact.db 绝对路径 */
  contactDbPath: string
  /** 工具的 keys.json 绝对路径（keys["contact/contact.db"].enc_key） */
  keysJsonPath: string
  logger: NicknameLogger
  /** sqlcipher 可执行文件（默认 PATH 上的 sqlcipher） */
  sqlcipherPath?: string
  /** 每群映射缓存 TTL ms，默认 10 分钟；群成员变动靠 TTL 自然刷新 */
  ttlMs?: number
  /** 子进程超时 ms，默认 10_000 */
  timeoutMs?: number
  /** 可注入执行器（测试 mock） */
  runner?: SqlRunner
  /** 可注入 key 读取（测试 mock；默认读 keys.json） */
  readKey?: KeyReader
  /** 可注入时钟（测试） */
  now?: () => number
}

/** 默认 keys.json 读取：失败抛**不含密钥**的错误（密钥内容绝不进异常文本） */
export function defaultReadKey(keysJsonPath: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(keysJsonPath, 'utf8'))
  } catch (error) {
    throw new Error(`nickname: cannot read keys.json at ${keysJsonPath} (${(error as NodeJS.ErrnoException).code ?? 'parse error'})`)
  }
  const entry = (parsed as { keys?: Record<string, { enc_key?: unknown }> })?.keys?.[
    'contact/contact.db'
  ]
  const key = entry?.enc_key
  if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('nickname: keys.json has no valid enc_key for contact/contact.db')
  }
  return key
}

/** 默认执行器：spawn sqlcipher，stdin 送 PRAGMA/SQL，超时 SIGKILL */
export function createSqlRunner(options: {
  sqlcipherPath: string
  timeoutMs: number
}): SqlRunner {
  const { sqlcipherPath, timeoutMs } = options
  return (argv, stdin) =>
    new Promise<SqlRunResult>((resolveRun) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const child = spawn(sqlcipherPath, [...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
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
      child.stdin?.on('error', () => undefined) // EPIPE 等不中断
      child.stdin?.end(stdin, 'utf8')
    })
}

/**
 * sqlcipher tabs 模式会给含特殊字符（如中文）的值加双引号（内部 `"` 翻倍转义）。
 * 去掉这层引号还原原值。
 */
function unquoteTabsField(field: string): string {
  if (field.length >= 2 && field.startsWith('"') && field.endsWith('"')) {
    return field.slice(1, -1).replaceAll('""', '"')
  }
  return field
}

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_TIMEOUT_MS = 10_000
/** chatId 形态校验：数字串 + @chatroom（防 SQL 注入；通过后才允许嵌入 SQL 文本） */
const CHATROOM_ID_PATTERN = /^\d+@chatroom$/

interface CacheEntry {
  map: Map<string, string>
  expiresAt: number
}

export class NicknameResolver {
  /** 密钥仅存于此私有字段，任何日志/异常/快照不得引用 */
  readonly #encKey: string
  private readonly contactDbPath: string
  private readonly logger: NicknameLogger
  private readonly runner: SqlRunner
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: NicknameResolverOptions) {
    this.contactDbPath = options.contactDbPath
    this.logger = options.logger
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? (() => Date.now())
    this.runner =
      options.runner ??
      createSqlRunner({
        sqlcipherPath: options.sqlcipherPath ?? 'sqlcipher',
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
    // 构造即取钥；失败抛出的错误不含密钥内容（defaultReadKey 保证）。
    this.#encKey = (options.readKey ?? defaultReadKey)(options.keysJsonPath)
  }

  /**
   * 取某群的 wxid → display name 映射（remark 非空优先，否则 nick_name，兜底 username）。
   * 带 TTL 缓存；失败降级为空映射并 warn（不抛错，读取主流程不中断）。
   */
  async resolveGroup(chatId: string): Promise<Map<string, string>> {
    if (!CHATROOM_ID_PATTERN.test(chatId)) {
      throw new Error(`nickname: invalid chatId form (expected "<digits>@chatroom"), refuse to query`)
    }
    const cached = this.cache.get(chatId)
    if (cached && cached.expiresAt > this.now()) return cached.map
    let map = new Map<string, string>()
    try {
      map = await this.queryGroup(chatId)
    } catch (error) {
      // 降级：返回空映射（lookup 会回落原 sender_id）；异常文本可能含 stderr，回显前
      // 统一过 redactHexRuns 脱敏（ERR-SRC-009，与 wechat-db 两处回显点同构覆盖）。
      this.logger.warn(`nickname resolve failed for ${chatId}, degrade to raw ids: ${redactHexRuns(String(error).slice(0, 200))}`)
      map = new Map<string, string>()
    }
    this.cache.set(chatId, { map, expiresAt: this.now() + this.ttlMs })
    return map
  }

  /** 单个 wxid 查显示名；查不到（或整群降级）→ 原样返回并 warn（一次一条，不中断） */
  async lookup(chatId: string, wxid: string): Promise<string> {
    const map = await this.resolveGroup(chatId)
    const name = map.get(wxid)
    if (name !== undefined) return name
    this.logger.warn(`nickname miss: ${wxid} not found in ${chatId} member map, using raw id`)
    return wxid
  }

  /** 手动作废缓存（群成员变动时可显式调用；否则靠 TTL 自然刷新） */
  invalidate(chatId?: string): void {
    if (chatId === undefined) this.cache.clear()
    else this.cache.delete(chatId)
  }

  /** 纯元数据（接入 getStatus）：绝不含密钥/昵称内容 */
  status(): { cachedGroups: number; ttlMs: number } {
    return { cachedGroups: this.cache.size, ttlMs: this.ttlMs }
  }

  /**
   * 实际查询。chatId 已过形态校验（仅数字+@chatroom）才嵌入 SQL —— 注入安全。
   * 密钥仅进 stdin；argv 只有只读 db URI。
   */
  private async queryGroup(chatId: string): Promise<Map<string, string>> {
    const sql = `SELECT c.username, COALESCE(NULLIF(TRIM(c.remark), ''), c.nick_name, c.username)
FROM chatroom_member m
JOIN name2id n ON n.rowid = m.member_id
JOIN contact c ON c.username = n.username
WHERE m.room_id = (SELECT id FROM contact WHERE username = '${chatId}')`
    const stdin = [
      // 密钥经 stdin 传递（防 ps 泄露）；只读打开
      `PRAGMA key="x'${this.#encKey}'";`,
      'PRAGMA cipher_compatibility=4;',
      'PRAGMA query_only=ON;',
      '.mode tabs',
      sql + ';',
      '',
    ].join('\n')
    const result = await this.runner([`file:${this.contactDbPath}?mode=ro`], stdin)
    if (result.code !== 0) {
      throw new Error(`sqlcipher exited ${result.code}`)
    }
    const map = new Map<string, string>()
    for (const line of result.stdout.split('\n')) {
      if (line === '' || line === 'ok') continue // 'ok' 为 PRAGMA 回显
      const tab = line.indexOf('\t')
      if (tab <= 0) continue
      const username = unquoteTabsField(line.slice(0, tab))
      const display = unquoteTabsField(line.slice(tab + 1))
      if (username !== '' && display !== '') map.set(username, display)
    }
    return map
  }
}
