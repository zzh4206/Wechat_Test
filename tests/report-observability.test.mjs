// report-observability.test.mjs —— T3：LLM 调用结构化观测 + batch_stats + degraded 告警。
// 覆盖任务卡验收：
// ① 三次 LLM 调用（2 批+合并）后 JSONL 恰好 3 行、字段齐全、durMs 为正、ok/errKind 正确（含失败用例）；
// ② 报告文本末尾含 batch_stats 行且数字正确（含失败批场景）；单次调用路径显示 1 批；
// ③ 群 A 连续 2 次 degraded 触发恰好 1 次 notify；群 B 1 次 degraded 不触发；成功后计数清零；
// ④ distiller 路径也落 llm_call（phase='distill'）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService } = await import('../lib/report.js')
const { Distiller } = await import('../lib/distiller.js')
const { PersonaService } = await import('../lib/persona.js')
const { BufferPool } = await import('../lib/buffer.js')
const { LlmCallRecorder, llmCallRelPath } = await import('../lib/llm-observe.js')

const CHAT = '888@chatroom'
const CHAT_B = '999@chatroom'
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
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-obs-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = mockLlm(script)
  const notified = []
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} },
    enabled: true,
    notifier: { async notify(kind, title, body) { notified.push({ kind, title, body }) } },
    ...extra,
  })
  return { dir, gs, store, llm, report, notified }
}

async function seedMany(gs, chatId, n) {
  const msgs = []
  for (let i = 0; i < n; i++) {
    msgs.push({ msgId: `m${i + 1}`, ts: T(8) + i * 60_000, senderPid: `wxid_${i % 5}`, senderName: `成员${i % 5}`, text: `消息内容 ${i + 1}` })
  }
  await gs.appendMessages(chatId, msgs)
  return msgs
}

/** 读 llm_call JSONL 并逐行解析 */
function readLlmCalls(dir, chatId) {
  const rel = llmCallRelPath(chatId)
  const raw = readFileSync(join(dir, rel), 'utf8')
  return raw.trim().split('\n').map((l) => JSON.parse(l))
}

// —————————————— ① llm_call JSONL：字段齐全、ok/errKind 正确 ——————————————

test('① 2 批+合并共 3 次调用 → JSONL 恰好 3 行、字段齐全、durMs 正数、全部 ok', async () => {
  const { dir, gs, report } = makeEnv([
    (p) => legalDraft([1]),
    (p) => legalDraft([121]),
    (p) => legalDraft([121]), // 合并
  ])
  await seedMany(gs, CHAT, 181)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  const entries = readLlmCalls(dir, CHAT)
  assert.equal(entries.length, 3, '恰好 3 行：批 1 + 批 2 + 合并')
  const fields = ['ev', 'chat', 'kind', 'phase', 'batch', 'msgs', 'promptChars', 'durMs', 'ok', 'errKind', 'ts']
  entries.forEach((e, i) => {
    fields.forEach((f) => assert.ok(f in e, `第 ${i + 1} 行缺字段 ${f}`))
    assert.equal(e.ev, 'llm_call')
    assert.equal(e.chat, CHAT)
    assert.equal(e.kind, 'daily')
    assert.ok(e.durMs > 0, 'durMs 为正数（下限 1ms）')
    assert.ok(e.promptChars > 0)
    assert.ok(e.ts > 0)
  })
  assert.deepEqual(
    entries.map((e) => [e.phase, e.batch, e.ok, e.errKind]),
    [['map', 1, true, ''], ['map', 2, true, ''], ['merge', 0, true, '']],
  )
  assert.deepEqual(entries.map((e) => e.msgs), [120, 61, 181])
  rmSync(dir, { recursive: true, force: true })
})

test('①-失败用例：批 1 两次非 timeout 失败 → 前 2 行 ok=false / errKind=other，重试也各落一行', async () => {
  const { dir, gs, report } = makeEnv([
    new Error('connection reset by peer'),
    new Error('connection reset by peer'),
    (p) => legalDraft([121]),
    (p) => legalDraft([121]),
  ])
  await seedMany(gs, CHAT, 181)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok', '部分批次失败不整体降级')
  const entries = readLlmCalls(dir, CHAT)
  assert.equal(entries.length, 4, '批 1 两次 + 批 2 + 合并')
  assert.equal(entries[0].ok, false)
  assert.equal(entries[0].errKind, 'other')
  assert.equal(entries[1].ok, false)
  assert.equal(entries[1].errKind, 'other')
  assert.equal(entries[2].ok, true)
  assert.equal(entries[3].phase, 'merge')
  rmSync(dir, { recursive: true, force: true })
})

test('①-失败用例：timeout 类错误 errKind=timeout', async () => {
  // 单次调用路径（batchThreshold 构造下限 10，6 条走小窗口）：两次尝试均 timeout → degraded；
  // 每次尝试各落一行，errKind 均为 timeout
  const TIMEOUT = new Error('llm stream finished with error: Request timed out.')
  const { dir, gs, report } = makeEnv([TIMEOUT, TIMEOUT], { batchThreshold: 5, sleep: () => Promise.resolve() })
  await seedMany(gs, CHAT, 6)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  const entries = readLlmCalls(dir, CHAT)
  assert.equal(entries.length, 2, '两次尝试各落一行')
  assert.ok(entries.every((e) => e.ok === false && e.errKind === 'timeout'), '全部行 errKind=timeout')
  rmSync(dir, { recursive: true, force: true })
})

// —————————————— ② batch_stats 行：报告末尾、数字正确 ——————————————

test('② 2 批（1 失败）+ 合并 → 报告末尾统计行：批 2（失败 1）· 调用 4 次', async () => {
  const { dir, gs, report } = makeEnv([
    new Error('connection reset by peer'),
    new Error('connection reset by peer'),
    (p) => legalDraft([121]),
    (p) => legalDraft([121]),
  ])
  await seedMany(gs, CHAT, 181)
  await report.generateReport(CHAT, 'daily', T(20, 30))
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  const lines = md.trimEnd().split('\n')
  const statLine = lines.find((l) => l.startsWith('> 统计：批 '))
  assert.ok(statLine, '报告含 batch_stats 行')
  assert.equal(lines[lines.length - 1], statLine, '统计行在报告末尾')
  // T9：统计行追加成本段（mock LLM 无 modelId → 'unknown'，未命中默认价格表 → 费用 0；token 为估算带 ~）
  assert.match(statLine, /^> 统计：批 2（失败 1）· 最大批耗时 \d+(\.\d+)? s · 缓存命中 0 · LLM 调用 4 次 \/ \d+(\.\d+)? s · 模型 unknown · 输入 ~[\d.]+k? \/ 输出 ~[\d.]+k? tok · ≈¥0\.0000$/)
  rmSync(dir, { recursive: true, force: true })
})

test('②-全成功：批 2（失败 0）· 调用 3 次；单次调用路径显示 1 批；degraded 也有合理输出', async () => {
  // 分批全成功
  {
    const { dir, gs, report } = makeEnv([(p) => legalDraft([1]), (p) => legalDraft([121]), (p) => legalDraft([121])])
    await seedMany(gs, CHAT, 181)
    await report.generateReport(CHAT, 'daily', T(20, 30))
    const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
    assert.match(md, /批 2（失败 0）· 最大批耗时 \d+(\.\d+)? s · 缓存命中 0 · LLM 调用 3 次/)
    rmSync(dir, { recursive: true, force: true })
  }
  // 小窗口单次调用路径 = 1 批
  {
    const { dir, gs, report } = makeEnv([(p) => legalDraft([1])], { batchThreshold: 50 })
    await seedMany(gs, CHAT, 10)
    await report.generateReport(CHAT, 'daily', T(20, 30))
    const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
    assert.match(md, /批 1（失败 0）· 最大批耗时 \d+(\.\d+)? s · 缓存命中 0 · LLM 调用 1 次/)
    rmSync(dir, { recursive: true, force: true })
  }
  // degraded（单次调用路径两次异常）= 1 批失败 1
  {
    const { dir, gs, report } = makeEnv([new Error('boom'), new Error('boom')], { batchThreshold: 50 })
    await seedMany(gs, CHAT, 10)
    const res = await report.generateReport(CHAT, 'daily', T(20, 30))
    assert.equal(res.status, 'degraded')
    const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
    assert.match(md, /批 1（失败 1）· 最大批耗时 \d+(\.\d+)? s · 缓存命中 0 · LLM 调用 2 次/)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('②-meta 落库：batch_stats 进 report_meta（向后兼容，新字段不删旧字段）', async () => {
  const { dir, gs, report } = makeEnv([(p) => legalDraft([1]), (p) => legalDraft([121]), (p) => legalDraft([121])])
  await seedMany(gs, CHAT, 181)
  await report.generateReport(CHAT, 'daily', T(20, 30))
  const metas = gs.getReportMetas(CHAT, { kind: 'daily', limit: 5 })
  assert.equal(metas.length, 1)
  const bs = metas[0].batchStats
  assert.ok(bs, 'meta 含 batchStats')
  assert.equal(bs.batches, 2)
  assert.equal(bs.failedBatches, 0)
  assert.equal(bs.totalCalls, 3)
  assert.ok(bs.totalMs > 0)
  assert.ok(bs.maxBatchMs > 0)
  // 旧字段仍在
  assert.equal(metas[0].status, 'ok')
  assert.equal(metas[0].messageCount, 181)
  assert.ok(typeof metas[0].note === 'string')
  rmSync(dir, { recursive: true, force: true })
})

test('②-检查点命中计入缓存命中', async () => {
  const { dir, gs, store, notified } = makeEnv([(p) => legalDraft([1]), (p) => legalDraft([121]), (p) => legalDraft([121])])
  await seedMany(gs, CHAT, 181)
  // 复用同一 env：第二次生成批 1/批 2 命中检查点，仅合并调用
  await report1()
  async function report1() {
    const svc = new ReportService({
      groupStore: gs, store, stateDir: dir,
      llm: mockLlm([(p) => legalDraft([1]), (p) => legalDraft([121]), (p) => legalDraft([121])]),
      logger: { warn() {}, error() {} }, enabled: true, notifier: { async notify() {} },
    })
    await svc.generateReport(CHAT, 'daily', T(20, 30))
  }
  const svc2 = new ReportService({
    groupStore: gs, store, stateDir: dir,
    llm: mockLlm([(p) => legalDraft([121])]),
    logger: { warn() {}, error() {} }, enabled: true, notifier: { async notify() {} },
  })
  await svc2.generateReport(CHAT, 'daily', T(20, 30))
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /缓存命中 2 · LLM 调用 1 次/, '第二次生成：2 批检查点命中 + 仅合并 1 次调用')
  assert.equal(notified.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

// —————————————— ③ 连续 2 窗口 degraded → 恰好 1 次 notify ——————————————

test('③ 群 A 连续 2 次 degraded → 恰好 1 次 notify；第 3 次不重复；群 B 1 次不触发；成功清零', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-alert-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const notified = []
  const mk = (script, chatId) => {
    const svc = new ReportService({
      groupStore: gs, store, stateDir: dir, llm: mockLlm(script),
      logger: { warn() {}, error() {} }, enabled: true, batchThreshold: 50,
      notifier: { async notify(kind, title, body) { notified.push({ chatId, kind, title, body }) } },
    })
    return svc
  }
  await seedMany(gs, CHAT, 10)
  await seedMany(gs, CHAT_B, 10)
  const boom = () => [new Error('boom'), new Error('boom')]

  // 群 A 第 1 次 degraded：不告警
  let res = await mk(boom(), CHAT).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  assert.equal(notified.length, 0, '第 1 个 degraded 窗口不告警')

  // 群 B 1 次 degraded：不告警（按群分别记，不互相污染）
  res = await mk(boom(), CHAT_B).generateReport(CHAT_B, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  assert.equal(notified.length, 0)

  // 群 A 第 2 个连续 degraded 窗口：恰好 1 次 notify
  res = await mk(boom(), CHAT).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  assert.equal(notified.length, 1, '连续 2 个 degraded 窗口 → 1 次 notify')
  assert.equal(notified[0].chatId, CHAT)
  assert.equal(notified[0].kind, 'report-degraded')

  // 群 A 第 3 个连续 degraded 窗口：不重复告警
  res = await mk(boom(), CHAT).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  assert.equal(notified.length, 1, '第 3 个窗口不重复告警')

  // 群 A 成功 → 计数清零（再 degraded 只回 1，不触发）
  res = await mk([legalDraft([1])], CHAT).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  assert.equal(notified.length, 1)
  res = await mk(boom(), CHAT).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  assert.equal(notified.length, 1, '清零后单次 degraded 不触发')

  // 连续状态持久化在 ckpt 同级状态文件
  assert.ok(existsSync(join(dir, 'reports', CHAT, 'alert-state.json')), '告警状态文件落盘（ckpt.json 同级）')
  const state = JSON.parse(readFileSync(join(dir, 'reports', CHAT, 'alert-state.json'), 'utf8'))
  assert.equal(state.daily, 1, '成功清零后当前 streak=1')
  rmSync(dir, { recursive: true, force: true })
})

test('③-按 kind 分别记：daily 连续 2 次 degraded 告警不影响 weekly 计数', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-alert-k-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const notified = []
  const mk = (script) => new ReportService({
    groupStore: gs, store, stateDir: dir, llm: mockLlm(script),
    logger: { warn() {}, error() {} }, enabled: true, batchThreshold: 50,
    notifier: { async notify() { notified.push(1) } },
  })
  await seedMany(gs, CHAT, 10)
  const boom = () => [new Error('boom'), new Error('boom')]
  await mk(boom()).generateReport(CHAT, 'daily', T(20, 30))
  await mk(boom()).generateReport(CHAT, 'weekly', T(20, 30))
  await mk(boom()).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(notified.length, 1, '仅 daily 达到连续 2 次')
  await mk(boom()).generateReport(CHAT, 'weekly', T(20, 30))
  assert.equal(notified.length, 2, 'weekly 连续 2 次也各自告警')
  const state = JSON.parse(readFileSync(join(dir, 'reports', CHAT, 'alert-state.json'), 'utf8'))
  assert.equal(state.daily, 2)
  assert.equal(state.weekly, 2)
  rmSync(dir, { recursive: true, force: true })
})

// —————————————— ④ distiller 路径也落 llm_call ——————————————

test('④ distiller 注入记录器 → JSONL 落一行 phase=distill，缺省注入零观测', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'distill-obs-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const recorder = new LlmCallRecorder(store)
  const buffer = new BufferPool({ bufferSize: 100 })
  buffer.push(CHAT, { ts: 1, sender: 'wxid_a', text: JSON.stringify('你好') })
  const personas = new PersonaService({ stateDir: join(dir, 'p'), logger: { warn() {}, error() {} } })
  const distiller = new Distiller({
    buffer,
    llm: { async complete() { return '[]' } },
    personas,
    groupPersonas: {},
    logger: { warn() {}, error() {} },
    distillEveryMessages: 999,
    distillIntervalMin: 999,
    onInsights: () => {},
    llmCallRecorder: recorder,
  })
  const ok = await distiller.tryDistill(CHAT, 'manual')
  assert.equal(ok, true)
  const entries = readLlmCalls(dir, CHAT)
  assert.equal(entries.length, 1)
  const e = entries[0]
  assert.equal(e.ev, 'llm_call')
  assert.equal(e.chat, CHAT)
  assert.equal(e.kind, 'distill')
  assert.equal(e.phase, 'distill')
  assert.equal(e.batch, 1)
  assert.equal(e.msgs, 1)
  assert.equal(e.ok, true)
  assert.equal(e.errKind, '')
  assert.ok(e.durMs > 0)
  assert.ok(e.promptChars > 0)
  distiller.dispose()
  rmSync(dir, { recursive: true, force: true })
})
