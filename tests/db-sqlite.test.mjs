/**
 * db-sqlite.test.mjs：SQLite 数据层（node:sqlite + DAO + 镜像 + 导入器）。
 * 全离线：临时目录建库，不碰真实 state / 真实 1数据 目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openDb, checkSchemaVersion } from '../lib/db/db.js'
import { KnowledgeDao, contentHash } from '../lib/db/dao.js'
import { createSqliteMirror } from '../lib/db/mirror.js'
import { Store } from '../lib/store.js'

const logger = { warn: () => {}, error: () => {}, debug: () => {} }

function tmpDb(name) {
  const dir = mkdtempSync(join(tmpdir(), `lurker-db-${name}-`))
  return { dir, path: join(dir, 't.db') }
}

test('DAO CRUD：doc/entry/report/chat_digest 基本读写', () => {
  const { path, dir } = tmpDb('crud')
  const db = openDb(path, { logger })
  assert.ok(db, 'openDb 应成功')
  const dao = new KnowledgeDao(db, logger)

  const docId = dao.upsertDoc({ title: '测试资料', contentMd: '# 正文\n' })
  assert.ok(docId)
  assert.equal(dao.getDoc(docId).title, '测试资料')
  dao.tagDoc(docId, '测试标签')
  assert.equal(dao.listDocsByTag('测试标签').length, 1)

  const entryId = dao.insertEntry({ ts: 1700000000000, kind: 'note', contentMd: '随手记' })
  assert.ok(entryId)
  assert.equal(dao.listEntriesPending().length, 1)

  const repId = dao.upsertReport({
    periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05',
    title: '日报 2026-01-05', contentMd: '正文',
  })
  assert.ok(repId)
  assert.equal(dao.getReport('daily', '2026-01-05').title, '日报 2026-01-05')
  assert.equal(dao.listReportsByRange('daily', '2026-01-01', '2026-01-31')[0].entry_count, 0)

  const dk = dao.insertChatDigest({
    chatTopic: 'topic:某个话题', digestMd: '要点', happenedOn: '2026-01-05',
    sourceKey: 'topic:2026-01-05:ab12cd34',
  })
  assert.ok(dk)
  assert.ok(dao.getChatDigestBySourceKey('topic:2026-01-05:ab12cd34'))
  assert.equal(dao.listChatDigestsByDay('2026-01-05').length, 1)

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('幂等：source_key 插两次行数不变且走 UPDATE；report 同键 upsert 不新增', () => {
  const { path, dir } = tmpDb('idem')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  const key = 'topic:2026-01-05:deadbeef'
  dao.insertChatDigest({ chatTopic: 'topic:A', digestMd: 'v1', sourceKey: key })
  assert.equal(dao.count('chat_digest'), 1)
  dao.insertChatDigest({ chatTopic: 'topic:A', digestMd: 'v2（更新）', sourceKey: key })
  assert.equal(dao.count('chat_digest'), 1, '冲突应 UPDATE 而非新插')
  assert.match(dao.getChatDigestBySourceKey(key).digest_md, /v2/)

  const rep = { periodType: 'weekly', periodStart: '2026-01-05', periodEnd: '2026-01-11', title: '周报', contentMd: 'v1' }
  dao.upsertReport(rep)
  dao.upsertReport({ ...rep, contentMd: 'v2（更新）' })
  assert.equal(dao.count('report'), 1)
  assert.match(dao.getReport('weekly', '2026-01-05').content_md, /v2/)

  // doc：同 content_hash 幂等返回已有 id
  const id1 = dao.upsertDoc({ title: 'a', contentMd: 'same' })
  const id2 = dao.upsertDoc({ title: 'b', contentMd: 'same' })
  assert.equal(id1, id2)
  assert.equal(dao.count('doc'), 1)

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('CHECK 拒绝非法周期：weekly 周期起点非周一 / monthly 非月初 / daily 不同日', () => {
  const { path, dir } = tmpDb('check')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  assert.equal(dao.upsertReport({ periodType: 'weekly', periodStart: '2026-01-06', periodEnd: '2026-01-12', title: 'x', contentMd: 'x' }), null)
  assert.equal(dao.upsertReport({ periodType: 'monthly', periodStart: '2026-01-02', periodEnd: '2026-01-31', title: 'x', contentMd: 'x' }), null)
  assert.equal(dao.upsertReport({ periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-06', title: 'x', contentMd: 'x' }), null)
  assert.equal(dao.upsertReport({ periodType: 'hourly', periodStart: '2026-01-05', periodEnd: '2026-01-05', title: 'x', contentMd: 'x' }), null)
  assert.equal(dao.count('report'), 0, '非法周期全部被 CHECK 拒绝')

  // 日期格式防线
  assert.equal(dao.insertChatDigest({ chatTopic: 't', digestMd: 'd', happenedOn: '20260105', sourceKey: 'k1' }), null)

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('镜像：insight/report 写入映射进库；未映射路径跳过；库不可写不影响 appendJsonl 返回 true', () => {
  const { path, dir } = tmpDb('mirror')
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-state-'))
  const store = new Store(stateDir, logger, path)
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  mkdirSync(join(stateDir, 'groups', '12345678@chatroom'), { recursive: true })
  mkdirSync(join(stateDir, 'audit'), { recursive: true })
  const insight = { ts: '2026-01-05T10:00:00.000Z', type: 'topic', title: '话题A', summary: '关于A的讨论要点' }
  assert.equal(store.appendJsonl('groups/12345678@chatroom/insights.jsonl', insight), true, 'appendJsonl 主流程必须成功')
  assert.equal(dao.count('chat_digest'), 1, 'insight 镜像进 chat_digest')
  assert.ok(store.appendJsonl('audit/something.jsonl', { x: 1 }), '未映射路径不影响主流程')
  assert.equal(dao.count('chat_digest') + dao.count('entry'), 1, '未映射路径不写库')

  const md = '# 日报\n\n正文'
  store.ensureDir('reports/12345678@chatroom') // appendJsonl/writeText 不建父目录（既有行为）
  assert.equal(store.writeText('reports/12345678@chatroom/2026-01-05.md', md), true)
  assert.equal(dao.count('report'), 1)
  // v0.4：镜像 report 带真实 chat_id（从 rel 路径解析）
  const mirrored = dao.getReport('daily', '2026-01-05', '12345678@chatroom')
  assert.match(mirrored.content_md, /正文/)
  assert.equal(mirrored.chat_id, '12345678@chatroom')

  // 镜像库路径指向一个不可打开的目标（如目录）：appendJsonl 仍返回 true
  const badDir = mkdtempSync(join(tmpdir(), 'lurker-baddb-'))
  const store2 = new Store(stateDir, logger, badDir) // 目录路径 → openDb 失败 → 镜像静默降级
  assert.equal(store2.appendJsonl('groups/12345678@chatroom/insights.jsonl', insight), true)

  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(badDir, { recursive: true, force: true })
})

test('镜像工厂：sqlitePath 缺省不启用（行为与旧版一致）', () => {
  assert.equal(createSqliteMirror(undefined, logger), null)
})

test('content_hash 归一化口径：去 BOM、CRLF→LF、strip', () => {
  const a = contentHash('\uFEFF# 标题\r\n\r\n正文\r\n')
  const b = contentHash('# 标题\n\n正文')
  assert.equal(a, b)
  assert.equal(a, createHash('sha256').update('# 标题\n\n正文', 'utf8').digest('hex'))
})

test('导入器：临时 state 样例跑两遍，行数不变（可重复运行）', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-imp-state-'))
  const { path: dbPath, dir: dbDir } = tmpDb('imp')

  mkdirSync(join(stateDir, 'groups', '12345678@chatroom'), { recursive: true })
  writeFileSync(
    join(stateDir, 'groups', '12345678@chatroom', 'insights.jsonl'),
    [
      JSON.stringify({ ts: '2026-01-05T10:00:00.000Z', type: 'topic', title: 'T1', summary: '要点一' }),
      JSON.stringify({ ts: '2026-01-05T11:00:00.000Z', type: 'opportunity', summary: '机会点' }),
      'not-json', // 非法行：计入未映射
    ].join('\n') + '\n',
  )
  mkdirSync(join(stateDir, 'reports', '12345678@chatroom'), { recursive: true })
  writeFileSync(join(stateDir, 'reports', '12345678@chatroom', '2026-01-05.md'), '# 日报\n\n内容')
  mkdirSync(join(stateDir, 'audit'), { recursive: true }) // 未映射目录
  writeFileSync(join(stateDir, 'audit', 'x.jsonl'), '{}\n')

  const run = () =>
    execFileSync(process.execPath, [join(repo, 'scripts', 'import-state-to-sqlite.mjs'), '--state-dir', stateDir, '--db', dbPath], {
      encoding: 'utf8',
    })

  const out1 = run()
  const out2 = run()
  assert.match(out1, /映射 2/)
  assert.match(out2, /映射 2/, '第二遍同样全部命中（幂等）')

  const db = openDb(dbPath, { logger })
  const dao = new KnowledgeDao(db, logger)
  assert.equal(dao.count('chat_digest'), 1)
  assert.equal(dao.count('entry'), 1)
  assert.equal(dao.count('report'), 1)
  db.close()

  assert.ok(existsSync(dbPath))
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

// ==================== v0.4：会话维度 + media（TECH-v0.4 §4） ====================

/** 构造 v3（v0.2.1）样例库：含 2 行同周期 report 与 1 条挂 report 的 entry */
function makeV3Db(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version = 3;')
  db.exec(`
    CREATE TABLE doc (id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual', source_ref TEXT, file_path TEXT,
      content_md TEXT, content_hash TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE tag (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE doc_tag (doc_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (doc_id, tag_id));
    CREATE TABLE report (id INTEGER PRIMARY KEY, period_type TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, title TEXT NOT NULL,
      content_md TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', doc_ids_hint TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (period_type, period_start));
    CREATE TABLE entry (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note', content_md TEXT NOT NULL,
      report_id INTEGER REFERENCES report(id) ON DELETE SET NULL, doc_id INTEGER,
      created_at INTEGER NOT NULL);
    CREATE TABLE chat_digest (id INTEGER PRIMARY KEY, chat_topic TEXT NOT NULL,
      digest_md TEXT NOT NULL, happened_on TEXT, doc_id INTEGER, source_key TEXT UNIQUE,
      created_by TEXT NOT NULL DEFAULT 'cli', created_at INTEGER NOT NULL);
    CREATE VIEW v_report_full AS
      SELECT r.*, (SELECT COUNT(*) FROM entry e WHERE e.report_id = r.id) AS entry_count
      FROM report r ORDER BY r.period_type, r.period_start DESC;
    INSERT INTO report (period_type, period_start, period_end, title, content_md, created_at, updated_at)
      VALUES ('daily', '2026-01-04', '2026-01-04', '日报A', '正文A', 1, 1),
             ('weekly', '2026-01-05', '2026-01-11', '周报', '正文W', 1, 1);
    INSERT INTO entry (ts, kind, content_md, report_id, created_at) VALUES (1, 'note', '条目', 1, 1);
  `)
  db.close()
}

test('迁移：v3 样例库 → v4 后行数不变、chat_id=aggregate、entry 外键存活；v4 重跑幂等', () => {
  const { path, dir } = tmpDb('migrate')
  makeV3Db(path)

  const db = openDb(path, { logger })
  assert.ok(db, 'v3 库应成功打开并自动迁移')
  const dao = new KnowledgeDao(db, logger)
  assert.equal(dao.count('report'), 2, '迁移后 report 行数不变')
  assert.equal(dao.count('entry'), 1, 'entry 数据零丢失')
  for (const r of dao.listReportsByRange('daily', '2026-01-01', '2026-12-31')) {
    assert.equal(r.chat_id, 'aggregate')
  }
  const w = dao.listReportsByRange('weekly', '2026-01-01', '2026-12-31')[0]
  assert.equal(w.chat_id, 'aggregate')
  assert.equal(w.title, '周报')

  // 迁移后可正常写入新语义：同周期双群共存
  assert.ok(dao.upsertReport({ periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05', title: '日报', contentMd: 'x', chatId: '12345678@chatroom' }))
  db.close()

  // v4 库重跑：无变化（幂等）
  const db2 = openDb(path, { logger })
  assert.ok(db2)
  const dao2 = new KnowledgeDao(db2, logger)
  assert.equal(dao2.count('report'), 3)
  assert.equal(checkSchemaVersion(db2), 4)
  db2.close()

  // 原生 sqlite3 CLI 侧核对 user_version=4（node:sqlite 视角一致）
  assert.equal(checkSchemaVersion(new DatabaseSync(path)), 4)
  rmSync(dir, { recursive: true, force: true })
})

test('迁移：user_version > 4 拒开；0/新建库直接建 v4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lurker-db-ver-'))
  const path = join(dir, 't.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version = 5;')
  db.close()
  assert.equal(openDb(path, { logger }), null, '>4 库应拒开并 warn')

  const fresh = join(dir, 'fresh.db')
  const db2 = openDb(fresh, { logger })
  assert.ok(db2, '全新库应成功创建 v4')
  assert.equal(checkSchemaVersion(db2), 4)
  db2.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v0.4 双群日报：同 (daily, 日期) 两 chat_id 共存；同 chat_id 重复走 upsert 不新增', () => {
  const { path, dir } = tmpDb('dual')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  const base = { periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05' }
  assert.ok(dao.upsertReport({ ...base, title: '日报 chatA', contentMd: 'A1', chatId: '12345678@chatroom' }))
  assert.ok(dao.upsertReport({ ...base, title: '日报 chatB', contentMd: 'B1', chatId: '1234567890@chatroom' }))
  assert.equal(dao.count('report'), 2, '两个 chat_id 各占一行')

  // 第三个同 chat_id：upsert 更新不新增
  dao.upsertReport({ ...base, title: '日报 chatA v2', contentMd: 'A2', chatId: '12345678@chatroom' })
  assert.equal(dao.count('report'), 2)
  const a = dao.getReport('daily', '2026-01-05', '12345678@chatroom')
  assert.match(a.content_md, /A2/)
  assert.match(dao.getReport('daily', '2026-01-05', '1234567890@chatroom').content_md, /B1/)

  // 缺省 chatId 走 aggregate，与群行共存
  dao.upsertReport({ ...base, title: '日报聚合', contentMd: 'AG' })
  assert.equal(dao.count('report'), 3)
  assert.equal(dao.getReport('daily', '2026-01-05').chat_id, 'aggregate')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v0.4 media：三态合法插入；available 无 path 被 CHECK 拒；source_key 重写幂等且 path 更新；ext 大写/带点被拒', () => {
  const { path, dir } = tmpDb('media')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  // 三种 status 合法插入
  assert.ok(dao.upsertMedia({ chatId: '12345678@chatroom', mediaType: 'image', sourceKey: 'demo-chat:10001', status: 'available', path: '/archive/a.jpg', pathKind: 'archive', ext: 'jpg', size: 100, md5: 'a'.repeat(32) }))
  assert.ok(dao.upsertMedia({ chatId: '12345678@chatroom', mediaType: 'file', sourceKey: 'demo-chat:10002', status: 'pending' }))
  assert.ok(dao.upsertMedia({ chatId: '1234567890@chatroom', mediaType: 'voice', sourceKey: 'demo-chat:20001', status: 'missing' }))
  assert.equal(dao.count('media'), 3)

  // available 必须 path 非空（CHECK）
  assert.equal(dao.upsertMedia({ chatId: '12345678@chatroom', mediaType: 'video', sourceKey: 'demo-chat:10003', status: 'available', path: null }), null)
  assert.equal(dao.count('media'), 3)

  // source_key 重写：行数不变、path 被更新
  assert.ok(dao.upsertMedia({ chatId: '12345678@chatroom', mediaType: 'image', sourceKey: 'demo-chat:10001', status: 'available', path: '/archive/b.jpg', pathKind: 'archive', ext: 'jpg' }))
  assert.equal(dao.count('media'), 3, 'source_key 冲突应 UPDATE 不新增')
  assert.equal(dao.listMediaByChat('12345678@chatroom', { mediaType: 'image' })[0].path, '/archive/b.jpg')

  // ext 大写 / 带点被 CHECK 拒
  assert.equal(dao.upsertMedia({ chatId: '12345678@chatroom', mediaType: 'file', sourceKey: 'demo-chat:10004', status: 'pending', ext: 'JPG' }), null)
  assert.equal(dao.upsertMedia({ chatId: '12345678@chatroom', mediaType: 'file', sourceKey: 'demo-chat:10005', status: 'pending', ext: '.jpg' }), null)

  // 按会话 + 状态过滤
  assert.equal(dao.listMediaByChat('12345678@chatroom').length, 2)
  assert.equal(dao.listMediaByChat('12345678@chatroom', { status: 'pending' }).length, 1)
  assert.equal(dao.listMediaByChat('不存在').length, 0)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('导入器 v0.4：reports/<chatId>/ 按群落行；既有 aggregate 行不删不改；两遍行数稳定', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-imp4-state-'))
  const { path: dbPath, dir: dbDir } = tmpDb('imp4')

  // 两个群同一天的日报 + 一个群多一天
  for (const chat of ['12345678@chatroom', '1234567890@chatroom']) {
    mkdirSync(join(stateDir, 'reports', chat), { recursive: true })
    writeFileSync(join(stateDir, 'reports', chat, '2026-01-05.md'), `# 日报 ${chat}\n\n内容`)
  }
  writeFileSync(join(stateDir, 'reports', '12345678@chatroom', '2026-01-06.md'), '# 0206')

  // 先建 v4 库并写入 1 行 aggregate（模拟迁移回填），验证导入器不删不改
  const pre = openDb(dbPath, { logger })
  const preDao = new KnowledgeDao(pre, logger)
  preDao.upsertReport({ periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05', title: '日报聚合', contentMd: '迁移回填' })
  pre.close()

  const run = () =>
    execFileSync(process.execPath, [join(repo, 'scripts', 'import-state-to-sqlite.mjs'), '--state-dir', stateDir, '--db', dbPath], { encoding: 'utf8' })

  const out1 = run()
  const out2 = run()
  assert.match(out1, /按群落 report 行 3/)
  assert.match(out2, /按群落 report 行 3/, '第二遍同样全部命中（幂等）')

  const db = openDb(dbPath, { logger })
  const dao = new KnowledgeDao(db, logger)
  assert.equal(dao.count('report'), 4, 'aggregate 1 行 + 两群 3 行')
  const agg = dao.getReport('daily', '2026-01-05')
  assert.equal(agg.chat_id, 'aggregate')
  assert.match(agg.content_md, /迁移回填/, 'aggregate 行未被导入器改写')
  assert.match(dao.getReport('daily', '2026-01-05', '12345678@chatroom').content_md, /内容/)
  assert.match(dao.getReport('daily', '2026-01-06', '12345678@chatroom').content_md, /0206/)
  db.close()

  rmSync(stateDir, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})
