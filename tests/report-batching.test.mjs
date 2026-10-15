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

test('单批失败（重试一次仍失败）→ 部分素材标注，其余照常归纳，不整体降级', async () => {
  const { dir, gs, llm, report } = makeEnv([
    new Error('Request timed out'),
    new Error('Request timed out'), // 批 1 重试仍失败
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
