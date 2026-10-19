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
import { openDb } from '../lib/db/db.js'
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
  assert.match(dao.getReport('daily', '2026-01-05').content_md, /正文/)

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
