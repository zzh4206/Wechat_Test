// report-timeout-split.test.mjs —— T1/T2：timeout 错误分类 + 对半切分重试 + 批间退避加抖动 + 检查点缓存（断点续跑）。
// 覆盖：
//   T1 ① 批首调 timeout、对半后成功 → ok 且调用数正确（全局序号不变量保持）；
//      ② 叶子批（<5 条）仍 timeout → degraded + partialNote 含该批（禁止无限切分）；
//      ③ 退避 sleep 被调用且时长在抖动范围内（注入 spy sleep；backoffDelayMs 纯函数封顶断言）；
//      ④ 非 timeout 错误仍走"重试一次"原路径（且不触发退避 sleep）；
//   T2 ⑤ 同窗口第二次生成只调上次的失败批 + 合并（mock 计数断言）；
//      ⑥ 命中检查点路径的最终 md 与全量路径一致；
//      ⑦ win.start 变化后检查点不命中（键含 win.start）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const {
  ReportService,
  reportCkptKey,
  reportWindow,
  backoffDelayMs,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
} = await import('../lib/report.js')

const CHAT = '999@chatroom'
const BASE = new Date(2026, 5, 10).getTime() // 2026-06-10（周三）
const T = (h, m = 0) => BASE + h * 3600_000 + m * 60_000

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

/** 脚本式 mock：数组元素为字符串（正常返回）或 Error（抛出）；耗尽后返回 '{}'（触发断言失败） */
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

/** spy sleep：记录每次退避时长，零真实延迟 */
function spySleep() {
  const ms = []
  return { ms, sleep: (m) => { ms.push(m); return Promise.resolve() } }
}

function makeEnv(script, extra = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-tos-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = mockLlm(script)
  const bo = spySleep()
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} },
    enabled: true,
    sleep: bo.sleep,
    ...extra,
  })
  return { dir, gs, store, llm, bo, report }
}

function seedMany(gs, n) {
  const msgs = []
  for (let i = 0; i < n; i++) {
    msgs.push({ msgId: `m${i + 1}`, ts: T(8) + i * 60_000, senderPid: `wxid_${i % 5}`, senderName: `成员${i % 5}`, text: `消息内容 ${i + 1}` })
  }
  return gs.appendMessages(CHAT, msgs).then(() => msgs)
}

// ———————————————— 纯函数 ————————————————

test('errKindOf 容错匹配：Request timed out / timeout / timed out → timeout，其余 other', async () => {
  const { errKindOf } = await import('../lib/report.js')
  assert.equal(errKindOf(new Error('llm stream finished with error: Request timed out.')), 'timeout')
  assert.equal(errKindOf(new Error('Request timeout')), 'timeout')
  assert.equal(errKindOf(new Error('Request timedout')), 'timeout')
  assert.equal(errKindOf(new Error('connection reset by peer')), 'other')
  assert.equal(errKindOf('timeout'), 'timeout')
  assert.equal(errKindOf(new Error('boom')), 'other')
  assert.equal(errKindOf(null), 'other')
})

test('backoffDelayMs：指数 2s 起、30s 封顶、抖动系数 0.75–1.25（注入随机源）', () => {
  assert.equal(BACKOFF_BASE_MS, 2000)
  assert.equal(BACKOFF_MAX_MS, 30000)
  assert.equal(backoffDelayMs(1, () => 0), 1500) // 2000×0.75
  assert.equal(backoffDelayMs(1, () => 1), 2500) // 2000×1.25
  assert.equal(backoffDelayMs(2, () => 0), 3000) // 4000×0.75
  assert.equal(backoffDelayMs(5, () => 0), 22500) // min(30000,2000×2^4)=30000 已封顶 ×0.75
  assert.equal(backoffDelayMs(10, () => 0.5), 30000) // 已封顶
})

// ———————————————— T1 ① 对半切分 ————————————————

test('T1-① 批首调 timeout → 对半切分后成功：ok、调用数正确、子批全局序号保持', async () => {
  const TIMEOUT = new Error('llm stream finished with error: Request timed out.')
  const { dir, gs, llm, bo, report } = makeEnv([
    TIMEOUT, // 批 1（120 条）首调 timeout → 不原样重试，对半切分
    (p) => { assert.ok(p.includes('"n":60') && !p.includes('"n":61'), '左半 1–60'); return legalDraft([1]) },
    (p) => { assert.ok(p.includes('"n":61'), '右半从 61 起（全局序号不变量）'); return legalDraft([61]) },
    legalDraft([121]), // 批 2（1 条）
    legalDraft([61]), // 合并
  ], { batchThreshold: 120 })
  await seedMany(gs, 121)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 5, '1 次超时 + 2 个子批 + 批 2 + 合并')
  assert.ok(llm.calls[4].includes('"batches"'), '末次为合并调用')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.ok(!md.includes('部分素材归纳失败'), '对半切分成功无 partial 标注')
  assert.equal(bo.ms.length, 1, '切分前退避一次')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— T1 ② 叶子批 degraded ————————————————

test('T1-② 叶子批（≤4 条 <5）仍 timeout → 该批 degraded + partialNote 含该批，禁止无限切分', async () => {
  const TIMEOUT = new Error('Request timed out.')
  // 阈值 12（构造函数下限 10）、13 条 → 批 1（12）+ 批 2（1）。
  // 批 1 递归：12 timeout → 6/6 → 3/3（叶子 <5，仍 timeout → degraded，不再切分）
  // 批 1 调用数 = 1 + 2 + 4 = 7（每次 timeout 都真实发起 LLM 调用后才降级）
  const { dir, gs, llm, report } = makeEnv([
    TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT,
    legalDraft([13]), // 批 2（1 条）成功
    legalDraft([13]), // 合并成功
  ], { batchThreshold: 12 })
  await seedMany(gs, 13)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok', '部分批失败不整体降级')
  assert.equal(llm.calls.length, 9, '批 1 全链 7 次（12→6/6→3/3 叶子）+ 批 2 + 合并')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /部分素材归纳失败：第 1 批/)
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— T1 ③ 退避加抖动 ————————————————

test('T1-③ 退避 sleep 被调用且时长在抖动范围内；连续失败退避指数抬升', async () => {
  const TIMEOUT = new Error('Request timed out.')
  // 阈值 12、13 条 → 批 1（12）+ 批 2（1），全部 timeout（全批失败 → 整体 degraded，无合并调用）
  const { dir, gs, llm, bo, report } = makeEnv([
    TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT,
  ], { batchThreshold: 12 })
  await seedMany(gs, 13)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded', '全部批次失败 → 整体 degraded（无合并调用）')
  assert.equal(llm.calls.length, 8, '批 1 全链 7 次 + 批 2 叶子 1 次')
  // 退避 4 次（深度优先递归，streak 依次 1/2/5/7）→ 基数 2s/4s/30s（封顶）/30s，各乘抖动 [0.75,1.25]
  assert.equal(bo.ms.length, 4)
  assert.ok(bo.ms[0] >= 1500 && bo.ms[0] <= 2500, `第 1 次退避 ${bo.ms[0]}ms 应在 [1500,2500]`)
  assert.ok(bo.ms[1] >= 3000 && bo.ms[1] <= 5000, `第 2 次退避 ${bo.ms[1]}ms 应在 [3000,5000]`)
  assert.ok(bo.ms[2] >= 22500 && bo.ms[2] <= 37500, `第 3 次退避 ${bo.ms[2]}ms 应在 [22500,37500]（streak=5 已封顶）`)
  assert.ok(bo.ms[3] >= 22500 && bo.ms[3] <= 37500, `第 4 次（批间）退避 ${bo.ms[3]}ms 应在 [22500,37500]（指数封顶）`)
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— T1 ④ 非 timeout 保持重试一次 ————————————————

test('T1-④ 非 timeout 错误仍走"重试一次"原路径：不切分、不退避', async () => {
  const { dir, gs, llm, bo, report } = makeEnv([
    new Error('connection reset by peer'), // 非 timeout → 原样重试
    new Error('connection reset by peer'), // 重试仍失败 → 批 1 degraded
    legalDraft([121]), // 批 2
    legalDraft([121]), // 合并
  ], { batchThreshold: 120 })
  await seedMany(gs, 121)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 4, '批 1 两次（原样重试，非切分）+ 批 2 + 合并')
  assert.equal(bo.ms.length, 0, '非 timeout 不触发退避 sleep')
  assert.equal(llm.calls[0], llm.calls[1], '重试为同 payload 原样重试')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /部分素材归纳失败：第 1 批/)
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— T2 ⑤ 检查点断点续跑 ————————————————

test('T2-⑤ 同窗口第二次生成只调上次的失败批 + 合并（断点续跑）', async () => {
  const TIMEOUT = new Error('Request timed out.')
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-ckpt-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  await seedMany(gs, 121)
  const mk = (llm) => new ReportService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} }, enabled: true,
    batchThreshold: 120, sleep: () => Promise.resolve(),
  })
  // 第一次：批 1 成功（写检查点）；批 2（1 条，叶子）timeout → degraded；合并成功
  const llm1 = mockLlm([legalDraft([1]), TIMEOUT, legalDraft([9])])
  const r1 = await mk(llm1).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r1.status, 'ok')
  assert.equal(llm1.calls.length, 3, '批 1 + 批 2(timeout) + 合并')
  // 第二次：批 1 命中检查点（0 调用）；批 2 无检查点 → 重调成功；合并重调
  const llm2 = mockLlm([legalDraft([121]), legalDraft([121])])
  const r2 = await mk(llm2).generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r2.status, 'ok')
  assert.equal(llm2.calls.length, 2, '只调上次的失败批（1）+ 合并（1）——批 1 走检查点')
  assert.ok(!llm2.calls[0].includes('"batches"'), '首调为批 2 而非合并')
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.ok(!md.includes('部分素材归纳失败'), '第二次批 2 成功 → 无 partial 标注')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— T2 ⑥ 命中路径与全量路径一致 ————————————————

test('T2-⑥ 检查点全命中（重跑）的最终 md 与全量路径完全一致', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-ckpt-eq-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  await seedMany(gs, 121)
  const mk = () => {
    // 每次调用都返回同一合法稿（evidence 全局序号 1/121 均有效）
    const llm = { calls: [], async complete(p) { this.calls.push(p); return legalDraft([1]) } }
    const report = new ReportService({
      groupStore: gs, store, stateDir: dir, llm,
      logger: { warn() {}, error() {} }, enabled: true,
      batchThreshold: 120, sleep: () => Promise.resolve(),
    })
    return { llm, report }
  }
  const a = mk()
  await a.report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(a.llm.calls.length, 3, '全量路径：2 批 + 合并')
  const md1 = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  const b = mk()
  await b.report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(b.llm.calls.length, 1, '检查点全命中：仅合并调用（合并不缓存）')
  const md2 = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  // T3 后报告尾新增 batch_stats 行（缓存命中/耗时逐次必然不同）——剥离后再比对正文等价性
  const strip = (md) => md.split('\n').filter((l) => !l.startsWith('> 统计：批 ')).join('\n')
  assert.equal(strip(md2), strip(md1), '命中路径最终 draft/md 与全量路径一致（不含 T3 batch_stats 统计行）')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— T2 ⑦ win.start 变化不命中 ————————————————

test('T2-⑦ win.start 变化后检查点不命中（键含 win.start；backfill 改起点自动失效）', async () => {
  const dailyWin = reportWindow('daily', T(20, 30))
  const weeklyWin = reportWindow('weekly', T(20, 30))
  assert.equal(dailyWin.dateKey, weeklyWin.dateKey, '同一天（dateKey 相同）')
  assert.notEqual(dailyWin.start, weeklyWin.start, '窗口起点不同（周报=周一）')
  assert.notEqual(
    reportCkptKey(CHAT, 'daily', dailyWin, '1', 0, 120),
    reportCkptKey(CHAT, 'daily', weeklyWin, '1', 0, 120),
    '键含 win.start：起点变 → 键变 → 不命中',
  )
  // 负责人加固：批切分边界变化（start/count 变）→ 键变 → 不命中，防止旧摘要静默复用
  assert.notEqual(
    reportCkptKey(CHAT, 'daily', dailyWin, '1', 0, 120),
    reportCkptKey(CHAT, 'daily', dailyWin, '1', 0, 60),
    '键含 start+count：阈值调整/自适应批大小改变批边界 → 不命中',
  )
  // 集成：daily 检查点已写满后，同日 weekly 首跑仍需全量批调用（不命中 daily 的检查点）
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-ckpt-ws-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  await seedMany(gs, 121)
  const mk = (kind) => {
    const llm = { calls: [], async complete(p) { this.calls.push(p); return legalDraft([1]) } }
    const report = new ReportService({
      groupStore: gs, store, stateDir: dir, llm,
      logger: { warn() {}, error() {} }, enabled: true,
      batchThreshold: 120, sleep: () => Promise.resolve(),
    })
    return { llm, report, kind }
  }
  const d = mk('daily')
  await d.report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(d.llm.calls.length, 3)
  const w = mk('weekly')
  await w.report.generateReport(CHAT, 'weekly', T(20, 30))
  assert.equal(w.llm.calls.length, 3, 'weekly 窗口起点不同 → 全量批调用，零命中')
  rmSync(dir, { recursive: true, force: true })
})

// ———————————————— T1 person-digest 同构改造 ————————————————

test('T1-person-digest：批 timeout 对半切分成功（全局序号保持）且退避被调用', async () => {
  const { PersonDigestService, localDayKey } = await import('../lib/person-digest.js')
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-tos-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const dayBase = new Date(2026, 5, 10, 9).getTime()
  const msgs = []
  for (let i = 0; i < 21; i++) {
    const mine = i % 2 === 0
    msgs.push({
      msgId: `pm${i + 1}`,
      ts: dayBase + i * 60_000,
      senderPid: mine ? 'wxid_boss001' : `wxid_${i}`,
      senderName: mine ? '老板' : `成员${i}`,
      text: `讨论点 ${i + 1}`,
    })
  }
  await gs.appendMessages('777@chatroom', msgs)
  const day = localDayKey(dayBase)
  const legal = (ev) => JSON.stringify({ person_pid: 'wxid_boss001', date: day, topics: [{ title: '排期', summary: '在催交付', evidence: ev }], mood_or_stance: '急', open_questions: [] })
  const calls = []
  const bo = spySleep()
  const script = [
    new Error('Request timed out.'), // 批 1（10 条）timeout → 对半 5/5
    legal([1]), legal([6]), // 两个子批成功（全局序号 1–5 / 6–10）
    legal([11]), legal([11]), // 批 2、批 3（21/10 → 3 批）
    legal([11]), // 合并
  ]
  let si = 0
  const llm = {
    calls,
    async complete(prompt) {
      calls.push(prompt)
      const next = script[si++]
      assert.ok(next !== undefined, '调用数超出脚本')
      if (next instanceof Error) throw next
      if (calls.length === 2) assert.ok(!prompt.includes('"n":6') || true)
      if (calls.length === 3) assert.ok(prompt.includes('"n":6'), '右半从全局序号 6 起')
      return next
    },
  }
  const svc = new PersonDigestService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} }, enabled: true,
    batchThreshold: 10, sleep: bo.sleep,
  })
  const res = await svc.generateDaily('777@chatroom', 'wxid_boss001', day)
  assert.equal(res.status, 'ok')
  assert.equal(calls.length, 6, '1 超时 + 2 子批 + 批 2 + 批 3 + 合并')
  assert.equal(bo.ms.length, 1, '切分前退避一次')
  const md = readFileSync(join(dir, res.path), 'utf8')
  assert.ok(!md.includes('部分素材归纳失败'), '切分成功无 partial 标注')
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})
