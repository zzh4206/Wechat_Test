// approval-actions.test.mjs —— 审批动作门面（C1）：转发 + 回执 + 关注位 + deadline 置信度。
// 全离线 mock（服务用最小 fake——门面只做转发，不搬逻辑）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { ApprovalActions } = await import('../lib/approval-actions.js')
const { GroupStoreService } = await import('../lib/group-store.js')
const { wxidFromDbRoot } = await import('../lib/account-probe.js')

const CHAT = '12345678@chatroom'

function fakeServices() {
  const calls = []
  const task = {
    confirmTask: async (c, id) => { calls.push(['task.confirmTask', c, id]); return id > 0 },
    cancelTask: async (c, id) => { calls.push(['task.cancelTask', c, id]); return true },
    completeTask: async (c, id) => { calls.push(['task.completeTask', c, id]); return true },
    confirmEvent: async (c, id) => { calls.push(['event.confirmEvent', c, id]); return true },
  }
  const promise = {
    confirmPromise: async (c, id) => { calls.push(['promise.confirmPromise', c, id]); return true },
    cancelPromise: async (c, id) => { calls.push(['promise.cancelPromise', c, id]); return true },
    confirmFulfilled: async (c, id, msgId) => { calls.push(['promise.confirmFulfilled', c, id, msgId]); return true },
    closePromise: async (c, id) => { calls.push(['promise.closePromise', c, id]); return true },
  }
  return { task, promise, calls }
}

test('门面转发 + 回执：taskConfirm 成功 → notify 一句话；失败 → 不回执', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'appr-')))
  const store = new GroupStoreService(dir, { warn() {}, error() {} })
  const svc = fakeServices()
  const notified = []
  const marksCalls = []
  const reviseCalls = []
  const actions = new ApprovalActions({
    task: svc.task, promise: svc.promise, store,
    notify: (kind, title, body) => notified.push({ kind, title, body }),
    logger: { warn() {}, error() {} },
    marks: { markTarget: async (c, k, tid, status, source) => { marksCalls.push([c, k, tid, status, source]); return true } },
    revision: { onApproval: async (c, tk, tid, summary, source) => { reviseCalls.push([c, tk, tid, summary, source]) } },
    source: 'chat',
  })
  void marksCalls; void reviseCalls
  const ok = await actions.taskConfirm(CHAT, 7)
  assert.equal(ok, true)
  assert.deepEqual(svc.calls, [['task.confirmTask', CHAT, 7]], '转发既有服务方法（逻辑不搬）')
  assert.equal(notified.length, 1)
  assert.equal(notified[0].kind, 'approval')
  assert.match(notified[0].body, /#7/)
  // 失败路径：无回执
  const fail = await actions.taskConfirm(CHAT, -1)
  assert.equal(fail, false)
  assert.equal(notified.length, 1, '失败不回执')
  rmSync(dir, { recursive: true, force: true })
})

test('其余动作转发：cancel/complete/event/promise 四动作/ deadline 置信度 1', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'appr2-')))
  const store = new GroupStoreService(dir, { warn() {}, error() {} })
  const svc = fakeServices()
  const deadlineCalls = []
  store.updateTaskDeadline = async (c, id, dl, conf) => { deadlineCalls.push([c, id, dl, conf]); return true }
  const notified = []
  const actions = new ApprovalActions({
    task: svc.task, promise: svc.promise, store,
    notify: (kind, t, b) => notified.push(b),
    logger: { warn() {}, error() {} },
    revision: { onApproval: async () => {} },
    marks: { markTarget: async () => true },
  })
  await actions.taskCancel(CHAT, 1)
  await actions.taskComplete(CHAT, 2)
  await actions.eventConfirm(CHAT, 3)
  await actions.promiseConfirm(CHAT, 4)
  await actions.promiseCancel(CHAT, 5)
  await actions.promiseFulfilled(CHAT, 6)
  await actions.promiseClose(CHAT, 7)
  assert.equal(svc.calls.filter((c) => c[0] !== 'task.complete').length, 6, 'complete 转调 markTarget（不再走 completeTask）')
  assert.ok(!svc.calls.some((c) => c[0] === 'task.complete'), '完成语义统一：不走 completeTask')
  assert.ok(svc.calls.some((c) => c[0] === 'promise.confirmFulfilled' && c[3] === null), 'fulfilled 转发（msgId null）')
  const dl = 1234567890
  await actions.taskSetDeadline(CHAT, 8, dl)
  assert.deepEqual(deadlineCalls, [[CHAT, 8, dl, 1]], '人工指定 → confidence 1')
  assert.equal(notified.length, 8)
  rmSync(dir, { recursive: true, force: true })
})

test('personFollow：未知 pid → 失败不回执成功语义', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'appr3-')))
  const store = new GroupStoreService(dir, { warn() {}, error() {} })
  const notified = []
  const actions = new ApprovalActions({
    task: fakeServices().task, promise: fakeServices().promise, store,
    notify: (k, t, b) => notified.push(b),
    logger: { warn() {}, error() {} },
    revision: { onApproval: async () => {} },
    marks: { markTarget: async () => true },
  })
  assert.deepEqual(store.getIdentities(CHAT), [], '初始无 identities')
  const failFollow = await actions.personFollow(CHAT, 'wxid_missing')
  assert.equal(failFollow, false, '未知 pid 失败')
  assert.equal(notified.length, 0, '失败不回执（与既有语义一致）')
  rmSync(dir, { recursive: true, force: true })
})

test('personFollow/Unfollow 走 watch_level 关注位（真实 identities 行）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'appr4-')))
  const store = new GroupStoreService(dir, { warn() {}, error() {} })
  // 用 identities 服务的既有写入路径种数据：store.open + upsertIdentity（服务方法）
  const storeAny = store
  await storeAny.open(CHAT)
  // upsertIdentity 是每群库方法；GroupStoreService 需 facade——若无则经 setIdentityWatchLevel 前置：
  // 直接种库（测试专用：走每群库 upsertIdentity 经内部 open——用 storeAny 内部不可达，
  // 改经顶层包装不可写；这里用 ApprovalActions 之外的合法路径：appendMessages 无法造 identities。
  // 因此经由 setIdentityWatchLevel 的前置查询返回空 → 先写 identities 的唯一合法路径是
  // upsertIdentity；给 GroupStoreService 补 facade 属实现（已在本阶段加：getIdentities）。
  // 写入经每群库 upsertIdentity：通过 GroupStoreService.open 拿到的实例即为合法服务对象。
  const perChat = storeAny.open(CHAT)
  await perChat.upsertIdentity({ pid: 'wxid_boss001', wxid: 'wxid_boss001', groupNick: '目标会话', remark: '', watchLevel: 'off' })
  const notified = []
  const actions = new ApprovalActions({
    task: fakeServices().task, promise: fakeServices().promise, store,
    notify: (k, t, b) => notified.push(b),
    logger: { warn() {}, error() {} },
    revision: { onApproval: async () => {} },
    marks: { markTarget: async () => true },
  })
  assert.equal(await actions.personFollow(CHAT, 'wxid_boss001'), true)
  const after = store.getIdentities(CHAT).find((r) => r.pid === 'wxid_boss001')
  assert.equal(after.watchLevel, 'group', 'follow → group')
  assert.equal(await actions.personUnfollow(CHAT, 'wxid_boss001'), true)
  assert.equal(store.getIdentities(CHAT).find((r) => r.pid === 'wxid_boss001').watchLevel, 'off', 'unfollow → off')
  assert.ok(notified.length === 2)
  rmSync(dir, { recursive: true, force: true })
})

test('reportRegen：未接队列 → false + warn；接钩子 → 转发并回执', async () => {
  const store = new GroupStoreService(resolve(mkdtempSync(join(tmpdir(), 'appr5-'))), { warn() {}, error() {} })
  const warns = []
  const actions = new ApprovalActions({
    task: fakeServices().task, promise: fakeServices().promise, store,
    notify: () => {}, logger: { warn: (m) => warns.push(m), error() {} },
    revision: { onApproval: async () => {} },
    marks: { markTarget: async () => true },
  })
  assert.equal(await actions.reportRegen(CHAT, '2026-06-10', 'daily'), false, '未接线忽略')
  assert.ok(warns.some((w) => w.includes('reportRegen')))
  const enqueued = []
  const actions2 = new ApprovalActions({
    task: fakeServices().task, promise: fakeServices().promise, store,
    notify: () => {}, logger: { warn() {}, error() {} },
    revision: { onApproval: async () => {} },
    marks: { markTarget: async () => true },
    enqueueReportRegen: (c, d, k) => { enqueued.push([c, d, k]); return true },
  })
  assert.equal(await actions2.reportRegen(CHAT, '2026-06-10', 'weekly'), true)
  assert.deepEqual(enqueued, [[CHAT, '2026-06-10', 'weekly']])
})


test('taskRewrite：转发 updateTaskText + 强化学习信号 + 修订接线', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'appr6-')))
  const store = new GroupStoreService(dir, { warn() {}, error() {} })
  const svc = fakeServices()
  const updateCalls = []
  const reviseCalls = []
  const notified = []
  const actions = new ApprovalActions({
    task: { ...svc.task, updateTaskText: async (c, id, t) => { updateCalls.push([c, id, t]); return true } },
    promise: svc.promise, store,
    notify: (k, t2, b) => notified.push(b),
    logger: { warn() {}, error() {} },
    revision: { onApproval: async (c, tk, tid, summary) => { reviseCalls.push([c, tk, tid, summary]) } },
  })
  const ok = await actions.taskRewrite(CHAT, 3, '周三交材料（修正）')
  assert.equal(ok, true)
  assert.deepEqual(updateCalls, [[CHAT, 3, '周三交材料（修正）']])
  assert.equal(reviseCalls.length, 1)
  assert.match(reviseCalls[0][3], /改写/)
  rmSync(dir, { recursive: true, force: true })
})

test('taskPostpone：别名转发 taskSetDeadline（置信度 1）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'appr7-')))
  const store = new GroupStoreService(dir, { warn() {}, error() {} })
  const deadlineCalls = []
  store.updateTaskDeadline = async (c, id, dl, conf) => { deadlineCalls.push([c, id, dl, conf]); return true }
  const notified = []
  const actions = new ApprovalActions({
    task: fakeServices().task, promise: fakeServices().promise, store,
    notify: (k, t, b) => notified.push(b),
    logger: { warn() {}, error() {} },
    revision: { onApproval: async () => {} },
    marks: { markTarget: async () => true },
  })
  await actions.taskPostpone(CHAT, 9, 999)
  assert.deepEqual(deadlineCalls, [[CHAT, 9, 999, 1]])
  rmSync(dir, { recursive: true, force: true })
})
