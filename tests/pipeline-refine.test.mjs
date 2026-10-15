// pipeline-refine.test.mjs —— T7：方案 B 滚动 refine 流水线 + A/B 灰度开关（任务卡 T7 八项验收）。
// ① 三段消息 3 次调用、σ 逐段传递；② σ 校验失败重试一次再失败该段降级；③ 末段断言失败整体 degraded；
// ④ 群记忆持久化与损坏作废；⑤ ab 模式正式报告用 A、.refine.json sidecar 落盘；⑥ 默认 map-reduce 零行为变化；
// ⑦ llm_call phase='refine' 落 JSONL；⑧ 序号映射回全窗口 msg_id。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService } = await import('../lib/report.js')

const CHAT = '999@chatroom'
const BASE = new Date(2026, 5, 10, 8).getTime()

// 60 条消息分三簇：簇间 35/28 分钟大静默（≥ gapWindowMs 10min）→ splitByRate 强低谷切成 3 段
// [0,20) [20,40) [40,60)（两簇各自 ≥ minSeg 20，取间隔最大者先切）
function segTs(i) {
  if (i < 20) return BASE + i * 60_000
  if (i < 40) return BASE + 20 * 60_000 + 35 * 60_000 + (i - 20) * 60_000
  return BASE + 40 * 60_000 + 63 * 60_000 + (i - 40) * 60_000
}

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

function makeEnv(script, extra = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pipeline-refine-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = mockLlm(script)
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} },
    enabled: true,
    sleep: async () => {}, // 段重试间退避零延迟（真实路径复用 backoffDelayMs+抖动）
    ...extra,
  })
  return { dir, gs, store, llm, report }
}

async function seedSegs(gs, n = 60) {
  const msgs = []
  for (let i = 0; i < n; i++) {
    msgs.push({ msgId: `m${i + 1}`, ts: segTs(i), senderPid: `wxid_${i % 5}`, senderName: `成员${i % 5}`, text: `消息内容 ${i + 1}` })
  }
  await gs.appendMessages(CHAT, msgs)
  return msgs
}

function draftObj(evidence, uniqueText = 'UI 稿交付时间已提前到周二。') {
  return {
    title: '排期敲定',
    lead: 'UI 稿今天定稿。',
    judgments: [
      { text: uniqueText, evidence },
      { text: '后端接口联调定在周四进行。', evidence },
      { text: 'Bob 承诺下午给出测试环境。', evidence },
    ],
    topics: [{ title: '排期', change: '提前一天', status: '', people: '', watch: '', evidence }],
    quotes: evidence,
  }
}

const stateOf = (names) => ({
  actors: names.map((name) => ({ name, stance: '主导讨论' })),
  openQuestions: ['测试环境何时就绪'],
  tasks: ['Bob 下午提供测试环境'],
  quotes: [{ n: 1, reason: '排期拍板' }],
})
const stateJson = (names) => JSON.stringify({ summary: '本段聚焦排期与测试环境。', state: stateOf(names) })
const finalJson = (evidence, names, uniqueText) => JSON.stringify({ report: draftObj(evidence, uniqueText), state: stateOf(names) })

test('① 三段消息 → 3 次 LLM 调用（每段一次含末段出稿）；σ 逐段传递；⑦ phase=refine 落 JSONL；⑧ 序号映射回全窗口 msg_id', async () => {
  const { dir, gs, llm, report } = makeEnv([
    (p) => { assert.ok(!p.includes('末段出稿'), '段 1 是中间段'); return stateJson(['张三']) },
    (p) => {
      assert.ok(p.includes('张三'), '第 2 段 prompt 含第 1 段 σ 的 actors')
      assert.ok(p.includes('"prior_state"'))
      assert.ok(p.includes('"n":12'), '段 2 含重叠带消息（12 = 20-8）')
      return stateJson(['王五'])
    },
    (p) => {
      assert.ok(p.includes('末段出稿'), '第 3 段是末段出稿')
      assert.ok(p.includes('王五'), '末段 prompt 含 σ₂ 的 actors')
      return finalJson([25, 33], ['李四'])
    },
  ], { reportPipeline: 'refine' })
  await seedSegs(gs, 60)
  const res = await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000)
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 3, '每段一次调用（末段出稿也是一次段调用）')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /\[evidence: m25, m33\]/, '⑧ B 出稿 evidence 全局序号映射回全窗口 msg_id')
  assert.match(md, /\[m25\]/, '⑧ quotes 序号映射回全窗口 msg_id')
  // ⑦ llm_call phase='refine' 落 JSONL（3 行，batch=段号 1..3）
  const lines = readFileSync(join(dir, 'groups', CHAT, 'llm-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 3)
  assert.ok(lines.every((l) => l.phase === 'refine' && l.ev === 'llm_call'))
  assert.deepEqual(lines.map((l) => l.batch), [1, 2, 3])
  rmSync(dir, { recursive: true, force: true })
})

test('② σ 校验失败重试一次，再失败该段跳过：σ 沿用上段 + partialNote 记段号，末段照常出稿', async () => {
  const badState = JSON.stringify({ summary: 'x', state: { actors: '张三' } }) // actors 非数组 → 校验失败
  const { dir, gs, llm, report } = makeEnv([
    stateJson(['张三']),
    badState, // 段 2 首次：σ 校验失败
    badState, // 段 2 重试：仍失败 → 该段降级
    (p) => {
      assert.ok(p.includes('张三') && !p.includes('王五'), '段 3 的 σ 沿用段 1（段 2 素材被跳过）')
      return finalJson([50], ['张三'])
    },
  ], { reportPipeline: 'refine' })
  await seedSegs(gs, 60)
  const res = await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000)
  assert.equal(res.status, 'ok', '中间段降级不整体失败')
  assert.equal(llm.calls.length, 4, '段 2 重试一次后跳过：3 段共 4 次调用')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /滚动流水线部分段归纳失败：第 2 段（σ 沿用上段，跳过其素材）/)
  rmSync(dir, { recursive: true, force: true })
})

test('③ 末段产出断言失败（重试一次仍失败）→ 整体 degraded 骨架；群记忆不写', async () => {
  const badFinal = JSON.stringify({ report: { title: 'x' }, state: stateOf(['张三']) }) // report 缺 judgments → parseReportDraft 失败
  const { dir, gs, llm, report } = makeEnv([
    stateJson(['张三']), stateJson(['王五']),
    badFinal, badFinal,
  ], { reportPipeline: 'refine' })
  await seedSegs(gs, 60)
  const res = await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000)
  assert.equal(res.status, 'degraded')
  assert.equal(llm.calls.length, 4)
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /degraded/)
  assert.match(md, /断言两次失败/)
  assert.equal(existsSync(join(dir, 'groups', CHAT, 'pipeline-memory.json')), false, '末段失败不动群记忆')
  rmSync(dir, { recursive: true, force: true })
})

test('④ 群记忆持久化：第二次生成首段 prompt 含上次 σ；损坏 JSON 作废重来', async () => {
  const { dir, gs, llm, report } = makeEnv([
    stateJson(['张三']), stateJson(['王五']), finalJson([10], ['李四']), // 第一次生成：末段 σ 含李四
    (p) => {
      assert.ok(p.includes('李四'), '第二次生成的首段 prompt 注入上次 σ（"此前状态"）')
      assert.ok(p.includes('"prior_state":{"actors"'))
      return stateJson(['张三'])
    },
    stateJson(['王五']), finalJson([10], ['李四']), // 第二次生成余下段
    (p) => {
      assert.ok(p.includes('"prior_state":null'), '记忆损坏作废后 prior_state=null')
      return stateJson(['张三'])
    },
    stateJson(['王五']), finalJson([10], ['李四']), // 第三次生成余下段
  ], { reportPipeline: 'refine' })
  await seedSegs(gs, 60)
  await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000)
  const memPath = join(dir, 'groups', CHAT, 'pipeline-memory.json')
  assert.equal(existsSync(memPath), true, '末段成功后 σₙ 持久化')
  assert.ok(readFileSync(memPath, 'utf8').includes('李四'))
  await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000) // 第二次：首段已断言含李四
  writeFileSync(memPath, '{oops') // 损坏
  const res = await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000)
  assert.equal(res.status, 'ok', '记忆损坏不影响生成（作废重来）')
  assert.equal(llm.calls.length, 9, '三次生成各 3 次调用')
  rmSync(dir, { recursive: true, force: true })
})

test('⑤ ab 模式：正式 md 用 map-reduce 结果；.refine.json sidecar 存在且含 draft/σ/统计；报告尾注明双跑', async () => {
  // 30 条连续消息（无 ≥10min 静默）→ A 单次调用；B 单段（≤minSeg 边界内不再切）
  const { dir, gs, llm, report } = makeEnv([
    (p) => { assert.ok(!p.includes('末段出稿'), 'A 是单次归纳路径'); return JSON.stringify(draftObj([7], 'A 管线关键判断。')) },
    (p) => { assert.ok(p.includes('末段出稿'), 'B 是 refine 末段出稿'); return finalJson([9], ['赵六'], 'B 管线细节补充。') },
  ], { reportPipeline: 'ab' })
  const msgs = []
  for (let i = 0; i < 30; i++) msgs.push({ msgId: `m${i + 1}`, ts: BASE + i * 60_000, senderPid: 'wxid_a', senderName: '成员A', text: `内容 ${i + 1}` })
  await gs.appendMessages(CHAT, msgs)
  const res = await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000)
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 2, 'A 一次 + B 一次（B 段切分与 A 批切分互不干扰）')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.ok(md.includes('A 管线关键判断。'), '正式落盘报告用 map-reduce 结果')
  assert.ok(!md.includes('B 管线细节补充。'), 'B 的产出不进正式报告')
  assert.match(md, /A\/B 双跑：refine 侧 1 次/, '报告尾统计注明 ab 双跑与 B 侧调用数')
  const sidePath = join(dir, 'reports', CHAT, '2026-06-10.refine.json')
  assert.equal(existsSync(sidePath), true, '.refine.json sidecar 存在')
  const side = JSON.parse(readFileSync(sidePath, 'utf8'))
  assert.ok(side.draft && side.draft.judgments[0].text.includes('B 管线'), 'sidecar 含 B 的 draft')
  assert.ok(side.state && side.state.actors.some((a) => a.name === '赵六'), 'sidecar 含 σ')
  assert.ok(side.stats && side.stats.totalCalls === 1 && side.stats.batches === 1, 'sidecar 含 B 批统计')
  // JSONL：A 行 phase='map'、B 行 phase='refine'，同文件自动兼容
  const lines = readFileSync(join(dir, 'groups', CHAT, 'llm-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.phase).sort(), ['map', 'refine'])
  rmSync(dir, { recursive: true, force: true })
})

test('⑥ 默认 map-reduce 零行为变化：单次调用、无 sidecar、无群记忆、无双跑标注', async () => {
  const { dir, gs, llm, report } = makeEnv([JSON.stringify(draftObj([1]))])
  const msgs = []
  for (let i = 0; i < 30; i++) msgs.push({ msgId: `m${i + 1}`, ts: BASE + i * 60_000, senderPid: 'wxid_a', senderName: '成员A', text: `内容 ${i + 1}` })
  await gs.appendMessages(CHAT, msgs)
  const res = await report.generateReport(CHAT, 'daily', BASE + 12 * 3600_000)
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 1, '默认管线与既有行为一致')
  assert.equal(existsSync(join(dir, 'reports', CHAT, '2026-06-10.refine.json')), false)
  assert.equal(existsSync(join(dir, 'groups', CHAT, 'pipeline-memory.json')), false)
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.ok(!md.includes('A/B 双跑'))
  rmSync(dir, { recursive: true, force: true })
})
