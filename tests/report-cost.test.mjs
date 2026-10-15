// report-cost.test.mjs —— T9：LLM 成本透明化（模型 / token / 费用）。
// 覆盖任务卡验收：
// ① 估算路径：promptChars=16000 → inTokens=10000；费用 = 10000/1M×8 + outTokens/1M×28 精确断言；
// ② 价格表命中 flash 模型用 0.8/2.8；
// ③ 未知模型费用 0 + warn 恰好一次；
// ④ 报告尾含「模型 glm-5.3 · 输入 ~… / 输出 ~… tok · ≈¥…」且 JSONL 每行含 model/inTokens/outTokens/costCny/tokensEst；
// ⑤ meta.batch_stats 往返含成本字段；
// ⑥ 真实 usage 探测分支：fn 返回带 usage 的对象 → tokensEst=false、统计行去 ~。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService } = await import('../lib/report.js')
const {
  LlmCallRecorder,
  llmCallRelPath,
  estimateTokens,
  computeCostCny,
  DEFAULT_LLM_PRICING,
  renderBatchStatsLine,
} = await import('../lib/llm-observe.js')

const CHAT = '777@chatroom'
const BASE = new Date(2026, 9, 16).getTime()
const T = (h) => BASE + h * 3600_000

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

function readLlmCalls(dir, chatId) {
  const raw = readFileSync(join(dir, llmCallRelPath(chatId)), 'utf8')
  return raw.trim().split('\n').map((l) => JSON.parse(l))
}

// —————————————— ① 估算路径：换算口径与费用精确值 ——————————————

test('① 估算：promptChars=16000 → inTokens=10000；费用 = 10000/1M×8 + 2000/1M×28 = 0.136（精确）', async () => {
  // 纯函数层
  assert.equal(estimateTokens(16000), 10000, '16000 字符 / 1.6 = 10000 tokens')
  assert.equal(estimateTokens(0), 0)
  const outTokens = estimateTokens(3200) // 3200 字符 → 2000 tokens
  assert.equal(outTokens, 2000)
  assert.equal(computeCostCny('glm-5.3', 10000, 2000, DEFAULT_LLM_PRICING), 0.136)

  // 集成层：Recorder 落行
  const dir = resolve(mkdtempSync(join(tmpdir(), 'cost-est-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const warns = []
  const rec = new LlmCallRecorder(store, undefined, {
    model: 'glm-5.3',
    logger: { warn: (m) => warns.push(m) },
  })
  const prompt = 'A'.repeat(16000)
  const raw = await rec.call(CHAT, 'daily', 'map', 1, 10, prompt, async () => 'B'.repeat(3200))
  assert.equal(raw.length, 3200)
  const entries = readLlmCalls(dir, CHAT)
  assert.equal(entries.length, 1)
  const e = entries[0]
  assert.equal(e.model, 'glm-5.3')
  assert.equal(e.inTokens, 10000)
  assert.equal(e.outTokens, 2000)
  assert.equal(e.costCny, 0.136)
  assert.equal(e.tokensEst, true, '无真实 usage → 估算标记')
  assert.equal(warns.length, 0, 'glm-5.3 在默认价格表内，不 warn')
  // 累计统计
  const st = rec.getStats()
  assert.equal(st.inTokens, 10000)
  assert.equal(st.outTokens, 2000)
  assert.equal(st.costCny, 0.136)
  assert.equal(st.tokensEst, true)
  rmSync(dir, { recursive: true, force: true })
})

// —————————————— ② flash 价格表命中 ——————————————

test('② flash 模型命中 0.8/2.8：10000 入 + 2000 出 = 0.008 + 0.0056 = 0.0136', async () => {
  assert.equal(computeCostCny('glm-5.3-flash', 10000, 2000, DEFAULT_LLM_PRICING), 0.0136)
  const dir = resolve(mkdtempSync(join(tmpdir(), 'cost-flash-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const rec = new LlmCallRecorder(store, undefined, { model: 'glm-5.3-flash', logger: { warn() {} } })
  await rec.call(CHAT, 'daily', 'map', 1, 10, 'A'.repeat(16000), async () => 'B'.repeat(3200))
  const e = readLlmCalls(dir, CHAT)[0]
  assert.equal(e.model, 'glm-5.3-flash')
  assert.equal(e.costCny, 0.0136)
  rmSync(dir, { recursive: true, force: true })
})

// —————————————— ③ 未知模型：费用 0 + warn 一次 ——————————————

test('③ 未知模型：costCny=0 且"未配置价格"只 warn 一次（两次调用）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'cost-unknown-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const warns = []
  const rec = new LlmCallRecorder(store, undefined, { model: 'glm-9.9-pro', logger: { warn: (m) => warns.push(m) } })
  await rec.call(CHAT, 'daily', 'map', 1, 10, 'A'.repeat(160), async () => 'B'.repeat(32))
  await rec.call(CHAT, 'daily', 'map', 2, 10, 'A'.repeat(160), async () => 'B'.repeat(32))
  const entries = readLlmCalls(dir, CHAT)
  assert.equal(entries.length, 2)
  assert.ok(entries.every((e) => e.costCny === 0), '未知模型费用记 0')
  assert.ok(entries.every((e) => e.inTokens > 0 && e.outTokens > 0), 'token 照常估算记录')
  assert.equal(warns.filter((w) => w.includes('未配置价格')).length, 1, '恰好 warn 一次')
  rmSync(dir, { recursive: true, force: true })
})

// —————————————— ④ 报告尾成本行 + JSONL 字段齐全 ——————————————

test('④ 报告尾含「模型 glm-5.3 · 输入 ~… / 输出 ~… tok · ≈¥…」；JSONL 每行含成本五字段', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'cost-report-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = {
    async complete() { return legalDraft([1]) },
    modelId() { return 'glm-5.3' },
  }
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} },
    enabled: true,
    batchThreshold: 50,
  })
  const msgs = []
  for (let i = 0; i < 10; i++) {
    msgs.push({ msgId: `m${i + 1}`, ts: T(8) + i * 60_000, senderPid: 'wxid_a', senderName: '成员A', text: `消息内容 ${i + 1}` })
  }
  await gs.appendMessages(CHAT, msgs)
  const res = await report.generateReport(CHAT, 'daily', T(20))
  assert.equal(res.status, 'ok')

  const md = readFileSync(join(dir, 'reports', CHAT, '2026-10-16.md'), 'utf8')
  const statLine = md.trimEnd().split('\n').find((l) => l.startsWith('> 统计：批 '))
  assert.ok(statLine, '报告尾统计行存在')
  assert.match(statLine, /模型 glm-5\.3 · 输入 ~\d+(\.\d+)?k? \/ 输出 ~\d+(\.\d+)?k? tok · ≈¥\d+\.\d{4}/)
  assert.ok(!statLine.includes('模型 unknown'), '模型名来自 LlmClient.modelId()')

  const entries = readLlmCalls(dir, CHAT)
  assert.ok(entries.length >= 1)
  for (const f of ['model', 'inTokens', 'outTokens', 'costCny', 'tokensEst']) {
    assert.ok(f in entries[0], `JSONL 行缺字段 ${f}`)
  }
  assert.equal(entries[0].model, 'glm-5.3')
  assert.equal(entries[0].tokensEst, true)
  assert.ok(entries[0].costCny > 0, 'glm-5.3 在默认价格表 → 费用非 0')

  // ⑤ meta.batch_stats 往返含成本字段
  const metas = gs.getReportMetas(CHAT, { kind: 'daily', limit: 5 })
  assert.equal(metas.length, 1)
  const bs = metas[0].batchStats
  assert.ok(bs, 'meta 含 batchStats')
  assert.equal(bs.model, 'glm-5.3')
  assert.equal(bs.inTokens, entries[0].inTokens)
  assert.equal(bs.outTokens, entries[0].outTokens)
  assert.equal(bs.costCny, entries[0].costCny)
  assert.equal(bs.tokensEst, true)
  rmSync(dir, { recursive: true, force: true })
})

// —————————————— ⑥ 真实 usage 探测分支 ——————————————

test('⑥ 宿主回传 usage：tokensEst=false、token 用真实值、统计行去 ~', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'cost-usage-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const rec = new LlmCallRecorder(store, undefined, { model: 'glm-5.3', logger: { warn() {} } })
  // openai 兼容完整响应形态：{ choices, usage }（Recorder 轻量探测命中）
  const raw = await rec.call(CHAT, 'daily', 'map', 1, 10, 'A'.repeat(16000), async () => ({
    choices: [{ message: { content: legalDraft([1]) } }],
    usage: { prompt_tokens: 12345, completion_tokens: 678 },
  }))
  assert.equal(raw, legalDraft([1]), '探测分支返回正文文本')
  const e = readLlmCalls(dir, CHAT)[0]
  assert.equal(e.inTokens, 12345, '真实 usage：不用 chars/1.6 估算')
  assert.equal(e.outTokens, 678)
  assert.equal(e.tokensEst, false)
  assert.equal(e.costCny, computeCostCny('glm-5.3', 12345, 678, DEFAULT_LLM_PRICING))
  // 统计行：真实 usage → 无 ~ 前缀；费用仍带 ≈（价格表本身可能过期）
  const st = rec.getStats()
  const line = renderBatchStatsLine({ batches: 1, failedBatches: 0, maxBatchMs: 1000, ckptHits: 0, totalCalls: st.calls, totalMs: st.totalMs, model: st.model, inTokens: st.inTokens, outTokens: st.outTokens, costCny: st.costCny, tokensEst: st.tokensEst })
  assert.match(line, /模型 glm-5\.3 · 输入 12\.3k \/ 输出 678 tok · ≈¥\d+\.\d{4}/)
  assert.ok(!line.includes('~'), '真实 usage 统计行无 ~ 标注')
  rmSync(dir, { recursive: true, force: true })
})

// 补充：字符串返回（生产三条路径的常态）不触发 usage 探测——已由 ① 覆盖；
// 老版统计行形状（无 model 字段）渲染不追加成本段（向后兼容，empty 路径沿用）。
test('兼容：BatchStats 无 model 字段 → 统计行不追加成本段（旧形状不变）', () => {
  const line = renderBatchStatsLine({ batches: 0, failedBatches: 0, maxBatchMs: 0, ckptHits: 0, totalCalls: 0, totalMs: 0 })
  assert.equal(line, '> 统计：批 0（失败 0）· 最大批耗时 0.0 s · 缓存命中 0 · LLM 调用 0 次 / 0.0 s')
  assert.ok(!line.includes('模型'))
})
