/**
 * db-entry-chat.test.mjs：v6 迁移（entry.chat_id 回填）+ 按群归档不串吃 +
 * v_marking_latest 按 (chat_id, target_ref) 分组 + 越界版本拒开。
 * 全离线：临时目录建库，合成数据（1234567890@chatroom 为占位群 ID）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb, checkSchemaVersion } from '../lib/db/db.js'
import { KnowledgeDao } from '../lib/db/dao.js'
import { Store } from '../lib/store.js'

const logger = { warn: () => {}, error: () => {}, debug: () => {} }

function tmpDb(name) {
  const dir = mkdtempSync(join(tmpdir(), `lurker-chat-${name}-`))
  return { dir, path: join(dir, 't.db') }
}

/** 构造 v5 样例库：entry 无 chat_id 列 + 旧版 v_marking_latest（GROUP BY 仅 target_ref） */
function makeV5Db(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE report (
      id INTEGER PRIMARY KEY, period_type TEXT NOT NULL, period_start TEXT NOT NULL,
      period_end TEXT NOT NULL, title TEXT NOT NULL, content_md TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', chat_id TEXT NOT NULL DEFAULT 'aggregate',
      doc_ids_hint TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (period_type, period_start, chat_id));
    CREATE TABLE entry (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'note',
      content_md TEXT NOT NULL,
      report_id INTEGER REFERENCES report(id) ON DELETE SET NULL,
      doc_id INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE marking (
      id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL,
      target_ref TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL,
      source_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE VIEW v_marking_latest AS
      SELECT m.* FROM marking m
      JOIN (SELECT target_ref, MAX(ts) AS mx, MAX(id) AS mi FROM marking GROUP BY target_ref) t
        ON m.target_ref = t.target_ref AND m.ts = t.mx AND m.id = t.mi;
    INSERT INTO report (period_type, period_start, period_end, title, content_md, chat_id, created_at, updated_at)
      VALUES ('daily', '2026-01-05', '2026-01-05', '日报A', '正文', 'aggregate', 1, 1);
    INSERT INTO entry (ts, kind, content_md, report_id, created_at)
      VALUES (1000, 'note', '迁移前旧行', 1, 1000);
    INSERT INTO marking (chat_id, kind, target_ref, ts, source, source_key, created_at)
      VALUES ('12345678@chatroom', 'done', 'demo-task-shared', 1700000000000, 'chat', 'mk:1', 1);
  `)
  db.exec('PRAGMA user_version = 5;')
  db.close()
}

test('v6 迁移：v5 库 → uv=6，entry.chat_id 全量回填 aggregate、既有行零变化；重跑幂等', () => {
  const { path, dir } = tmpDb('migrate56')
  makeV5Db(path)

  const before = new DatabaseSync(path)
  const snap = {
    entry: before.prepare('SELECT id, ts, kind, content_md, report_id, created_at FROM entry ORDER BY id').all(),
    report: before.prepare('SELECT * FROM report ORDER BY id').all(),
    marking: before.prepare('SELECT * FROM marking ORDER BY id').all(),
  }
  before.close()

  const db = openDb(path, { logger })
  assert.ok(db, 'v5 库应成功打开并迁移到 v6')
  assert.equal(checkSchemaVersion(db), 6)

  const after = db.prepare('SELECT id, ts, kind, content_md, report_id, created_at FROM entry ORDER BY id').all()
  assert.deepEqual(after, snap.entry, 'entry 既有行（chat_id 外的列）零变化')
  assert.deepEqual(db.prepare('SELECT * FROM report ORDER BY id').all(), snap.report, 'report 零变化')
  assert.deepEqual(db.prepare('SELECT * FROM marking ORDER BY id').all(), snap.marking, 'marking 零变化')
  const cols = db.prepare('PRAGMA table_info(entry)').all().map((r) => r.name)
  assert.ok(cols.includes('chat_id'), 'entry 应新增 chat_id 列')
  assert.deepEqual(
    db.prepare('SELECT DISTINCT chat_id FROM entry').all().map((r) => r.chat_id),
    ['aggregate'],
    '既有行 chat_id 应全部回填 aggregate',
  )
  db.close()

  // 重跑幂等：第二次打开仍 uv=6、行数不变
  const db2 = openDb(path, { logger })
  assert.equal(checkSchemaVersion(db2), 6)
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM entry').get().n, 1)
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM marking').get().n, 1)
  db2.close()
  rmSync(dir, { recursive: true, force: true })
})

test('双群 entry 各自归档不串吃：镜像 opportunity 带群 chatId，按群统计互不混', () => {
  const { path, dir } = tmpDb('dual-entry')
  const stateDir = mkdtempSync(join(tmpdir(), 'lurker-chat-state-'))
  const store = new Store(stateDir, logger, path)
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)

  const chatA = '12345678@chatroom'
  const chatB = '1234567890@chatroom'
  for (const chat of [chatA, chatB]) {
    store.ensureDir(`groups/${chat}`)
    for (let i = 0; i < 2; i++) {
      assert.equal(
        store.appendJsonl(`groups/${chat}/insights.jsonl`, {
          ts: '2026-01-05T10:00:00.000Z',
          type: 'opportunity',
          summary: `${chat} 的机会点 ${i}（合成占位）`,
        }),
        true,
      )
    }
  }

  // 镜像落库：opportunity → entry，chat_id 各归各群
  const perChat = (cid) =>
    db.prepare('SELECT COUNT(*) AS n FROM entry WHERE chat_id = ?').get(cid).n
  assert.equal(perChat(chatA), 2, '群 A 的 2 条 opportunity 各自归群 A')
  assert.equal(perChat(chatB), 2, '群 B 的 2 条 opportunity 各自归群 B')
  assert.equal(perChat('aggregate'), 0, '不应有串到 aggregate 的 entry')
  assert.equal(dao.count('entry'), 4)

  // 模拟按群归档（= report gen --chat-id 语义：只动本群未归档 entry）
  const archive = (cid) => {
    db.exec('BEGIN IMMEDIATE;')
    db.prepare("INSERT INTO report (period_type, period_start, period_end, title, content_md, chat_id, created_at, updated_at) VALUES ('daily','2026-01-05','2026-01-05',?,'',?,1,1)").run(`日报 ${cid}`, cid)
    const rid = db.prepare('SELECT id FROM report WHERE chat_id = ?').get(cid).id
    db.prepare('UPDATE entry SET report_id = ? WHERE report_id IS NULL AND chat_id = ?').run(rid, cid)
    db.exec('COMMIT;')
  }
  archive(chatA)
  archive(chatB)
  const countByReportChat = (cid) =>
    db.prepare('SELECT COUNT(*) AS n FROM entry e JOIN report r ON e.report_id = r.id WHERE r.chat_id = ?').get(cid).n
  assert.equal(countByReportChat(chatA), 2, '群 A 报告只吃到群 A 的 entry')
  assert.equal(countByReportChat(chatB), 2, '群 B 报告只吃到群 B 的 entry')

  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

test('v_marking_latest：同 target_ref 不同 chat 各保留各自最新态', () => {
  const { path, dir } = tmpDb('mark-chat')
  const db = openDb(path, { logger })
  const dao = new KnowledgeDao(db, logger)
  const base = { targetRef: 'demo-task-shared', source: 'chat' }

  // 群 A：undone → done；群 B：同一 target_ref 独立走 done → undone
  dao.insertMarking({ ...base, chatId: '12345678@chatroom', kind: 'undone', ts: 1700000000000, sourceKey: 'mk:a1' })
  dao.insertMarking({ ...base, chatId: '12345678@chatroom', kind: 'done', ts: 1700003600000, sourceKey: 'mk:a2' })
  dao.insertMarking({ ...base, chatId: '1234567890@chatroom', kind: 'done', ts: 1700000000000, sourceKey: 'mk:b1' })
  dao.insertMarking({ ...base, chatId: '1234567890@chatroom', kind: 'undone', ts: 1700007200000, sourceKey: 'mk:b2' })

  const latest = db
    .prepare("SELECT chat_id, kind FROM v_marking_latest WHERE target_ref = 'demo-task-shared' ORDER BY chat_id")
    .all()
    .map((r) => ({ chat_id: r.chat_id, kind: r.kind }))
  assert.equal(latest.length, 2, '同 target_ref 两群各留一行')
  assert.deepEqual(latest, [
    { chat_id: '1234567890@chatroom', kind: 'undone' },
    { chat_id: '12345678@chatroom', kind: 'done' },
  ], '各群各自最新态（A=done，B=undone），互不串（ORDER BY chat_id：数字 9 排在 @ 前）')

  // 删除类目标在另一群独立存在
  dao.insertMarking({ chatId: '1234567890@chatroom', kind: 'deleted', targetRef: 'demo-task-only-b', ts: 1700000000000, sourceKey: 'mk:b3' })
  assert.equal(dao.listMarkingsLatest().length, 3)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('越界拒开：user_version 7 拒开；0 全新建 v6', () => {
  const { path, dir } = tmpDb('reject')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version = 7;')
  db.close()
  assert.equal(openDb(path, { logger }), null, '>6 库应拒开并 warn')

  const fresh = join(dir, 'fresh.db')
  const db2 = openDb(fresh, { logger })
  assert.ok(db2)
  assert.equal(checkSchemaVersion(db2), 6, '全新库直接建 v6')
  const cols = db2.prepare('PRAGMA table_info(entry)').all().map((r) => r.name)
  assert.ok(cols.includes('chat_id'), '新建库 entry 自带 chat_id')
  db2.close()
  rmSync(dir, { recursive: true, force: true })
})
