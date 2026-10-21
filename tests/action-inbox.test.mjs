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
    revision: { onApproval: async (c, tk, tid, summary, src) => { calls.push(['revision', c, tk, tid, summary, src]) } },
    marks: { markTarget: async (c, tk, tid, status, src) => { calls.push(['markTarget', c, tk, tid, status, src]); return true } },
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
  assert.deepEqual(env.calls, [['task.confirm', CHAT, 5], ['revision', CHAT, 'task', 5, '任务「#5」确认为真', 'chat']], '审批成功 → 修订接线（P0 返工）')
  const results = readFileSync(join(env.dir, ACTION_RESULTS_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(results, [{ actionId: 'a1', ok: true, code: 'ok', ts: 1000 }])
  const audit = readFileSync(join(env.dir, WEB_ACTIONS_AUDIT_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(audit[0].type, 'task.confirm')
  assert.equal(audit[0].chatId, CHAT)
  assert.ok(!JSON.stringify(audit).includes('语句'), '审计零正文')
  const off = JSON.parse(readFileSync(join(env.dir, ACTIONS_OFFSET_REL), 'utf8'))
  assert.equal(off.byteOffset, Buffer.byteLength(line() + '\n', 'utf8'), 'W-3 水位=字节偏移（行尾之后）')
  assert.equal(off.lastActionId, 'a1', 'W-3 连续性锚点')
  rmSync(env.dir, { recursive: true, force: true })
})

test('W-1：审计行含 operator（token 哈希前缀），未注入记 unknown；原 token 绝不出现', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-op-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('web')
  store.ensureDir('audit')
  const svc = fakeActions()
  const inbox = new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], operator: 'op123456', logger: { warn() {}, error() {} }, pollSec: 1, now: () => 1,
  })
  store.writeText(ACTIONS_REL, line({ actionId: 'op1' }) + '\n')
  await inbox.poll()
  const audit = readFileSync(join(dir, WEB_ACTIONS_AUDIT_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(audit[0].operator, 'op123456')
  assert.ok(!readFileSync(join(dir, WEB_ACTIONS_AUDIT_REL), 'utf8').includes('tok_'), '审计无原 token')
  rmSync(dir, { recursive: true, force: true })
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
  // 手动回退水位到第 1 行末（字节偏移）模拟未消费第二行
  env.store.writeText(ACTIONS_OFFSET_REL, JSON.stringify({ byteOffset: Buffer.byteLength(line({ actionId: 'dup' }) + '\n', 'utf8'), lastActionId: 'dup' }) + '\n')
  const n = await env.inbox.poll()
  assert.equal(n, 0, '同 actionId 幂等跳过')
  assert.equal(env.calls.length, 2, '只执行一次（confirm + 修订接线各一）')
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

test('W-3 中途崩溃（水位滞后于文件）重放：恰好只消费未处理行', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-crash-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('web')
  const l1 = line({ actionId: 'c1', targetId: 1 })
  const l2 = line({ actionId: 'c2', targetId: 2 })
  const l3 = line({ actionId: 'c3', targetId: 3 })
  store.writeText(ACTIONS_REL, `${l1}\n${l2}\n${l3}\n`)
  // 模拟崩溃点：第 2 行已处理并落盘水位，第 3 行未处理（实例在水位之后构造 = 重启载入）
  const crashOffset = Buffer.byteLength(`${l1}\n${l2}\n`, 'utf8')
  store.writeText(ACTIONS_OFFSET_REL, JSON.stringify({ byteOffset: crashOffset, lastActionId: 'c2' }) + '\n')
  const svc = fakeActions()
  const inbox = new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn() {}, error() {} }, pollSec: 1, now: () => 1,
    resolveTarget: defaultResolve,
  })
  const n = await inbox.poll()
  assert.equal(n, 1, '只处理第 3 行')
  assert.deepEqual(svc.calls.filter((c) => c[0] === 'task.confirm'), [['task.confirm', CHAT, 3]], '已执行的 c1/c2 不重放')
  rmSync(dir, { recursive: true, force: true })
})

test('W-3 截断/轮转：byteOffset > 文件长度 → resync 从头消费 + error（seen 幂等不重复执行）', async () => {
  const errors = []
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-cut-')))
  const store = new Store(dir, { warn() {}, error(m) { errors.push(m) } })
  store.ensureDir('web')
  const svc = fakeActions()
  const inbox = new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn() {}, error(m) { errors.push(m) } }, pollSec: 1, now: () => 1,
    resolveTarget: defaultResolve,
  })
  store.writeText(ACTIONS_REL, `${line({ actionId: 't1', targetId: 1 })}\n${line({ actionId: 't2', targetId: 2 })}\n`)
  await inbox.poll()
  const callsBefore = svc.calls.length
  // 前端轮转：文件换成更短的新文件（同 actionId）→ 水位超长 → resync
  store.writeText(ACTIONS_REL, line({ actionId: 't1', targetId: 1 }) + '\n')
  const n = await inbox.poll()
  assert.equal(n, 0, 'resync 后 seen 幂等跳过')
  assert.equal(svc.calls.length, callsBefore, '不重复执行')
  assert.ok(errors.some((m) => m.includes('轮转/截断')), 'error 审计一条')
  rmSync(dir, { recursive: true, force: true })
})

test('W-3 轮转后的新动作照常消费（resync 不卡新行）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-cut2-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('web')
  const svc = fakeActions()
  const inbox = new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn() {}, error() {} }, pollSec: 1, now: () => 1,
    resolveTarget: defaultResolve,
  })
  store.writeText(ACTIONS_REL, `${line({ actionId: 'o1', targetId: 1 })}\n${line({ actionId: 'o2', targetId: 2 })}\n${line({ actionId: 'o3', targetId: 3 })}\n`)
  await inbox.poll()
  // 轮转成更短文件 + 新动作
  store.writeText(ACTIONS_REL, `${line({ actionId: 'o1', targetId: 1 })}\n${line({ actionId: 'n1', targetId: 9 })}\n`)
  const n = await inbox.poll()
  assert.equal(n, 1)
  assert.ok(svc.calls.some((c) => c[0] === 'task.confirm' && c[2] === 9), '新动作执行')
  assert.equal(svc.calls.filter((c) => c[0] === 'task.confirm' && c[2] === 1).length, 1, '旧 actionId 幂等')
  rmSync(dir, { recursive: true, force: true })
})

test('W-3 连续性校验：offset 记录 lastActionId 与文件该位置行不符 → resync + warn', async () => {
  const warns = []
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-anchor-')))
  const store = new Store(dir, { warn(m) { warns.push(m) }, error() {} })
  store.ensureDir('web')
  const svc = fakeActions()
  const mk = () => new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn(m) { warns.push(m) }, error() {} }, pollSec: 1, now: () => 1,
    resolveTarget: defaultResolve,
  })
  const l1 = line({ actionId: 'k1', targetId: 1 })
  store.writeText(ACTIONS_REL, `${l1}\n`)
  const first = mk()
  await first.poll()
  // 文件被改写（首行同长度但 actionId 锚点对不上）
  store.writeText(ACTIONS_REL, `${line({ actionId: 'zz', targetId: 1 })}\n${line({ actionId: 'k2', targetId: 2 })}\n`)
  const second = mk() // 新实例（重启载入水位）
  const n = await second.poll()
  assert.ok(warns.some((m) => m.includes('连续性校验失败')), 'warn 一条')
  assert.equal(n, 2, 'resync 后两行都进消费（seen 为空——新实例）')
  assert.equal(svc.calls.filter((c) => c[0] === 'task.confirm').length, 3, '首轮 k1 + 重启后 zz/k2 各一次')
  rmSync(dir, { recursive: true, force: true })
})

test('W-3 旧版行计数水位文件 → resync + warn（结果文件幂等兜底不重复执行）', async () => {
  const warns = []
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-legacy-')))
  const store = new Store(dir, { warn(m) { warns.push(m) }, error() {} })
  store.ensureDir('web')
  const svc = fakeActions()
  const mk = () => new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn(m) { warns.push(m) }, error() {} }, pollSec: 1, now: () => 1,
    resolveTarget: defaultResolve,
  })
  store.writeText(ACTIONS_REL, `${line({ actionId: 'lg1', targetId: 1 })}\n`)
  await mk().poll()
  const callsBefore = svc.calls.length
  store.writeText(ACTIONS_OFFSET_REL, '1\n') // 旧版格式（模拟升级）
  const n = await mk().poll()
  assert.ok(warns.some((m) => m.includes('旧版行计数')), 'warn 一条')
  assert.equal(n, 0)
  assert.equal(svc.calls.length, callsBefore, '结果文件幂等兜底：不重复执行')
  rmSync(dir, { recursive: true, force: true })
})

test('W-3 尾部半行不消费（前端写一半）：下轮补全后再消费', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-half-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('web')
  const svc = fakeActions()
  const inbox = new ActionInbox({
    store,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn() {}, error() {} }, pollSec: 1, now: () => 1,
    resolveTarget: defaultResolve,
  })
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(dir, ACTIONS_REL), line({ actionId: 'h1', targetId: 1 })) // 无换行
  assert.equal(await inbox.poll(), 0, '半行不消费')
  assert.equal(svc.calls.length, 0)
  appendFileSync(join(dir, ACTIONS_REL), '\n')
  assert.equal(await inbox.poll(), 1, '补全换行后消费')
  assert.equal(svc.calls.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('W-9：回执写失败入墓碑（有界），下轮 poll 补写；连续失败 error 告警', async () => {
  const errors = []
  const dir = resolve(mkdtempSync(join(tmpdir(), 'inbox-tomb-')))
  let failAppends = 4
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('web')
  const flaky = new Proxy(store, {
    get(target, prop, recv) {
      if (prop === 'appendJsonl') {
        return (rel, entry) => {
          if (rel === ACTION_RESULTS_REL && failAppends > 0) { failAppends -= 1; return false }
          return target.appendJsonl(rel, entry)
        }
      }
      return Reflect.get(target, prop, recv)
    },
  })
  const svc = fakeActions()
  const inbox = new ActionInbox({
    store: flaky,
    actions: new ApprovalActions({ task: svc.task, promise: svc.promise, store: { updateTaskDeadline: async () => true, setIdentityWatchLevel: async () => true }, notify: () => {}, logger: { warn() {}, error() {} } }),
    groups: [CHAT], logger: { warn() {}, error(m) { errors.push(m) } }, pollSec: 1, now: () => 1,
    resolveTarget: defaultResolve,
  })
  store.writeText(ACTIONS_REL, `${line({ actionId: 'w1', targetId: 1 })}\n${line({ actionId: 'w2', targetId: 2 })}\n`)
  await inbox.poll()
  const resultsRaw = existsSync(join(dir, ACTION_RESULTS_REL))
    ? readFileSync(join(dir, ACTION_RESULTS_REL), 'utf8').trim().split('\n').map(JSON.parse)
    : []
  assert.ok(resultsRaw.length < 2, '部分回执写失败被吞')
  await inbox.poll() // 第二轮：补写仍失败 → 连续失败计数到 3 → error 告警
  assert.ok(errors.some((m) => m.includes('回执写失败连续')), '连续失败 error 告警')
  failAppends = 0 // 磁盘恢复
  await inbox.poll()
  const after = readFileSync(join(dir, ACTION_RESULTS_REL), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(after.map((r) => r.actionId).sort(), ['w1', 'w2'], '墓碑补写：所有 actionId 都有回执')
  rmSync(dir, { recursive: true, force: true })
})
