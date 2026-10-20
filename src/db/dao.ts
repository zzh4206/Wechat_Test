/**
 * dao.ts：知识库 CRUD（冻结 schema 上的薄封装）。
 * 幂等语义：
 * - upsertDoc：content_hash 命中已有行 → 返回已有 id、不覆盖（DESIGN 修订2「拒绝重复」语义）；
 * - upsertReport：(period_type, period_start, chat_id) 三元组命中 → UPDATE 正文等（修订1「UPDATE 而非删建」）；
 * - insertChatDigest：source_key 命中 → UPDATE（schema UNIQUE 幂等键）；
 * - upsertMedia：source_key 命中 → UPDATE（媒体重扫幂等，updated_at 刷新）。
 * 全部写路径失败只 warn 返回 null/false，不抛致命错误。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { normalizeText, withTransaction, type DbLogger } from './db.js'
import type {
  ChatDigestInput,
  ChatDigestRow,
  DocInput,
  DocRow,
  EntryInput,
  EntryRow,
  MarkingInput,
  MarkingRow,
  MediaInput,
  MediaRow,
  ReportFullRow,
  ReportInput,
  ReportRevisionInput,
  ReportRevisionRow,
  ReportRow,
} from './types.js'

export { normalizeText }

/** 归一化后取 SHA-256 hex（去 BOM、CRLF→LF、strip；DESIGN.md 修订2） */
export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex')
}

/** 8 位短哈希（外部 source_key 用，如 'topic:2026-01-05:ab12cd34'） */
export function hash8(text: string): string {
  return contentHash(text).slice(0, 8)
}

export class KnowledgeDao {
  constructor(
    private readonly db: DatabaseSync,
    private readonly logger: DbLogger,
  ) {}

  private now(): number {
    return Date.now()
  }

  // ---------- doc ----------

  /** 幂等插入资料：content_hash 命中 → 返回已有 id；非法输入/写失败 → null */
  upsertDoc(input: DocInput): number | null {
    if (!input.title) return null
    const contentMd = input.contentMd?.trim() ? input.contentMd : null
    const hash = contentMd ? contentHash(contentMd) : null
    try {
      if (hash) {
        const hit = this.db
          .prepare('SELECT id FROM doc WHERE content_hash = ? LIMIT 1')
          .get(hash) as { id: number } | undefined
        if (hit) return hit.id
      }
      const now = input.createdAt ?? this.now()
      const res = this.db
        .prepare(
          `INSERT INTO doc (title, category, source_type, source_ref, file_path, content_md, content_hash, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title,
          input.category ?? null,
          input.sourceType ?? 'manual',
          input.sourceRef ?? null,
          input.filePath ?? null,
          contentMd,
          hash,
          input.status ?? 'active',
          now,
          now,
        )
      return Number(res.lastInsertRowid)
    } catch (error) {
      this.logger.warn(`dao.upsertDoc failed: ${String(error)}`)
      return null
    }
  }

  getDoc(id: number): DocRow | null {
    try {
      return (this.db.prepare('SELECT * FROM doc WHERE id = ?').get(id) as DocRow | undefined) ?? null
    } catch {
      return null
    }
  }

  /**
   * tag 按 name 幂等存在即取（SELECT 无则 INSERT），返回 tag id；失败 → null。
   * 与 Python get_or_create_tag 同语义。
   */
  ensureTag(name: string): number | null {
    if (!name) return null
    try {
      const hit = this.db.prepare('SELECT id FROM tag WHERE name = ?').get(name) as { id: number } | undefined
      if (hit) return hit.id
      this.db.prepare('INSERT INTO tag (name) VALUES (?)').run(name)
      const row = this.db.prepare('SELECT id FROM tag WHERE name = ?').get(name) as { id: number }
      return row.id
    } catch (error) {
      this.logger.warn(`dao.ensureTag failed: ${String(error)}`)
      return null
    }
  }

  /**
   * 全库 content_md 已含该 URL → 返回已有 doc id（与 Python 脚本查重 2 同口径：
   * `content_md LIKE '%<url>%'`），未命中/失败 → null。
   */
  findDocIdByUrl(url: string): number | null {
    if (!url) return null
    try {
      // instr() 精确子串（URL 常含 _ 等 LIKE 通配符，不用 LIKE 以免口径漂移；与 Python `u in m` 等价）
      const row = this.db
        .prepare('SELECT id FROM doc WHERE instr(content_md, ?) > 0 LIMIT 1')
        .get(url) as { id: number } | undefined
      return row?.id ?? null
    } catch (error) {
      this.logger.warn(`dao.findDocIdByUrl failed: ${String(error)}`)
      return null
    }
  }

  /** content_hash 精确命中 → 返回已有 doc id（文件索引行指纹查重），未命中/失败 → null */
  findDocByHash(hash: string): number | null {
    if (!hash) return null
    try {
      const row = this.db.prepare('SELECT id FROM doc WHERE content_hash = ? LIMIT 1').get(hash) as
        | { id: number }
        | undefined
      return row?.id ?? null
    } catch (error) {
      this.logger.warn(`dao.findDocByHash failed: ${String(error)}`)
      return null
    }
  }

  /** 给资料打标签（tag/doc_tag 幂等：INSERT OR IGNORE） */
  tagDoc(docId: number, tagName: string): boolean {
    try {
      this.db.prepare('INSERT OR IGNORE INTO tag (name) VALUES (?)').run(tagName)
      const tag = this.db.prepare('SELECT id FROM tag WHERE name = ?').get(tagName) as { id: number }
      this.db.prepare('INSERT OR IGNORE INTO doc_tag (doc_id, tag_id) VALUES (?, ?)').run(docId, tag.id)
      return true
    } catch (error) {
      this.logger.warn(`dao.tagDoc failed: ${String(error)}`)
      return false
    }
  }

  /** 按标签查资料 */
  listDocsByTag(tagName: string): DocRow[] {
    try {
      return this.db
        .prepare(
          `SELECT d.* FROM doc d
           JOIN doc_tag dt ON dt.doc_id = d.id
           JOIN tag t ON t.id = dt.tag_id
           WHERE t.name = ? ORDER BY d.id`,
        )
        .all(tagName) as unknown as DocRow[]
    } catch {
      return []
    }
  }

  // ---------- entry ----------

  insertEntry(input: EntryInput): number | null {
    try {
      const res = this.db
        .prepare(
          `INSERT INTO entry (ts, kind, content_md, report_id, doc_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.ts, input.kind ?? 'note', input.contentMd, input.reportId ?? null, input.docId ?? null, input.createdAt ?? this.now())
      return Number(res.lastInsertRowid)
    } catch (error) {
      this.logger.warn(`dao.insertEntry failed: ${String(error)}`)
      return null
    }
  }

  /** entry 无业务唯一键；导入器等幂等场景用 (ts, kind, content_md) 精确查重 */
  findEntry(ts: number, kind: string, contentMd: string): EntryRow | null {
    try {
      return (
        (this.db
          .prepare('SELECT * FROM entry WHERE ts = ? AND kind = ? AND content_md = ? LIMIT 1')
          .get(ts, kind, contentMd) as EntryRow | undefined) ?? null
      )
    } catch {
      return null
    }
  }

  /** 未归档条目（report_id IS NULL，走部分索引） */
  listEntriesPending(limit = 200): EntryRow[] {
    try {
      return this.db
        .prepare('SELECT * FROM entry WHERE report_id IS NULL ORDER BY ts LIMIT ?')
        .all(limit) as unknown as EntryRow[]
    } catch {
      return []
    }
  }

  /** 按周期（起止日期，含端点）取条目 */
  listEntriesByRange(startTs: number, endTs: number): EntryRow[] {
    try {
      return this.db
        .prepare('SELECT * FROM entry WHERE ts >= ? AND ts < ? ORDER BY ts')
        .all(startTs, endTs) as unknown as EntryRow[]
    } catch {
      return []
    }
  }

  // ---------- report ----------

  /**
   * 幂等 upsert：UNIQUE(period_type, period_start, chat_id) 三元组冲突 → UPDATE 正文。
   * T4 裁定（REPLY-v0.6）：修订**不改变** status——冲突分支保持既有 status 不动
   * （final 保持 final：draft→final 单向定稿，修订不降级；draft 也不会被自动 final）。
   */
  upsertReport(input: ReportInput): number | null {
    const chatId = input.chatId ?? 'aggregate'
    try {
      const now = input.createdAt ?? this.now()
      const res = this.db
        .prepare(
          `INSERT INTO report (period_type, period_start, period_end, title, content_md, status, chat_id, doc_ids_hint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (period_type, period_start, chat_id) DO UPDATE SET
             period_end = excluded.period_end,
             title = excluded.title,
             content_md = excluded.content_md,
             doc_ids_hint = excluded.doc_ids_hint,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.periodType,
          input.periodStart,
          input.periodEnd,
          input.title,
          input.contentMd,
          input.status ?? 'draft',
          chatId,
          input.docIdsHint ?? null,
          now,
          now,
        )
      const row = this.getReport(input.periodType, input.periodStart, chatId)
      return row?.id ?? Number(res.lastInsertRowid)
    } catch (error) {
      this.logger.warn(`dao.upsertReport failed: ${String(error)}`)
      return null
    }
  }

  /** chatId 缺省时按 aggregate 语义查（v0.4 唯一键三元组） */
  getReport(periodType: string, periodStart: string, chatId = 'aggregate'): ReportRow | null {
    try {
      return (
        (this.db
          .prepare('SELECT * FROM report WHERE period_type = ? AND period_start = ? AND chat_id = ?')
          .get(periodType, periodStart, chatId) as ReportRow | undefined) ?? null
      )
    } catch {
      return null
    }
  }

  /** 视图查询：报告全文 + 条目数 */
  listReportsByRange(periodType: string, startDay: string, endDay: string): ReportFullRow[] {
    try {
      return this.db
        .prepare('SELECT * FROM v_report_full WHERE period_type = ? AND period_start >= ? AND period_start <= ? ORDER BY period_start')
        .all(periodType, startDay, endDay) as unknown as ReportFullRow[]
    } catch {
      return []
    }
  }

  // ---------- media ----------

  /** 幂等 upsert：source_key 冲突 → UPDATE 全字段并刷新 updated_at（媒体重扫幂等） */
  upsertMedia(m: MediaInput): number | null {
    if (!m.chatId || !m.mediaType || !m.sourceKey || !m.status) return null
    try {
      const now = m.createdAt ?? this.now()
      const res = this.db
        .prepare(
          `INSERT INTO media (chat_id, media_type, file_name, ext, size, md5, path, path_kind, status, source_key, source_ts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_key) DO UPDATE SET
             chat_id = excluded.chat_id,
             media_type = excluded.media_type,
             file_name = excluded.file_name,
             ext = excluded.ext,
             size = excluded.size,
             md5 = excluded.md5,
             path = excluded.path,
             path_kind = excluded.path_kind,
             status = excluded.status,
             source_ts = excluded.source_ts,
             updated_at = excluded.updated_at`,
        )
        .run(
          m.chatId,
          m.mediaType,
          m.fileName ?? null,
          m.ext ?? null,
          m.size ?? null,
          m.md5 ?? null,
          m.path ?? null,
          m.pathKind ?? null,
          m.status,
          m.sourceKey,
          m.sourceTs ?? null,
          now,
          now,
        )
      const row = this.db.prepare('SELECT id FROM media WHERE source_key = ?').get(m.sourceKey) as
        | { id: number }
        | undefined
      return row?.id ?? Number(res.lastInsertRowid)
    } catch (error) {
      this.logger.warn(`dao.upsertMedia failed: ${String(error)}`)
      return null
    }
  }

  /** 按会话查媒体元数据（可选按类型/状态过滤，走 idx_media_chat） */
  listMediaByChat(chatId: string, filter?: { mediaType?: string; status?: string }): MediaRow[] {
    try {
      const conds = ['chat_id = ?']
      const args: SQLInputValue[] = [chatId]
      if (filter?.mediaType) {
        conds.push('media_type = ?')
        args.push(filter.mediaType)
      }
      if (filter?.status) {
        conds.push('status = ?')
        args.push(filter.status)
      }
      args.push(500)
      return this.db
        .prepare(`SELECT * FROM media WHERE ${conds.join(' AND ')} ORDER BY created_at LIMIT ?`)
        .all(...args) as unknown as MediaRow[]
    } catch {
      return []
    }
  }

  // ---------- report_revision / marking（v0.6，TECH-v0.6 §3.1） ----------

  /**
   * 幂等插入修订事件：source_key 冲突 → 返回已有 id、**不 UPDATE**
   * （修订是不可变事实，重放不产生重复行也不覆盖）；失败 → null。
   */
  insertReportRevision(input: ReportRevisionInput): number | null {
    if (!input.chatId || !input.sourceKey) return null
    try {
      const hit = this.db
        .prepare('SELECT id FROM report_revision WHERE source_key = ? LIMIT 1')
        .get(input.sourceKey) as { id: number } | undefined
      if (hit) return hit.id
      const res = this.db
        .prepare(
          `INSERT INTO report_revision (chat_id, period_type, period_start, ts, type, target_ref, summary, source, source_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.chatId,
          input.periodType,
          input.periodStart,
          input.ts,
          input.type,
          input.targetRef ?? null,
          input.summary ?? null,
          input.source ?? 'chat',
          input.sourceKey,
          input.createdAt ?? this.now(),
        )
      return Number(res.lastInsertRowid)
    } catch (error) {
      this.logger.warn(`dao.insertReportRevision failed: ${String(error)}`)
      return null
    }
  }

  /**
   * 幂等插入标记：source_key 冲突 → 返回已有 id、**不 UPDATE**（标记同样是不可变事实；
   * 同一 target_ref 的状态演变由追加新行表达，最新态走 v_marking_latest）。失败 → null。
   */
  insertMarking(input: MarkingInput): number | null {
    if (!input.chatId || !input.targetRef || !input.sourceKey) return null
    try {
      const hit = this.db
        .prepare('SELECT id FROM marking WHERE source_key = ? LIMIT 1')
        .get(input.sourceKey) as { id: number } | undefined
      if (hit) return hit.id
      const res = this.db
        .prepare(
          `INSERT INTO marking (chat_id, kind, target_ref, ts, source, source_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.chatId,
          input.kind,
          input.targetRef,
          input.ts,
          input.source ?? 'chat',
          input.sourceKey,
          input.createdAt ?? this.now(),
        )
      return Number(res.lastInsertRowid)
    } catch (error) {
      this.logger.warn(`dao.insertMarking failed: ${String(error)}`)
      return null
    }
  }

  /** 修订列表：可选按会话/周期类型过滤（走 idx_revision_report），按 ts 升序 */
  listRevisions(chatId?: string, periodType?: string): ReportRevisionRow[] {
    try {
      const conds: string[] = []
      const args: SQLInputValue[] = []
      if (chatId) {
        conds.push('chat_id = ?')
        args.push(chatId)
      }
      if (periodType) {
        conds.push('period_type = ?')
        args.push(periodType)
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      return this.db
        .prepare(`SELECT * FROM report_revision ${where} ORDER BY ts LIMIT 500`)
        .all(...args) as unknown as ReportRevisionRow[]
    } catch {
      return []
    }
  }

  /** 标记最新态（v_marking_latest：每 target_ref 最新一条，同 ts 并列取 MAX(id)）；可选按 kind 过滤 */
  listMarkingsLatest(kind?: string): MarkingRow[] {
    try {
      const rows = kind
        ? this.db.prepare('SELECT * FROM v_marking_latest WHERE kind = ? ORDER BY ts LIMIT 500').all(kind)
        : this.db.prepare('SELECT * FROM v_marking_latest ORDER BY ts LIMIT 500').all()
      return rows as unknown as MarkingRow[]
    } catch {
      return []
    }
  }

  // ---------- chat_digest ----------
  /** 幂等：source_key 冲突 → UPDATE（digest_md / happened_on / doc_id） */
  insertChatDigest(input: ChatDigestInput): number | null {
    if (!input.chatTopic || !input.digestMd || !input.sourceKey) return null
    try {
      const now = input.createdAt ?? this.now()
      const res = this.db
        .prepare(
          `INSERT INTO chat_digest (chat_topic, digest_md, happened_on, doc_id, source_key, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_key) DO UPDATE SET
             chat_topic = excluded.chat_topic,
             digest_md = excluded.digest_md,
             happened_on = excluded.happened_on,
             doc_id = excluded.doc_id`,
        )
        .run(
          input.chatTopic,
          input.digestMd,
          input.happenedOn ?? null,
          input.docId ?? null,
          input.sourceKey,
          input.createdBy ?? 'cli',
          now,
        )
      const row = this.db.prepare('SELECT id FROM chat_digest WHERE source_key = ?').get(input.sourceKey) as
        | { id: number }
        | undefined
      return row?.id ?? Number(res.lastInsertRowid)
    } catch (error) {
      this.logger.warn(`dao.insertChatDigest failed: ${String(error)}`)
      return null
    }
  }

  getChatDigestBySourceKey(sourceKey: string): ChatDigestRow | null {
    try {
      return (
        (this.db.prepare('SELECT * FROM chat_digest WHERE source_key = ?').get(sourceKey) as ChatDigestRow | undefined) ??
        null
      )
    } catch {
      return null
    }
  }

  listChatDigestsByDay(day: string): ChatDigestRow[] {
    try {
      return this.db.prepare('SELECT * FROM chat_digest WHERE happened_on = ? ORDER BY id').all(day) as unknown as ChatDigestRow[]
    } catch {
      return []
    }
  }

  // ---------- 批量 ----------

  /** 多条写入走 BEGIN IMMEDIATE 短事务（外部写入规约，DESIGN 修订4） */
  bulkWrite(fn: () => void): boolean {
    return withTransaction(this.db, this.logger, fn)
  }

  /** 单标量统计（导入器 / 测试断言行数用） */
  count(table: 'doc' | 'tag' | 'doc_tag' | 'report' | 'entry' | 'chat_digest' | 'media' | 'report_revision' | 'marking'): number {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      return Number(row.n)
    } catch {
      return -1
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 已关闭则忽略 */
    }
  }
}
