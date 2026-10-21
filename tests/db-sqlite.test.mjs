/**
 * db-sqlite.test.mjs：SQLite 数据层（node:sqlite + DAO + 镜像 + 导入器）。
 * 全离线：临时目录建库，不碰真实 state / 真实 1数据 目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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

  // 报告显式通道（缺口 G1）：writeReport 按 kind 推导 period，路径侧不再猜测
  const md = '# 日报\n\n正文'
  store.ensureDir('reports/12345678@chatroom') // writeText 不建父目录（既有行为）
  assert.equal(store.writeReport('daily', '12345678@chatroom', '2026-01-05', md), true)
  assert.equal(dao.count('report'), 1)
  const mirrored = dao.getReport('daily', '2026-01-05', '12345678@chatroom')
  assert.match(mirrored.content_md, /正文/)
  assert.equal(mirrored.chat_id, '12345678@chatroom')

  // G1：周报/月报按 kind 推导 period（不再错标 daily）
  assert.equal(store.writeReport('weekly', '12345678@chatroom', '2026-01-05', '# 周报'), true)
  const weekly = dao.getReport('weekly', '2026-01-05', '12345678@chatroom')
  assert.equal(weekly.period_start, '2026-01-05', '2026-01-05 是周一')
  assert.equal(weekly.period_end, '2026-01-11', 'period_end = 周一+6 天')
  assert.equal(store.writeReport('monthly', '12345678@chatroom', '2026-02-01', '# 月报'), true)
  const monthly = dao.getReport('monthly', '2026-02-01', '12345678@chatroom')
  assert.equal(monthly.period_start, '2026-02-01')
  assert.equal(monthly.period_end, '2026-02-28', '2026 非闰年，月末 28 日')
  // 错键拒绝：月报 dateKey 非 1 号 → 跳过镜像（不猜测）
  assert.equal(store.writeReport('monthly', '12345678@chatroom', '2026-02-15', '# 月报?'), true)
  assert.equal(dao.count('report'), 3, '非法键不入库')
  // G2：summary 聚合行 chat_id='aggregate'
  store.ensureDir('reports/summary')
  assert.equal(store.writeReport('daily', 'aggregate', '2026-01-05', '# 跨群汇总'), true)
  const agg = dao.getReport('daily', '2026-01-05', 'aggregate')
  assert.equal(agg.chat_id, 'aggregate')

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

test('迁移：v3 样例库 → v6 后行数不变、chat_id=aggregate、entry 外键存活；重跑幂等', () => {
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

  // v6 库重跑：无变化（幂等）
  const db2 = openDb(path, { logger })
  assert.ok(db2)
  const dao2 = new KnowledgeDao(db2, logger)
  assert.equal(dao2.count('report'), 3)
  assert.equal(checkSchemaVersion(db2), 6)
  db2.close()

  // 原生 sqlite3 CLI 侧核对 user_version=5（node:sqlite 视角一致）
  assert.equal(checkSchemaVersion(new DatabaseSync(path)), 6)
  rmSync(dir, { recursive: true, force: true })
})

test('迁移：user_version > 6 拒开；0/新建库直接建 v6', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lurker-db-ver-'))
  const path = join(dir, 't.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version = 7;')
  db.close()
  assert.equal(openDb(path, { logger }), null, '>6 库应拒开并 warn')

  const fresh = join(dir, 'fresh.db')
  const db2 = openDb(fresh, { logger })
  assert.ok(db2, '全新库应成功创建 v6')
  assert.equal(checkSchemaVersion(db2), 6)
  db2.close()
  rmSync(dir, { recursive: true, force: true })
})

test('迁移：v4 库 → v6 链式（4→5→6）纯新增两表两视图，既有数据零变化；重跑幂等；<4 拒开', () => {
  const { path, dir } = tmpDb('migrate45')
  const db = openDb(path, { logger }) // 先建 v6 库
  db.close()
  // 手动降到 v4 并删掉 v0.6 新对象，模拟真实 v4 库
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA foreign_keys = OFF;')
  raw.exec('DROP VIEW IF EXISTS v_marking_latest; DROP VIEW IF EXISTS v_report_revised;')
  raw.exec('DROP TABLE IF EXISTS marking; DROP TABLE IF EXISTS report_revision;')
  // v6 新增对象一并降级，模拟真实 v4 库（entry 尚无 chat_id）
  raw.exec('DROP INDEX IF EXISTS idx_entry_chat;')
  raw.exec('ALTER TABLE entry DROP COLUMN chat_id;')
  raw.exec('PRAGMA user_version = 4;')
  raw.close()

  const before = new DatabaseSync(path)
  const snapshot = (db2) => ({
    report: db2.prepare('SELECT * FROM report ORDER BY id').all(),
    entry: db2.prepare('SELECT COUNT(*) AS n FROM entry').get().n,
  })
  const snap = snapshot(before)
  before.close()

  const db2 = openDb(path, { logger })
  assert.ok(db2, 'v4 库应成功打开并链式迁移到 v6')
  assert.equal(checkSchemaVersion(db2), 6)
  const after = snapshot(db2)
  assert.deepEqual(after, snap, '迁移后既有行零变化')
  const dao = new KnowledgeDao(db2, logger)
  assert.equal(dao.count('report_revision'), 0)
  assert.equal(dao.count('marking'), 0)
  db2.close()

  // 重跑幂等
  const db3 = openDb(path, { logger })
  assert.ok(db3)
  assert.equal(checkSchemaVersion(db3), 6)
  db3.close()

  // <4（除 0/3）拒开
  const bad = join(dir, 'bad.db')
  const raw2 = new DatabaseSync(bad)
  raw2.exec('PRAGMA user_version = 2;')
  raw2.close()
  assert.equal(openDb(bad, { logger }), null, 'v2 库应拒开')
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

  // 两个群同一天的日报 + 一个群多一天 + 周报/月报各一（G4：混合类型识别）
  for (const chat of ['12345678@chatroom', '1234567890@chatroom']) {
    mkdirSync(join(stateDir, 'reports', chat), { recursive: true })
    writeFileSync(join(stateDir, 'reports', chat, '2026-01-05.md'), `# 日报 ${chat}\n\n内容`)
  }
  writeFileSync(join(stateDir, 'reports', '12345678@chatroom', '2026-01-06.md'), '# 0206') // 无类型标题 → 回退 daily 计数
  writeFileSync(join(stateDir, 'reports', '12345678@chatroom', '2026-01-05.md').replace('2026-01-05', '2026-01-12'), '# 周报 12345678@chatroom 2026-01-12\n\n周内容')
  writeFileSync(join(stateDir, 'reports', '12345678@chatroom', '2026-02-01.md'), '# 月报 12345678@chatroom 2026-02-01\n\n月内容')

  // 先建 v4 库并写入 1 行 aggregate（模拟迁移回填），验证导入器不删不改
  const pre = openDb(dbPath, { logger })
  const preDao = new KnowledgeDao(pre, logger)
  preDao.upsertReport({ periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05', title: '日报聚合', contentMd: '迁移回填' })
  pre.close()

  const run = () =>
    execFileSync(process.execPath, [join(repo, 'scripts', 'import-state-to-sqlite.mjs'), '--state-dir', stateDir, '--db', dbPath], { encoding: 'utf8' })

  const out1 = run()
  const out2 = run()
  assert.match(out1, /报告文件 5：report 行 5（daily=3 weekly=1 monthly=1/)
  assert.match(out1, /回退 daily=1/, "'# 0206' 无标题 → 回退 daily 并计数")
  assert.match(out2, /report 行 5/, '第二遍同样全部命中（幂等）')

  const db = openDb(dbPath, { logger })
  const dao = new KnowledgeDao(db, logger)
  assert.equal(dao.count('report'), 6, 'aggregate 1 行 + 5 行报告')
  const agg = dao.getReport('daily', '2026-01-05')
  assert.equal(agg.chat_id, 'aggregate')
  assert.match(agg.content_md, /迁移回填/, 'aggregate 行未被导入器改写')
  assert.match(dao.getReport('daily', '2026-01-05', '12345678@chatroom').content_md, /内容/)
  assert.match(dao.getReport('daily', '2026-01-06', '12345678@chatroom').content_md, /0206/)
  // G4：周/月报按标题识别 → period 推导正确（不再错标 daily）
  const weekly = dao.getReport('weekly', '2026-01-12', '12345678@chatroom')
  assert.equal(weekly.period_start, '2026-01-12', '周一')
  assert.equal(weekly.period_end, '2026-01-18')
  const monthly = dao.getReport('monthly', '2026-02-01', '12345678@chatroom')
  assert.equal(monthly.period_start, '2026-02-01')
  assert.equal(monthly.period_end, '2026-02-28')
  db.close()

  rmSync(stateDir, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

test('writeReport 路径按类型分目录：daily 不变；weekly/monthly 子目录；周一双触发不互覆', () => {
  const { path, dir } = tmpDb('wr-path')
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-wr-'))
  const store = new Store(stateDir, logger, path)
  store.ensureDir('reports/12345678@chatroom')
  store.ensureDir('reports/summary')

  // daily 路径不变
  assert.equal(store.writeReport('daily', '12345678@chatroom', '2026-01-05', '日报 20:30'), true)
  const dailyPath = join(stateDir, 'reports', '12345678@chatroom', '2026-01-05.md')
  assert.ok(existsSync(dailyPath), 'daily 维持 reports/<chatId>/<dateKey>.md')
  // weekly 新路径（同 dateKey=周一）
  assert.equal(store.writeReport('weekly', '12345678@chatroom', '2026-01-05', '周报 20:40'), true)
  const weeklyPath = join(stateDir, 'reports', '12345678@chatroom', 'weekly', '2026-01-05.md')
  assert.ok(existsSync(weeklyPath), 'weekly → reports/<chatId>/weekly/<dateKey>.md')
  // 周一双触发不互覆：两文件都在且内容各自正确
  assert.match(readFileSync(dailyPath, 'utf8'), /日报 20:30/)
  assert.match(readFileSync(weeklyPath, 'utf8'), /周报 20:40/)
  // monthly 新路径
  assert.equal(store.writeReport('monthly', '12345678@chatroom', '2026-01-01', '月报'), true)
  assert.ok(existsSync(join(stateDir, 'reports', '12345678@chatroom', 'monthly', '2026-01-01.md')))
  // aggregate：daily 语义维持 summary 根；weekly/monthly 聚合走子目录
  assert.equal(store.writeReport('daily', 'aggregate', '2026-01-05', 'summary-d'), true)
  assert.ok(existsSync(join(stateDir, 'reports', 'summary', '2026-01-05.md')))
  assert.equal(store.writeReport('weekly', 'aggregate', '2026-01-05', 'summary-w'), true)
  assert.ok(existsSync(join(stateDir, 'reports', 'summary', 'weekly', '2026-01-05.md')))
  assert.equal(store.writeReport('monthly', 'aggregate', '2026-02-01', 'summary-m'), true)
  assert.ok(existsSync(join(stateDir, 'reports', 'summary', 'monthly', '2026-02-01.md')))

  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)
  // DB 行靠 kind 区分无误（回归断言）
  assert.equal(dao.getReport('daily', '2026-01-05', '12345678@chatroom').content_md, '日报 20:30')
  assert.equal(dao.getReport('weekly', '2026-01-05', '12345678@chatroom').content_md, '周报 20:40')
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

// ==================== mirrorDocsFromReport：报告 → doc 非对话资料提取 ====================

const GITHUB_URL = 'https://github.com/example-org/example-repo'
const WEB_URL = 'https://example.com/some/page'

/** 报告 md 样例：含 GitHub 引用行、普通 URL、「### 本期文件索引」区段 */
function sampleReportMd() {
  return [
    '# 日报',
    '',
    '> 「example-repo 挺好用」 ' + GITHUB_URL,
    '> 看看这个 ' + WEB_URL + '。',
    '',
    '### 本期文件索引',
    '',
    '- demo-report.pdf（2.1MB，来自 synth-0001）',
    '（本期无新文件）', // 占位行不该另建 doc（下方区段里故意混排验证跳过）
    '',
    '### 其他',
  ].join('\n')
}

function docsOf(db) {
  return db.prepare('SELECT id, title, category, source_type, source_ref, content_md FROM doc ORDER BY id').all()
}

test('doc 提取：报告落盘→URL/file doc 自动生成 + 双标签（来自报告/github）', () => {
  const { path, dir } = tmpDb('docs')
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-docs-'))
  const store = new Store(stateDir, logger, path)
  store.ensureDir('reports/12345678@chatroom')

  assert.equal(store.writeReport('daily', '12345678@chatroom', '2026-01-05', sampleReportMd()), true)

  const db = new DatabaseSync(path)
  const rows = docsOf(db)
  // 2 个 URL doc + 1 个文件索引 doc（占位行「本期无新文件」被跳过）
  assert.equal(rows.length, 3, `应 3 条 doc，实际：${JSON.stringify(rows, null, 2)}`)

  const gh = rows.find((r) => r.content_md.includes(GITHUB_URL))
  const web = rows.find((r) => r.content_md.includes(WEB_URL))
  const file = rows.find((r) => r.category === 'file')
  assert.ok(gh && web && file)

  // 口径：title / category / source_type / source_ref
  assert.equal(gh.title, '资源：example-repo', 'GitHub 取引用行中的仓库名')
  assert.equal(web.title, '资源：example.com', '非 GitHub 无可读描述 → 域名兜底')
  for (const r of [gh, web]) {
    assert.equal(r.category, 'web')
    assert.equal(r.source_type, 'web')
    assert.equal(r.source_ref, '报告 2026-01-05 · 12345678@chatroom')
    assert.match(r.content_md, /^- URL：/)
    assert.match(r.content_md, /- 语境：/)
    assert.match(r.content_md, /- 提及：报告 2026-01-05 · 12345678@chatroom/)
  }
  assert.equal(file.title, 'demo-report.pdf（2.1MB，来自 synth-0001）')
  assert.equal(file.source_type, 'file_import')
  assert.equal(file.source_ref, '报告 2026-01-05 · 12345678@chatroom')

  // 双标签：GitHub doc 挂「来自报告」+「github」；其余只挂「来自报告」
  const tags = (docId) =>
    db
      .prepare('SELECT t.name FROM tag t JOIN doc_tag dt ON dt.tag_id = t.id WHERE dt.doc_id = ? ORDER BY t.name')
      .all(docId)
      .map((r) => r.name)
  assert.deepEqual(tags(gh.id), ['github', '来自报告'])
  assert.deepEqual(tags(web.id), ['来自报告'])
  assert.deepEqual(tags(file.id), ['来自报告'])

  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

test('doc 提取：同一报告重写 → doc 不重复；同一 URL 两份报告 → 1 条 doc 且 source_ref 保持首建', () => {
  const { path, dir } = tmpDb('docs-idem')
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-docs2-'))
  const store = new Store(stateDir, logger, path)
  store.ensureDir('reports/12345678@chatroom')
  store.ensureDir('reports/1234567890@chatroom')

  const md = sampleReportMd()
  store.writeReport('daily', '12345678@chatroom', '2026-01-05', md)
  // 同键重写（upsert 同一报告）→ 资料提取再跑一遍也不重复
  store.writeReport('daily', '12345678@chatroom', '2026-01-05', md)

  // 第二份报告（不同 chat/日期）含同一 GitHub URL → 只 1 条 doc，source_ref 保持首建不覆盖
  store.writeReport('daily', '1234567890@chatroom', '2026-01-06', `> 转发 ${GITHUB_URL}\n`)

  const db = new DatabaseSync(path)
  const rows = docsOf(db)
  const gh = rows.filter((r) => r.content_md.includes(GITHUB_URL))
  assert.equal(gh.length, 1, '同一 URL 跨报告只 1 条 doc')
  // 口径（与 Python「命中即跳过」一致）：保持首建 source_ref，不并提不覆盖
  assert.equal(gh[0].source_ref, '报告 2026-01-05 · 12345678@chatroom')
  // 第二份报告的新 URL 正常建；文件行在两份报告中原文不同（提及行不同）但行指纹同 → 仍不重复
  const fileDocs = rows.filter((r) => r.category === 'file')
  assert.equal(fileDocs.length, 1, '文件索引行原文相同 → 不重复建')
  assert.equal(rows.length, 3)
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

test('doc 提取：与 Python 批量脚本并存防重——content_md 已含 URL 的既有 doc（如 Python 所建）命中即跳过', () => {
  const { path, dir } = tmpDb('docs-py')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  // 模拟 Python 脚本先建的 doc：content_md 含该 URL（格式与 Python 输出一致）
  const pyBody = `- URL：${GITHUB_URL}\n- 语境：> 「example-repo」 ${GITHUB_URL}\n- 提及：报告 2025-12-01 · 12345678@chatroom\n`
  const pyId = dao.upsertDoc({ title: '资源：example-repo', category: 'web', sourceType: 'web', contentMd: pyBody })
  assert.ok(pyId)

  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-docs3-'))
  const store = new Store(stateDir, logger, path)
  store.ensureDir('reports/12345678@chatroom')
  store.writeReport('daily', '12345678@chatroom', '2026-01-05', sampleReportMd())

  // TS 侧只新建 Python 未覆盖的 2 条（web_url + 文件行），不与 Python 侧重复
  const after = new DatabaseSync(path)
  const rows = docsOf(after)
  assert.equal(rows.filter((r) => r.content_md.includes(GITHUB_URL)).length, 1, 'URL 子串查重生效，0 重复')
  assert.equal(rows.length, 3)
  assert.equal(dao.getDoc(pyId).id, pyId, 'Python 侧既有 doc 未被覆盖')
  after.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

test('doc 提取：无 URL 报告 → 零 doc；提取失败不影响 writeReport 返回 true', () => {
  const { path, dir } = tmpDb('docs-plain')
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-docs4-'))
  const store = new Store(stateDir, logger, path)
  store.ensureDir('reports/12345678@chatroom')

  assert.equal(store.writeReport('daily', '12345678@chatroom', '2026-01-05', '纯文字日报\n### 本期文件索引\n\n（本期无新文件）\n'), true)
  let db = new DatabaseSync(path)
  assert.equal(docsOf(db).length, 0, '无 URL/无索引行 → 零 doc')
  db.close()

  // 镜像库指向目录 → 镜像初始化失败静默降级，writeReport 仍 true（既有降级语义回归）
  const badDir = mkdtempSync(join(tmpdir(), 'lurker-baddb2-'))
  const store2 = new Store(stateDir, logger, badDir)
  assert.equal(store2.writeReport('daily', '12345678@chatroom', '2026-01-06', sampleReportMd()), true)

  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(badDir, { recursive: true, force: true })
})

// ==================== v0.6：修订历史 + 完成情况标记（TECH-v0.6 §4） ====================

test('v0.6 迁移：v4 样例库 → 链式到 uv=6、既有数据零变化；重跑幂等（DAO 视角）', () => {
  const { path, dir } = tmpDb('v06-mig')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)
  const rid = dao.upsertReport({ periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05', title: '日报', contentMd: 'v1' })
  db.close()
  const raw = new DatabaseSync(path)
  raw.exec('DROP VIEW IF EXISTS v_marking_latest; DROP VIEW IF EXISTS v_report_revised;')
  raw.exec('DROP TABLE marking; DROP TABLE report_revision;')
  raw.exec('DROP INDEX IF EXISTS idx_entry_chat;')
  raw.exec('ALTER TABLE entry DROP COLUMN chat_id;')   // 模拟真实 v4 库（entry 尚无 chat_id）
  raw.exec('PRAGMA user_version = 4;')
  raw.close()

  const db2 = openDb(path, { logger })
  const dao2 = new KnowledgeDao(db2, logger)
  assert.equal(checkSchemaVersion(db2), 6)
  assert.equal(dao2.count('report'), 1, '既有 report 行零变化')
  assert.equal(dao2.getReport('daily', '2026-01-05').id, rid)
  db2.close()
  const db3 = openDb(path, { logger }) // 重跑幂等
  assert.equal(checkSchemaVersion(db3), 6)
  db3.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v0.6 修订：同 source_key 两遍 → 1 行；不同 source_key → 多行；v_report_revised 计数正确', () => {
  const { path, dir } = tmpDb('v06-rev')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  const base = { chatId: '12345678@chatroom', periodType: 'daily', periodStart: '2026-01-05', ts: 1700000000000, type: 'section', source: 'chat' }
  const id1 = dao.insertReportRevision({ ...base, sourceKey: 'rev:c:d:1' })
  assert.ok(id1)
  const id1b = dao.insertReportRevision({ ...base, summary: '重放不覆盖', sourceKey: 'rev:c:d:1' })
  assert.equal(id1b, id1, 'source_key 冲突返回已有 id（不 UPDATE）')
  assert.equal(dao.count('report_revision'), 1, '修订事件不可变：重放零新增')
  const row = db.prepare('SELECT * FROM report_revision WHERE id = ?').get(id1)
  assert.equal(row.summary, null, '已有行未被重放覆盖')

  dao.insertReportRevision({ ...base, type: 'correction', ts: 1700000600000, sourceKey: 'rev:c:d:2' })
  dao.insertReportRevision({ ...base, chatId: '1234567890@chatroom', type: 'status', sourceKey: 'rev:c2:d:3' })
  assert.equal(dao.count('report_revision'), 3, '不同 source_key → 多行')

  const revised = db.prepare('SELECT * FROM v_report_revised').all()
  assert.equal(revised.length, 2)
  const ownRevised = revised.find((r) => r.chat_id === '12345678@chatroom')
  assert.equal(ownRevised.revision_count, 2, '同一报告 2 条修订')
  assert.equal(ownRevised.revised_at, 1700000600000, 'revised_at = MAX(ts)')

  // 列表过滤
  assert.equal(dao.listRevisions('12345678@chatroom').length, 2)
  assert.equal(dao.listRevisions('12345678@chatroom', 'daily').length, 2)
  assert.equal(dao.listRevisions().length, 3)

  // CHECK 防线：非法 kind/period/长度被拒
  assert.equal(dao.insertReportRevision({ ...base, sourceKey: 'rev:bad:1', periodType: 'hourly' }), null)
  assert.equal(dao.insertReportRevision({ ...base, sourceKey: 'rev:bad:2', source: 'sms' }), null)
  assert.equal(dao.insertReportRevision({ ...base, sourceKey: 'rev:bad:3', chatId: '' }), null)

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v0.6 标记：同 target undone→done 两行；v_marking_latest 只见 done；跨群聚合可查', () => {
  const { path, dir } = tmpDb('v06-mark')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  const base = { chatId: '12345678@chatroom', source: 'chat', ts: 1700000000000 }
  assert.ok(dao.insertMarking({ ...base, kind: 'undone', targetRef: 'demo-task-0001', sourceKey: 'mark:1' }))
  assert.ok(dao.insertMarking({ ...base, kind: 'done', targetRef: 'demo-task-0001', ts: 1700003600000, sourceKey: 'mark:2' }))
  assert.equal(dao.count('marking'), 2, '状态演变 = 追加行，不 UPDATE')
  // source_key 冲突：返回已有 id、不覆盖
  assert.equal(dao.insertMarking({ ...base, kind: 'undone', targetRef: 'demo-task-0001', sourceKey: 'mark:2' }), 2)

  // 跨群另一 target
  dao.insertMarking({ chatId: '1234567890@chatroom', kind: 'undone', targetRef: 'demo-task-0002', source: 'web', ts: 1700001000000, sourceKey: 'mark:3' })
  dao.insertMarking({ chatId: '1234567890@chatroom', kind: 'deleted', targetRef: 'demo-task-0003', ts: 1700002000000, sourceKey: 'mark:4' })

  const latest = db.prepare('SELECT * FROM v_marking_latest ORDER BY target_ref').all()
  assert.equal(latest.length, 3)
  assert.equal(latest[0].kind, 'done', 'undone→done 演变后最新态只见 done')
  assert.equal(latest[1].kind, 'undone')
  assert.equal(latest[2].kind, 'deleted')

  const undone = dao.listMarkingsLatest('undone')
  assert.equal(undone.length, 1)
  assert.equal(undone[0].chat_id, '1234567890@chatroom', '跨群聚合可查')
  assert.equal(dao.listMarkingsLatest().length, 3)

  // CHECK 防线
  assert.equal(dao.insertMarking({ ...base, kind: 'paused', targetRef: 'x', sourceKey: 'mark:5' }), null)
  assert.equal(dao.insertMarking({ ...base, kind: 'done', targetRef: '', sourceKey: 'mark:6' }), null)

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v0.6 T4 语义：final 报告 upsert 修订内容后仍 final；draft 报告 upsert 后仍 draft', () => {
  const { path, dir } = tmpDb('v06-t4')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  dao.upsertReport({ periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05', title: '日报A', contentMd: 'v1', status: 'final' })
  dao.upsertReport({ periodType: 'daily', periodStart: '2026-01-06', periodEnd: '2026-01-06', title: '日报B', contentMd: 'v1' })

  // final 被修订（重放同键内容更新、status 仍传 draft）→ 保持 final，内容更新
  dao.upsertReport({ periodType: 'daily', periodStart: '2026-01-05', periodEnd: '2026-01-05', title: '日报A', contentMd: 'v2（修订）', status: 'draft' })
  const a = dao.getReport('daily', '2026-01-05')
  assert.equal(a.status, 'final', 'T4：final 被修订后仍 final（不降级）')
  assert.match(a.content_md, /v2（修订）/, '内容正常更新')

  // draft 重放（status 仍 draft）→ 不自动 final
  dao.upsertReport({ periodType: 'daily', periodStart: '2026-01-06', periodEnd: '2026-01-06', title: '日报B', contentMd: 'v2' })
  const b = dao.getReport('daily', '2026-01-06')
  assert.equal(b.status, 'draft', 'T4：draft 报告 upsert 后仍 draft（不自动 final）')

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v0.6 镜像：mirrorReportRevision / mirrorMarking 幂等入镜；非法 period 跳过', () => {
  const { path, dir } = tmpDb('v06-mirror')
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-v06-state-'))
  const store = new Store(stateDir, logger, path)
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  const m = store.mirror
  m.mirrorReportRevision('12345678@chatroom', 'daily', '2026-01-05', 1700000000000, 'section', { summary: '合成占位', sourceKey: 'rev:t:1' })
  m.mirrorReportRevision('12345678@chatroom', 'daily', '2026-01-05', 1700000000000, 'section', { summary: '重放', sourceKey: 'rev:t:1' })
  assert.equal(dao.count('report_revision'), 1, '修订镜像幂等')
  m.mirrorReportRevision('12345678@chatroom', 'monthly', '2026-01-15', 1700000000000, 'status')
  assert.equal(dao.count('report_revision'), 1, '非法 periodStart（非月初）跳过')

  m.mirrorMarking('12345678@chatroom', 'undone', 'demo-task-9', 1700000000000, { sourceKey: 'mark:t:1' })
  m.mirrorMarking('12345678@chatroom', 'done', 'demo-task-9', 1700003600000, { sourceKey: 'mark:t:2' })
  assert.equal(dao.count('marking'), 2)
  assert.equal(db.prepare("SELECT kind FROM v_marking_latest WHERE target_ref='demo-task-9'").get().kind, 'done')

  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})
