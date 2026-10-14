// promise-track.test.mjs —— M5-T5.1/T5.2：请求→应答配对识别、状态机全流转
// （含跳票不删）、兑现自动关联 + 手动兜底、承诺变更更新原行、模式学习免确认、
// 催办草稿落 outbox、扫描水位持久化续扫、报告双向看板真数据。全离线 mock。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Store } from '../lib/store.js'
import { GroupStoreService } from '../lib/group-store.js'
import { Outbox } from '../lib/outbox.js'
import {
  PromiseRecognitionService,
  PromiseReminderService,
  parsePromiseRecognition,
  followupDraft,
  loadScanWatermark,
  saveScanWatermark,
  FULFIL_CONFIDENCE_MIN,
} from '../lib/promise-track.js'
import { ReportService } from '../lib/report.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CHAT = 'g@chatroom'

function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}
const NOW = at(2026, 3, 10, 10, 0) // 周二 10:00
const DAY = 86_400_000

function makeEnv() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'promise-track-')))
  const store = new Store(base, silentLogger)
  const groupStore = new GroupStoreService(base, silentLogger)
  const outbox = new Outbox({ store, now: () => NOW })
  return { base, store, groupStore, outbox, cleanup: () => { groupStore.dispose(); rmSync(base, { recursive: true, force: true }) } }
}

async function seedIdentities(groupStore) {
  await groupStore.appendIdentity(CHAT, { pid: 'wxid_self', wxid: 'wxid_self', groupNick: '小明' })
  await groupStore.appendIdentity(CHAT, { pid: 'wxid_bob', wxid: 'wxid_bob', groupNick: '老王' })
}

async function seedMessages(groupStore, msgs) {
  await groupStore.appendMessages(CHAT, msgs.map((m, i) => ({
    msgId: m.msgId ?? `m${i + 1}`,
    ts: m.ts ?? NOW - 60_000,
    senderPid: m.senderPid,
    senderName: m.senderName ?? '',
    kind: m.kind,
    text: m.text,
    quoteOfMsgId: m.quoteOfMsgId,
  })))
}

function mockLlm(responses) {
  const calls = { n: 0, prompts: [] }
  return {
    calls,
    async complete(prompt) {
      calls.prompts.push(prompt)
      const r = responses[calls.n]
      calls.n++
      if (r instanceof Error) throw r
      if (r === undefined) throw new Error('mock 队列已空')
      return typeof r === 'string' ? r : JSON.stringify(r)
    },
  }
}

function svc(groupStore, llm, opts = {}) {
  const events = []
  const service = new PromiseRecognitionService({
    groupStore,
    llm,
    logger: silentLogger,
    enabled: opts.enabled ?? true,
    selfWxid: opts.selfWxid ?? 'wxid_self',
    patternLearning: opts.patternLearning ?? true,
    store: opts.store ?? undefined,
    now: () => opts.now?.() ?? NOW,
    onPromiseEvent: (ev) => events.push(ev),
    scanLimit: opts.scanLimit,
  })
  return { service, events }
}

// ———————————— 纯函数 ————————————

test('parsePromiseRecognition：合法输出解析、非法结构返回 null、confidence clamp', () => {
  const ok = parsePromiseRecognition(JSON.stringify({
    promises: [{ n: 2, requester_n: 1, statement: '晚点发你报表', promiser: '老王', deadline_text: '周五', deadline_confidence: 2 }],
    promise_updates: [{ p: 1, new_deadline: '下周一' }],
    fulfilments: [{ p: 1, n: 5, confidence: 0.9 }],
  }), 5, 1)
  assert.ok(ok)
  assert.equal(ok.promises[0].deadlineConfidence, 1, 'clamp 到 [0,1]')
  assert.equal(ok.promiseUpdates[0].p, 1)
  assert.equal(ok.fulfilments[0].n, 5)
  assert.equal(parsePromiseRecognition('{"promises":[{"n":9,"statement":"x"}]}', 5, 1), null, 'n 越界非法')
  assert.equal(parsePromiseRecognition('{"promises":[{"n":1}]}', 5, 1), null, 'statement 缺失非法')
  assert.equal(parsePromiseRecognition('不是 JSON', 5, 1), null)
  assert.equal(parsePromiseRecognition('{"promise_updates":[{"p":3,"new_deadline":"周一"}]}', 5, 1), null, 'p 越界非法')
})

test('followupDraft：单风格得体话术，含事项与时限，绝不带发送语义', () => {
  const draft = followupDraft('老王', '季度报表', at(2026, 3, 9, 18, 0))
  assert.ok(draft.includes('老王'))
  assert.ok(draft.includes('季度报表'))
  assert.ok(draft.includes('3月9日'))
  assert.ok(!/\b(send|发送到群|直接发)\b/.test(draft))
  const noDl = followupDraft('', '材料', null)
  assert.ok(noDl.includes('之前提到的时间'))
})

// ———————————— 识别：请求→应答配对 + 待确认闸门 ————————————

test('请求→应答配对识别：pending_confirm + requester_evidence_msg_id 落库 + 回调事件', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'req1', senderPid: 'wxid_self', senderName: '小明', text: '能发我一份上季度报表吗' },
      { msgId: 'ans1', senderPid: 'wxid_bob', senderName: '老王', text: '晚点发你，周五前整理好', ts: NOW - 30_000 },
    ])
    const llm = mockLlm([{
      promises: [{ n: 2, requester_n: 1, statement: '周五前把上季度报表发给小明', promiser: '老王', deadline_text: '周五前', deadline_confidence: 0.8 }],
      promise_updates: [],
      fulfilments: [],
    }])
    const { service, events } = svc(env.groupStore, llm)
    const res = await service.scanChat(CHAT)
    assert.equal(res.promisesInserted, 1)
    const rows = env.groupStore.getPromises(CHAT)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.status, 'pending_confirm', '待确认闸门')
    assert.equal(row.requesterEvidenceMsgId, 'req1', '我的原始请求已关联')
    assert.equal(row.evidenceMsgId, 'ans1')
    assert.equal(row.assignerPid, 'wxid_bob')
    assert.ok(row.deadline !== null, 'deadline 由本地解析器落地')
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'promise_pending_confirm')
    assert.equal(llm.calls.n, 1)
    assert.ok(!llm.calls.prompts[0].includes('msg_id'), 'msg_id 不进 prompt')
    assert.ok(!llm.calls.prompts[0].includes('"ans1"'), '真实消息 id 不进 prompt')
    assert.ok(await service.confirmPromise(CHAT, row.promiseId), 'confirmPromise → waiting')
    assert.equal((await env.groupStore.getPromise(CHAT, row.promiseId)).status, 'waiting')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('LLM 两次失败 → 降级不落库；无新消息不触发 LLM', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { senderPid: 'wxid_bob', senderName: '老王', text: '明天给你' },
    ])
    const llm = mockLlm([new Error('net down'), new Error('net down')])
    const { service } = svc(env.groupStore, llm)
    const res = await service.scanChat(CHAT)
    assert.equal(res.degraded, true)
    assert.equal(env.groupStore.getPromises(CHAT).length, 0)
    const res2 = await service.scanChat(CHAT)
    assert.equal(res2.ran, false, '水位推进后无新消息不再调 LLM')
    assert.equal(llm.calls.n, 2, '总共只调了两次（重试一次）')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('enabled=false 全程零活动（零 LLM 调用、零落库）', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [{ senderPid: 'wxid_bob', senderName: '老王', text: '明天给你' }])
    const llm = mockLlm([])
    const { service } = svc(env.groupStore, llm, { enabled: false })
    const res = await service.scanChat(CHAT)
    assert.equal(res.ran, false)
    assert.equal(llm.calls.n, 0)
    assert.equal(env.groupStore.getPromises(CHAT).length, 0)
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

// ———————————— 状态机全流转 ————————————

test('状态机全流转：确认→兑现自动关联（发送者校验+置信度）→手动兜底→变更更新原行→跳票不删', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'req1', senderPid: 'wxid_self', senderName: '小明', text: '材料好了发我一份', ts: NOW - 3 * DAY },
      { msgId: 'ans1', senderPid: 'wxid_bob', senderName: '老王', text: '好的，周三前给你', ts: NOW - 3 * DAY + 60_000 },
      { msgId: 'oth1', senderPid: 'wxid_other', senderName: '路人', text: '我替他给你吧', ts: NOW - 2 * DAY },
      { msgId: 'ful1', senderPid: 'wxid_bob', senderName: '老王', text: '材料在这，查收', ts: NOW - 1000 },
      { msgId: 'ful2', senderPid: 'wxid_bob', senderName: '老王', text: '正式版给你', ts: NOW + 3000 },
    ])
    const llm = mockLlm([
      // 扫描1（untilTs=NOW-2*DAY）：窗口 [req1, ans1] → 承诺候选
      { promises: [{ n: 2, requester_n: 1, statement: '周三前把材料给小明', promiser: '老王', deadline_text: '周三前', deadline_confidence: 0.8 }], promise_updates: [], fulfilments: [] },
      // 扫描2（untilTs=NOW-500）：窗口 [oth1, ful1] → 变更（延期到周五）+ 他人代答兑现（拒绝）
      { promises: [], promise_updates: [{ p: 1, new_deadline: '周五' }], fulfilments: [{ p: 1, n: 1, confidence: 0.9 }] },
      // 扫描3（untilTs=NOW+4000）：窗口 [ful2] → 承诺人本人兑现（接受）
      { promises: [], promise_updates: [], fulfilments: [{ p: 1, n: 1, confidence: 0.95 }] },
    ])
    const { service, events } = svc(env.groupStore, llm)
    await service.scanChat(CHAT, NOW - 2 * DAY)
    let row = env.groupStore.getPromises(CHAT)[0]
    const id = row.promiseId
    assert.ok(await service.confirmPromise(CHAT, id), '→ waiting')
    // 低置信度兑现不自动关联（独立服务，全窗口 [req1..ful1]，n3=ful1）
    const { service: svc2 } = svc(env.groupStore, mockLlm([{ promises: [], promise_updates: [], fulfilments: [{ p: 1, n: 3, confidence: FULFIL_CONFIDENCE_MIN - 0.1 }] }]))
    await svc2.scanChat(CHAT, NOW - 500)
    assert.equal(env.groupStore.getPromise(CHAT, id).status, 'waiting', '低置信度不自动置 fulfilled')
    // 非承诺人发消息：拒绝自动兑现
    await service.scanChat(CHAT, NOW - 500)
    assert.equal(env.groupStore.getPromise(CHAT, id).status, 'waiting', '他人代答不自动兑现')
    // 变更：延期到周五，更新原行不新建
    const all = env.groupStore.getPromises(CHAT)
    assert.equal(all.length, 1, '变更不新建条目')
    const dlDays = (all[0].deadline - at(2026, 3, 10, 0, 0)) / DAY
    assert.ok(Math.abs(dlDays - 3.999) < 0.05, `deadline 更新为本周五 3 月 13 日 23:59（差 ${dlDays} 天）`)
    // 真兑现：承诺人本人 + 高置信度 → fulfilled，关联兑现消息
    await service.scanChat(CHAT, NOW + 4000)
    row = env.groupStore.getPromise(CHAT, id)
    assert.equal(row.status, 'fulfilled')
    assert.equal(row.fulfilledMsgId, 'ful2')
    assert.ok(row.fulfilledTs !== null)
    assert.ok(events.some((e) => e.type === 'promise_fulfilled'))
    // 手动兜底：新建一条 waiting（无自动兑现），confirmFulfilled 直接收口
    const id2 = await env.groupStore.appendPromise(CHAT, { statement: '下版白皮书', assignerPid: 'wxid_bob', deadline: NOW + DAY, status: 'waiting' }, NOW)
    assert.ok(await service.confirmFulfilled(CHAT, id2, null), '手动勾选兑现兜底')
    assert.equal(env.groupStore.getPromise(CHAT, id2).status, 'fulfilled')
    // 跳票：不删条目
    const id3 = await env.groupStore.appendPromise(CHAT, { statement: '过期承诺', assignerPid: 'wxid_bob', deadline: NOW - 2 * DAY, status: 'waiting' }, NOW - 3 * DAY)
    const reminder = new PromiseReminderService({
      groupStore: env.groupStore,
      notifier: { notify: () => {} },
      outbox: env.outbox,
      logger: silentLogger,
      groups: [CHAT],
      now: () => NOW,
    })
    reminder.start()
    await reminder.tick()
    const broken = env.groupStore.getPromise(CHAT, id3)
    assert.equal(broken.status, 'broken', '逾期自动标记跳票')
    assert.ok(broken.brokenMarkedAt > 0)
    assert.equal(env.groupStore.getPromises(CHAT, { status: 'broken' }).length, 1, '跳票条目保留（不删）')
    // 手动关闭
    assert.ok(await service.closePromise(CHAT, id3))
    assert.equal(env.groupStore.getPromise(CHAT, id3).status, 'cancelled')
    // cancel/fulfilled 后不可再取消
    assert.equal(await service.cancelPromise(CHAT, id), false, '已兑现不可取消')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('模式学习：确认过的「承诺人+句式」同类承诺免确认直接 waiting', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'r1', senderPid: 'wxid_self', senderName: '小明', text: '能发我一份报表吗', ts: NOW - 60_000 - 1000 },
      { msgId: 'a1', senderPid: 'wxid_bob', senderName: '老王', text: '晚点发你', ts: NOW - 60_000 },
      { msgId: 'r2', senderPid: 'wxid_self', senderName: '小明', text: '能发我一份清单吗', ts: NOW - 30_000 - 1000 },
      { msgId: 'a2', senderPid: 'wxid_bob', senderName: '老王', text: '晚点发你', ts: NOW - 30_000 },
    ])
    const llm = mockLlm([
      { promises: [{ n: 2, requester_n: 1, statement: '晚点发报表', promiser: '老王', deadline_text: null, deadline_confidence: 0 }], promise_updates: [], fulfilments: [] },
      { promises: [{ n: 2, requester_n: 1, statement: '晚点发清单', promiser: '老王', deadline_text: null, deadline_confidence: 0 }], promise_updates: [], fulfilments: [] },
    ])
    const { service } = svc(env.groupStore, llm)
    await service.scanChat(CHAT, NOW - 45_000)
    const first = env.groupStore.getPromises(CHAT)[0]
    assert.equal(first.status, 'pending_confirm')
    assert.ok(await service.confirmPromise(CHAT, first.promiseId), '确认并登记指纹')
    await service.scanChat(CHAT)
    const rows = env.groupStore.getPromises(CHAT)
    const second = rows.find((r) => r.promiseId !== first.promiseId)
    assert.equal(second.status, 'waiting', '同指纹免确认直接 waiting')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

// ———————————— 提醒时点 + 催办草稿 ————————————

test('提醒时点：截止当天触发一次、逾期跳票触发一次（reminder_log 去重）+ 催办草稿落 outbox', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    const notified = []
    const dlToday = at(2026, 3, 10, 23, 59) // 今天到期
    const id = await env.groupStore.appendPromise(CHAT, { statement: '发会议纪要', assignerPid: 'wxid_bob', deadline: dlToday, status: 'waiting' }, NOW - DAY)
    const outbox = new Outbox({ store: env.store, now: () => NOW })
    const reminder = new PromiseReminderService({
      groupStore: env.groupStore,
      notifier: { notify: (type, title) => { notified.push({ type, title }) } },
      outbox,
      logger: silentLogger,
      followupDraftEnabled: true,
      groups: [CHAT],
      now: () => NOW,
    })
    reminder.start()
    await reminder.tick() // 截止当天
    assert.equal(env.groupStore.getPromise(CHAT, id).status, 'waiting')
    await reminder.tick() // 同日第二次：去重不重发
    assert.equal(notified.length, 1, '每承诺每时点只触发一次')
    // 推进到逾期：跳票标记 + 催办草稿
    const late = dlToday + DAY + 3_600_000
    const reminder2 = new PromiseReminderService({
      groupStore: env.groupStore,
      notifier: { notify: (type, title) => notified.push({ type, title }) },
      outbox,
      logger: silentLogger,
      followupDraftEnabled: true,
      groups: [CHAT],
      now: () => late,
    })
    reminder2.start()
    await reminder2.tick()
    const row = env.groupStore.getPromise(CHAT, id)
    assert.equal(row.status, 'broken', '逾期未兑现 → broken（跳票标记）')
    const drafts = outbox.tailOutbox(50).filter((e) => e.kind === 'followup_draft')
    assert.equal(drafts.length, 1, '催办草稿落 outbox')
    assert.equal(drafts[0].channel, 'filehelper')
    assert.ok(drafts[0].body.includes('会议纪要'))
    assert.ok(drafts[0].title.includes('未发送'))
    await reminder2.tick()
    const drafts2 = outbox.tailOutbox(50).filter((e) => e.kind === 'followup_draft')
    assert.equal(drafts2.length, 1, '跳票后不重复生成催办')
    reminder.stop()
    reminder2.stop()
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('followupDraftEnabled=false：跳票标记但不生成催办草稿', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    const id = await env.groupStore.appendPromise(CHAT, { statement: 's', assignerPid: 'wxid_bob', deadline: NOW - DAY, status: 'waiting' }, NOW - 2 * DAY)
    const reminder = new PromiseReminderService({
      groupStore: env.groupStore,
      notifier: { notify: () => {} },
      outbox: env.outbox,
      logger: silentLogger,
      groups: [CHAT],
      now: () => NOW,
    })
    reminder.start()
    await reminder.tick()
    assert.equal(env.groupStore.getPromise(CHAT, id).status, 'broken')
    assert.equal(env.outbox.tailOutbox(50).filter((e) => e.kind === 'followup_draft').length, 0)
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

// ———————————— 扫描水位持久化（M4 遗留收口） ————————————

test('扫描水位持久化：重启后从水位续扫，不重看旧消息；首启无水位=游标口径', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'old1', senderPid: 'wxid_bob', senderName: '老王', text: '旧的应答', ts: NOW - 2 * DAY },
      { msgId: 'new1', senderPid: 'wxid_self', senderName: '小明', text: '新的请求', ts: NOW - 60_000 },
    ])
    // 首启（有 store、无水位）：游标口径——从 0 起扫会看到旧消息？不：无水位=不回灌，
    // 但扫描窗口是"水位之后"，首启水位 0 会扫到全部。水位持久化的语义是**重启用**：
    // 先用一次并落水位，再新建服务（模拟重启）验证不重扫。
    const llm = mockLlm([{ promises: [], promise_updates: [], fulfilments: [] }])
    const { service } = svc(env.groupStore, llm, { store: env.store })
    await service.scanChat(CHAT, NOW - 50_000)
    const wm = loadScanWatermark(env.store, CHAT)
    assert.equal(wm, NOW - 60_000, '水位 = 本批最后一条消息 ts，已落 stateDir')
    // 重启：新服务实例（内存水位丢失），LLM 队列空 = 不应再有任何调用
    const llm2 = mockLlm([])
    const { service: service2 } = svc(env.groupStore, llm2, { store: env.store })
    const res = await service2.scanChat(CHAT)
    assert.equal(res.ran, false, '重启后从水位续扫，无新消息不重看当日消息')
    assert.equal(llm2.calls.n, 0)
    // 新消息到来：只扫水位之后
    await env.groupStore.appendMessages(CHAT, [{ msgId: 'new2', ts: NOW - 10_000, senderPid: 'wxid_bob', senderName: '老王', text: '新应答' }])
    const llm3 = mockLlm([{ promises: [{ n: 1, requester_n: 0, statement: '新承诺', promiser: '老王', deadline_text: null, deadline_confidence: 0 }], promise_updates: [], fulfilments: [] }])
    const { service: service3 } = svc(env.groupStore, llm3, { store: env.store })
    await service3.scanChat(CHAT)
    assert.ok(llm3.calls.prompts[0].includes('新应答'), '新消息进入扫描窗口')
    assert.ok(!llm3.calls.prompts[0].includes('旧的应答'), '旧消息不重看')
    assert.equal(env.groupStore.getPromises(CHAT).length, 1)
    // 纯函数冒烟：损坏状态文件回退 null
    env.store.writeText('scan-watermark.json', '{broken')
    assert.equal(loadScanWatermark(env.store, CHAT), null)
    saveScanWatermark(env.store, CHAT, 123)
    assert.equal(loadScanWatermark(env.store, CHAT), 123)
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

// ———————————— 报告联动：双向看板真数据 ————————————

test('报告 L2 双向看板接真数据：我欠人的（tasks active/逾期）+ 人欠我的（promises waiting/broken）', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await env.groupStore.appendMessages(CHAT, [{ msgId: 'm1', ts: NOW - 3_600_000, senderPid: 'wxid_self', senderName: '小明', text: '今天在忙' }])
    // 我欠人的：一条 active 未到期 + 一条已逾期
    await env.groupStore.appendTask(CHAT, { statement: '给老王交周报', status: 'active', deadline: NOW + DAY }, NOW)
    await env.groupStore.appendTask(CHAT, { statement: '回复评审意见', status: 'active', deadline: NOW - DAY }, NOW - 2 * DAY)
    // 人欠我的：waiting + broken
    await env.groupStore.appendPromise(CHAT, { statement: '老王发我会议纪要', assignerPid: 'wxid_bob', deadline: NOW + DAY, status: 'waiting' }, NOW)
    await env.groupStore.appendPromise(CHAT, { statement: '老王发我报价单', assignerPid: 'wxid_bob', deadline: NOW - DAY, status: 'broken' }, NOW - 2 * DAY)
    const report = new ReportService({
      groupStore: env.groupStore,
      store: env.store,
      stateDir: env.base,
      llm: mockLlm([]), // 报告 LLM 不可用 → degraded 骨架（看板是真数据，不依赖 LLM）
      logger: silentLogger,
      enabled: true,
      now: () => NOW,
    })
    const res = await report.generateReport(CHAT, 'daily', NOW)
    assert.ok(res.path)
    const md = env.store.readText(res.path)
    assert.ok(md.includes('我欠人的：'))
    assert.ok(md.includes('给老王交周报'))
    assert.ok(md.includes('【逾期】回复评审意见'), '逾期任务升级标记')
    assert.ok(md.includes('人欠我的：'))
    assert.ok(md.includes('老王发我会议纪要'))
    assert.ok(md.includes('【已跳票】老王发我报价单'), '跳票不删、持续进「人欠我的」')
    report.dispose()
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})
