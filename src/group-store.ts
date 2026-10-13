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
  // v0/v1 → v2：topic_clusters 增加 person 维度列（M2-T2.3 人物增量摘要）。
  // 只加列不退：历史行新列取默认值，旧查询不受影响（迁移不可重放倒退）。
  (db) => {
    db.exec(`
      ALTER TABLE topic_clusters ADD COLUMN person_pid        TEXT NOT NULL DEFAULT '';
      ALTER TABLE topic_clusters ADD COLUMN digest_date       TEXT NOT NULL DEFAULT '';
      ALTER TABLE topic_clusters ADD COLUMN digest_status     TEXT NOT NULL DEFAULT '';
      ALTER TABLE topic_clusters ADD COLUMN evidence_msg_ids  TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE topic_clusters ADD COLUMN mood_or_stance    TEXT NOT NULL DEFAULT '';
      ALTER TABLE topic_clusters ADD COLUMN open_questions    TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE topic_clusters ADD COLUMN message_count     INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE topic_clusters ADD COLUMN digest_path       TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_clusters_person ON topic_clusters(person_pid, digest_date);
    `)
  },
]

/** identities 表行（M2-T2.1 追加：关注名单同步写入/查询） */
export interface IdentityRow {
  pid: string
  wxid: string
  groupNick?: string
  remark?: string
  watchLevel?: 'global' | 'group' | 'off'
}

/** supersede 标记前缀（写进 digest_status；读方以此识别旧行，不改 schema 版本） */
export const DIGEST_SUPERSEDED_MARK = 'superseded__'

/** 报告元数据单行（M3-T3.1：报告落盘后入库一行，供检索/盘点） */
export interface ReportMetaRow {
  kind: 'daily' | 'weekly' | 'monthly'
  /** 报告周期结束日的本地日期键 YYYY-MM-DD（= 文件名 <date>.md） */
  date: string
  windowStart: number
  windowEnd: number
  status: 'ok' | 'degraded' | 'empty'
  /** 相对 stateDir 的 md 路径 */
  path: string
  judgmentCount: number
  topicCount: number
  messageCount: number
  generatedAt: number
}

/** topic_clusters 单行（person 维度，M2-T2.3 追加：人物增量摘要写入/查询） */
export interface PersonDigestRow {
  personPid: string
  date: string
  status: string
  title: string
  summary: string
  evidenceMsgIds: readonly string[]
  moodOrStance: string
  openQuestions: readonly string[]
  messageCount: number
  digestPath: string
  /** 摘要时间窗（毫秒；读取接口同样返回） */
  windowStart: number
  windowEnd: number
}

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

  /** 按 msg_id 精确取一条（已关闭返回 null） */
  getMessage(msgId: string): StoredMessage | null {
    if (this.closed) return null
    const r = this.db
      .prepare(
        `SELECT msg_id, ts, sender_pid, sender_name, kind, text, quote_of_msg_id, file_id, raw_class
         FROM messages WHERE msg_id = ? LIMIT 1`,
      )
      .get(msgId) as Record<string, unknown> | undefined
    if (!r) return null
    return {
      msgId: String(r.msg_id),
      ts: Number(r.ts),
      senderPid: String(r.sender_pid),
      senderName: String(r.sender_name),
      kind: r.kind as MessageKind,
      text: String(r.text),
      quoteOfMsgId: r.quote_of_msg_id === null ? null : String(r.quote_of_msg_id),
      fileId: r.file_id === null ? null : String(r.file_id),
      rawClass: r.raw_class === null ? null : String(r.raw_class),
    }
  }

  /**
   * M2-T2.2：引用回复链多级追溯。从 msgId 出发沿 quote_of_msg_id 向上（被引用方向）
   * 逐级取消息，返回 [起始消息, 其引用的消息, 再上一级, ...]（按链顺序排列）。
   * - maxDepth：链上最多返回的消息条数（含起始消息），默认 5（D2 §4-T2.2）；
   * - 断链（被引用消息不在库，如 qref-* 占位 id）在该级终止，返回已取到的部分链；
   * - 环引用（数据异常）经 seen 集防死循环；
   * - TODO(M2+)：软关联（无引用的时序+语义近似，置信度<阈值仅展示）本任务不做。
   */
  getQuoteChain(msgId: string, maxDepth = 5): StoredMessage[] {
    const chain: StoredMessage[] = []
    if (this.closed || maxDepth <= 0) return chain
    const seen = new Set<string>()
    let cur: string | null = msgId
    while (cur !== null && chain.length < maxDepth && !seen.has(cur)) {
      seen.add(cur)
      const row = this.getMessage(cur)
      if (!row) break // 断链：被引用消息不在库
      chain.push(row)
      cur = row.quoteOfMsgId
    }
    return chain
  }

  /** 当前消息总条数 */
  countMessages(): number {
    if (this.closed) return 0
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n)
  }

  // —— 以下为 M2-T2.1/T2.4 追加 API（identities 读写 + 按人检索），不改上方既有行 ——

  /** upsert 一条 identities（按 wxid 幂等：重名换 pid 不产生重复行）。返回是否成功。 */
  async upsertIdentity(row: IdentityRow): Promise<boolean> {
    if (!row.pid || !row.wxid) return false
    const level = row.watchLevel ?? 'off'
    if (level !== 'global' && level !== 'group' && level !== 'off') return false
    return this.write((db) => {
      db.prepare(`
        INSERT INTO identities (pid, wxid, group_nick, remark, watch_level)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(wxid) DO UPDATE SET
          pid = excluded.pid,
          group_nick = excluded.group_nick,
          remark = excluded.remark,
          watch_level = excluded.watch_level
      `).run(row.pid, row.wxid, row.groupNick ?? '', row.remark ?? '', level)
      return true
    })
  }

  /** 读 identities：全部（默认）或按 watch_level 过滤。只读，失败返回 []。 */
  getIdentities(opts: { watchLevel?: 'global' | 'group' | 'off' } = {}): Array<{
    pid: string
    wxid: string
    groupNick: string
    remark: string
    watchLevel: 'global' | 'group' | 'off'
  }> {
    if (this.closed) return []
    try {
      const rows = opts.watchLevel
        ? this.db.prepare('SELECT pid, wxid, group_nick, remark, watch_level FROM identities WHERE watch_level = ?').all(opts.watchLevel)
        : this.db.prepare('SELECT pid, wxid, group_nick, remark, watch_level FROM identities').all()
      return (rows as Record<string, unknown>[]).map((r) => ({
        pid: String(r.pid),
        wxid: String(r.wxid),
        groupNick: String(r.group_nick),
        remark: String(r.remark),
        watchLevel: r.watch_level as 'global' | 'group' | 'off',
      }))
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getIdentities failed: ${String(error)}`)
      return []
    }
  }

  /**
   * 按人检索（M2-T2.4）：sender_pid ∈ senderKeys（wxid 或派生 pid），可选关键词子串
   * （instr 匹配，无 LIKE 转义问题），按 ts 降序取最近 limit 条。只读。
   */
  searchByPerson(
    senderKeys: readonly string[],
    keyword: string | undefined,
    opts: { afterTs?: number; beforeTs?: number; limit?: number } = {},
  ): StoredMessage[] {
    if (this.closed || senderKeys.length === 0) return []
    const conds = [`sender_pid IN (${senderKeys.map(() => '?').join(',')})`]
    const params: (string | number)[] = [...senderKeys]
    if (keyword && keyword !== '') {
      conds.push('instr(text, ?) > 0')
      params.push(keyword)
    }
    if (opts.afterTs !== undefined) {
      conds.push('ts > ?')
      params.push(opts.afterTs)
    }
    if (opts.beforeTs !== undefined) {
      conds.push('ts < ?')
      params.push(opts.beforeTs)
    }
    const limit = Math.max(0, Math.floor(opts.limit ?? 100))
    const rows = this.db
      .prepare(
        `SELECT msg_id, ts, sender_pid, sender_name, kind, text, quote_of_msg_id, file_id, raw_class
         FROM messages WHERE ${conds.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ${limit}`,
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

  // —— 以下为 M2-T2.3 追加 API（人物增量摘要落盘 + 计数/兜底上下文查询），不改上方既有行 ——

  /** 写一条 person 维度 topic_clusters 行（evidence/open_questions 存 JSON 文本）。返回是否成功。 */
  async appendPersonDigest(row: PersonDigestRow): Promise<boolean> {
    if (!row.personPid || !row.date) return false
    return this.write((db) => {
      db.prepare(`
        INSERT INTO topic_clusters
          (window_start, window_end, summary, title,
           person_pid, digest_date, digest_status, evidence_msg_ids,
           mood_or_stance, open_questions, message_count, digest_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Math.floor(row.windowStart),
        Math.floor(row.windowEnd),
        row.summary ?? '',
        row.title ?? '',
        row.personPid,
        row.date,
        row.status ?? '',
        JSON.stringify(row.evidenceMsgIds ?? []),
        row.moodOrStance ?? '',
        JSON.stringify(row.openQuestions ?? []),
        Math.floor(row.messageCount ?? 0),
        row.digestPath ?? '',
      )
      return true
    })
  }

  /**
   * 读某人物某日的 topic_clusters 行（M3 定夺点②：同日重跑覆盖——默认只返回生效行，
   * 被 supersede 的旧行需显式 includeSuperseded 才返回；不物理删除）。
   * 只读，失败返回 []。
   */
  getPersonDigests(
    personPid: string,
    date: string,
    opts: { includeSuperseded?: boolean } = {},
  ): Array<PersonDigestRow & { windowStart: number; windowEnd: number }> {
    if (this.closed) return []
    try {
      const rows = this.db
        .prepare(`
          SELECT window_start, window_end, summary, title, person_pid, digest_date,
                 digest_status, evidence_msg_ids, mood_or_stance, open_questions,
                 message_count, digest_path
          FROM topic_clusters WHERE person_pid = ? AND digest_date = ? ORDER BY rowid ASC
        `)
        .all(personPid, date) as Record<string, unknown>[]
      const mapped = rows.map((r) => ({
        personPid: String(r.person_pid),
        date: String(r.digest_date),
        status: String(r.digest_status),
        title: String(r.title),
        summary: String(r.summary),
        evidenceMsgIds: safeJsonArray(r.evidence_msg_ids),
        moodOrStance: String(r.mood_or_stance),
        openQuestions: safeJsonArray(r.open_questions),
        messageCount: Number(r.message_count),
        digestPath: String(r.digest_path),
        windowStart: Number(r.window_start),
        windowEnd: Number(r.window_end),
      }))
      // 默认过滤被 supersede 的旧行（读方默认取最新生效行）
      return opts.includeSuperseded
        ? mapped
        : mapped.filter((row) => !row.status.startsWith(DIGEST_SUPERSEDED_MARK))
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getPersonDigests failed: ${String(error)}`)
      return []
    }
  }

  /**
   * 同日重跑覆盖（M3 定夺点②）：把该 pid+date 的既有行 digest_status 打上
   * superseded 前缀（不改 schema、不物理删除）。返回是否成功。
   */
  async supersedePersonDigests(personPid: string, date: string): Promise<boolean> {
    return this.write((db) => {
      db.prepare(
        `UPDATE topic_clusters SET digest_status = '${DIGEST_SUPERSEDED_MARK}' || digest_status
         WHERE person_pid = ? AND digest_date = ? AND digest_status NOT LIKE '${DIGEST_SUPERSEDED_MARK}%'`,
      ).run(personPid, date)
      return true
    })
  }

  /** 报告元数据行写入（表惰性建，不动 user_version；见服务层同名方法）。 */
  async appendReportMeta(row: ReportMetaRow): Promise<boolean> {
    return this.write((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS report_meta (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          kind          TEXT NOT NULL,
          date          TEXT NOT NULL,
          window_start  INTEGER NOT NULL,
          window_end    INTEGER NOT NULL,
          status        TEXT NOT NULL,
          path          TEXT NOT NULL DEFAULT '',
          judgment_count INTEGER NOT NULL DEFAULT 0,
          topic_count   INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          generated_at  INTEGER NOT NULL
        );
      `)
      db.prepare(`
        INSERT INTO report_meta
          (kind, date, window_start, window_end, status, path, judgment_count, topic_count, message_count, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.kind,
        row.date,
        Math.floor(row.windowStart),
        Math.floor(row.windowEnd),
        row.status,
        row.path ?? '',
        Math.floor(row.judgmentCount ?? 0),
        Math.floor(row.topicCount ?? 0),
        Math.floor(row.messageCount ?? 0),
        Math.floor(row.generatedAt),
      )
      return true
    })
  }

  /** 读报告元数据（generated_at 降序；可选按 kind 过滤）。只读，失败返回 []。 */
  getReportMetas(opts: { kind?: ReportMetaRow['kind']; limit?: number } = {}): ReportMetaRow[] {
    if (this.closed) return []
    try {
      const conds: string[] = []
      const params: (string | number)[] = []
      if (opts.kind) {
        conds.push('kind = ?')
        params.push(opts.kind)
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const limit = Math.max(0, Math.floor(opts.limit ?? 100))
      const rows = this.db
        .prepare(`SELECT * FROM report_meta ${where} ORDER BY generated_at DESC LIMIT ${limit}`)
        .all(...params) as Record<string, unknown>[]
      return rows.map((r) => ({
        kind: String(r.kind) as ReportMetaRow['kind'],
        date: String(r.date),
        windowStart: Number(r.window_start),
        windowEnd: Number(r.window_end),
        status: String(r.status) as ReportMetaRow['status'],
        path: String(r.path),
        judgmentCount: Number(r.judgment_count),
        topicCount: Number(r.topic_count),
        messageCount: Number(r.message_count),
        generatedAt: Number(r.generated_at),
      }))
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getReportMetas failed: ${String(error)}`)
      return []
    }
  }

  /** 按 sender/时间窗计数（与既有 countMessages() 并存；发言量仅内部信号用）。只读。 */
  countMessagesBy(
    senderKeys: readonly string[] | undefined,
    opts: { afterTs?: number; beforeTs?: number } = {},
  ): number {
    if (this.closed) return 0
    try {
      const conds: string[] = []
      const params: (string | number)[] = []
      if (senderKeys && senderKeys.length > 0) {
        conds.push(`sender_pid IN (${senderKeys.map(() => '?').join(',')})`)
        params.push(...senderKeys)
      }
      if (opts.afterTs !== undefined) {
        conds.push('ts > ?')
        params.push(opts.afterTs)
      }
      if (opts.beforeTs !== undefined) {
        conds.push('ts < ?')
        params.push(opts.beforeTs)
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM messages ${where}`).get(...params)!.n)
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] countMessages failed: ${String(error)}`)
      return 0
    }
  }

  /**
   * 某人物某时间窗的消息 + 兜底上下文（功能文档 §3.2"上下文保留"）：
   * 返回目标人物每条消息前后各 pad 条（去重、按 ts 升序）的并集切片；
   * 调用方以 senderKeys 过滤即得本人消息。只读。
   */
  getPersonDayContext(
    senderKeys: readonly string[],
    startTs: number,
    endTs: number,
    pad = 2,
  ): StoredMessage[] {
    if (this.closed || senderKeys.length === 0) return []
    const day = this.getMessages({ afterTs: startTs, beforeTs: endTs, limit: 2000 })
    const keep = new Set<number>()
    day.forEach((m, i) => {
      if (!senderKeys.includes(m.senderPid)) return
      for (let j = Math.max(0, i - pad); j <= Math.min(day.length - 1, i + pad); j++) keep.add(j)
    })
    return [...keep].sort((a, b) => a - b).map((i) => day[i])
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

  /**
   * M2-T2.2：引用链查询（服务层）。库未开/失败返回 []（读操作不建库、不落盘）。
   * TODO(M2+)：软关联（时序+语义近似）留给后续任务，这里只走 quote_of_msg_id 硬链。
   */
  getQuoteChain(chatId: string, msgId: string, maxDepth = 5): StoredMessage[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    try {
      return st.getQuoteChain(msgId, maxDepth)
    } catch (error) {
      this.logger.error(`group-store getQuoteChain(${chatId}) failed: ${String(error)}`)
      return []
    }
  }

  /** M2-T2.1：向某群 identities upsert 一行（库未开则惰性建库；失败返回 false） */
  async appendIdentity(chatId: string, row: IdentityRow): Promise<boolean> {
    try {
      return await this.open(chatId).upsertIdentity(row)
    } catch (error) {
      this.logger.error(`group-store appendIdentity(${chatId}) failed: ${String(error)}`)
      return false
    }
  }

  /** M2-T2.4：某群按人检索；库未打开返回 []（不为此建库——不做全量索引） */
  searchByPerson(
    chatId: string,
    senderKeys: readonly string[],
    keyword?: string,
    opts?: { afterTs?: number; beforeTs?: number; limit?: number },
  ): StoredMessage[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    try {
      return st.searchByPerson(senderKeys, keyword, opts)
    } catch (error) {
      this.logger.error(`group-store searchByPerson(${chatId}) failed: ${String(error)}`)
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

  // —— M2-T2.3 追加（服务层包装；库未开时惰性建库写 / 只读返回空） ——

  /** 写一条 person 维度摘要行（失败返回 false） */
  async appendPersonDigest(chatId: string, row: PersonDigestRow): Promise<boolean> {
    try {
      return await this.open(chatId).appendPersonDigest(row)
    } catch (error) {
      this.logger.error(`group-store appendPersonDigest(${chatId}) failed: ${String(error)}`)
      return false
    }
  }

  /** 读某人物某日摘要行（M3 定夺点②：默认只返回生效行，supersede 旧行需 includeSuperseded）；库未打开返回 [] */
  getPersonDigests(
    chatId: string,
    personPid: string,
    date: string,
    opts: { includeSuperseded?: boolean } = {},
  ): Array<PersonDigestRow & { windowStart: number; windowEnd: number }> {
    const st = this.stores.get(chatId)
    if (!st) return []
    try {
      return st.getPersonDigests(personPid, date, opts)
    } catch (error) {
      this.logger.error(`group-store getPersonDigests(${chatId}) failed: ${String(error)}`)
      return []
    }
  }

  /** 计数包装（库未开返回 0；发言量仅内部信号用） */
  countMessages(
    chatId: string,
    senderKeys: readonly string[] | undefined,
    opts?: { afterTs?: number; beforeTs?: number },
  ): number {
    const st = this.stores.get(chatId)
    if (!st) return 0
    try {
      return st.countMessagesBy(senderKeys, opts)
    } catch (error) {
      this.logger.error(`group-store countMessages(${chatId}) failed: ${String(error)}`)
      return 0
    }
  }

  /** 兜底上下文查询包装（库未开返回 []） */
  getPersonDayContext(
    chatId: string,
    senderKeys: readonly string[],
    startTs: number,
    endTs: number,
    pad = 2,
  ): StoredMessage[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    try {
      return st.getPersonDayContext(senderKeys, startTs, endTs, pad)
    } catch (error) {
      this.logger.error(`group-store getPersonDayContext(${chatId}) failed: ${String(error)}`)
      return []
    }
  }

  // —— 以下为 M3 追加 API（identities 服务层只读包装 / 摘要同日重跑 supersede /
//     报告元数据行），不改上方既有行 ——

/** 读某群 identities（服务层只读包装；库未开返回 []，不为此建库） */
getIdentities(
  chatId: string,
  opts: { watchLevel?: 'global' | 'group' | 'off' } = {},
): Array<{ pid: string; wxid: string; groupNick: string; remark: string; watchLevel: 'global' | 'group' | 'off' }> {
  const st = this.stores.get(chatId)
  if (!st) return []
  return st.getIdentities(opts)
}

/**
 * 同日重跑覆盖语义（M3 定夺点②）：同 pid+date 的旧行标记 superseded（digest_status
 * 前缀标记，不改 schema/不物理删除），新行由调用方随后 append；读方
 * getPersonDigests 默认过滤旧行、默认取最新生效行。返回是否成功。
 */
async supersedePersonDigests(chatId: string, personPid: string, date: string): Promise<boolean> {
  try {
    return await this.open(chatId).supersedePersonDigests(personPid, date)
  } catch (error) {
    this.logger.error(`group-store supersedePersonDigests(${chatId}) failed: ${String(error)}`)
    return false
  }
}

/** 报告元数据单行（M3-T3.1：报告落盘后入库一行，供检索/盘点）——形状见模块级 ReportMetaRow */
/** 写一行报告元数据（表不存在则惰性建；不动 user_version，历史库无需迁移）。失败返回 false。 */
async appendReportMeta(chatId: string, row: ReportMetaRow): Promise<boolean> {
  try {
    return await this.open(chatId).appendReportMeta(row)
  } catch (error) {
    this.logger.error(`group-store appendReportMeta(${chatId}) failed: ${String(error)}`)
    return false
  }
}

/** 读某群报告元数据（按 generated_at 降序；库未开返回 []）。 */
getReportMetas(chatId: string, opts: { kind?: ReportMetaRow['kind']; limit?: number } = {}): ReportMetaRow[] {
  const st = this.stores.get(chatId)
  if (!st) return []
  return st.getReportMetas(opts)
}

  /** 关闭全部库句柄（dispose 时调用，幂等） */
  dispose(): void {
    for (const st of this.stores.values()) st.close()
    this.stores.clear()
  }
}

/** 安全解析 JSON 数组文本（损坏/非法返回 []，不抛出） */
function safeJsonArray(text: unknown): string[] {
  try {
    const v = JSON.parse(String(text ?? '[]'))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
