// group-store.test.mjs —— M1-T1.1：每群 SQLite 数据桶（node:sqlite，:memory: / 临时目录，离线）。
// 覆盖：建库/迁移、messages 写入与查询、幂等（同 msg_id 不重复）、kind 校验、
//       路径围栏（非法 chatId / assertInsideState 逃逸）、schema_version 推进、dispose。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService, MESSAGE_KINDS } = await import('../lib/group-store.js')
const { assertInsideState } = await import('../lib/guard.js')

// macOS /var 是 /private/var 的 symlink，先 realpath 保证围栏断言一致
const stateDir = mkdtempSync(join(tmpdir(), 'lurker-gstore-'))
const realStateDir = resolve(stateDir)
const logger = { warn() {}, error() {} }
test.after(() => rmSync(stateDir, { recursive: true, force: true }))

const svc = new GroupStoreService(realStateDir, logger)
const CHAT = '12345@chatroom'

test('建库：库文件位于 <stateDir>/groups/<chatId>/store.db', async () => {
  const n = await svc.appendMessages(CHAT, [
    { msgId: 'm1', ts: 1000, senderPid: 'P01', senderName: '甲', text: 'hello' },
  ])
  assert.equal(n, 1)
  const dbPath = join(realStateDir, 'groups', CHAT, 'store.db')
  assert.ok(existsSync(dbPath), `expect db at ${dbPath}`)
  assert.ok(svc.isOpen(CHAT))
  assert.deepEqual(svc.openedChats(), [CHAT])
})

test('迁移：schema_version 推进到 MIGRATIONS 当前版本，核心表全部存在', async () => {
  const st = svc.open(CHAT)
  assert.ok(st.schemaVersion >= 1)
  const names = await queryTables()
  for (const t of ['messages', 'identities', 'topic_clusters', 'events', 'tasks', 'promises', 'files']) {
    assert.ok(names.includes(t), `table ${t} should exist`)
  }
})

/** 只读重开库文件做 sqlite_master 内省（不依赖内部句柄导出） */
async function queryTables() {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(realStateDir, 'groups', CHAT, 'store.db'), { readOnly: true })
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  } finally {
    db.close()
  }
}

test('写入/查询：批量写入、afterTs/beforeTs/kinds/limit/排序', async () => {
  await svc.appendMessages(CHAT, [
    { msgId: 'm2', ts: 2000, senderPid: 'P02', senderName: '乙', kind: 'image', text: '[图片]' },
    { msgId: 'm3', ts: 3000, senderPid: 'P01', senderName: '甲', kind: 'quote', quoteOfMsgId: 'm1', text: '回复' },
    { msgId: 'm4', ts: 4000, senderPid: 'P03', senderName: '丙', kind: 'system', text: '丙 加入了群聊' },
    { msgId: 'm5', ts: 5000, senderPid: 'P02', senderName: '乙', kind: 'task', text: '非法 kind 会被丢弃' },
  ])
  const st = svc.open(CHAT)
  assert.equal(st.countMessages(), 4) // 非法 kind 'task' 被拒

  const all = st.getMessages()
  assert.equal(all.length, 4)
  assert.deepEqual(all.map((m) => m.msgId), ['m1', 'm2', 'm3', 'm4']) // ts 升序

  const after = st.getMessages({ afterTs: 2000, limit: 2 })
  assert.deepEqual(after.map((m) => m.msgId), ['m3', 'm4'])

  const before = st.getMessages({ beforeTs: 3000, ascending: false })
  assert.deepEqual(before.map((m) => m.msgId), ['m2', 'm1'])

  const quotes = st.getMessages({ kinds: ['quote'] })
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].quoteOfMsgId, 'm1')
  assert.equal(quotes[0].senderName, '甲')

  const limited = st.getMessages({ ascending: false, limit: 2 })
  assert.deepEqual(limited.map((m) => m.msgId), ['m4', 'm3'])
})

test('幂等：同 msg_id 重复写入不重复入库', async () => {
  const n = await svc.appendMessages(CHAT, [{ msgId: 'm1', ts: 1000, senderPid: 'P01', text: 'dup' }])
  assert.equal(n, 0)
  const st = svc.open(CHAT)
  assert.equal(st.countMessages(), 4)
})

test('服务层查询：未打开的群返回 [] 且不落盘建库', () => {
  const ghost = 'ghost@chatroom'
  assert.deepEqual(svc.getMessages(ghost), [])
  assert.ok(!svc.isOpen(ghost))
  assert.ok(!existsSync(join(realStateDir, 'groups', ghost)))
  assert.equal(svc.schemaVersion(ghost), 0)
})

test('路径围栏：非法 chatId 被拒；stateDir 外路径被 assertInsideState 拦截', () => {
  for (const bad of ['../evil', 'a/b@c', '.hidden', '', 'x'.repeat(200)]) {
    assert.throws(() => svc.open(bad), `chatId ${JSON.stringify(bad)} must be rejected`)
  }
  // 围栏本体：模拟逃逸目标（即使 chatId 校验被绕过，assertInsideState 也拦）
  assert.throws(() => assertInsideState(realStateDir, resolve(realStateDir, '..', 'outside.db')))
  // 目录已由服务创建在 state 内
  assert.doesNotThrow(() => assertInsideState(realStateDir, join(realStateDir, 'groups', CHAT, 'store.db')))
})

test('围栏纪律：库目录确实在 stateDir 内（mkdir 前 assertInsideState 已过）', () => {
  const dir = join(realStateDir, 'groups', CHAT)
  assert.doesNotThrow(() => assertInsideState(realStateDir, dir))
  assert.throws(() => assertInsideState(realStateDir, realStateDir + '-sibling/groups'))
})

test('dispose：关闭全部句柄，写入/查询失败安全返回', async () => {
  const st = svc.open(CHAT)
  st.close()
  st.close() // 幂等
  assert.deepEqual(st.getMessages(), [])
  assert.equal(await st.appendMessages([{ msgId: 'x', ts: 1, senderPid: 'P09' }]), 0)
  svc.dispose()
  assert.deepEqual(svc.openedChats(), [])
})

test('内存库迁移冒烟：:memory: 亦可完整建表（同 MIGRATIONS 路径）', async () => {
  const { GroupStore } = await import('../lib/group-store.js')
  const mem = new GroupStore(':memory:', ':memory:', logger)
  // M2-T2.3：topic_clusters person 维度（v2）→ M4：report_meta 收编 + tasks 增列（v3），
  // MIGRATIONS 只追加不回退，版本随迁移条目数推进
  assert.equal(mem.schemaVersion, 4) // M5 v4：MIGRATIONS 只追加不回退（必要调整）
  assert.equal(await mem.appendMessages([{ msgId: 'a', ts: 1, senderPid: 'P01', text: 'x' }]), 1)
  assert.equal(mem.countMessages(), 1)
  mem.close()
})

test('可写 kind 集合与 D2 §3 一致', () => {
  assert.deepEqual([...MESSAGE_KINDS], ['text', 'image', 'voice', 'file', 'system', 'quote'])
})
