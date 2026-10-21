// reminder.test.mjs —— M4-T4.3：时点表四种触发（注入时钟）、每日 7:50 速览合并、
// 逾期自动标记、outbox 落盘断言、dispose 无残留。全离线 mock。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Store } from '../lib/store.js'
import { GroupStoreService } from '../lib/group-store.js'
import { Outbox } from '../lib/outbox.js'
import { ReminderService, SOFT_DEADLINE_MS } from '../lib/reminder.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CHAT = 'g@chatroom'

function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}
const NOW = at(2026, 3, 10, 10, 0) // 周二 10:00
const DAY = 86_400_000

function makeEnv() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reminder-')))
  const store = new Store(base, silentLogger)
  const groupStore = new GroupStoreService(base, silentLogger)
  const outbox = new Outbox({ store, now: () => NOW })
  const notified = []
  const notifier = { notify: async (kind, title, body) => { notified.push({ kind, title, body }); return { shown: true, dryRun: false } } }
  // tasks 外键（assigner_pid / evidence_msg_id）→ 先落 identities + 证据消息行
  void groupStore.appendIdentity(CHAT, { pid: 'wxid_boss', wxid: 'wxid_boss', groupNick: '老板', watchLevel: 'off' })
  void groupStore.appendMessages(CHAT, [{ msgId: 'm1', ts: NOW, senderPid: 'wxid_boss', text: '@小明 发周报' }])
  const cleanup = () => { groupStore.dispose(); rmSync(base, { recursive: true, force: true }) }
  return { base, store, groupStore, outbox, notifier, notified, cleanupAll: [], cleanup }
}
function disposeEnv(env) {
  for (const stop of env.cleanupAll) stop()
  env.cleanup()
}

function makeService(env, opts = {}) {
  let t = opts.start ?? NOW
  const svc = new ReminderService({
    groupStore: env.groupStore,
    notifier: env.notifier,
    outbox: env.outbox,
    store: opts.store === undefined ? env.store : opts.store,
    logger: silentLogger,
    enabled: opts.enabled ?? true,
    deadline1hRemind: opts.deadline1hRemind ?? false,
    groups: opts.groups ?? [CHAT],
    digestTime: opts.digestTime ?? '07:50',
    now: () => t,
    setInterval: () => 0,
    clearInterval: () => {},
    tickMs: 60_000,
  })
  const stop = svc.start() // scheduler 同约定：tick 手工驱动前须 start（enabled=false 返回 noop stop）
  env.cleanupAll = env.cleanupAll ?? []
  env.cleanupAll.push(stop)
  return {
    svc,
    tick: () => svc.tick(),
    set: (v) => { t = v },
    get: () => t,
  }
}

/** 建一条 active 任务，返回 taskId */
async function seedTask(env, deadline, opts = {}) {
  return env.groupStore.appendTask(CHAT, {
    statement: opts.statement ?? '发周报',
    assignerPid: 'wxid_boss',
    evidenceMsgId: 'm1',
    status: 'active',
    deadline,
    deadlineConfidence: deadline === null ? 0 : 0.9,
  }, opts.createdAt ?? NOW)
}

test('时点表·识别时：由识别端触发（reminder 不重复发）；模块不承担该时点', async () => {
  const env = makeEnv()
  try {
    const id = await seedTask(env, null)
    assert.ok(id)
    // reminder 只负责截止相关时点——识别时卡片在 task-recognition.test.mjs 断言
  } finally { disposeEnv(env) }
})

test('时点表·截止前 1 天：进入 [dl-1d, dl) 触发一次，notify + outbox 各一条', async () => {
  const env = makeEnv()
  try {
    const dl = NOW + 23 * 3_600_000
    await seedTask(env, dl)
    const h = makeService(env)
    await h.tick()
    // 首个 tick 同时会推当日 7:50 速览（NOW=10:00 已过时点），故按 kind 过滤断言
    const due1d = () => env.notified.filter((n) => n.kind === 'remind:due-1d')
    assert.equal(due1d().length, 1, '23h 后已进 1 天窗口')
    assert.ok(due1d()[0].title.includes('发周报'))
    const box = env.outbox.tailOutbox(10).filter((b) => b.kind === 'remind:due-1d')
    assert.equal(box.length, 1)
    assert.equal(box[0].channel, 'filehelper')
    assert.equal(box[0].status, 'pending')
    assert.ok(box[0].body.includes('deadline'))
    // 重复 tick 不再触发（每任务每时点一次）
    await h.tick()
    assert.equal(due1d().length, 1)
    // 远离截止（>24h）的新任务不触发
    await seedTask(env, NOW + 3 * DAY, { statement: '别的任务' })
    await h.tick()
    assert.equal(due1d().length, 1)
  } finally { disposeEnv(env) }
})

test('时点表·截止前 1 小时：deadline1hRemind=false 默认关；true 才触发', async () => {
  const env = makeEnv()
  try {
    const dl = NOW + 30 * 60_000
    await seedTask(env, dl)
    // 默认关：30 分钟前只有 1d 时点（若未触发过）+ 无 1h；此处直接断言无 due-1h
    const off = makeService(env)
    await off.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'remind:due-1h').length, 0, '默认关')
    // 打开：触发 due-1h
    const on = makeService(env, { deadline1hRemind: true })
    on.set(NOW + 60_000) // 进入 [dl-1h, dl)
    await on.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'remind:due-1h').length, 1)
  } finally { disposeEnv(env) }
})

test('时点表·逾期：标题加【逾期】+ overdue_marked_at 自动标记 + 只触发一次', async () => {
  const env = makeEnv()
  try {
    const dl = NOW - 60_000
    const id = await seedTask(env, dl)
    const h = makeService(env)
    await h.tick()
    const overdueNotes = env.notified.filter((n) => n.kind === 'remind:overdue')
    assert.equal(overdueNotes.length, 1)
    assert.ok(overdueNotes[0].title.startsWith('【逾期】'), '升级样式')
    const row = env.groupStore.getTask(CHAT, id)
    assert.ok(row.overdueMarkedAt > 0, '逾期自动标记')
    assert.equal(row.status, 'active', '不删条目不改状态')
    await h.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'remind:overdue').length, 1, '只触发一次')
  } finally { disposeEnv(env) }
})

test('无明确 deadline：按识别时刻 +3 天软提醒', async () => {
  const env = makeEnv()
  try {
    await seedTask(env, null, { createdAt: NOW })
    const viewSvc = makeService(env)
    // 3 天内：不触发
    await viewSvc.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'remind:overdue').length, 0)
    // 越过软时限（NOW+3d）：逾期软提醒
    viewSvc.set(NOW + SOFT_DEADLINE_MS + 60_000)
    await viewSvc.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'remind:overdue').length, 1)
    const box = env.outbox.tailOutbox(20).filter((b) => b.kind === 'remind:overdue').at(-1)
    assert.ok(box.body.includes('无明确 deadline'), 'outbox 标注软提醒')
  } finally { disposeEnv(env) }
})

test('每日 7:50 速览：合并当日到期/逾期/待确认一次性推送（notify + outbox 各一条）', async () => {
  const env = makeEnv()
  try {
    await seedTask(env, at(2026, 3, 10, 18, 0), { statement: '今天到期的任务' }) // 当日 18:00
    await env.groupStore.appendTask(CHAT, { statement: '待确认任务', status: 'pending_confirm' }, NOW)
    const h = makeService(env)
    // 07:49 不推
    h.set(at(2026, 3, 11, 7, 49))
    await h.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'digest').length, 0)
    // 07:51 推一次，merged 一条
    h.set(at(2026, 3, 11, 7, 51))
    await h.tick()
    const digests = env.notified.filter((n) => n.kind === 'digest')
    assert.equal(digests.length, 1)
    assert.ok(digests[0].title.includes('今日待办速览'))
    const boxes = env.outbox.tailOutbox(10).filter((b) => b.kind === 'digest')
    assert.equal(boxes.length, 1, 'outbox 只有一条合并正文')
    assert.ok(boxes[0].body.includes('今天到期的任务'))
    assert.ok(boxes[0].body.includes('（待确认）待确认任务'))
    // W-11：evidence_ref 指向 outbox 条目自身 id（不再指向从未写入的 reminder/digest/<day>.txt）
    assert.equal(boxes[0].evidence_ref, `outbox/${boxes[0].id}`, 'evidence_ref=outbox/<id> 且可解析回本条')
    assert.ok(!boxes[0].evidence_ref.startsWith('reminder/'), '不指向从未落盘的 reminder 文件')
    // 同日再 tick 不重复
    await h.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'digest').length, 1)
    // 明日再推（此时昨日任务已逾期，进明日速览）
    h.set(at(2026, 3, 12, 8, 0))
    await h.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'digest').length, 2)
    const box2 = env.outbox.tailOutbox(10).filter((b) => b.kind === 'digest').at(-1)
    assert.ok(box2.body.includes('【逾期】'), '逾期任务带升级标记')
  } finally { disposeEnv(env) }
})

test('速览去重持久化：重启后同日不重复推（store 注入）', async () => {
  const env = makeEnv()
  try {
    await seedTask(env, at(2026, 3, 10, 18, 0))
    const s1 = makeService(env)
    s1.set(at(2026, 3, 10, 8, 0))
    await s1.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'digest').length, 1)
    // 模拟重启：全新 service + 同一 store
    const s2 = makeService(env)
    s2.set(at(2026, 3, 10, 9, 0))
    await s2.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'digest').length, 1, 'state.json 去重')
  } finally { disposeEnv(env) }
})

test('无待办日的速览：notify + outbox 各一条空速览', async () => {
  const env = makeEnv()
  try {
    const h = makeService(env)
    h.set(at(2026, 3, 10, 8, 0))
    await h.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'digest').length, 1)
    const box = env.outbox.tailOutbox(20).filter((b) => b.kind === 'digest').at(-1)
    assert.ok(box.title.includes('（无）'))
  } finally { disposeEnv(env) }
})

test('enabled=false 零活动：start 返回 noop、tick 无副作用', async () => {
  const env = makeEnv()
  try {
    await seedTask(env, NOW - 60_000)
    const h = makeService(env, { enabled: false })
    const stop = h.svc.start()
    assert.equal(typeof stop, 'function')
    await h.tick()
    assert.equal(env.notified.filter((n) => n.kind === 'remind:overdue').length, 0)
    assert.equal(env.outbox.tailOutbox(10).length, 0)
    stop()
  } finally { disposeEnv(env) }
})

test('start/stop：dispose 无定时器残留（注入 setInterval/clearInterval 断言）', async () => {
  const env = makeEnv()
  try {
    let cleared = 0
    let started = 0
    const svc = new ReminderService({
      groupStore: env.groupStore, notifier: env.notifier, outbox: env.outbox,
      logger: silentLogger, enabled: true, groups: [CHAT],
      now: () => NOW,
      setInterval: () => { started++; return 42 },
      clearInterval: () => { cleared++ },
    })
    const stop = svc.start()
    assert.equal(started, 1)
    stop()
    assert.equal(cleared, 1, 'clearInterval 恰好一次')
    stop() // 幂等
    assert.equal(cleared, 1)
  } finally { disposeEnv(env) }
})

test('viewOf：有效截止与逾期判定', () => {
  const env = makeEnv()
  try {
    const h = makeService(env)
    const explicit = {
      taskId: 1, statement: 'x', assignerPid: null, evidenceMsgId: null,
      deadline: NOW + 1000, deadlineConfidence: 1, status: 'active',
      learnedPattern: null, overdueMarkedAt: 0, createdAt: NOW,
    }
    const v1 = h.svc.viewOf(explicit, NOW)
    assert.equal(v1.effectiveDeadline, NOW + 1000)
    assert.equal(v1.hasExplicitDeadline, true)
    assert.equal(v1.overdue, false)
    const soft = { ...explicit, deadline: null }
    const v2 = h.svc.viewOf(soft, NOW)
    assert.equal(v2.effectiveDeadline, NOW + SOFT_DEADLINE_MS)
    assert.equal(v2.hasExplicitDeadline, false)
    assert.equal(v2.overdue, false)
    assert.equal(h.svc.viewOf(soft, NOW + SOFT_DEADLINE_MS + 1).overdue, false, '未标记前不算逾期')
  } finally { disposeEnv(env) }
})
