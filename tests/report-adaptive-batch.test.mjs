// report-adaptive-batch.test.mjs —— T4：自适应批大小（safe-batch 反馈环，技术文档 §3.2）。
// 覆盖：
//   ① 首次非叶子批 timeout → safeBatch 120→84（写盘+warn），下次生成批大小 = 84；
//   ② 对半切分递归中再 timeout 连续压（120→84→58）；
//   ③ 连续 5 次「全部批成功且最大批耗时 < 历史 P50×0.5」→ 扩张 ×1.2 并清零计数；
//   ④ 耗时不达标（≥ P50×0.5）→ 不扩张；
//   ⑤ adaptiveBatch=false → 固定 batchThreshold，timeout 不压缩、文件不变；
//   ⑥ 状态跨 ReportService 实例化保留（新实例仍读到收缩值，并入 ①②断言）；
//   ⑦ (chatId, kind) 独立互不影响；
//   ⑧ 损坏 JSON 作废重来（回初始值，重写成合法文件）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService, safeBatchRelPath, p50BatchMs } = await import('../lib/report.js')

const CHAT = '555@chatroom'
const BASE = new Date(2026, 5, 10).getTime() // 2026-06-10（周三）
const T = (h, m = 0) => BASE + h * 3600_000 + m * 60_000
const TIMEOUT = new Error('llm stream finished with error: Request timed out.')

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

/** 脚本式 mock：字符串正常返回 / Error 抛出 / 函数(prompt) 断言式返回；耗尽返回 '{}' */
function mockLlm(script = []) {
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

/**
 * 可注入单调时钟：runBatched 在每批首尾各取一次 → 每批假耗时恰为 batchMs。
 * LLM mock 真实耗时 ~0，用假时钟完全驱动「快于/慢于历史 P50」场景。
 */
function fakeClock(batchMs) {
  let t = 1000
  return () => (t += batchMs)
}

function makeEnv(script, extra = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-adab-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = mockLlm(script)
  const warns = []
  const mkSvc = (llmOverride, override = {}) => new ReportService({
    groupStore: gs, store, stateDir: dir, llm: llmOverride ?? llm,
    logger: { warn: (m) => warns.push(m), error() {} },
    enabled: true,
    sleep: () => Promise.resolve(),
    monotonicMs: fakeClock(extra.__batchMs ?? 10),
    ...extra,
    ...override,
  })
  return { dir, gs, store, llm, warns, mkSvc, report: mkSvc() }
}

function seedMany(gs, n, chat = CHAT, prefix = 'm') {
  const msgs = []
  for (let i = 0; i < n; i++) {
    msgs.push({ msgId: `${prefix}${i + 1}`, ts: T(8) + i * 60_000, senderPid: `wxid_${i % 5}`, senderName: `成员${i % 5}`, text: `消息内容 ${i + 1}` })
  }
  return gs.appendMessages(chat, msgs).then(() => msgs)
}

/** 读取 safe-batch.json 中某 kind 的状态 */
function readSafeBatch(dir, chat = CHAT, kind = 'daily') {
  const raw = readFileSync(join(dir, safeBatchRelPath(chat)), 'utf8')
  return JSON.parse(raw)[kind]
}

/** 预置 safe-batch.json（模拟历史状态：已收缩/已有历史样本；先建目录） */
function preseedSafeBatch(dir, state, chat = CHAT, kind = 'daily') {
  const file = join(dir, safeBatchRelPath(chat))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ [kind]: state }))
}

// ———————————————— 纯函数：P50 ——————————————

test('p50BatchMs：奇数取中位、偶数取中间均值、空/全非法返回 null', () => {
  assert.equal(p50BatchMs([]), null)
  assert.equal(p50BatchMs(['x', 0, -1]), null)
  assert.equal(p50BatchMs([30, 10, 20]), 20)
  assert.equal(p50BatchMs([10, 40, 20, 30]), 25)
  assert.equal(p50BatchMs([5, 1]), 3)
})

// ———————————————— ① 首次 timeout 收缩（含 ⑥ 跨实例化保留） ——————————————

test('T4-①⑥ 非叶子批 timeout → safeBatch 120→84（写盘+warn）；新实例下次生成批大小 = 84', async () => {
  const { dir, gs, mkSvc, warns } = makeEnv([
    TIMEOUT, // 批 1（120 条）timeout → 对半切分（压缩在生成结束统一结算写盘）
    legalDraft([1]), legalDraft([61]), // 左右半批（60/60）成功
    legalDraft([121]), // 批 2（1 条）成功
    legalDraft([121]), // 合并成功
  ], { batchThreshold: 120 })
  await seedMany(gs, 121)
  const r1 = await mkSvc().generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r1.status, 'ok')
  const sb = readSafeBatch(dir)
  assert.equal(sb.safeBatch, 84, 'floor(120×0.7)=84')
  assert.equal(sb.streak, 0, 'timeout 打断连续成功计数')
  assert.ok(warns.some((w) => w.includes('safeBatch 120→84') && w.includes('timeout 压缩')), '调整 warn 含原因')
  assert.ok(warns.some((w) => w.includes('检查点按范围失效属预期')), '变化提示检查点按范围失效')
  // ⑥ 跨 ReportService 实例化保留：新 new 一个（独立 llm mock）仍读到收缩值
  const llm2 = mockLlm([legalDraft([1]), legalDraft([85]), legalDraft([85])])
  const r2 = await mkSvc(llm2).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r2.status, 'ok')
  assert.equal(llm2.calls.length, 3, '84+37 两批 + 合并')
  assert.ok(llm2.calls[0].includes('"n":84') && !llm2.calls[0].includes('"n":85'), '下次生成首批 = 84 条（mock prompt msgs 数断言）')
  assert.equal(readSafeBatch(dir).safeBatch, 84, '成功但 streak 未满 5 → 不变')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— ② 递归对半连续压 ——————————————

test('T4-② 递归对半中再 timeout 连续压：120→84→58，下次批大小 = 58', async () => {
  const { dir, gs, mkSvc, warns } = makeEnv([
    TIMEOUT, // 批 1（120）timeout → 压一层（in-memory 84）→ 对半 60/60
    TIMEOUT, // 左半（60）仍 timeout → 再压一层（58）→ 对半 30/30
    legalDraft([1]), legalDraft([31]), // 左左/左右成功
    legalDraft([61]), // 右半（60）成功
    legalDraft([121]), // 批 2（1 条）成功
    legalDraft([121]), // 合并成功
  ], { batchThreshold: 120 })
  await seedMany(gs, 121)
  const r1 = await mkSvc().generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r1.status, 'ok')
  assert.equal(readSafeBatch(dir).safeBatch, 58, 'floor(84×0.7)=58（一次大超时按递归路径连续压两级）')
  assert.ok(warns.some((w) => w.includes('safeBatch 120→58')), 'warn 记录起点→终点')
  // 下次生成批大小 = 58（121 条 → 58+58+5 三批）
  const llm2 = mockLlm([legalDraft([1]), legalDraft([59]), legalDraft([59]), legalDraft([117]), legalDraft([117])])
  const r2 = await mkSvc(llm2).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r2.status, 'ok')
  assert.ok(llm2.calls[0].includes('"n":58') && !llm2.calls[0].includes('"n":59'), '下次生成首批 = 58 条')
  assert.equal(llm2.calls.length, 4, '三批 + 合并')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— ③ 连续成功扩张 / ④ 耗时不达标 ——————————————

test('T4-③ 连续 5 次成功且最大批耗时 < P50×0.5 → 扩张 ×1.2（84→100）并清零计数', async () => {
  const { dir, gs, mkSvc } = makeEnv([], { batchThreshold: 120 })
  await seedMany(gs, 121)
  // 每批假耗时 10ms < 30000×0.5=15000 → 达标；6 条 30s 历史使 P50 全程稳定在 30000
  preseedSafeBatch(dir, { safeBatch: 84, streak: 0, durs: [30000, 30000, 30000, 30000, 30000, 30000] })
  for (let i = 0; i < 5; i++) {
    const llm = mockLlm([legalDraft([1]), legalDraft([85]), legalDraft([85])]) // 84+37 两批 + 合并
    const r = await mkSvc(llm).generateReport(CHAT, 'daily', T(20, 30))
    assert.equal(r.status, 'ok')
    if (i < 4) assert.equal(readSafeBatch(dir).safeBatch, 84, `第 ${i + 1} 次成功后尚未扩张`)
  }
  const sb = readSafeBatch(dir)
  assert.equal(sb.safeBatch, 100, '计满 5 次：floor(84×1.2)=100（扩张回 84+）')
  assert.equal(sb.streak, 0, '扩张后计数清零')
  rmSync(dir, { recursive: true, force: true })
})

test('T4-④ 耗时不达标（≥ P50×0.5）→ 不扩张、既有计数清零', async () => {
  const { dir, gs, mkSvc } = makeEnv([], { batchThreshold: 120, __batchMs: 20000 })
  await seedMany(gs, 121)
  preseedSafeBatch(dir, { safeBatch: 84, streak: 3, durs: [30000, 30000, 30000, 30000, 30000, 30000] })
  for (let i = 0; i < 2; i++) {
    // 假批耗时 20000 ≥ 15000 → 不达标
    const llm = mockLlm([legalDraft([1]), legalDraft([85]), legalDraft([85])])
    const r = await mkSvc(llm).generateReport(CHAT, 'daily', T(20, 30))
    assert.equal(r.status, 'ok')
  }
  const sb = readSafeBatch(dir)
  assert.equal(sb.safeBatch, 84, '耗时不达标不扩张')
  assert.equal(sb.streak, 0, '预置计数 3 被清零（连续被打破）')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— ⑤ 关闭开关 ——————————————

test('T4-⑤ adaptiveBatch=false → 固定 batchThreshold：timeout 不压缩、状态文件原样', async () => {
  const { dir, gs, mkSvc } = makeEnv([
    TIMEOUT, legalDraft([1]), legalDraft([61]), // 批 1 timeout → 对半成功（不压缩）
    legalDraft([121]), legalDraft([121]), // 批 2 + 合并
  ], { batchThreshold: 120, adaptiveBatch: false })
  await seedMany(gs, 121)
  preseedSafeBatch(dir, { safeBatch: 84, streak: 2, durs: [30000] })
  const r1 = await mkSvc().generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r1.status, 'ok')
  const sb = readSafeBatch(dir)
  assert.equal(sb.safeBatch, 84, '文件原样（关闭时零读零写反馈）')
  assert.equal(sb.streak, 2)
  assert.deepEqual(sb.durs, [30000])
  // 下次生成仍按配置 120 切批（零行为差异）
  const llm2 = mockLlm([legalDraft([1]), legalDraft([121]), legalDraft([121])])
  await mkSvc(llm2).generateReport(CHAT, 'daily', T(20, 30))
  assert.ok(llm2.calls[0].includes('"n":120'), '固定 120 切批')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— ⑦ (chatId, kind) 独立 ——————————————

test('T4-⑦ (chatId, kind) 独立：A 群收缩不影响 B 群；同群 weekly 不受 daily 影响', async () => {
  const { dir, gs, mkSvc } = makeEnv([
    TIMEOUT, legalDraft([1]), legalDraft([61]), legalDraft([121]), legalDraft([121]),
  ], { batchThreshold: 120 })
  await seedMany(gs, 121)
  await seedMany(gs, 121, '666@chatroom', 'b')
  const r = await mkSvc().generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r.status, 'ok')
  assert.equal(readSafeBatch(dir, CHAT, 'daily').safeBatch, 84, 'A 群 daily 收缩')
  assert.equal(readSafeBatch(dir, CHAT, 'weekly'), undefined, '同群 weekly 无条目（未生成不初始化）')
  assert.ok(!existsSync(join(dir, safeBatchRelPath('666@chatroom'))), 'B 群零文件')
  // B 群生成一次（全成功）→ 初始 120，不受 A 群影响
  const llmB = mockLlm([legalDraft([1]), legalDraft([121]), legalDraft([121])])
  await mkSvc(llmB).generateReport('666@chatroom', 'daily', T(20, 30))
  assert.equal(readSafeBatch(dir, '666@chatroom', 'daily').safeBatch, 120, 'B 群初始 120（互不影响）')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— ⑧ 损坏作废重来 ——————————————

test('T4-⑧ 损坏 JSON 作废重来：回初始值并重写成合法文件', async () => {
  const { dir, gs, mkSvc, warns } = makeEnv([legalDraft([1]), legalDraft([121]), legalDraft([121])], { batchThreshold: 120 })
  await seedMany(gs, 121)
  const corrupt = join(dir, safeBatchRelPath(CHAT))
  mkdirSync(dirname(corrupt), { recursive: true })
  writeFileSync(corrupt, '{corrupted!!!')
  const r = await mkSvc().generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r.status, 'ok')
  assert.ok(warns.some((w) => w.includes('safe-batch 状态文件损坏')), '损坏告警可见')
  const sb = readSafeBatch(dir)
  assert.equal(sb.safeBatch, 120, '作废重来 → 初始 = 配置 batchThreshold')
  assert.equal(sb.streak, 1, '本次全成功且快于基准 → 计数从 0 重新起算（=1）')
  rmSync(dir, { recursive: true, force: true })
})
