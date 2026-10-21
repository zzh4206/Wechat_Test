// queries.mjs —— FE-1 只读查询（前端设计 §2 / §4.2）。
//
// 数据源：knowledge.db（0数据格式 v6）+ 每群库 groups/<chatId>/store.db + digests/*.md。
// - 一律 `readOnly: true` 打开，再叠 `PRAGMA query_only`；本模块零写入；
// - 所有 SQL 参数化，chatId 先过白名单（调用方传入 allowed 集合）；
// - 返回只含页面所需字段；报告/资料正文经 renderMarkdown 转为块结构（不产出 HTML）。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renderMarkdown } from './markdown.mjs'
import { ID_RE } from './manifest.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/
const PERIODS = new Set(['daily', 'weekly', 'monthly'])
const LIST_LIMIT = 500

/** 只读打开 SQLite；文件不存在返回 null */
export function openReadOnly(path) {
  if (!path || !existsSync(path)) return null
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA query_only = ON')
  return db
}

/** 查询参数非法（→ 400） */
export class BadRequest extends Error {}

function checkDate(v, name) {
  if (v !== undefined && !DATE_RE.test(v)) throw new BadRequest(`${name} 须为 YYYY-MM-DD`)
  return v
}

/** 把可选 chat 参数收敛为白名单内的 chatId 列表 */
function scopeChats(chat, allowed) {
  if (chat === undefined) return [...allowed]
  if (!allowed.has(chat)) return null
  return [chat]
}

const placeholders = (n) => Array(n).fill('?').join(',')

// —— knowledge.db ——

/** 白名单群（含聚合）及各自最近一期报告日期 */
export function listChats(kdb, allowed) {
  const latest = new Map()
  if (kdb) {
    const ids = [...allowed]
    const rows = kdb.prepare(`SELECT chat_id, MAX(period_start) AS latest FROM report WHERE chat_id IN (${placeholders(ids.length)}) GROUP BY chat_id`).all(...ids)
    for (const r of rows) latest.set(r.chat_id, r.latest)
  }
  return [...allowed].map(chatId => ({ chatId, latestReport: latest.get(chatId) ?? null }))
}

/** 报告列表（不含正文） */
export function listReports(kdb, allowed, q) {
  const chats = scopeChats(q.chat, allowed)
  if (!chats) return null
  if (q.period !== undefined && !PERIODS.has(q.period)) throw new BadRequest('period 须为 daily/weekly/monthly')
  checkDate(q.from, 'from')
  checkDate(q.to, 'to')
  const where = [`r.chat_id IN (${placeholders(chats.length)})`]
  const args = [...chats]
  if (q.period) { where.push('r.period_type = ?'); args.push(q.period) }
  if (q.from) { where.push('r.period_start >= ?'); args.push(q.from) }
  if (q.to) { where.push('r.period_start <= ?'); args.push(q.to) }
  return kdb.prepare(`
    SELECT r.id, r.period_type AS periodType, r.period_start AS periodStart, r.period_end AS periodEnd,
           r.title, r.status, r.chat_id AS chatId, r.updated_at AS updatedAt, r.entry_count AS entryCount,
           COALESCE(v.revision_count, 0) AS revisionCount
    FROM v_report_full r
    LEFT JOIN v_report_revised v
      ON v.chat_id = r.chat_id AND v.period_type = r.period_type AND v.period_start = r.period_start
    WHERE ${where.join(' AND ')}
    ORDER BY r.period_start DESC, r.period_type, r.chat_id
    LIMIT ${LIST_LIMIT}`).all(...args)
}

/** 报告详情：正文块 + 修订历史 + 同群同周期的前后期 */
export function getReport(kdb, allowed, id) {
  const r = kdb.prepare(`SELECT id, period_type, period_start, period_end, title, content_md, status, chat_id, updated_at
                         FROM report WHERE id = ?`).get(id)
  if (!r || !allowed.has(r.chat_id)) return null
  const neighbor = (op, order) => kdb.prepare(`SELECT id, period_start AS periodStart FROM report
      WHERE chat_id = ? AND period_type = ? AND period_start ${op} ? ORDER BY period_start ${order} LIMIT 1`)
    .get(r.chat_id, r.period_type, r.period_start) ?? null
  const revisions = kdb.prepare(`SELECT ts, type, summary, source FROM report_revision
      WHERE chat_id = ? AND period_type = ? AND period_start = ? ORDER BY ts, id`)
    .all(r.chat_id, r.period_type, r.period_start)
  return {
    id: r.id,
    periodType: r.period_type,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    title: r.title,
    status: r.status,
    chatId: r.chat_id,
    updatedAt: r.updated_at,
    blocks: renderMarkdown(r.content_md),
    revisions,
    prev: neighbor('<', 'DESC'),
    next: neighbor('>', 'ASC'),
  }
}

/** 月历：当月每天出现了哪些周期的报告（周报/月报记在 period_start 当天） */
export function calendar(kdb, allowed, q) {
  if (q.chat === undefined || !allowed.has(q.chat)) return null
  if (!MONTH_RE.test(q.month ?? '')) throw new BadRequest('month 须为 YYYY-MM')
  const rows = kdb.prepare(`SELECT id, period_type, period_start FROM report
      WHERE chat_id = ? AND substr(period_start, 1, 7) = ? ORDER BY period_start`).all(q.chat, q.month)
  const days = {}
  for (const r of rows) (days[r.period_start] ??= []).push({ id: r.id, periodType: r.period_type })
  return { chatId: q.chat, month: q.month, days }
}

/** 资料列表（doc 不分群；q 暂用 instr，FTS5 落地后替换） */
export function listDocs(kdb, q) {
  const where = ["d.status = 'active'"]
  const args = []
  if (q.category !== undefined) { where.push('d.category = ?'); args.push(q.category) }
  if (q.tag !== undefined) {
    where.push('EXISTS (SELECT 1 FROM doc_tag dt JOIN tag t ON t.id = dt.tag_id WHERE dt.doc_id = d.id AND t.name = ?)')
    args.push(q.tag)
  }
  if (q.q !== undefined) {
    if (q.q.length > 100) throw new BadRequest('q 过长')
    where.push('instr(d.title, ?) > 0')
    args.push(q.q)
  }
  return kdb.prepare(`
    SELECT d.id, d.title, d.category, d.source_type AS sourceType, d.source_ref AS sourceRef,
           d.file_path AS filePath, d.updated_at AS updatedAt,
           (SELECT json_group_array(t.name) FROM doc_tag dt JOIN tag t ON t.id = dt.tag_id WHERE dt.doc_id = d.id) AS tags
    FROM doc d WHERE ${where.join(' AND ')}
    ORDER BY d.updated_at DESC LIMIT ${LIST_LIMIT}`).all(...args)
    .map(d => ({ ...d, tags: JSON.parse(d.tags) }))
}

/** 资料详情（file_path 只展示不提供下载） */
export function getDoc(kdb, id) {
  const d = kdb.prepare(`SELECT id, title, category, source_type, source_ref, file_path, content_md, updated_at
                         FROM doc WHERE id = ? AND status = 'active'`).get(id)
  if (!d) return null
  return {
    id: d.id, title: d.title, category: d.category, sourceType: d.source_type,
    sourceRef: d.source_ref, filePath: d.file_path, updatedAt: d.updated_at,
    blocks: d.content_md ? renderMarkdown(d.content_md) : [],
  }
}

/** 全部标签与分类（筛选器用） */
export function docFacets(kdb) {
  return {
    tags: kdb.prepare('SELECT name FROM tag ORDER BY name').all().map(r => r.name),
    categories: kdb.prepare("SELECT DISTINCT category FROM doc WHERE category IS NOT NULL AND status = 'active' ORDER BY category").all().map(r => r.category),
  }
}

/** 媒体元数据（只有地址与元数据，本体不入库也不提供下载） */
export function listMedia(kdb, allowed, q) {
  const chats = scopeChats(q.chat, allowed)
  if (!chats) return null
  const where = [`chat_id IN (${placeholders(chats.length)})`]
  const args = [...chats]
  if (q.type !== undefined) { where.push('media_type = ?'); args.push(q.type) }
  if (q.status !== undefined) { where.push('status = ?'); args.push(q.status) }
  return kdb.prepare(`
    SELECT id, chat_id AS chatId, media_type AS mediaType, file_name AS fileName, ext, size,
           path, path_kind AS pathKind, status, source_ts AS sourceTs
    FROM media WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(source_ts, created_at) DESC LIMIT ${LIST_LIMIT}`).all(...args)
}

/** 当日会话要点（chat_digest 不分群；只存要点不存原文） */
export function listDigests(kdb, q) {
  checkDate(q.day, 'day')
  const rows = q.day
    ? kdb.prepare('SELECT id, chat_topic, digest_md, happened_on FROM chat_digest WHERE happened_on = ? ORDER BY id').all(q.day)
    : kdb.prepare(`SELECT id, chat_topic, digest_md, happened_on FROM chat_digest ORDER BY happened_on DESC, id DESC LIMIT ${LIST_LIMIT}`).all()
  return rows.map(r => ({ id: r.id, chatTopic: r.chat_topic, happenedOn: r.happened_on, blocks: renderMarkdown(r.digest_md) }))
}

// —— 每群库 + digests/ ——

const digestDir = (stateDir, chatId, pid) => join(stateDir, 'digests', chatId, ...(pid ? [pid] : []))

const listDir = (dir) => {
  try { return readdirSync(dir) } catch { return [] }
}

/** 关注人员：identities（watch_level≠off）∪ 已有摘要目录的 pid */
export function listPersons(stateDir, allowed, chatId) {
  if (!allowed.has(chatId)) return null
  const persons = new Map()
  let db = null
  try {
    db = openReadOnly(join(stateDir, 'groups', chatId, 'store.db'))
    if (db) {
      for (const r of db.prepare('SELECT pid, group_nick, remark, watch_level FROM identities').all()) {
        persons.set(r.pid, { pid: r.pid, groupNick: r.group_nick, remark: r.remark, watchLevel: r.watch_level, days: [] })
      }
    }
  } catch {
    // 每群库不可读（未建库/被锁）→ 只按摘要目录列出
  } finally {
    db?.close()
  }
  for (const pid of listDir(digestDir(stateDir, chatId))) {
    if (!ID_RE.test(pid)) continue
    const days = listDir(digestDir(stateDir, chatId, pid))
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map(f => f.slice(0, 10)).sort().reverse()
    const p = persons.get(pid) ?? { pid, groupNick: '', remark: '', watchLevel: 'off', days: [] }
    p.days = days
    persons.set(pid, p)
  }
  return [...persons.values()].filter(p => p.watchLevel !== 'off' || p.days.length > 0)
}

/** 某人某日摘要（md 文件，经 renderMarkdown） */
export function getPersonDigest(stateDir, allowed, chatId, pid, day) {
  if (!allowed.has(chatId)) return null
  if (!ID_RE.test(pid)) throw new BadRequest('pid 非法')
  if (!DATE_RE.test(day ?? '')) throw new BadRequest('day 须为 YYYY-MM-DD')
  const file = join(digestDir(stateDir, chatId, pid), `${day}.md`)
  try {
    if (!statSync(file).isFile()) return null
    return { chatId, pid, day, blocks: renderMarkdown(readFileSync(file, 'utf8')) }
  } catch {
    return null
  }
}

// —— FE-2：审批收件箱（每群库只读；审批写入只走 actions.jsonl） ——

const EVIDENCE_PREVIEW = 120

/** 打开某群的每群库（不存在返回 null） */
function openGroupDb(stateDir, chatId) {
  return openReadOnly(join(stateDir, 'groups', chatId, 'store.db'))
}

/** 表是否有某列（旧库可能缺 created_at 等迁移列） */
function hasColumn(db, table, col) {
  return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, col) !== undefined
}

/**
 * 某群待处理项：
 * - pending：待确认的任务 / 承诺 / 事件；
 * - active：进行中的任务与承诺（可完成/兑现/关闭；无时限的任务标「待定时间」）。
 * 证据只带发送者与前 120 字预览，完整上下文走 /api/evidence。
 */
function inboxOfChat(db, chatId) {
  const nick = new Map(db.prepare('SELECT pid, group_nick, remark FROM identities').all().map(r => [r.pid, r.remark || r.group_nick]))
  const msgStmt = db.prepare('SELECT ts, sender_pid, sender_name, text FROM messages WHERE msg_id = ?')
  const evidenceOf = (msgId) => {
    if (!msgId) return null
    const m = msgStmt.get(msgId)
    if (!m) return { msgId, ts: null, sender: '', preview: '' }
    return { msgId, ts: m.ts, sender: m.sender_name || nick.get(m.sender_pid) || '', preview: m.text.slice(0, EVIDENCE_PREVIEW) }
  }
  const items = []
  const taskCreated = hasColumn(db, 'tasks', 'created_at') ? 'created_at' : '0'
  for (const r of db.prepare(`SELECT task_id, statement, assigner_pid, evidence_msg_id, deadline, deadline_confidence, status, ${taskCreated} AS created_at
      FROM tasks WHERE status IN ('pending_confirm', 'active') ORDER BY task_id DESC LIMIT ${LIST_LIMIT}`).all()) {
    items.push({
      kind: 'task', id: r.task_id, chatId, statement: r.statement, status: r.status,
      assigner: r.assigner_pid ? nick.get(r.assigner_pid) ?? '' : '',
      deadline: r.deadline, deadlineConfidence: r.deadline_confidence, createdAt: r.created_at || null,
      evidence: evidenceOf(r.evidence_msg_id),
    })
  }
  for (const r of db.prepare(`SELECT promise_id, statement, assigner_pid, evidence_msg_id, deadline, deadline_confidence, status
      FROM promises WHERE status IN ('pending_confirm', 'active') ORDER BY promise_id DESC LIMIT ${LIST_LIMIT}`).all()) {
    items.push({
      kind: 'promise', id: r.promise_id, chatId, statement: r.statement, status: r.status,
      assigner: r.assigner_pid ? nick.get(r.assigner_pid) ?? '' : '',
      deadline: r.deadline, deadlineConfidence: r.deadline_confidence,
      evidence: evidenceOf(r.evidence_msg_id),
    })
  }
  for (const r of db.prepare(`SELECT event_id, category, statement, evidence_msg_id, confidence, status
      FROM events WHERE status = 'pending_confirm' ORDER BY event_id DESC LIMIT ${LIST_LIMIT}`).all()) {
    items.push({
      kind: 'event', id: r.event_id, chatId, statement: r.statement, status: r.status,
      category: r.category, confidence: r.confidence,
      evidence: evidenceOf(r.evidence_msg_id),
    })
  }
  return items
}

/** 收件箱：chat 缺省 = 全部白名单群 */
export function listInbox(stateDir, allowed, chat) {
  const chats = scopeChats(chat, allowed)
  if (!chats) return null
  const items = []
  for (const chatId of chats) {
    let db = null
    try {
      db = openGroupDb(stateDir, chatId)
      if (db) items.push(...inboxOfChat(db, chatId))
    } catch {
      // 单群库不可读（未建库/被锁/旧 schema）不拖累其它群
    } finally {
      db?.close()
    }
  }
  return items
}

/** 证据上下文：证据消息前后各 around 条（≤10） */
export function evidenceContext(stateDir, allowed, q) {
  if (q.chat === undefined || !allowed.has(q.chat)) return null
  if (typeof q.msg !== 'string' || q.msg === '' || q.msg.length > 128) throw new BadRequest('msg 非法')
  const around = Math.min(Math.max(Number.parseInt(q.around ?? '5', 10) || 5, 1), 10)
  const db = openGroupDb(stateDir, q.chat)
  if (!db) return { msgId: q.msg, messages: [] }
  try {
    const center = db.prepare('SELECT ts FROM messages WHERE msg_id = ?').get(q.msg)
    if (!center) return { msgId: q.msg, messages: [] }
    const cols = 'msg_id, ts, sender_pid, sender_name, kind, text'
    const before = db.prepare(`SELECT ${cols} FROM messages WHERE (ts < ? OR (ts = ? AND msg_id < ?)) ORDER BY ts DESC, msg_id DESC LIMIT ?`).all(center.ts, center.ts, q.msg, around).reverse()
    const self = db.prepare(`SELECT ${cols} FROM messages WHERE msg_id = ?`).all(q.msg)
    const after = db.prepare(`SELECT ${cols} FROM messages WHERE (ts > ? OR (ts = ? AND msg_id > ?)) ORDER BY ts, msg_id LIMIT ?`).all(center.ts, center.ts, q.msg, around)
    return {
      msgId: q.msg,
      messages: [...before, ...self, ...after].map(m => ({
        msgId: m.msg_id, ts: m.ts, sender: m.sender_name, kind: m.kind, text: m.text, isEvidence: m.msg_id === q.msg,
      })),
    }
  } finally {
    db.close()
  }
}
