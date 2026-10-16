// report-batching.test.mjs —— 大窗口分批归纳+合并（2026-10-15 热修：181 条单次调用 Request timed out）。
// 覆盖：181 条 → 2 批 + 合并（全局序号跨批可映射）；单批失败降级标注（不整体降级）；
//       小窗口路径零变化（1 次调用）；全部批次失败 → 整体 degraded 原因可见化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService, BATCH_THRESHOLD_DEFAULT } = await import('../lib/report.js')
const { PersonDigestService, BATCH_THRESHOLD_DEFAULT: PD_THRESHOLD } = await import('../lib/person-digest.js')

const CHAT = '888@chatroom'
const BASE = new Date(2026, 5, 10).getTime()
const T = (h, m = 0) => BASE + h * 3600_000 + m * 60_000

function mockLlm(script) {
  const calls = []
  return {
    calls,
    async complete(prompt) {
      calls.push(prompt)
      const next = script.shift()
      if (typeof next === 'function') return next(prompt)
      if (next instanceof Error) throw next
      return next ?? '{}'
    },
  }
}

function legalDraft(evidence = [1]) {
  return JSON.stringify({
    title: '排期敲定',
    lead: 'UI 稿今天定稿。',
    judgments: [
      { text: 'UI 稿交付时间已提前到周二。', evidence },
      { text: '后端接口联调定在周四进行。', evidence },
      { text: 'Bob 承诺下午给出测试环境。', evidence },
    ],
    topics: [{ title: '排期', change: '提前一天', status: '', people: '', watch: '', evidence }],
    quotes: evidence,
  })
}

function makeEnv(script, extra = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-batch-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = mockLlm(script)
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} },
    enabled: true,
    ...extra,
  })
  return { dir, gs, store, llm, report }
}

function seedMany(gs, n) {
  const msgs = []
  for (let i = 0; i < n; i++) {
    msgs.push({ msgId: `m${i + 1}`, ts: T(8) + i * 60_000, senderPid: `wxid_${i % 5}`, senderName: `成员${i % 5}`, text: `消息内容 ${i + 1}` })
  }
  return gs.appendMessages(CHAT, msgs).then(() => msgs)
}

test('默认阈值常量 = 120（181 > 120 触发分批）', () => {
  assert.equal(BATCH_THRESHOLD_DEFAULT, 120)
  assert.equal(PD_THRESHOLD, 120)
})

test('181 条 → 2 批 + 合并（共 3 次调用）；批 2 全局序号从 121 起；evidence 映射回全窗口 msg_id', async () => {
  const { dir, gs, llm, report } = makeEnv([
    (prompt) => legalDraft([1]), // 批 1（全局序号 1–120）
    (prompt) => {
      // 批 2 的 evidence 必须用全局序号（121–181 才合法）
      assert.ok(prompt.includes('"n":121'), '批 2 序号从 121 起')
      assert.ok(!prompt.includes('"n":1,'), '批 2 不含批 1 消息')
      return legalDraft([121])
    },
    (prompt) => {
      assert.ok(prompt.includes('"batches"'), '合并调用输入=各批摘要')
      assert.ok(prompt.includes('"message_count":181'))
      // 合并稿 evidence 用批 2 的全局序号 121 → 应映射 m121
      return legalDraft([121])
    },
  ])
  await seedMany(gs, 181)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 3)
  assert.equal(res.messageCount, 181)
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /\[evidence: m121\]/, '合并稿全局序号映射回批 2 的 msg_id')
  assert.ok(!md.includes('部分素材归纳失败'), '全部批次成功无标注')
  rmSync(dir, { recursive: true, force: true })
})

test('单批失败（非 timeout，重试一次仍失败）→ 部分素材标注，其余照常归纳，不整体降级', async () => {
  const { dir, gs, llm, report } = makeEnv([
    new Error('connection reset by peer'), // 非 timeout：保持"重试一次"原路径
    new Error('connection reset by peer'), // 批 1 重试仍失败
    legalDraft([121]), // 批 2 成功
    legalDraft([121]), // 合并成功
  ])
  await seedMany(gs, 181)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok', '部分批次失败不整体降级')
  assert.equal(llm.calls.length, 4, '批 1 两次 + 批 2 一次 + 合并一次')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /部分素材归纳失败：第 1 批/)
  rmSync(dir, { recursive: true, force: true })
})

test('小窗口（≤阈值）路径零变化：仍单次调用', async () => {
  const { dir, gs, llm, report } = makeEnv([legalDraft([1])], { batchThreshold: 50 })
  await seedMany(gs, 10)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('全部批次失败 → 整体 degraded 且原因可见化', async () => {
  const { dir, gs, llm, report } = makeEnv([
    new Error('boom'), new Error('boom'),
    new Error('boom'), new Error('boom'),
  ])
  await seedMany(gs, 181)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  assert.equal(llm.calls.length, 4)
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /分批归纳全部批次失败/)
  rmSync(dir, { recursive: true, force: true })
})

// —— person-digest 同构分批 ——

const PD_CHAT = '777@chatroom'
const WXID = 'wxid_boss001'

test('person-digest 大窗口分批：>阈值 → 批+合并调用，evidence 全局序号映射回 msg_id', async () => {
  const { GroupStoreService: GSS } = await import('../lib/group-store.js')
  const { PersonDigestService, localDayKey } = await import('../lib/person-digest.js')
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-batch-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = new GSS(dir, { warn() {}, error() {} })
  const dayBase = new Date(2026, 5, 10, 9).getTime()
  const msgs = []
  for (let i = 0; i < 25; i++) {
    const mine = i % 2 === 0
    msgs.push({
      msgId: `pm${i + 1}`,
      ts: dayBase + i * 60_000,
      senderPid: mine ? WXID : `wxid_${i}`,
      senderName: mine ? '老板' : `成员${i}`,
      text: `讨论点 ${i + 1}`,
    })
  }
  await gs.appendMessages(PD_CHAT, msgs)
  const day = localDayKey(dayBase)
  const calls = []
  const llm = {
    calls,
    async complete(prompt) {
      calls.push(prompt)
      const legal = (ev) => JSON.stringify({ person_pid: WXID, date: day, topics: [{ title: '排期', summary: '在催交付', evidence: ev }], mood_or_stance: '急', open_questions: [] })
      if (calls.length === 2) {
        assert.ok(prompt.includes('"n":11'), '批 2 全局序号从 11 起')
        return legal([11])
      }
      if (calls.length === 4) {
        assert.ok(prompt.includes('"batches"'), '合并调用输入=各批素材')
        return legal([11])
      }
      return legal([1])
    },
  }
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true, batchThreshold: 10 })
  const res = await svc.generateDaily(PD_CHAT, WXID, day)
  assert.equal(res.status, 'ok')
  assert.equal(calls.length, 4, '3 批（25/10）+ 合并')
  const rows = gs.getPersonDigests(PD_CHAT, WXID, day)
  assert.deepEqual(rows[0].evidenceMsgIds, ['pm11'], '全局序号 11 → pm11')
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

// —— 日报窗口锚定调度（前日 20:20 → 触发时刻）——

const WBASE = new Date(2026, 9, 16).getTime() // 2026-10-16（触发日）
const W = (d, h, m = 0) => WBASE + d * 86_400_000 + h * 3600_000 + m * 60_000

test('窗口边界保险：前日 20:29 的消息在今昨两份日报中都命中（刻意重叠）', async () => {
  const { reportWindow } = await import('../lib/report.js')
  // 今日报告（触发 Oct 16 20:30）：窗口 [Oct 15 20:20, Oct 16 20:30]
  const today = reportWindow('daily', W(0, 20, 30))
  assert.equal(today.start, W(-1, 20, 20))
  assert.equal(today.end, W(0, 20, 30))
  // 昨日报告（触发 Oct 15 20:30）：窗口 [Oct 14 20:20, Oct 15 20:30]
  const yesterday = reportWindow('daily', W(-1, 20, 30))
  assert.equal(yesterday.start, W(-2, 20, 20))
  assert.equal(yesterday.end, W(-1, 20, 30))
  // 边界消息：前日 20:29（在 20:30 发送前一分钟发出）
  const boundary = W(-1, 20, 29)
  assert.ok(boundary >= today.start && boundary <= today.end, '今日报告含前日 20:29 消息')
  assert.ok(boundary >= yesterday.start && boundary <= yesterday.end, '昨日报告也含（重叠保险，属预期）')
})

test('窗口边界：前日 20:19 的消息不进今日日报（余量 10 分钟之外）', async () => {
  const { reportWindow } = await import('../lib/report.js')
  const today = reportWindow('daily', W(0, 20, 30))
  const early = W(-1, 20, 19)
  assert.ok(early < today.start, '20:19 早于窗口起点，归昨日之前的语义（不重复捕捞）')
})
