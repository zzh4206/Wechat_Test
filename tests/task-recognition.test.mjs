// task-recognition.test.mjs —— M4-T4.1/T4.2：识别（指派/确认语义/时间解析/无 deadline）、
// @我精确与降级、待确认→确认→active、模式学习免确认、冲突演变链、v3 迁移、
// 日报「今日行动」接真数据源。全离线 mock（LLM mock + 临时目录 SQLite）。
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
  TaskRecognitionService,
  parseDeadlineText,
  parseRecognition,
  patternFingerprint,
  selfMention,
  isAcceptanceText,
  resolvePidByName,
} from '../lib/task-recognition.js'
import { ReportService } from '../lib/report.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CHAT = 'g@chatroom'

function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}
const NOW = at(2026, 3, 10, 10, 0) // 2026-03-10 周二 10:00

function makeEnv() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'task-rec-')))
  const store = new Store(base, silentLogger)
  const groupStore = new GroupStoreService(base, silentLogger)
  const outbox = new Outbox({ store, now: () => NOW })
  return { base, store, groupStore, outbox, cleanup: () => { groupStore.dispose(); rmSync(base, { recursive: true, force: true }) } }
}

async function seedIdentities(groupStore) {
  await groupStore.appendIdentity(CHAT, { pid: 'wxid_boss', wxid: 'wxid_boss', groupNick: '老板', watchLevel: 'global' })
  await groupStore.appendIdentity(CHAT, { pid: 'wxid_self', wxid: 'wxid_self', groupNick: '小明', watchLevel: 'global' })
}

async function seedMessages(groupStore, msgs) {
  await groupStore.appendMessages(CHAT, msgs.map((m, i) => ({
    msgId: m.msgId ?? `m${i + 1}`,
    ts: m.ts ?? NOW - 60_000,
    senderPid: m.senderPid,
    senderName: m.senderName ?? '',
    text: m.text,
    quoteOfMsgId: m.quoteOfMsgId,
  })))
}

/** LLM mock：忽略 prompt，按队列依次返回（或抛错） */
function mockLlm(responses) {
  const calls = { n: 0, prompts: [] }
  return {
    calls,
    complete: async (prompt) => {
      calls.prompts.push(prompt)
      const r = responses[Math.min(calls.n, responses.length - 1)]
      calls.n++
      if (typeof r === 'string' && r.startsWith('THROW')) throw new Error(r.slice(5))
      return typeof r === 'function' ? r(prompt) : r
    },
  }
}

/** 构造识别服务：待确认事件同步落 outbox（模拟 index.ts 接线） */
function makeService(groupStore, llm, opts = {}) {
  const outbox = opts.outbox
  const events = []
  const svc = new TaskRecognitionService({
    groupStore,
    llm,
    logger: silentLogger,
    enabled: opts.enabled ?? true,
    selfWxid: opts.selfWxid ?? 'wxid_self',
    patternLearning: opts.patternLearning ?? true,
    now: () => opts.now?.() ?? NOW,
    onRecognitionEvent: (ev) => {
      events.push(ev)
      outbox?.appendOutbox({
        kind: ev.type,
        title: ev.type.endsWith('pending_confirm') ? '识别到疑似任务，待确认' : '任务已入清单',
        body: ev.statement,
        evidence_ref: `${ev.kind}:${ev.id}`,
      })
    },
  })
  return { svc, events }
}

// ———————————— 纯函数：时间解析 ————————————

test('parseDeadlineText：相对时间（今天内/下班前/今晚）', () => {
  assert.equal(parseDeadlineText('今天内', NOW).deadline, at(2026, 3, 10, 23, 59))
  assert.equal(parseDeadlineText('下班前', NOW).deadline, at(2026, 3, 10, 18, 0))
  assert.equal(parseDeadlineText('今晚给我', NOW).deadline, at(2026, 3, 10, 22, 0))
  assert.ok(parseDeadlineText('今天内', NOW).confidence > 0)
})

test('parseDeadlineText：星期与下周（本周五之前 / 下周一）', () => {
  // 本周五 = 2026-03-13；下周一 = 2026-03-16
  assert.equal(parseDeadlineText('周五之前', NOW).deadline, at(2026, 3, 13, 23, 59))
  assert.equal(parseDeadlineText('下周一交', NOW).deadline, at(2026, 3, 16, 23, 59))
  // 本周已过的星期顺延到下一个该星期（周二问"周一之前" → 下周一）
  assert.equal(parseDeadlineText('周一之前', NOW).deadline, at(2026, 3, 16, 23, 59))
})

test('parseDeadlineText：绝对时间与时刻', () => {
  assert.equal(parseDeadlineText('3月15日', NOW).deadline, at(2026, 3, 15, 23, 59))
  assert.equal(parseDeadlineText('18:30', NOW).deadline, at(2026, 3, 10, 18, 30))
  // 已过时刻顺延明天
  assert.equal(parseDeadlineText('09:00', NOW).deadline, at(2026, 3, 11, 9, 0))
})

test('parseDeadlineText：解析不了 → null + confidence 0（无明确 deadline）', () => {
  const r = parseDeadlineText('尽快', NOW)
  assert.equal(r.deadline, null)
  assert.equal(r.confidence, 0)
  assert.equal(parseDeadlineText(null, NOW).deadline, null)
})

// ———————————— 纯函数：句式指纹 / @我 / 确认语义 ————————————

test('patternFingerprint：动词+句长档，稳定且区分', () => {
  const a = patternFingerprint('帮我查一下明天的会议安排')
  const b = patternFingerprint('@小明 帮我查一下上周的报销进度')
  assert.equal(a, b, '同动词同句长档（@ 提及去除后）指纹一致')
  assert.notEqual(a, patternFingerprint('把材料发给老板'), '不同动词指纹不同')
  assert.notEqual(a, patternFingerprint('帮我查一下明天上午十点在会议室三楼的评审会议安排并整理纪要'), '句长档不同')
})

test('selfMention：精确匹配 / 别名命中 / 未配置降级代理信号', () => {
  assert.deepEqual(selfMention('@wxid_self 把报告发我', 'wxid_self', ['小明']), { precise: true, proxy: true })
  assert.deepEqual(selfMention('@小明 把报告发我', 'wxid_self', ['小明']), { precise: true, proxy: true })
  assert.deepEqual(selfMention('@张三 帮忙看看', 'wxid_self', ['小明']), { precise: false, proxy: true })
  // selfWxid 为空 = 精确匹配关闭：只有代理信号
  assert.deepEqual(selfMention('@任何人 你好', '', ['小明']), { precise: false, proxy: true })
  assert.deepEqual(selfMention('没有提及', 'wxid_self', ['小明']), { precise: false, proxy: false })
})

test('isAcceptanceText：好的/收到/我来；长句不算', () => {
  assert.ok(isAcceptanceText('好的'))
  assert.ok(isAcceptanceText('收到，马上弄'))
  assert.ok(isAcceptanceText('我来'))
  assert.ok(!isAcceptanceText('好的，不过我这边还有个别的需求想先跟你对齐一下再说'))
  assert.ok(!isAcceptanceText('好了别说了'))
})

test('resolvePidByName：group_nick / remark / wxid 反查', async () => {
  const { groupStore, cleanup } = makeEnv()
  try {
    await seedIdentities(groupStore)
    const ids = groupStore.getIdentities(CHAT)
    assert.equal(resolvePidByName('老板', ids), 'wxid_boss')
    assert.equal(resolvePidByName('wxid_self', ids), 'wxid_self')
    assert.equal(resolvePidByName('路人', ids), null)
  } finally { cleanup() }
})

test('parseRecognition：非法类别 / 越界序号整体判非法（触发重试）', () => {
  const good = JSON.stringify({ tasks: [{ n: 1, statement: 'x', assigner: '', deadline_text: null, deadline_confidence: 0.5 }], events: [], task_updates: [] })
  assert.ok(parseRecognition(good, 3, 0, 0))
  assert.equal(parseRecognition(JSON.stringify({ tasks: [], events: [{ n: 1, category: 'nonsense', statement: 'x', confidence: 1, supersedes_e: 0 }], task_updates: [] }), 3, 0, 0), null, '非法类别整体非法')
  assert.equal(parseRecognition(JSON.stringify({ tasks: [{ n: 9, statement: 'x' }], events: [], task_updates: [] }), 3, 0, 0), null, '序号越界整体非法')
})

// ———————————— 识别主流程 ————————————

test('识别：@指派 → pending_confirm 入库 + 待确认回调 + outbox 落详情 + deadline 解析', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'm1', senderPid: 'wxid_boss', senderName: '老板', text: '@小明 帮我查一下上周的报销进度，下班前给我' },
    ])
    const llm = mockLlm([JSON.stringify({
      tasks: [{ n: 1, statement: '查上周报销进度并反馈', assigner: '老板', deadline_text: '下班前', deadline_confidence: 0.8 }],
      events: [],
      task_updates: [],
    })])
    const { svc, events } = makeService(env.groupStore, llm, { outbox: env.outbox })
    const res = await svc.scanChat(CHAT, NOW)
    assert.equal(res.ran, true)
    assert.equal(res.tasksInserted, 1)
    const tasks = env.groupStore.getTasks(CHAT)
    assert.equal(tasks.length, 1)
    const t = tasks[0]
    assert.equal(t.status, 'pending_confirm')
    assert.equal(t.assignerPid, 'wxid_boss')
    assert.equal(t.evidenceMsgId, 'm1')
    assert.equal(t.deadline, at(2026, 3, 10, 18, 0), '下班前 → 当日 18:00')
    assert.ok(t.deadlineConfidence > 0)
    assert.equal(t.overdueMarkedAt, 0)
    // 待确认卡片：notify 短句（这里断言回调）+ outbox 详情（零发送）
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'task_pending_confirm')
    const box = env.outbox.tailOutbox(5)
    assert.equal(box.length, 1)
    assert.equal(box[0].channel, 'filehelper')
    assert.equal(box[0].status, 'pending')
    assert.ok(box[0].body.includes('查上周报销进度'))
    // msg_id 不进 prompt（本地序号映射）：数据区只出现 n，不出现 m1
    assert.ok(!llm.calls.prompts[0].includes('m1'))
  } finally { env.cleanup() }
})

test('识别：无明确 deadline → deadline=null 标记', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [{ msgId: 'm1', senderPid: 'wxid_boss', text: '@小明 帮我查一下报销进度' }])
    const llm = mockLlm([JSON.stringify({
      tasks: [{ n: 1, statement: '查报销进度', assigner: '老板', deadline_text: null, deadline_confidence: 0 }],
      events: [], task_updates: [],
    })])
    const { svc } = makeService(env.groupStore, llm)
    await svc.scanChat(CHAT, NOW)
    const t = env.groupStore.getTasks(CHAT)[0]
    assert.equal(t.deadline, null)
    assert.equal(t.deadlineConfidence, 0)
  } finally { env.cleanup() }
})

test('我的确认语义：任务证据后本人「好的」→ 直接 active（免待确认）', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'm1', senderPid: 'wxid_boss', text: '@小明 把周报发我' },
      { msgId: 'm2', senderPid: 'wxid_self', text: '好的', ts: NOW - 30_000 },
    ])
    const llm = mockLlm([JSON.stringify({
      tasks: [{ n: 1, statement: '发周报', assigner: '老板', deadline_text: null, deadline_confidence: 0 }],
      events: [], task_updates: [],
    })])
    const { svc, events } = makeService(env.groupStore, llm)
    await svc.scanChat(CHAT, NOW)
    const t = env.groupStore.getTasks(CHAT)[0]
    assert.equal(t.status, 'active', '确认语义关联为已接受')
    assert.equal(events[0].type, 'task_active')
  } finally { env.cleanup() }
})

test('待确认闭环：confirmTask → active + 登记 learned_pattern', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'm1', senderPid: 'wxid_boss', text: '@小明 帮我查一下报销进度' },
    ])
    const llm = mockLlm([JSON.stringify({
      tasks: [{ n: 1, statement: '查报销进度', assigner: '老板', deadline_text: null, deadline_confidence: 0 }],
      events: [], task_updates: [],
    })])
    const { svc } = makeService(env.groupStore, llm)
    await svc.scanChat(CHAT, NOW)
    const t = env.groupStore.getTasks(CHAT)[0]
    assert.equal(t.status, 'pending_confirm')
    assert.ok(await svc.confirmTask(CHAT, t.taskId))
    const confirmed = env.groupStore.getTask(CHAT, t.taskId)
    assert.equal(confirmed.status, 'active')
    const expected = `wxid_boss:${patternFingerprint('@小明 帮我查一下报销进度')}`
    assert.equal(confirmed.learnedPattern, expected)
    // cancelTask / 状态机：cancel 后不能再 confirm
    assert.ok(await svc.cancelTask(CHAT, t.taskId))
    assert.equal(env.groupStore.getTask(CHAT, t.taskId).status, 'cancelled')
    assert.ok(!(await svc.confirmTask(CHAT, t.taskId)))
  } finally { env.cleanup() }
})

test('模式学习：同 派发人+句式指纹 免确认直接 active；patternLearning=false 恢复待确认', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    // 动态 mock：从 prompt 数据区取**最后一条消息的 n**，对该消息产出识别
    //（模拟生产单实例服务的水位推进：每批扫描只看新消息）。
    const lastN = (prompt) => {
      const m = /"messages":(\[.*?\]),"known_tasks"/s.exec(prompt)
      return JSON.parse(m[1]).at(-1).n
    }
    let statement = ''
    let learning = true
    const llm = mockLlm([(prompt) => JSON.stringify({
      tasks: [{ n: lastN(prompt), statement, assigner: '老板', deadline_text: null, deadline_confidence: 0 }],
      events: [], task_updates: [],
    })])
    const { svc } = makeService(env.groupStore, llm, { patternLearning: learning })

    // 第一批：识别 → 待确认 → 确认（登记 learned_pattern）
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'old1', ts: NOW - 3_600_000, senderPid: 'wxid_boss', text: '@小明 帮我查一下昨天的会议记录' },
    ])
    statement = '查会议记录'
    await svc.scanChat(CHAT, NOW - 3_500_000)
    const first = env.groupStore.getTasks(CHAT)[0]
    assert.equal(first.status, 'pending_confirm')
    assert.ok(await svc.confirmTask(CHAT, first.taskId))
    assert.equal(first.evidenceMsgId, 'old1')

    // 第二批：同句式（同动词"查"+同句长档）→ 免确认
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'new1', ts: NOW, senderPid: 'wxid_boss', text: '@小明 帮我查一下最新的报销额度' },
    ])
    statement = '查报销额度'
    await svc.scanChat(CHAT, NOW + 1)
    const second = env.groupStore.getTasks(CHAT).at(-1)
    assert.equal(second.taskId !== first.taskId, true)
    assert.equal(second.evidenceMsgId, 'new1')
    assert.equal(second.status, 'active', '模式学习免确认')

    // 不同动词句式 → 仍待确认
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'new2', ts: NOW + 60_000, senderPid: 'wxid_boss', text: '@小明 把报价单发给客户' },
    ])
    statement = '发报价单'
    await svc.scanChat(CHAT, NOW + 60_001)
    const third = env.groupStore.getTasks(CHAT).at(-1)
    assert.equal(third.evidenceMsgId, 'new2')
    assert.equal(third.status, 'pending_confirm')

    // patternLearning=false：同句式也不免确认（新环境 + 单实例水位）
    const env2 = makeEnv()
    try {
      await seedIdentities(env2.groupStore)
      await env2.groupStore.appendIdentity(CHAT, { pid: 'wxid_boss', wxid: 'wxid_boss', groupNick: '老板', watchLevel: 'off' })
      await env2.groupStore.appendTask(CHAT, {
        statement: '历史任务', assignerPid: 'wxid_boss', status: 'active',
        learnedPattern: `wxid_boss:${patternFingerprint('@小明 帮我查一下报销进度')}`,
      }, NOW)
      await env2.groupStore.appendMessages(CHAT, [
        { msgId: 'x1', ts: NOW, senderPid: 'wxid_boss', text: '@小明 帮我查一下报销进度' },
      ])
      const llm4 = mockLlm([(prompt) => JSON.stringify({
        tasks: [{ n: lastN(prompt), statement: '查报销进度', assigner: '老板', deadline_text: null, deadline_confidence: 0 }],
        events: [], task_updates: [],
      })])
      const s4 = makeService(env2.groupStore, llm4, { patternLearning: false })
      await s4.svc.scanChat(CHAT, NOW + 1)
      assert.equal(env2.groupStore.getTasks(CHAT).at(-1).status, 'pending_confirm', '学习开关关闭 → 恢复待确认闸门')
    } finally { env2.cleanup() }
  } finally { env.cleanup() }
})

test('事件识别：五类别入库 pending_confirm → confirmEvent → active；手动补记 source=manual', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'm1', senderPid: 'wxid_boss', text: '定下来了：方案B，周五之前报价' },
    ])
    const llm = mockLlm([JSON.stringify({
      tasks: [],
      events: [
        { n: 1, category: 'decision', statement: '团队决定采用方案B', confidence: 0.9, supersedes_e: 0 },
        { n: 1, category: 'deadline', statement: '周五之前提交报价', confidence: 0.8, supersedes_e: 0 },
      ],
      task_updates: [],
    })])
    const { svc } = makeService(env.groupStore, llm)
    const res = await svc.scanChat(CHAT, NOW)
    assert.equal(res.eventsInserted, 2)
    const events = env.groupStore.getEvents(CHAT)
    assert.ok(events.every((e) => e.status === 'pending_confirm'))
    assert.ok(events.every((e) => e.source === 'auto'))
    assert.ok(events.every((e) => e.evidenceMsgId === 'm1'))
    assert.ok(await svc.confirmEvent(CHAT, events[0].eventId))
    assert.equal(env.groupStore.getEvent(CHAT, events[0].eventId).status, 'active')

    // 手动补记：归一 events 库、source='manual'、状态直接 active
    const id = await svc.recordManualEntry(CHAT, '记住：周四要交材料')
    const manual = env.groupStore.getEvent(CHAT, id)
    assert.equal(manual.source, 'manual')
    assert.equal(manual.status, 'active')
    assert.equal(manual.statement, '周四要交材料')
    assert.equal(manual.category, 'deadline')
  } finally { env.cleanup() }
})

test('冲突演变链：新事件推翻旧行（双向指针 + superseded），任务改期更新原行', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [
      { msgId: 'm1', senderPid: 'wxid_boss', text: '定下来了：方案B' },
    ])
    const llm1 = mockLlm([JSON.stringify({
      tasks: [],
      events: [{ n: 1, category: 'decision', statement: '决定用方案B', confidence: 0.9, supersedes_e: 0 }],
      task_updates: [],
    })])
    const s1 = makeService(env.groupStore, llm1)
    await s1.svc.scanChat(CHAT, NOW)
    const old = env.groupStore.getEvents(CHAT)[0]
    await s1.svc.confirmEvent(CHAT, old.eventId)

    // 后续消息推翻：「改到方案C」
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'm2', ts: NOW + 60_000, senderPid: 'wxid_boss', text: '改到方案C' },
    ])
    const llm2 = mockLlm([JSON.stringify({
      tasks: [],
      events: [{ n: 1, category: 'change', statement: '决定改为方案C', confidence: 0.85, supersedes_e: 1 }],
      task_updates: [],
    })])
    const s2 = makeService(env.groupStore, llm2)
    await s2.svc.scanChat(CHAT, NOW + 60_000)
    const fresh = env.groupStore.getEvent(CHAT, old.eventId)
    const events = env.groupStore.getEvents(CHAT)
    const neu = events.find((e) => e.eventId !== old.eventId)
    assert.equal(fresh.status, 'superseded', '旧行标记已更新（不删除）')
    assert.equal(fresh.supersedesEventId, neu.eventId, '旧行 supersedes_event_id 指向新行')
    assert.equal(neu.supersedesEventId, old.eventId, '新行指向旧行（provenance）')

    // 任务侧：deadline 变更更新原行不新建
    await env.groupStore.appendTask(CHAT, { statement: '发周报', assignerPid: 'wxid_boss', status: 'active', deadline: at(2026, 3, 12, 18, 0) }, NOW)
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'm3', ts: NOW + 120_000, senderPid: 'wxid_boss', text: '周报改到周五吧' },
    ])
    const llm3 = mockLlm([JSON.stringify({
      tasks: [], events: [], task_updates: [{ t: 1, new_deadline: '周五' }],
    })])
    const s3 = makeService(env.groupStore, llm3)
    const res = await s3.svc.scanChat(CHAT, NOW + 120_000)
    assert.equal(res.deadlinesUpdated, 1)
    const tasks = env.groupStore.getTasks(CHAT)
    assert.equal(tasks.length, 1, '更新原行，不新建')
    assert.equal(tasks[0].deadline, at(2026, 3, 13, 23, 59))
  } finally { env.cleanup() }
})

test('降级：LLM 两次非法 → degraded、零落库、零回调', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [{ msgId: 'm1', senderPid: 'wxid_boss', text: '@小明 帮我查一下' }])
    const llm = mockLlm(['not json', 'also not json'])
    const { svc, events } = makeService(env.groupStore, llm)
    const res = await svc.scanChat(CHAT, NOW)
    assert.equal(res.ran, true)
    assert.equal(res.degraded, true)
    assert.equal(res.tasksInserted, 0)
    assert.equal(llm.calls.n, 2, '失败重试一次')
    assert.equal(events.length, 0)
    assert.equal(env.groupStore.getTasks(CHAT).length, 0)
  } finally { env.cleanup() }
})

test('enabled=false 零活动；selfWxid 空降级扫描照常（warn 一次）', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await seedMessages(env.groupStore, [{ msgId: 'm1', senderPid: 'wxid_boss', text: '@小明 帮我查一下' }])
    const llm = mockLlm([JSON.stringify({ tasks: [], events: [], task_updates: [] })])
    const off = makeService(env.groupStore, llm, { enabled: false })
    const res = await off.svc.scanChat(CHAT, NOW)
    assert.equal(res.ran, false)
    assert.equal(llm.calls.n, 0, '零 LLM 调用')

    const warns = []
    const svc = new TaskRecognitionService({
      groupStore: env.groupStore, llm,
      logger: { ...silentLogger, warn: (m) => warns.push(m) },
      enabled: true, selfWxid: '', now: () => NOW,
    })
    await svc.scanChat(CHAT, NOW)
    assert.equal(llm.calls.n, 1)
    assert.equal(warns.filter((w) => w.includes('selfWxid')).length, 1, '降级 warn 恰好一次')
  } finally { env.cleanup() }
})

// ———————————— 日报「今日行动」接真数据源 ————————————

test('日报 L1「今日行动」：待确认清单 + 当日到期任务进报告（真数据源）', async () => {
  const env = makeEnv()
  try {
    await seedIdentities(env.groupStore)
    await env.groupStore.appendTask(CHAT, { statement: '查报销进度（待确认）', assignerPid: 'wxid_boss', status: 'pending_confirm' }, NOW)
    await env.groupStore.appendTask(CHAT, { statement: '发周报', assignerPid: 'wxid_boss', status: 'active', deadline: NOW + 3_600_000 }, NOW)
    await seedMessages(env.groupStore, [
      { msgId: 'a', senderPid: 'wxid_boss', text: '消息一' },
      { msgId: 'b', senderPid: 'wxid_self', text: '消息二' },
      { msgId: 'c', senderPid: 'wxid_boss', text: '消息三' },
    ])
    const llm = mockLlm([JSON.stringify({
      title: '日报', lead: '导语',
      judgments: [{ text: '判断一', evidence: [1] }, { text: '判断二', evidence: [2] }, { text: '判断三', evidence: [3] }],
      topics: [], quotes: [1, 2, 3],
    })])
    const report = new ReportService({
      groupStore: env.groupStore, store: env.store, stateDir: env.base, llm,
      logger: silentLogger, enabled: true, groups: [CHAT], now: () => NOW,
    })
    const res = await report.generateReport(CHAT, 'daily', NOW)
    assert.equal(res.status, 'ok')
    const md = env.store.readText(res.path)
    assert.ok(md.includes('（待确认）查报销进度（待确认）'), '待确认清单进今日行动')
    assert.ok(md.includes('发周报'), '当日到期任务进今日行动')
    assert.ok(!md.includes('M4 任务与承诺识别接入后回填'), '占位行已被真数据源替换')
  } finally { env.cleanup() }
})

// ———————————— v3 迁移（含惰性表兼容场景） ————————————

test('v3 迁移：全新库 → version 3 + reminder_log 可用', async () => {
  const env = makeEnv()
  try {
    const st = env.groupStore.open(CHAT)
    assert.equal(st.schemaVersion, 3)
    assert.ok(await env.groupStore.appendReminderLog(CHAT, 1, 'due-1d', NOW))
    assert.ok(!(await env.groupStore.appendReminderLog(CHAT, 1, 'due-1d', NOW)), '主键去重')
    assert.ok(await env.groupStore.appendReminderLog(CHAT, 1, 'overdue', NOW))
  } finally { env.cleanup() }
})

test('v3 迁移兼容：v2 时代惰性 report_meta 已存在 → 不重建、数据保留、仅登记版本', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'task-rec-mig-')))
  try {
    const dbPath = join(base, 'groups', CHAT, 'store.db')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(base, 'groups', CHAT), { recursive: true })
    // 模拟 v2 时代：惰性建表（M3 行为）+ user_version=2，且已有一行历史元数据
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      PRAGMA user_version = 2;
      CREATE TABLE report_meta (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT NOT NULL, date TEXT NOT NULL,
        window_start  INTEGER NOT NULL, window_end INTEGER NOT NULL,
        status        TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
        judgment_count INTEGER NOT NULL DEFAULT 0, topic_count INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0, generated_at INTEGER NOT NULL
      );
    `)
    raw.prepare(`INSERT INTO report_meta (kind, date, window_start, window_end, status, path, generated_at)
                 VALUES ('daily', '2026-03-09', 0, 1, 'ok', 'reports/x/2026-03-09.md', 1)`).run()
    raw.close()

    const groupStore = new GroupStoreService(base, silentLogger)
    const st = groupStore.open(CHAT)
    assert.equal(st.schemaVersion, 3, '迁移推进到 v3')
    const metas = groupStore.getReportMetas(CHAT)
    assert.equal(metas.length, 1, '惰性表历史行完好（未被重建清空）')
    assert.equal(metas[0].date, '2026-03-09')
    // v3 新能力可用
    assert.ok(await groupStore.appendTask(CHAT, { statement: 's', status: 'active' }, NOW))
    assert.equal(groupStore.getTask(CHAT, 1).createdAt, NOW, 'tasks.created_at 列就位')
    groupStore.dispose()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
