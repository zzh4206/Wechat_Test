/**
 * group-store.ts：每群独立 SQLite 数据桶（D2 报告 M1-T1.1）。
 *
 * 设计约定（docs/技术报告-D2分析与提醒助手实施计划.md §2 §3）：
 * - 用 Node ≥24 内置 node:sqlite（零第三方依赖）；
 * - 库文件 `<stateDir>/groups/<chatId>/store.db`，每群独立；
 * - schema 迁移走 PRAGMA user_version（MIGRATIONS 有序数组，单调推进，只前不退）；
 * - 本任务（M1-T1.1）只暴露 messages 的写入/查询 API；
 *   identities / topic_clusters / events / tasks / promises / files 仅建结构（M2-M5 填 API）；
 * - 全部写操作经单一入口 write()（promise 链串行化，防并发写交错）；
 * - 路径纪律：任何落盘路径先过 assertInsideState（沿用 store.ts 的围栏约定），
 *   外加 chatId 白名单字符校验（防 `..` / `/` 伪装成 chatId）；
 * - 写失败只记 logger，绝不抛致命错误拖垮宿主（与 store.ts 同口径）；
 * - 不发送任何消息，不读取除白名单传入路径外的任何微信数据。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertInsideState } from './guard.js'
import type { StoreLogger } from './store.js'

/** messages.kind 允许值（D2 §3） */
export const MESSAGE_KINDS = ['text', 'image', 'voice', 'file', 'system', 'quote'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

/** chatId 只允许白名单字符（微信 chatId 形如 `123@chatroom` / wxid） */
const CHAT_ID_RE = /^[A-Za-z0-9_@=-]{1,128}$/

/** 待写入消息（调用方即后续 bus.ingest 下游，M1-T1.2 接线） */
export interface StorableMessage {
  /** 消息唯一 id（源库 MsgSvrID 或事件 messageId） */
  msgId: string
  /** 毫秒时间戳 */
  ts: number
  /** 发送者代号（pid，如 P01；未代号化时传 wxid，由上层映射） */
  senderPid: string
  /** 群内显示名（快照，便于回溯） */
  senderName?: string
  kind?: MessageKind
  text?: string
  /** 引用链：被引用消息的 msg_id */
  quoteOfMsgId?: string
  /** 附件指针：files.file_id */
  fileId?: string
  /** 源库原始类型码（排查/重放用） */
  rawClass?: string
}

/** 落库后的行（查询返回） */
export interface StoredMessage extends Required<Omit<StorableMessage, 'senderName' | 'kind' | 'text' | 'quoteOfMsgId' | 'fileId' | 'rawClass'>> {
  senderName: string
  kind: MessageKind
  text: string
  quoteOfMsgId: string | null
  fileId: string | null
  rawClass: string | null
}

export interface QueryMessagesOptions {
  /** 只返回 ts > afterTs 的消息 */
  afterTs?: number
  /** 只返回 ts < beforeTs 的消息 */
  beforeTs?: number
  kinds?: readonly MessageKind[]
  /** 返回条数上限（默认 500） */
  limit?: number
  /** 默认按 ts 升序；false 则降序（取最近） */
  ascending?: boolean
}

/**
 * 有序迁移表：MIGRATIONS[i] 把 user_version 从 i 推到 i+1。
 * 只允许追加，不允许修改历史条目（迁移不可重放倒退）。
 */
const MIGRATIONS: readonly ((db: DatabaseSync) => void)[] = [
  // v0 → v1：D2 §3 核心表骨架
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        msg_id          TEXT PRIMARY KEY,
        ts              INTEGER NOT NULL,
        sender_pid      TEXT NOT NULL,
        sender_name     TEXT NOT NULL DEFAULT '',
        kind            TEXT NOT NULL DEFAULT 'text'
                        CHECK (kind IN ('text','image','voice','file','system','quote')),
        text            TEXT NOT NULL DEFAULT '',
        quote_of_msg_id TEXT REFERENCES messages(msg_id),
        file_id         TEXT REFERENCES files(file_id),
        raw_class       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_pid, ts);

      CREATE TABLE IF NOT EXISTS identities (
        pid         TEXT PRIMARY KEY,
        wxid        TEXT NOT NULL UNIQUE,
        group_nick  TEXT NOT NULL DEFAULT '',
        remark      TEXT NOT NULL DEFAULT '',
        watch_level TEXT NOT NULL DEFAULT 'off'
                    CHECK (watch_level IN ('global','group','off'))
      );

      CREATE TABLE IF NOT EXISTS topic_clusters (
        cluster_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        window_start INTEGER NOT NULL,
        window_end   INTEGER NOT NULL,
        summary      TEXT NOT NULL DEFAULT '',
        title        TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_clusters_window ON topic_clusters(window_start);

      CREATE TABLE IF NOT EXISTS events (
        event_id            INTEGER PRIMARY KEY AUTOINCREMENT,
        category            TEXT NOT NULL DEFAULT '',
        statement           TEXT NOT NULL,
        evidence_msg_id     TEXT REFERENCES messages(msg_id),
        confidence          REAL NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'active',
        supersedes_event_id INTEGER REFERENCES events(event_id),
        source              TEXT NOT NULL DEFAULT 'auto'
                            CHECK (source IN ('auto','manual'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id           INTEGER PRIMARY KEY AUTOINCREMENT,
        statement         TEXT NOT NULL,
        assigner_pid      TEXT REFERENCES identities(pid),
        evidence_msg_id   TEXT REFERENCES messages(msg_id),
        deadline          INTEGER,
        deadline_confidence REAL NOT NULL DEFAULT 0,
        status            TEXT NOT NULL DEFAULT 'pending_confirm'
                          CHECK (status IN ('pending_confirm','active','done','cancelled')),
        learned_pattern   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS promises (
        promise_id               INTEGER PRIMARY KEY AUTOINCREMENT,
        statement                TEXT NOT NULL,
        assigner_pid             TEXT REFERENCES identities(pid),
        evidence_msg_id          TEXT REFERENCES messages(msg_id),
        deadline                 INTEGER,
        deadline_confidence      REAL NOT NULL DEFAULT 0,
        status                   TEXT NOT NULL DEFAULT 'pending_confirm'
                                 CHECK (status IN ('pending_confirm','active','done','cancelled')),
        learned_pattern          TEXT,
        requester_evidence_msg_id TEXT REFERENCES messages(msg_id),
        fulfilled_msg_id         TEXT REFERENCES messages(msg_id),
        fulfilled_ts             INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_promises_status ON promises(status);

      CREATE TABLE IF NOT EXISTS files (
        file_id         TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        ext             TEXT NOT NULL DEFAULT '',
        size            INTEGER NOT NULL DEFAULT 0,
        sender_pid      TEXT REFERENCES identities(pid),
        msg_id          TEXT REFERENCES messages(msg_id),
        wx_path         TEXT NOT NULL DEFAULT '',
        hash            TEXT NOT NULL DEFAULT '',
        summary         TEXT NOT NULL DEFAULT '',
        star            INTEGER NOT NULL DEFAULT 0,
        version_root_id TEXT REFERENCES files(file_id)
      );
    `)
  },
]

/** 单群库句柄（不直接对外导出使用，统一经 GroupStoreService） */
export class GroupStore {
  private readonly db: DatabaseSync
  private closed = false
  /** 单一写入口的串行化链（node:sqlite 同步 API，promise 链保序防交错） */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly chatId: string,
    readonly dbPath: string,
    private readonly logger: StoreLogger,
  ) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  /** 当前 schema 版本（= PRAGMA user_version） */
  get schemaVersion(): number {
    return Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
  }

  /** 迁移：按 MIGRATIONS 顺序推进 user_version；失败抛出（由上层 fail-closed 处理） */
  private migrate(): void {
    let v = this.schemaVersion
    while (v < MIGRATIONS.length) {
      this.db.exec('BEGIN')
      try {
        MIGRATIONS[v](this.db)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      v = this.schemaVersion
    }
  }

  /**
   * 单一写入口：所有写操作经此串行执行。
   * 返回是否成功（false = 已关闭或执行失败，失败只记日志不抛出）。
   */
  write<T>(op: (db: DatabaseSync) => T): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const next = this.writeChain.then(
      () => {
        if (this.closed) return false
        try {
          this.db.exec('BEGIN')
          const result = op(this.db)
          this.db.exec('COMMIT')
          return result !== false
        } catch (error) {
          try {
            this.db.exec('ROLLBACK')
          } catch {
            /* 已回滚或未开事务 */
          }
          this.logger.error(`group-store[${this.chatId}] write failed: ${String(error)}`)
          return false
        }
      },
      () => false,
    )
    this.writeChain = next.catch(() => undefined)
    return next
  }

  /** 批量写入消息（INSERT OR IGNORE：同 msg_id 幂等）。返回成功写入条数。 */
  async appendMessages(msgs: readonly StorableMessage[]): Promise<number> {
    let inserted = 0
    const ok = await this.write((db) => {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO messages
          (msg_id, ts, sender_pid, sender_name, kind, text, quote_of_msg_id, file_id, raw_class)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const m of msgs) {
        const kind = m.kind ?? 'text'
        if (!MESSAGE_KINDS.includes(kind)) continue
        if (!m.msgId || typeof m.ts !== 'number' || !m.senderPid) continue
        const r = stmt.run(
          m.msgId,
          Math.floor(m.ts),
          m.senderPid,
          m.senderName ?? '',
          kind,
          m.text ?? '',
          m.quoteOfMsgId ?? null,
          m.fileId ?? null,
          m.rawClass ?? null,
        )
        inserted += Number(r.changes)
      }
      return true
    })
    // 事务失败（回滚）时按 0 计：inserted 只在事务提交后有意义
    return ok ? inserted : 0
  }

  /** 查询消息（只读，不经写入口） */
  getMessages(opts: QueryMessagesOptions = {}): StoredMessage[] {
    if (this.closed) return []
    const conds: string[] = []
    const params: (string | number)[] = []
    if (opts.afterTs !== undefined) {
      conds.push('ts > ?')
      params.push(opts.afterTs)
    }
    if (opts.beforeTs !== undefined) {
      conds.push('ts < ?')
      params.push(opts.beforeTs)
    }
    if (opts.kinds && opts.kinds.length > 0) {
      conds.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`)
      params.push(...opts.kinds)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const order = opts.ascending === false ? 'DESC' : 'ASC'
    const limit = Math.max(0, Math.floor(opts.limit ?? 500))
    const rows = this.db
      .prepare(
        `SELECT msg_id, ts, sender_pid, sender_name, kind, text, quote_of_msg_id, file_id, raw_class
         FROM messages ${where} ORDER BY ts ${order}, rowid ${order} LIMIT ${limit}`,
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      msgId: String(r.msg_id),
      ts: Number(r.ts),
      senderPid: String(r.sender_pid),
      senderName: String(r.sender_name),
      kind: r.kind as MessageKind,
      text: String(r.text),
      quoteOfMsgId: r.quote_of_msg_id === null ? null : String(r.quote_of_msg_id),
      fileId: r.file_id === null ? null : String(r.file_id),
      rawClass: r.raw_class === null ? null : String(r.raw_class),
    }))
  }

  /** 当前消息总条数 */
  countMessages(): number {
    if (this.closed) return 0
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n)
  }

  /** 关闭库句柄（幂等） */
  close(): void {
    if (this.closed) return
    this.closed = true
    // 等挂起的写排空再关，避免 close 撞上 in-flight 事务
    this.writeChain.then(
      () => {
        try {
          this.db.close()
        } catch (error) {
          this.logger.warn(`group-store[${this.chatId}] close failed: ${String(error)}`)
        }
      },
      () => undefined,
    )
  }
}

/**
 * 每群 SQLite 数据桶服务：chatId → GroupStore 的惰性管理器。
 * 跨模块暴露走 ctx.provide('groupLurker').groupStore（服务模式，不做全局单例）。
 */
export class GroupStoreService {
  private readonly stores = new Map<string, GroupStore>()

  constructor(
    private readonly stateDir: string,
    private readonly logger: StoreLogger,
  ) {}

  /** chatId 字符白名单校验（防路径注入；assertInsideState 是第二道围栏） */
  private assertChatId(chatId: string): void {
    if (!CHAT_ID_RE.test(chatId)) {
      throw new Error(`group-store: illegal chatId rejected: ${JSON.stringify(chatId)}`)
    }
  }

  /** 惰性取（或建）某群的库；路径先过 assertInsideState 围栏 */
  open(chatId: string): GroupStore {
    const existing = this.stores.get(chatId)
    if (existing) return existing
    this.assertChatId(chatId)
    const dir = join(this.stateDir, 'groups', chatId)
    const dbPath = join(dir, 'store.db')
    assertInsideState(this.stateDir, dbPath)
    mkdirSync(dir, { recursive: true })
    const st = new GroupStore(chatId, dbPath, this.logger)
    this.stores.set(chatId, st)
    return st
  }

  /** 写入某群消息（不存在则先建库）。返回成功写入条数；非法输入/失败返回 0。 */
  async appendMessages(chatId: string, msgs: readonly StorableMessage[]): Promise<number> {
    try {
      return await this.open(chatId).appendMessages(msgs)
    } catch (error) {
      this.logger.error(`group-store appendMessages(${chatId}) failed: ${String(error)}`)
      return 0
    }
  }

  /** 查询某群消息；库不存在/失败返回 []（惰性不建库，读操作不产生落盘） */
  getMessages(chatId: string, opts?: QueryMessagesOptions): StoredMessage[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    try {
      return st.getMessages(opts)
    } catch (error) {
      this.logger.error(`group-store getMessages(${chatId}) failed: ${String(error)}`)
      return []
    }
  }

  /** 某GroupStore库 schema 版本（未建库返回 0） */
  schemaVersion(chatId: string): number {
    return this.stores.get(chatId)?.schemaVersion ?? 0
  }

  /** 是否已打开 */
  isOpen(chatId: string): boolean {
    return this.stores.has(chatId)
  }

  /** 已打开的群列表 */
  openedChats(): string[] {
    return [...this.stores.keys()]
  }

  /** 关闭全部库句柄（dispose 时调用，幂等） */
  dispose(): void {
    for (const st of this.stores.values()) st.close()
    this.stores.clear()
  }
}
