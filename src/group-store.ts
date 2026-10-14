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
  // v2 → v3（M4-T4.1 + M3 遗留收口）：
  // 1. report_meta 惰性表收编进正式迁移：迁移前先探测 sqlite_master，表已存在
  //    （v2 时代的惰性建表产物）则不重复建、仅登记版本；不存在才 CREATE。
  //    schema 与惰性版逐字一致，两来源的行互通。
  // 2. tasks 增列（提醒计划器用）：overdue_marked_at（逾期自动标记时刻）、
  //    created_at（识别时刻，无 deadline 时 +3 天软提醒的锚点）。ADD COLUMN 前
  //    先 PRAGMA table_info 探测，列已存在则跳过（对只建了部分表的库也稳健）。
  // 3. reminder_log：提醒计划器的"每任务每时点只触发一次"持久化去重表。
  (db) => {
    const hasReportMeta = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_meta'`)
      .get()
    if (!hasReportMeta) {
      db.exec(`
        CREATE TABLE report_meta (
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
    }
    // tasks 可能不存在（早期部分建表的库）：先补全表骨架（已存在则 no-op）。
    // 兜底骨架不带外键子句——部分建表的库可能缺 identities/messages，
    // foreign_keys=ON 下带外键的建表骨架会在插入时报 no such table。
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id           INTEGER PRIMARY KEY AUTOINCREMENT,
        statement         TEXT NOT NULL,
        assigner_pid      TEXT,
        evidence_msg_id   TEXT,
        deadline          INTEGER,
        deadline_confidence REAL NOT NULL DEFAULT 0,
        status            TEXT NOT NULL DEFAULT 'pending_confirm'
                          CHECK (status IN ('pending_confirm','active','done','cancelled')),
        learned_pattern   TEXT,
        overdue_marked_at INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `)
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Record<string, unknown>[]).map((c) => String(c.name))
    if (!taskCols.includes('overdue_marked_at')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN overdue_marked_at INTEGER NOT NULL DEFAULT 0;`)
    }
    if (!taskCols.includes('created_at')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;`)
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminder_log (
        task_id   INTEGER NOT NULL,
        point     TEXT NOT NULL,
        fired_at  INTEGER NOT NULL,
        PRIMARY KEY (task_id, point)
      );
    `)
  },
  // v3 → v4（M5-T5.1/T5.3：promises 状态机扩列 + files/events 补列）：
  // 1. promises 的 v1 骨架沿用了 tasks 的四态 CHECK（'pending_confirm','active','done','cancelled'），
  //    与 F8 状态机（pending_confirm → waiting → fulfilled/broken/cancelled）冲突；
  //    SQLite 不能改 CHECK，只能重建表：promises_new（新五态 CHECK + created_at/broken_marked_at
  //    两列）→ 旧数据迁移（active→waiting、done→fulfilled 语义映射）→ 换名。只前不退。
  // 2. files 补列（ADD COLUMN 前先 PRAGMA table_info 探测）：category（类型归类）、
  //    appearances（多次出现记录 JSON 数组）、last_seen_ts（最近一次出现）、
  //    context（发送前后上下文快照，摘要/星标依据）、keywords（摘要关键词 JSON 数组）。
  // 3. events 补列 file_ids（T5.4：事件可挂文件引用，JSON 数组，最小实现）。
  (db) => {
    // 部分建表的库（v2 时代惰性产物）可能没有 promises：有则重建扩态，无则按新骨架建。
    const PROMISES_DDL = `
      CREATE TABLE promises_new (
        promise_id               INTEGER PRIMARY KEY AUTOINCREMENT,
        statement                TEXT NOT NULL,
        assigner_pid             TEXT REFERENCES identities(pid),
        evidence_msg_id          TEXT REFERENCES messages(msg_id),
        deadline                 INTEGER,
        deadline_confidence      REAL NOT NULL DEFAULT 0,
        status                   TEXT NOT NULL DEFAULT 'pending_confirm'
                                 CHECK (status IN ('pending_confirm','waiting','fulfilled','broken','cancelled')),
        learned_pattern          TEXT,
        requester_evidence_msg_id TEXT REFERENCES messages(msg_id),
        fulfilled_msg_id         TEXT REFERENCES messages(msg_id),
        fulfilled_ts             INTEGER,
        created_at               INTEGER NOT NULL DEFAULT 0,
        broken_marked_at         INTEGER NOT NULL DEFAULT 0
      );`
    const hasPromises = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'promises'`)
      .get()
    if (hasPromises) {
      db.exec(`
        ${PROMISES_DDL}
        INSERT INTO promises_new
          (promise_id, statement, assigner_pid, evidence_msg_id, deadline, deadline_confidence,
           status, learned_pattern, requester_evidence_msg_id, fulfilled_msg_id, fulfilled_ts,
           created_at, broken_marked_at)
        SELECT
          promise_id, statement, assigner_pid, evidence_msg_id, deadline, deadline_confidence,
          CASE status WHEN 'active' THEN 'waiting' WHEN 'done' THEN 'fulfilled' ELSE status END,
          learned_pattern, requester_evidence_msg_id, fulfilled_msg_id, fulfilled_ts, 0, 0
        FROM promises;
        DROP TABLE promises;
        ALTER TABLE promises_new RENAME TO promises;
      `)
    } else {
      db.exec(`
        ${PROMISES_DDL}
        ALTER TABLE promises_new RENAME TO promises;
      `)
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_promises_status ON promises(status);`)
    const addCol = (table: string, col: string, ddl: string): void => {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).map((c) => String(c.name))
      if (cols.length === 0) return // 表不存在（部分建表库）：跳过，不报 no such table
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`)
    }
    addCol('files', 'category', `category TEXT NOT NULL DEFAULT ''`)
    addCol('files', 'appearances', `appearances TEXT NOT NULL DEFAULT '[]'`)
    addCol('files', 'last_seen_ts', `last_seen_ts INTEGER NOT NULL DEFAULT 0`)
    addCol('files', 'context', `context TEXT NOT NULL DEFAULT ''`)
    addCol('files', 'keywords', `keywords TEXT NOT NULL DEFAULT '[]'`)
    addCol('events', 'file_ids', `file_ids TEXT NOT NULL DEFAULT '[]'`)
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

/** tasks 表单行（M4-T4.1 追加：任务识别写入/查询） */
export interface TaskRow {
  taskId: number
  statement: string
  assignerPid: string | null
  evidenceMsgId: string | null
  /** 毫秒时间戳；null = 无明确 deadline */
  deadline: number | null
  deadlineConfidence: number
  status: 'pending_confirm' | 'active' | 'done' | 'cancelled'
  /** 模式学习指纹（`${assigner_pid}:${hash}`）；null = 未登记 */
  learnedPattern: string | null
  /** 逾期自动标记时刻（0 = 未标记；不删条目） */
  overdueMarkedAt: number
  /** 识别/入库时刻（无 deadline 时 +3 天软提醒锚点） */
  createdAt: number
}

/** 新任务入库入参（taskId/overdueMarkedAt/createdAt 由本层补全） */
export interface NewTaskInput {
  statement: string
  assignerPid?: string | null
  evidenceMsgId?: string | null
  deadline?: number | null
  deadlineConfidence?: number
  status?: TaskRow['status']
  learnedPattern?: string | null
}

/** events 表单行（M4-T4.1 追加：事件识别写入/查询） */
export interface EventRow {
  eventId: number
  category: string
  statement: string
  evidenceMsgId: string | null
  confidence: number
  /** 'pending_confirm' | 'active' | 'superseded' */
  status: string
  /**
   * 演变链指针：新行指向被其推翻的旧行（provenance）；
   * 旧行被推翻时也回指新行（successor），旧行 status='superseded'。
   */
  supersedesEventId: number | null
  source: 'auto' | 'manual'
  /** M6-T3：已挂文件引用（events.file_ids JSON 数组） */
  fileIds: string[]
}

/** 新事件入库入参 */
export interface NewEventInput {
  category: string
  statement: string
  evidenceMsgId?: string | null
  confidence?: number
  status?: string
  supersedesEventId?: number | null
  source?: 'auto' | 'manual'
}

// —— 以下为 M5-T5.1/T5.3 追加类型（promises / files 行与入参），不改上方既有行 ——

/** promises.status 允许值（F8 状态机，功能文档 §10.2；v4 CHECK 同口径） */
export const PROMISE_STATUSES = ['pending_confirm', 'waiting', 'fulfilled', 'broken', 'cancelled'] as const
export type PromiseStatus = (typeof PROMISE_STATUSES)[number]

/** promises 表单行 */
export interface PromiseRow {
  promiseId: number
  statement: string
  /** 承诺人 pid（他人） */
  assignerPid: string | null
  /** 承诺证据消息（他人的应答） */
  evidenceMsgId: string | null
  deadline: number | null
  deadlineConfidence: number
  status: PromiseStatus
  /** 模式学习指纹（`${assigner_pid}:${hash}`）；null = 未登记 */
  learnedPattern: string | null
  /** 我的原始请求消息（如有）；null = 对方主动许诺 */
  requesterEvidenceMsgId: string | null
  /** 兑现消息 / 兑现时刻 */
  fulfilledMsgId: string | null
  fulfilledTs: number | null
  /** 识别/入库时刻 */
  createdAt: number
  /** 跳票自动标记时刻（0 = 未标记；跳票不删条目） */
  brokenMarkedAt: number
}

/** 新承诺入库入参（promiseId/createdAt/brokenMarkedAt 由本层补全） */
export interface NewPromiseInput {
  statement: string
  assignerPid?: string | null
  evidenceMsgId?: string | null
  deadline?: number | null
  deadlineConfidence?: number
  status?: PromiseStatus
  learnedPattern?: string | null
  requesterEvidenceMsgId?: string | null
}

/** files 表单行（appearances/keywords 落库为 JSON，读出已解析） */
export interface FileRow {
  fileId: string
  name: string
  ext: string
  size: number
  senderPid: string | null
  /** 首次出现消息 */
  msgId: string | null
  /** 微信内路径；'' 或 '待下载' = 离线期媒体未下载占位 */
  wxPath: string
  hash: string
  summary: string
  star: number
  /** 版本链根（链首 file_id；自指/空 = 无链或链根自身） */
  versionRootId: string | null
  /** 类型归类（文档/表格/压缩包/代码文本/图片/视频/其他） */
  category: string
  /** 多次出现记录 [{msg_id, ts}]（首条与 msg_id 一致） */
  appearances: Array<{ msgId: string; ts: number }>
  /** 最近一次出现时刻 */
  lastSeenTs: number
  /** 发送前后上下文快照（供报告/检索） */
  context: string
  keywords: string[]
}

/** files 入库入参（fileId 必填——来源消息 msg_id 派生，天然幂等） */
export interface NewFileInput {
  fileId: string
  name: string
  ext?: string
  size?: number
  senderPid?: string | null
  msgId?: string | null
  wxPath?: string
  hash?: string
  versionRootId?: string | null
  category?: string
  context?: string
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

  // —— 以下为 M4-T4.1/T4.2 追加 API（tasks / events / reminder_log 读写），不改上方既有行 ——

  /** 写一条任务（初始 status 由调用方定：'pending_confirm' 或模式学习 'active'）。返回新 taskId；失败返回 null。 */
  async appendTask(input: NewTaskInput, createdAt?: number): Promise<number | null> {
    const status = input.status ?? 'pending_confirm'
    if (!TASK_STATUSES.includes(status)) return null
    let newId: number | null = null
    const ok = await this.write((db) => {
      const r = db.prepare(`
        INSERT INTO tasks
          (statement, assigner_pid, evidence_msg_id, deadline, deadline_confidence,
           status, learned_pattern, overdue_marked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        input.statement,
        input.assignerPid ?? null,
        input.evidenceMsgId ?? null,
        input.deadline === null || input.deadline === undefined ? null : Math.floor(input.deadline),
        input.deadlineConfidence ?? 0,
        status,
        input.learnedPattern ?? null,
        createdAt === undefined ? Date.now() : Math.floor(createdAt),
      )
      newId = Number(r.lastInsertRowid)
      return true
    })
    return ok ? newId : null
  }

  /** 按 id 取任务；不存在/失败返回 null。 */
  getTask(taskId: number): TaskRow | null {
    if (this.closed) return null
    try {
      const r = this.db.prepare('SELECT * FROM tasks WHERE task_id = ? LIMIT 1').get(taskId) as Record<string, unknown> | undefined
      return r ? mapTaskRow(r) : null
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getTask failed: ${String(error)}`)
      return null
    }
  }

  /** 查任务：可选 status 过滤、deadline 时间窗（deadline IS NOT NULL 时生效）、上限。只读。 */
  getTasks(opts: { status?: TaskRow['status']; deadlineFrom?: number; deadlineTo?: number; limit?: number } = {}): TaskRow[] {
    if (this.closed) return []
    try {
      const conds: string[] = []
      const params: (string | number)[] = []
      if (opts.status) {
        conds.push('status = ?')
        params.push(opts.status)
      }
      if (opts.deadlineFrom !== undefined) {
        conds.push('deadline IS NOT NULL AND deadline >= ?')
        params.push(opts.deadlineFrom)
      }
      if (opts.deadlineTo !== undefined) {
        conds.push('deadline IS NOT NULL AND deadline < ?')
        params.push(opts.deadlineTo)
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const limit = Math.max(0, Math.floor(opts.limit ?? 200))
      const rows = this.db
        .prepare(`SELECT * FROM tasks ${where} ORDER BY task_id ASC LIMIT ${limit}`)
        .all(...params) as Record<string, unknown>[]
      return rows.map(mapTaskRow)
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getTasks failed: ${String(error)}`)
      return []
    }
  }

  /** 更新任务状态（confirm/cancel/done 闭环）。返回是否成功。 */
  async updateTaskStatus(taskId: number, status: TaskRow['status']): Promise<boolean> {
    if (!TASK_STATUSES.includes(status)) return false
    return this.write((db) => {
      const r = db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run(status, taskId)
      return Number(r.changes) > 0
    })
  }

  /** 登记模式学习指纹（确认时调用）。返回是否成功。 */
  async setTaskLearnedPattern(taskId: number, pattern: string): Promise<boolean> {
    return this.write((db) => {
      const r = db.prepare('UPDATE tasks SET learned_pattern = ? WHERE task_id = ?').run(pattern, taskId)
      return Number(r.changes) > 0
    })
  }

  /**
   * deadline 变更（冲突演变链·任务侧）：更新原行（不新建），返回是否成功。
   */
  async updateTaskDeadline(taskId: number, deadline: number | null, confidence: number): Promise<boolean> {
    return this.write((db) => {
      const r = db.prepare('UPDATE tasks SET deadline = ?, deadline_confidence = ? WHERE task_id = ?')
        .run(deadline === null ? null : Math.floor(deadline), confidence, taskId)
      return Number(r.changes) > 0
    })
  }

  /** 逾期自动标记（只记时刻，不改状态不删条目；重复标记幂等）。返回是否发生了新标记。 */
  async markTaskOverdue(taskId: number, at: number): Promise<boolean> {
    return this.write((db) => {
      const r = db
        .prepare('UPDATE tasks SET overdue_marked_at = ? WHERE task_id = ? AND overdue_marked_at = 0')
        .run(Math.floor(at), taskId)
      return Number(r.changes) > 0
    })
  }

  /** 写一条事件。返回新 eventId；失败返回 null。 */
  async appendEvent(input: NewEventInput): Promise<number | null> {
    let newId: number | null = null
    const ok = await this.write((db) => {
      const r = db.prepare(`
        INSERT INTO events (category, statement, evidence_msg_id, confidence, status, supersedes_event_id, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.category,
        input.statement,
        input.evidenceMsgId ?? null,
        input.confidence ?? 0,
        input.status ?? 'active',
        input.supersedesEventId === undefined ? null : input.supersedesEventId,
        input.source ?? 'auto',
      )
      newId = Number(r.lastInsertRowid)
      return true
    })
    return ok ? newId : null
  }

  /** 按 id 取事件；不存在/失败返回 null。 */
  getEvent(eventId: number): EventRow | null {
    if (this.closed) return null
    try {
      const r = this.db.prepare('SELECT * FROM events WHERE event_id = ? LIMIT 1').get(eventId) as Record<string, unknown> | undefined
      return r ? mapEventRow(r) : null
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getEvent failed: ${String(error)}`)
      return null
    }
  }

  /** 查事件：可选 status/source/category 过滤，event_id 升序。只读。 */
  getEvents(opts: { status?: string; source?: 'auto' | 'manual'; category?: string; limit?: number } = {}): EventRow[] {
    if (this.closed) return []
    try {
      const conds: string[] = []
      const params: (string | number)[] = []
      if (opts.status) {
        conds.push('status = ?')
        params.push(opts.status)
      }
      if (opts.source) {
        conds.push('source = ?')
        params.push(opts.source)
      }
      if (opts.category) {
        conds.push('category = ?')
        params.push(opts.category)
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const limit = Math.max(0, Math.floor(opts.limit ?? 200))
      const rows = this.db
        .prepare(`SELECT * FROM events ${where} ORDER BY event_id ASC LIMIT ${limit}`)
        .all(...params) as Record<string, unknown>[]
      return rows.map(mapEventRow)
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getEvents failed: ${String(error)}`)
      return []
    }
  }

  /**
   * 冲突演变链（事件侧，M4-T4.2）：旧行标记 superseded 并把 supersedes_event_id
   * 回指新行（successor 指针；新行的 supersedes_event_id 由调用方建行时指向旧行）。
   * 不物理删除。返回是否成功。
   */
  async supersedeEvent(oldEventId: number, successorEventId: number): Promise<boolean> {
    return this.write((db) => {
      const r = db
        .prepare(`UPDATE events SET status = 'superseded', supersedes_event_id = ? WHERE event_id = ?`)
        .run(successorEventId, oldEventId)
      return Number(r.changes) > 0
    })
  }

  /** 更新事件状态（待确认闭环 / 演变链标记）。返回是否成功。 */
  async updateEventStatus(eventId: number, status: string): Promise<boolean> {
    return this.write((db) => {
      const r = db.prepare('UPDATE events SET status = ? WHERE event_id = ?').run(status, eventId)
      return Number(r.changes) > 0
    })
  }

  /** 提醒去重登记：INSERT OR IGNORE，返回 true = 首次登记（应触发提醒）。 */
  async appendReminderLog(taskId: number, point: string, firedAt: number): Promise<boolean> {
    return this.write((db) => {
      const r = db
        .prepare('INSERT OR IGNORE INTO reminder_log (task_id, point, fired_at) VALUES (?, ?, ?)')
        .run(taskId, point, Math.floor(firedAt))
      return Number(r.changes) > 0
    })
  }

  // —— 以下为 M5-T5.1/T5.3 追加 API（promises / files / events 文件引用），不改上方既有行 ——

  /** 写一条承诺。返回新 promiseId；失败返回 null。 */
  async appendPromise(input: NewPromiseInput, createdAt?: number): Promise<number | null> {
    const status = input.status ?? 'pending_confirm'
    if (!PROMISE_STATUSES.includes(status)) return null
    let newId: number | null = null
    const ok = await this.write((db) => {
      const r = db.prepare(`
        INSERT INTO promises
          (statement, assigner_pid, evidence_msg_id, deadline, deadline_confidence,
           status, learned_pattern, requester_evidence_msg_id, fulfilled_msg_id, fulfilled_ts,
           created_at, broken_marked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0)
      `).run(
        input.statement,
        input.assignerPid ?? null,
        input.evidenceMsgId ?? null,
        input.deadline === null || input.deadline === undefined ? null : Math.floor(input.deadline),
        input.deadlineConfidence ?? 0,
        status,
        input.learnedPattern ?? null,
        input.requesterEvidenceMsgId ?? null,
        createdAt === undefined ? Date.now() : Math.floor(createdAt),
      )
      newId = Number(r.lastInsertRowid)
      return true
    })
    return ok ? newId : null
  }

  /** 按 id 取承诺；不存在/失败返回 null。 */
  getPromise(promiseId: number): PromiseRow | null {
    if (this.closed) return null
    try {
      const r = this.db.prepare('SELECT * FROM promises WHERE promise_id = ? LIMIT 1').get(promiseId) as Record<string, unknown> | undefined
      return r ? mapPromiseRow(r) : null
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getPromise failed: ${String(error)}`)
      return null
    }
  }

  /** 查承诺：可选 status 过滤，promise_id 升序。只读。 */
  getPromises(opts: { status?: PromiseStatus; limit?: number } = {}): PromiseRow[] {
    if (this.closed) return []
    try {
      const where = opts.status ? `WHERE status = '${opts.status}'` : ''
      const limit = Math.max(0, Math.floor(opts.limit ?? 200))
      const rows = this.db
        .prepare(`SELECT * FROM promises ${where} ORDER BY promise_id ASC LIMIT ${limit}`)
        .all() as Record<string, unknown>[]
      return rows.map(mapPromiseRow)
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getPromises failed: ${String(error)}`)
      return []
    }
  }

  /** 更新承诺状态（confirm/兑现/跳票/取消闭环）。返回是否成功。 */
  async updatePromiseStatus(promiseId: number, status: PromiseStatus): Promise<boolean> {
    if (!PROMISE_STATUSES.includes(status)) return false
    return this.write((db) => {
      const r = db.prepare('UPDATE promises SET status = ? WHERE promise_id = ?').run(status, promiseId)
      return Number(r.changes) > 0
    })
  }

  /** 登记承诺模式学习指纹（确认时调用）。返回是否成功。 */
  async setPromiseLearnedPattern(promiseId: number, pattern: string): Promise<boolean> {
    return this.write((db) => {
      const r = db.prepare('UPDATE promises SET learned_pattern = ? WHERE promise_id = ?').run(pattern, promiseId)
      return Number(r.changes) > 0
    })
  }

  /** 承诺 deadline 变更（「延期到周五」）：更新原行不新建。返回是否成功。 */
  async updatePromiseDeadline(promiseId: number, deadline: number | null, confidence: number): Promise<boolean> {
    return this.write((db) => {
      const r = db.prepare('UPDATE promises SET deadline = ?, deadline_confidence = ? WHERE promise_id = ?')
        .run(deadline === null ? null : Math.floor(deadline), confidence, promiseId)
      return Number(r.changes) > 0
    })
  }

  /** 跳票自动标记（只记时刻不改删条目；幂等：broken_marked_at=0 时才写）。返回是否发生了新标记。 */
  async markPromiseBroken(promiseId: number, at: number): Promise<boolean> {
    return this.write((db) => {
      const r = db
        .prepare('UPDATE promises SET broken_marked_at = ?, status = ? WHERE promise_id = ? AND broken_marked_at = 0 AND status = ?')
        .run(Math.floor(at), 'broken', promiseId, 'waiting')
      return Number(r.changes) > 0
    })
  }

  /** 兑现关联（自动或手动兜底）：fulfilled_msg_id/fulfilled_ts + status='fulfilled'。返回是否成功。 */
  async fulfillPromise(promiseId: number, msgId: string | null, ts: number): Promise<boolean> {
    return this.write((db) => {
      const r = db
        .prepare(`UPDATE promises SET fulfilled_msg_id = ?, fulfilled_ts = ?, status = 'fulfilled' WHERE promise_id = ?`)
        .run(msgId, Math.floor(ts), promiseId)
      return Number(r.changes) > 0
    })
  }

  /**
   * 文件索引写入：新文件插入；已存在（同 file_id）返回原 id 不重复建。
   * 重复合并（同名+同大小+同发送者键）由 file-index 模块判定后走 updateFileAppearance。
   */
  async appendFile(input: NewFileInput): Promise<string | null> {
    const ok = await this.write((db) => {
      db.prepare(`
        INSERT INTO files
          (file_id, name, ext, size, sender_pid, msg_id, wx_path, hash, version_root_id,
           category, appearances, last_seen_ts, context, keywords)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.fileId,
        input.name,
        input.ext ?? '',
        Math.floor(input.size ?? 0),
        input.senderPid ?? null,
        input.msgId ?? null,
        input.wxPath ?? '',
        input.hash ?? '',
        input.versionRootId ?? null,
        input.category ?? '',
        '[]',
        0,
        input.context ?? '',
        '[]',
      )
      return true
    })
    return ok ? input.fileId : null
  }

  /** 按 id 取文件；不存在/失败返回 null。 */
  getFile(fileId: string): FileRow | null {
    if (this.closed) return null
    try {
      const r = this.db.prepare('SELECT * FROM files WHERE file_id = ? LIMIT 1').get(fileId) as Record<string, unknown> | undefined
      return r ? mapFileRow(r) : null
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getFile failed: ${String(error)}`)
      return null
    }
  }

  /** 查文件索引：可选发送者/类别过滤，first ts 升序（用 msg 的消息时间需 join，这里按 rowid）。只读。 */
  getFiles(opts: { senderPid?: string; category?: string; limit?: number } = {}): FileRow[] {
    if (this.closed) return []
    try {
      const conds: string[] = []
      const params: string[] = []
      if (opts.senderPid) { conds.push('sender_pid = ?'); params.push(opts.senderPid) }
      if (opts.category) { conds.push('category = ?'); params.push(opts.category) }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const limit = Math.max(0, Math.floor(opts.limit ?? 500))
      const rows = this.db
        .prepare(`SELECT * FROM files ${where} ORDER BY rowid ASC LIMIT ${limit}`)
        .all(...params) as Record<string, unknown>[]
      return rows.map(mapFileRow)
    } catch (error) {
      this.logger.error(`group-store[${this.chatId}] getFiles failed: ${String(error)}`)
      return []
    }
  }

  /** 追加一次出现记录（重复合并；ts 0 = 未知时刻）。返回是否成功。 */
  async appendFileAppearance(fileId: string, msgId: string, ts: number, wxPath?: string): Promise<boolean> {
    return this.write((db) => {
      const row = db.prepare('SELECT appearances, last_seen_ts FROM files WHERE file_id = ?').get(fileId) as Record<string, unknown> | undefined
      if (!row) return false
      const list = safeJsonArray(row.appearances).includes(msgId)
        ? safeJsonArray(row.appearances)
        : [...safeJsonArray(row.appearances), msgId]
      db.prepare('UPDATE files SET appearances = ?, last_seen_ts = MAX(last_seen_ts, ?), wx_path = CASE WHEN ? IS NULL OR ? = \'\' THEN wx_path ELSE ? END WHERE file_id = ?')
        .run(JSON.stringify(list), Math.floor(ts), wxPath ?? '', wxPath ?? '', wxPath ?? '', fileId)
      return true
    })
  }

  /** 更新文件摘要/关键词/上下文/星标（file-index 摘要阶段）。返回是否成功。 */
  async updateFileMeta(fileId: string, meta: { summary?: string; keywords?: string[]; context?: string; star?: number; versionRootId?: string | null }): Promise<boolean> {
    return this.write((db) => {
      const cur = db.prepare('SELECT context FROM files WHERE file_id = ?').get(fileId) as Record<string, unknown> | undefined
      if (!cur) return false
      // 未提供的字段保留原值（COALESCE 兜底）：摘要阶段与星标/链阶段可分次写
      db.prepare(`UPDATE files SET
          summary = COALESCE(?, summary),
          keywords = COALESCE(?, keywords),
          context = COALESCE(?, context),
          star = COALESCE(?, star),
          version_root_id = COALESCE(?, version_root_id)
        WHERE file_id = ?`)
        .run(
          meta.summary === undefined ? null : meta.summary,
          meta.keywords === undefined ? null : JSON.stringify(meta.keywords),
          meta.context === undefined ? null : meta.context,
          meta.star === undefined ? null : Math.floor(meta.star),
          meta.versionRootId === undefined ? null : meta.versionRootId,
          fileId,
        )
      return true
    })
  }

  /**
   * 保留期清理（M6-T1）：删除 cutoff 之前、且未被任何长期表引用的 messages 行。
   * events/tasks/promises 证据、files.msg_id、引用链（quote_of_msg_id）指向的行
   * 一律保留——保留期不破坏引用完整性。返回实际删除条数。
   */
  async deleteMessagesBefore(beforeTs: number): Promise<number> {
    let deleted = 0
    const ok = await this.write((db) => {
      const r = db
        .prepare(
          `DELETE FROM messages WHERE ts < ? AND msg_id NOT IN (
             SELECT evidence_msg_id FROM events WHERE evidence_msg_id IS NOT NULL
             UNION SELECT evidence_msg_id FROM tasks WHERE evidence_msg_id IS NOT NULL
             UNION SELECT evidence_msg_id FROM promises WHERE evidence_msg_id IS NOT NULL
             UNION SELECT requester_evidence_msg_id FROM promises WHERE requester_evidence_msg_id IS NOT NULL
             UNION SELECT fulfilled_msg_id FROM promises WHERE fulfilled_msg_id IS NOT NULL
             UNION SELECT msg_id FROM files WHERE msg_id IS NOT NULL
             UNION SELECT quote_of_msg_id FROM messages WHERE quote_of_msg_id IS NOT NULL
           )`,
        )
        .run(Math.floor(beforeTs))
      deleted = Number(r.changes)
      return true
    })
    return ok ? deleted : 0
  }

  /** 事件挂文件引用（T5.4 最小实现：events.file_ids JSON 数组并集）。返回是否成功。 */
  async attachFilesToEvent(eventId: number, fileIds: readonly string[]): Promise<boolean> {
    if (fileIds.length === 0) return false
    return this.write((db) => {
      const row = db.prepare('SELECT file_ids FROM events WHERE event_id = ?').get(eventId) as Record<string, unknown> | undefined
      if (!row) return false
      const merged = [...new Set([...safeJsonArray(row.file_ids), ...fileIds])]
      db.prepare('UPDATE events SET file_ids = ? WHERE event_id = ?').run(JSON.stringify(merged), eventId)
      return true
    })
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

  /** 按群取单条消息（服务层只读包装；库未开返回 null，不为此建库） */
  getMessage(chatId: string, msgId: string): StoredMessage | null {
    const st = this.stores.get(chatId)
    if (!st) return null
    return st.getMessage(msgId)
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

  // —— 以下为 M4-T4.1/T4.2 追加（tasks/events/reminder_log 服务层包装），不改上方既有行 ——

  /** 写一条任务（库未开则惰性建库；失败返回 null） */
  async appendTask(chatId: string, input: NewTaskInput, createdAt?: number): Promise<number | null> {
    try {
      return await this.open(chatId).appendTask(input, createdAt)
    } catch (error) {
      this.logger.error(`group-store appendTask(${chatId}) failed: ${String(error)}`)
      return null
    }
  }

  /** 按 id 取任务；库未打开返回 null（读操作不建库） */
  getTask(chatId: string, taskId: number): TaskRow | null {
    const st = this.stores.get(chatId)
    if (!st) return null
    return st.getTask(taskId)
  }

  /** 查任务；库未打开返回 [] */
  getTasks(chatId: string, opts?: { status?: TaskRow['status']; deadlineFrom?: number; deadlineTo?: number; limit?: number }): TaskRow[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    return st.getTasks(opts)
  }

  /** 更新任务状态；失败返回 false */
  async updateTaskStatus(chatId: string, taskId: number, status: TaskRow['status']): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.updateTaskStatus(taskId, status)
  }

  /** 登记模式学习指纹；失败返回 false */
  async setTaskLearnedPattern(chatId: string, taskId: number, pattern: string): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.setTaskLearnedPattern(taskId, pattern)
  }

  /** deadline 变更（更新原行不新建）；失败返回 false */
  async updateTaskDeadline(chatId: string, taskId: number, deadline: number | null, confidence: number): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.updateTaskDeadline(taskId, deadline, confidence)
  }

  /** 逾期自动标记；失败返回 false */
  async markTaskOverdue(chatId: string, taskId: number, at: number): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.markTaskOverdue(taskId, at)
  }

  /** 写一条事件；失败返回 null */
  async appendEvent(chatId: string, input: NewEventInput): Promise<number | null> {
    try {
      return await this.open(chatId).appendEvent(input)
    } catch (error) {
      this.logger.error(`group-store appendEvent(${chatId}) failed: ${String(error)}`)
      return null
    }
  }

  /** 按 id 取事件；库未打开返回 null */
  getEvent(chatId: string, eventId: number): EventRow | null {
    const st = this.stores.get(chatId)
    if (!st) return null
    return st.getEvent(eventId)
  }

  /** 查事件；库未打开返回 [] */
  getEvents(chatId: string, opts?: { status?: string; source?: 'auto' | 'manual'; category?: string; limit?: number }): EventRow[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    return st.getEvents(opts)
  }

  /** 冲突演变链：旧行 superseded + 回指新行；失败返回 false */
  async supersedeEvent(chatId: string, oldEventId: number, successorEventId: number): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.supersedeEvent(oldEventId, successorEventId)
  }

  /** 更新事件状态；库未打开返回 false */
  async updateEventStatus(chatId: string, eventId: number, status: string): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.updateEventStatus(eventId, status)
  }

  /** 提醒去重登记；失败返回 false */
  async appendReminderLog(chatId: string, taskId: number, point: string, firedAt: number): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.appendReminderLog(taskId, point, firedAt)
  }

  // —— 以下为 M5-T5.1/T5.3 追加（promises / files / 事件文件引用 服务层包装），不改上方既有行 ——

  /** 写一条承诺（库未开则惰性建库；失败返回 null） */
  async appendPromise(chatId: string, input: NewPromiseInput, createdAt?: number): Promise<number | null> {
    try {
      return await this.open(chatId).appendPromise(input, createdAt)
    } catch (error) {
      this.logger.error(`group-store appendPromise(${chatId}) failed: ${String(error)}`)
      return null
    }
  }

  getPromise(chatId: string, promiseId: number): PromiseRow | null {
    const st = this.stores.get(chatId)
    if (!st) return null
    return st.getPromise(promiseId)
  }

  getPromises(chatId: string, opts?: { status?: PromiseStatus; limit?: number }): PromiseRow[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    return st.getPromises(opts)
  }

  async updatePromiseStatus(chatId: string, promiseId: number, status: PromiseStatus): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.updatePromiseStatus(promiseId, status)
  }

  async setPromiseLearnedPattern(chatId: string, promiseId: number, pattern: string): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.setPromiseLearnedPattern(promiseId, pattern)
  }

  async updatePromiseDeadline(chatId: string, promiseId: number, deadline: number | null, confidence: number): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.updatePromiseDeadline(promiseId, deadline, confidence)
  }

  async markPromiseBroken(chatId: string, promiseId: number, at: number): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.markPromiseBroken(promiseId, at)
  }

  async fulfillPromise(chatId: string, promiseId: number, msgId: string | null, ts: number): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.fulfillPromise(promiseId, msgId, ts)
  }

  async appendFile(chatId: string, input: NewFileInput): Promise<string | null> {
    try {
      return await this.open(chatId).appendFile(input)
    } catch (error) {
      this.logger.error(`group-store appendFile(${chatId}) failed: ${String(error)}`)
      return null
    }
  }

  getFile(chatId: string, fileId: string): FileRow | null {
    const st = this.stores.get(chatId)
    if (!st) return null
    return st.getFile(fileId)
  }

  getFiles(chatId: string, opts?: { senderPid?: string; category?: string; limit?: number }): FileRow[] {
    const st = this.stores.get(chatId)
    if (!st) return []
    return st.getFiles(opts)
  }

  async appendFileAppearance(chatId: string, fileId: string, msgId: string, ts: number, wxPath?: string): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.appendFileAppearance(fileId, msgId, ts, wxPath)
  }

  async updateFileMeta(chatId: string, fileId: string, meta: { summary?: string; keywords?: string[]; context?: string; star?: number; versionRootId?: string | null }): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.updateFileMeta(fileId, meta)
  }

  async attachFilesToEvent(chatId: string, eventId: number, fileIds: readonly string[]): Promise<boolean> {
    const st = this.stores.get(chatId)
    if (!st) return false
    return st.attachFilesToEvent(eventId, fileIds)
  }

  /** M6-T1 保留期清理：删除 cutoff 前未被引用的 messages 行，返回删除条数（未开库 = 0） */
  async deleteMessagesBefore(chatId: string, beforeTs: number): Promise<number> {
    this.assertChatId(chatId)
    const st = this.stores.get(chatId)
    if (!st) return 0
    return st.deleteMessagesBefore(beforeTs)
  }

  /** 关闭全部库句柄（dispose 时调用，幂等） */
  dispose(): void {
    for (const st of this.stores.values()) st.close()
    this.stores.clear()
  }
}

/** tasks.status 允许值（schema CHECK 同口径） */
export const TASK_STATUSES: readonly TaskRow['status'][] = ['pending_confirm', 'active', 'done', 'cancelled']

function mapTaskRow(r: Record<string, unknown>): TaskRow {
  return {
    taskId: Number(r.task_id),
    statement: String(r.statement),
    assignerPid: r.assigner_pid === null ? null : String(r.assigner_pid),
    evidenceMsgId: r.evidence_msg_id === null ? null : String(r.evidence_msg_id),
    deadline: r.deadline === null ? null : Number(r.deadline),
    deadlineConfidence: Number(r.deadline_confidence),
    status: String(r.status) as TaskRow['status'],
    learnedPattern: r.learned_pattern === null ? null : String(r.learned_pattern),
    overdueMarkedAt: Number(r.overdue_marked_at ?? 0),
    createdAt: Number(r.created_at ?? 0),
  }
}

function mapEventRow(r: Record<string, unknown>): EventRow {
  return {
    eventId: Number(r.event_id),
    category: String(r.category),
    statement: String(r.statement),
    evidenceMsgId: r.evidence_msg_id === null ? null : String(r.evidence_msg_id),
    confidence: Number(r.confidence),
    status: String(r.status),
    supersedesEventId: r.supersedes_event_id === null ? null : Number(r.supersedes_event_id),
    source: String(r.source) as EventRow['source'],
    // M6-T3：已挂文件引用（events.file_ids JSON 数组；attachFilesToEvent 写入侧）
    fileIds: safeJsonArray(r.file_ids).map(String),
  }
}

/** promises 行映射（M5 追加；appearances 类 JSON 在 files，见 mapFileRow） */
function mapPromiseRow(r: Record<string, unknown>): PromiseRow {
  return {
    promiseId: Number(r.promise_id),
    statement: String(r.statement),
    assignerPid: r.assigner_pid === null ? null : String(r.assigner_pid),
    evidenceMsgId: r.evidence_msg_id === null ? null : String(r.evidence_msg_id),
    deadline: r.deadline === null ? null : Number(r.deadline),
    deadlineConfidence: Number(r.deadline_confidence),
    status: String(r.status) as PromiseRow['status'],
    learnedPattern: r.learned_pattern === null ? null : String(r.learned_pattern),
    requesterEvidenceMsgId: r.requester_evidence_msg_id === null ? null : String(r.requester_evidence_msg_id),
    fulfilledMsgId: r.fulfilled_msg_id === null ? null : String(r.fulfilled_msg_id),
    fulfilledTs: r.fulfilled_ts === null ? null : Number(r.fulfilled_ts),
    createdAt: Number(r.created_at ?? 0),
    brokenMarkedAt: Number(r.broken_marked_at ?? 0),
  }
}

/** files 行映射（appearances/keywords 为 JSON 数组文本；损坏回退空） */
function mapFileRow(r: Record<string, unknown>): FileRow {
  return {
    fileId: String(r.file_id),
    name: String(r.name),
    ext: String(r.ext),
    size: Number(r.size ?? 0),
    senderPid: r.sender_pid === null ? null : String(r.sender_pid),
    msgId: r.msg_id === null ? null : String(r.msg_id),
    wxPath: String(r.wx_path ?? ''),
    hash: String(r.hash ?? ''),
    summary: String(r.summary ?? ''),
    star: Number(r.star ?? 0),
    versionRootId: r.version_root_id === null ? null : String(r.version_root_id),
    category: String(r.category ?? ''),
    appearances: safeJsonArray(r.appearances).map((id) => ({ msgId: id, ts: 0 })),
    lastSeenTs: Number(r.last_seen_ts ?? 0),
    context: String(r.context ?? ''),
    keywords: safeJsonArray(r.keywords),
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
