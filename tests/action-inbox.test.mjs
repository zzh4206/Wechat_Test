// action-inbox.test.mjs —— 前端动作收件箱（C2）：白名单/越权/幂等/stale/坏行/水位跨重启。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { ActionInbox, ACTION_TYPES, parseActionLine, ACTIONS_REL, ACTIONS_OFFSET_REL, ACTION_RESULTS_REL, WEB_ACTIONS_AUDIT_REL } = await import('../lib/action-inbox.js')
const { ApprovalActions } = await import('../lib/approval-actions.js')
const { Store } = await import('../lib/store.js')

const CHAT = '12345678@chatroom'
const OTHER = '999@chatroom'

function fakeActions() {
  const calls = []
  return {
    calls,
    task: {
      confirmTask: async (c, id) => { calls.push(['task.confirm', c, id]); return id !== 404 && id !== 13 },
      cancelTask: async () => { calls.push(['task.cancel']); return true },
      completeTask: async () => { calls.push(['task.complete']); return true },
      confirmEvent: async () => { calls.push(['event.confirm']); return true },
    },
    promise: {
      confirmPromise: async () => { calls.push(['promise.confirm']); return true },
      cancelPromise: async () => { calls.push(['promise.cancel']); return true },
      confirmFulfilled: async () => { calls.push(['promise.fulfilled']); return true },
      closePromise: async () => { calls.push(['promise.close']); return true },
    },
  }
}

const defaultResolve = (c, k, id) => (id === 404 ? null : { createdAt: 1 })
function makeEnv({ resolveTarget } = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('web')
  store.ensureDir('audit')
  const svc = fakeActions()
  const calls = svc.calls
  const notified = []
  const actions = new ApprovalActions({
    task: svc.task, promise: svc.promise,
    store: { updateTaskDeadline: async (c, id, dl, conf) => { calls.push(['task.deadline', c, id, dl, conf]); return true }, setIdentityWatchLevel: async (c, pid, level) => { calls.push(['person.watch', c, pid, level]); return pid !== 'wxid_missing' }, getIdentities: () => [] },
    notify: (k, t, b) => notified.push(b),
    logger: { warn() {}, error() {} },
  })
  const env = { dir, store, svc, calls, notified }
  env.inbox = new ActionInbox({
    store, actions, groups: [CHAT],
    resolveTarget: resolveTarget ?? defaultResolve,
    logger: { warn() {}, error() {} },
    pollSec: 1, now: () => 1000,
    marks: { markTarget: async (c, kind, tid, status) => { calls.push(['mark', c, kind, tid, status]); return tid !== 666 } },
  })
  return env
}

const line = (over = {}) => JSON.stringify({ actionId: 'a1', ts: 1, chatId: CHAT, type: 'task.confirm', targetId: 5, ...over })

test('正常路径：task.confirm 分发 + 结果文件 + 审计元数据 + 水位推进', async () => {
  const env = makeEnv()
  env.store.writeText(ACTIONS_REL, line() + '\n')
  const n = await env.inbox.poll()
  assert.equal(n, 1)
  assert.deepEqual(env.calls, [['task.confirm', CHAT, 5]])
  const results = readFileSync(join(env.dir, ACTION_RESULTS_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(results, [{ actionId: 'a1', ok: true, code: 'ok', ts: 1000 }])
  const audit = readFileSync(join(env.dir, WEB_ACTIONS_AUDIT_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(audit[0].type, 'task.confirm')
  assert.equal(audit[0].chatId, CHAT)
  assert.ok(!JSON.stringify(audit).includes('语句'), '审计零正文')
  assert.equal(readFileSync(join(env.dir, ACTIONS_OFFSET_REL), 'utf8').trim(), '1', '水位推进')
  rmSync(env.dir, { recursive: true, force: true })
})

test('白名单外 type 拒绝（unsupported）；越权 chatId 拒绝（forbidden）', async () => {
  const env = makeEnv()
  env.store.writeText(ACTIONS_REL, [
    line({ actionId: 'a1', type: 'system.shutdown', targetId: 1 }),
    line({ actionId: 'a2', chatId: OTHER, targetId: 2 }),
  ].join('\n') + '\n')
  await env.inbox.poll()
  const results = readFileSync(join(env.dir, ACTION_RESULTS_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(results.map((r) => r.code), ['type_not_allowed', 'chat_not_allowed'])
  assert.equal(env.calls.length, 0, '均未执行')
  rmSync(env.dir, { recursive: true, force: true })
})

test('stale 细分（W-8）：目标不存在 → not_found；存在但状态不符 → status_conflict', async () => {
  const env = makeEnv({ resolveTarget: (c, k, id) => (id === 404 ? null : { createdAt: 1 }) })
  env.store.writeText(ACTIONS_REL, [
    line({ actionId: 's1', targetId: 404 }),
    line({ actionId: 's2', targetId: 13 }),
  ].join('\n') + '\n')
  await env.inbox.poll()
  const results = readFileSync(join(env.dir, ACTION_RESULTS_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(results[0], { actionId: 's1', ok: false, code: 'not_found', ts: 1000 })
  assert.equal(results[1].code, 'status_conflict', '存在但状态不符 → status_conflict')
  rmSync(env.dir, { recursive: true, force: true })
})

test('幂等：同 actionId 重放跳过（不重复执行、不重复出结果）', async () => {
  const env = makeEnv()
  env.store.writeText(ACTIONS_REL, line({ actionId: 'dup' }) + '\n')
  await env.inbox.poll()
  await env.inbox.poll() // 水位已推进；再写一行同 actionId 于行 2
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(env.dir, ACTIONS_REL), line({ actionId: 'dup' }) + '\n')
  // 手动回退水位模拟未消费第二行
  env.store.writeText(ACTIONS_OFFSET_REL, '1\n')
  const n = await env.inbox.poll()
  assert.equal(n, 0, '同 actionId 幂等跳过')
  assert.equal(env.calls.length, 1, '只执行一次')
  rmSync(env.dir, { recursive: true, force: true })
})

test('坏行跳过（水位推进不卡队列）；targetId 非正整数 bad_request', async () => {
  const env = makeEnv()
  env.store.writeText(ACTIONS_REL, [
    'not-json{{{',
    line({ actionId: 'b1', targetId: 0 }),
    line({ actionId: 'b2', type: 'task.confirm', targetId: 7 }),
  ].join('\n') + '\n')
  const n = await env.inbox.poll()
  assert.equal(n, 2, '坏行跳过、两行有效处理')
  const results = readFileSync(join(env.dir, ACTION_RESULTS_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(results[0].code, 'bad_request')
  assert.equal(results[1].actionId, 'b1')
  assert.equal(results[2].actionId, 'b2')
  rmSync(env.dir, { recursive: true, force: true })
})

test('水位跨重启：重启后从上次水位续读（不重复处理）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox2-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('web')
  store.writeText(ACTIONS_REL, line({ actionId: 'r1' }) + '\n')
  const svc = fakeActions()
  const mk = () => new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn() {}, error() {} }, pollSec: 1, now: () => 1,
  })
  const first = mk()
  await first.poll()
  const callsAfterFirst = svc.calls.length
  const second = mk() // 新实例（模拟重启）
  const n = await second.poll()
  assert.equal(n, 0)
  assert.equal(svc.calls.length, callsAfterFirst, '重启后不重复处理')
  rmSync(dir, { recursive: true, force: true })
})

test('白名单枚举含 person.follow/unfollow、report.regen、task.mark/promise.mark（阶段三/四对接）', () => {
  for (const t of ['person.follow', 'person.unfollow', 'report.regen', 'task.mark', 'promise.mark']) {
    assert.ok(ACTION_TYPES.includes(t), `白名单含 ${t}`)
  }
})

test('parseActionLine：坏行返回 null', () => {
  assert.equal(parseActionLine('nope'), null)
  assert.equal(parseActionLine('{"actionId":"a"}'), null, '缺 chatId/type')
})
