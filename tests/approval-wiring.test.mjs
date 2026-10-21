// approval-wiring.test.mjs —— createApprovalWiring 组装出的 taskComplete 必须走完整标记链
// （reportRevision.markTarget：存在性校验 → 镜像 → 标记当天日报修订段），
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
const MARK_AT = new Date(2026, 9, 16, 21, 0, 0).getTime() // 标记发生 2026-10-16 21:00（当天日报已生成）
const MARK_KEY = '2026-10-16'

function makeEnv() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'approval-wiring-')))
  const dbPath = join(dir, 'knowledge.db')
  const logger = { warn() {}, error() {}, info() {} }
  const groupStore = new GroupStoreService(dir, logger)
  const store = new Store(dir, logger, dbPath)
  const llm = { async complete() { return '{}' } } // 本文件不触发识别
  const task = new TaskRecognitionService({ groupStore, llm, logger, enabled: true, store })
  const promise = new PromiseRecognitionService({ groupStore, llm, logger, enabled: true })
  const { approvalActions } = createApprovalWiring({ store, groupStore, task, promise, notify: () => {}, logger, now: () => MARK_AT })
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

test('taskComplete：修订行写入标记当天的日报、出身日报不动（与 ActionInbox task.mark 同链）', async () => {
  const env = makeEnv()
  try {
    const tid = await env.groupStore.appendTask(CHAT, { statement: '交材料', status: 'active' }, ORIGIN)
    assert.ok(tid)
    const originRel = reportRelPath(CHAT, ORIGIN_KEY, 'daily')
    const rel = reportRelPath(CHAT, MARK_KEY, 'daily')
    env.store.ensureDir(`reports/${CHAT}`)
    env.store.writeText(originRel, `# 日报 ${ORIGIN_KEY}\n\n正文\n`)
    env.store.writeText(rel, `# 日报 ${MARK_KEY}\n\n正文\n`)

    const ok = await env.approvalActions.taskComplete(CHAT, tid, 'chat')
    assert.equal(ok, true)
    const md = env.store.readText(rel)
    assert.ok(md.includes('## 修订记录'), '标记当天日报追加修订段')
    assert.ok(md.includes(`标记：task「#${tid}」→ 已完成（来源：对话框）`), '修订行含目标与来源')
    assert.equal(env.store.readText(originRel).includes('修订记录'), false, '出身日报不追加（标记是工作流演化，落当天）')
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

test('report.finalize：draft → final + 修订行（source=web）；重复定稿 status_conflict；不存在 not_found；定稿后重写正文仍 final', async () => {
  const env = makeEnv()
  const { ActionInbox, ACTIONS_REL, ACTION_RESULTS_REL } = await import('../lib/action-inbox.js')
  try {
    env.store.writeReport('daily', CHAT, ORIGIN_KEY, `# 日报 ${ORIGIN_KEY}\n\n初稿\n`)
    assert.equal(env.dao.getReport('daily', ORIGIN_KEY, CHAT).status, 'draft')
    const inbox = new ActionInbox({ store: env.store, actions: env.approvalActions, groups: [CHAT], logger: { warn() {}, error() {} } })
    const lines = [
      { actionId: 'f1', type: 'report.finalize', params: { kind: 'daily', dateKey: ORIGIN_KEY } },
      { actionId: 'f2', type: 'report.finalize', params: { kind: 'daily', dateKey: ORIGIN_KEY } },
      { actionId: 'f3', type: 'report.finalize', params: { kind: 'daily', dateKey: '2026-10-15' } },
      { actionId: 'f4', type: 'report.finalize', params: { kind: 'weekly', dateKey: '2026-10-14' } }, // 周二不是周期起点
    ]
    env.store.ensureDir('web')
    env.store.writeText(ACTIONS_REL, lines.map(l => JSON.stringify({ ts: 1, chatId: CHAT, ...l })).join('\n') + '\n')
    await inbox.poll()
    const codes = env.store.readText(ACTION_RESULTS_REL).trim().split('\n').map(JSON.parse).map(r => [r.actionId, r.code])
    assert.deepEqual(codes, [['f1', 'ok'], ['f2', 'status_conflict'], ['f3', 'not_found'], ['f4', 'bad_request']])
    assert.equal(env.dao.getReport('daily', ORIGIN_KEY, CHAT).status, 'final')
    const revs = env.dao.listRevisions(CHAT, 'daily').filter(r => r.type === 'status')
    assert.equal(revs.length, 1)
    assert.equal(revs[0].source, 'web')
    // 重新生成/修订改写正文：upsertReport 冲突分支不覆盖 status（T4）
    env.store.writeReport('daily', CHAT, ORIGIN_KEY, `# 日报 ${ORIGIN_KEY}\n\n重写后\n`)
    const after = env.dao.getReport('daily', ORIGIN_KEY, CHAT)
    assert.deepEqual([after.status, after.content_md.includes('重写后')], ['final', true])
  } finally {
    env.cleanup()
  }
})

test('report.finalize：未启用知识库镜像 → unsupported（status 只存在于 knowledge.db）', async () => {
  const { Store: S } = await import('../lib/store.js')
  const { ActionInbox, ACTIONS_REL, ACTION_RESULTS_REL } = await import('../lib/action-inbox.js')
  const dir = resolve(mkdtempSync(join(tmpdir(), 'finalize-nodb-')))
  const logger = { warn() {}, error() {}, info() {} }
  const groupStore = new GroupStoreService(dir, logger)
  const store = new S(dir, logger) // 无 sqlitePath = 无镜像
  const llm = { async complete() { return '{}' } }
  const task = new TaskRecognitionService({ groupStore, llm, logger, enabled: true, store })
  const promise = new PromiseRecognitionService({ groupStore, llm, logger, enabled: true })
  const { approvalActions } = createApprovalWiring({ store, groupStore, task, promise, notify: () => {}, logger })
  try {
    const inbox = new ActionInbox({ store, actions: approvalActions, groups: [CHAT], logger })
    store.ensureDir('web')
    store.writeText(ACTIONS_REL, JSON.stringify({ actionId: 'n1', ts: 1, chatId: CHAT, type: 'report.finalize', params: { kind: 'daily', dateKey: ORIGIN_KEY } }) + '\n')
    await inbox.poll()
    assert.equal(JSON.parse(store.readText(ACTION_RESULTS_REL).trim()).code, 'unsupported')
  } finally {
    groupStore.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('report.regen：入队 ok；同一报告已在队列 → duplicate（不是 not_found）', async () => {
  const env = makeEnv()
  const { ActionInbox, ACTIONS_REL, ACTION_RESULTS_REL } = await import('../lib/action-inbox.js')
  const { RegenQueue } = await import('../lib/regen-queue.js')
  const queue = new RegenQueue({ store: env.store, logger: { warn() {}, error() {} } })
  const logger = { warn() {}, error() {}, info() {} }
  const task = new TaskRecognitionService({ groupStore: env.groupStore, llm: { async complete() { return '{}' } }, logger, enabled: true, store: env.store })
  const promise = new PromiseRecognitionService({ groupStore: env.groupStore, llm: { async complete() { return '{}' } }, logger, enabled: true })
  const { approvalActions } = createApprovalWiring({
    store: env.store, groupStore: env.groupStore, task, promise, notify: () => {}, logger,
    enqueueReportRegen: (c, d, k) => queue.enqueue(c, d, 1, k, 'manual') !== 'deduped',
  })
  try {
    const inbox = new ActionInbox({ store: env.store, actions: approvalActions, groups: [CHAT], logger })
    env.store.ensureDir('web')
    const l = (id) => JSON.stringify({ actionId: id, ts: 1, chatId: CHAT, type: 'report.regen', params: { kind: 'daily', dateKey: ORIGIN_KEY } })
    env.store.writeText(ACTIONS_REL, [l('r1'), l('r2')].join('\n') + '\n')
    await inbox.poll()
    const codes = env.store.readText(ACTION_RESULTS_REL).trim().split('\n').map(JSON.parse).map(r => r.code)
    assert.deepEqual(codes, ['ok', 'duplicate'])
    assert.deepEqual(queue.list().map(e => e.reason), ['manual'])
  } finally {
    env.cleanup()
  }
})
