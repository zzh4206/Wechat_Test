// approval-wiring.test.mjs —— createApprovalWiring 组装出的 taskComplete 必须走完整标记链
// （reportRevision.markTarget：存在性校验 → 镜像 → 出身日报修订段），
// 与 ActionInbox 的 task.mark 同源同效。直连 store.mirrorMarking 会跳过校验与修订段。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { TaskRecognitionService } = await import('../lib/task-recognition.js')
const { PromiseRecognitionService } = await import('../lib/promise-track.js')
const { createApprovalWiring } = await import('../lib/approval-wiring.js')
const { reportRelPath } = await import('../lib/report.js')
const { openDb } = await import('../lib/db/db.js')
const { KnowledgeDao } = await import('../lib/db/dao.js')

const CHAT = '12345678@chatroom'
const ORIGIN = new Date(2026, 9, 14, 10, 0, 0).getTime() // 本地时间 2026-10-14 10:00
const ORIGIN_KEY = '2026-10-14'

function makeEnv() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'approval-wiring-')))
  const dbPath = join(dir, 'knowledge.db')
  const logger = { warn() {}, error() {}, info() {} }
  const groupStore = new GroupStoreService(dir, logger)
  const store = new Store(dir, logger, dbPath)
  const llm = { async complete() { return '{}' } } // 本文件不触发识别
  const task = new TaskRecognitionService({ groupStore, llm, logger, enabled: true, store })
  const promise = new PromiseRecognitionService({ groupStore, llm, logger, enabled: true })
  const { approvalActions } = createApprovalWiring({ store, groupStore, task, promise, notify: () => {}, logger })
  const db = openDb(dbPath, { logger })
  const dao = new KnowledgeDao(db, logger)
  const cleanup = () => {
    db.close()
    groupStore.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  return { store, groupStore, approvalActions, dao, cleanup }
}

test('taskComplete：目标不存在 → false，marking 零行', async () => {
  const env = makeEnv()
  try {
    const ok = await env.approvalActions.taskComplete(CHAT, 9999, 'chat')
    assert.equal(ok, false, '不存在的任务不得"完成成功"')
    assert.equal(env.dao.count('marking'), 0)
  } finally {
    env.cleanup()
  }
})

test('taskComplete：修订行写入条目出身日报（与 ActionInbox task.mark 同链）', async () => {
  const env = makeEnv()
  try {
    const tid = await env.groupStore.appendTask(CHAT, { statement: '交材料', status: 'active' }, ORIGIN)
    assert.ok(tid)
    const rel = reportRelPath(CHAT, ORIGIN_KEY, 'daily')
    env.store.ensureDir(`reports/${CHAT}`)
    env.store.writeText(rel, `# 日报 ${ORIGIN_KEY}\n\n正文\n`)

    const ok = await env.approvalActions.taskComplete(CHAT, tid, 'chat')
    assert.equal(ok, true)
    const md = env.store.readText(rel)
    assert.ok(md.includes('## 修订记录'), '出身日报追加修订段')
    assert.ok(md.includes(`标记：task「#${tid}」→ 已完成（来源：对话框）`), '修订行含目标与来源')
    const latest = env.dao.listMarkingsLatest()
    assert.equal(latest.length, 1)
    assert.equal(latest[0].kind, 'done')
    assert.equal(latest[0].target_ref, `${CHAT}:task:${tid}`)
  } finally {
    env.cleanup()
  }
})

test('收件箱 stale 细分：已处理过的目标报 status_conflict，不存在报 not_found（含事件）', async () => {
  const env = makeEnv()
  const { ActionInbox, ACTIONS_REL, ACTION_RESULTS_REL } = await import('../lib/action-inbox.js')
  const { resolveInboxTarget } = createApprovalWiring({ store: env.store, groupStore: env.groupStore, task: null, promise: null, notify: () => {}, logger: { warn() {}, error() {} } })
  try {
    const tid = await env.groupStore.appendTask(CHAT, { statement: '交材料', status: 'active' }, ORIGIN)
    // 事件 id 刻意与任务 id 错开：按任务表去查事件 id 时查不到（id 重合会让错误实现碰巧通过）
    await env.groupStore.appendEvent(CHAT, { category: 'meeting', statement: '占位', status: 'active' })
    const eid = await env.groupStore.appendEvent(CHAT, { category: 'meeting', statement: '开会', status: 'active' })
    assert.equal(env.groupStore.getTask(CHAT, eid), null)
    const inbox = new ActionInbox({ store: env.store, actions: env.approvalActions, groups: [CHAT], logger: { warn() {}, error() {} }, resolveTarget: resolveInboxTarget })
    const lines = [
      { actionId: 'x1', type: 'task.confirm', targetId: tid }, // 已 active → 状态不符
      { actionId: 'x2', type: 'task.confirm', targetId: 9999 },
      { actionId: 'x3', type: 'event.confirm', targetId: eid }, // 事件按事件解析，不能当任务查
      { actionId: 'x4', type: 'event.confirm', targetId: 9999 },
    ]
    env.store.ensureDir('web')
    env.store.writeText(ACTIONS_REL, lines.map(l => JSON.stringify({ ts: 1, chatId: CHAT, ...l })).join('\n') + '\n')
    await inbox.poll()
    const codes = Object.fromEntries(env.store.readText(ACTION_RESULTS_REL).trim().split('\n').map(JSON.parse).map(r => [r.actionId, r.code]))
    assert.deepEqual(codes, { x1: 'status_conflict', x2: 'not_found', x3: 'status_conflict', x4: 'not_found' })
  } finally {
    env.cleanup()
  }
})

test('index.ts 把 resolveInboxTarget 注入 ActionInbox（未注入时收件箱一律报 not_found）', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
  assert.match(src, /resolveTarget: resolveInboxTarget/)
})
