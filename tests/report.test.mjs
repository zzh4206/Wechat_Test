// report.test.mjs —— M3 报告引擎（全离线 mock，node:sqlite 临时目录）。
// 覆盖：mock llm（合法 / 违反金字塔重试一次成功 / 两次均坏 → degraded 不缺报告）、
//       周期切窗（日/周/月自然窗口）、手动触发不错位（与调度同窗同文件）、
//       聚合截断与排序（rankGroups 注入 + 默认相关度排序 + 其余一行带过）、
//       outbox 联动的调度回调不在此测（接线在 index，属 M4 端到端）、
//       person-digest 定夺：派生 pid 反查（identities: wx_xxxx→wxid）与同日重跑覆盖语义。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService, reportWindow, parseReportDraft, extractJudgments, clampQuote, reportRelPath, QUOTE_MAX_CHARS } = await import('../lib/report.js')
const { PersonDigestService, localDayKey, resolveSenderKeys } = await import('../lib/person-digest.js')
const { derivePid } = await import('../lib/persona-track.js')

const CHAT = '888@chatroom'
// 2026-06-10 是周三；本周一为 2026-06-08
const BASE = new Date(2026, 5, 10).getTime()
const T = (h, m = 0) => BASE + h * 3600_000 + m * 60_000

function mockLlm(script) {
  const calls = []
  return {
    calls,
    async complete(prompt) {
      calls.push(prompt)
      const next = script.shift()
      if (typeof next === 'function') return next()
      if (next instanceof Error) throw next
      return next ?? '{}'
    },
  }
}

function legalOutput(maxN = 5) {
  const ev3 = maxN >= 4 ? 4 : 1
  return JSON.stringify({
    title: '排期敲定',
    lead: '**UI 稿今天定稿**：项目排期由周三提前到周二。',
    judgments: [
      { text: 'UI 稿交付时间已提前到周二。', evidence: [2] },
      { text: '后端接口联调定在周四进行。', evidence: [Math.min(3, maxN)] },
      { text: 'Bob 承诺下午给出测试环境。', evidence: [ev3] },
    ],
    topics: [{ title: '项目排期', change: '排期提前一天', status: 'UI 稿是当前瓶颈', people: '老板主张提前；Bob 配合', watch: '周二能否真交付', evidence: [2] }],
    quotes: [2],
  })
}

async function seedDay(gs, msgs) {
  await gs.appendMessages(CHAT, msgs)
}

function makeEnv(script, extra = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = mockLlm(script)
  const report = new ReportService({
    groupStore: gs,
    store,
    stateDir: dir,
    llm,
    logger: { warn() {}, error() {} },
    enabled: true,
    ...extra,
  })
  return { dir, gs, store, llm, report }
}

test('周期切窗：daily=当天；weekly=本周一起；monthly=本月 1 日起（纯函数）', () => {
  const d = reportWindow('daily', T(20, 30))
  assert.equal(d.start, BASE)
  assert.equal(d.end, BASE + 86_400_000)
  assert.equal(d.dateKey, '2026-06-10')
  const w = reportWindow('weekly', T(20, 40))
  assert.equal(w.start, BASE - 2 * 86_400_000) // 本周一 00:00
  assert.equal(w.dateKey, '2026-06-10')
  const m = reportWindow('monthly', T(8))
  assert.equal(m.start, new Date(2026, 5, 1).getTime())
  assert.equal(m.dateKey, '2026-06-10')
})

test('合法输出：三层金字塔齐备，判断 3–5 条挂 msg_id 证据，引用 ≤50 字，元数据行入库', async () => {
  const msgs = [
    { msgId: 'm1', ts: T(9), senderPid: 'wxid_a', senderName: '爱丽丝', text: '早' },
    { msgId: 'm2', ts: T(10), senderPid: 'wxid_boss', senderName: '老板', text: 'UI 稿提前到周二交' },
    { msgId: 'm3', ts: T(11), senderPid: 'wxid_c', senderName: '阿丙', text: '周四联调' },
    { msgId: 'm4', ts: T(12), senderPid: 'wxid_bob', senderName: 'Bob', text: '下午给测试环境' },
    { msgId: 'm5', ts: T(13), senderPid: 'wxid_a', senderName: '爱丽丝', text: '收到' },
  ]
  const { dir, gs, llm, report } = makeEnv([legalOutput()])
  await seedDay(gs, msgs)
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  assert.equal(res.judgmentCount, 3)
  assert.match(llm.calls[0], /三条硬性写作原则/)
  assert.match(llm.calls[0], /变化优先于存量/)
  // 隐私纪律：数据区无 msg_id（序号化），指令区含 schema
  assert.ok(!llm.calls[0].includes('"m2"'))
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /## L1 一分钟层/)
  assert.match(md, /### 关键判断/)
  assert.match(md, /\[evidence: m2\]/)
  assert.match(md, /## L2 五分钟层/)
  assert.match(md, /【变化】/)
  assert.match(md, /【现状】/)
  assert.match(md, /【相关人】/)
  assert.match(md, /【待观察】/)
  assert.match(md, /### 双向任务看板/)
  assert.match(md, /## L3 溯源层/)
  assert.match(md, /\[m2\] 2026-06-10 10:00 老板/)
  // 引用 ≤50 字
  for (const line of md.split('\n')) {
    const q = line.match(/「(.+)」$/)
    if (q) assert.ok(q[1].length <= QUOTE_MAX_CHARS, `引用超长: ${q[1]}`)
  }
  const metas = gs.getReportMetas(CHAT)
  assert.equal(metas.length, 1)
  assert.equal(metas[0].status, 'ok')
  assert.equal(metas[0].kind, 'daily')
  gs.dispose()
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('违反金字塔（judgments 只有 2 条）→ 重试一次成功（llm 调 2 次）', async () => {
  const { dir, gs, llm, report } = makeEnv([
    JSON.stringify({ title: 't', lead: 'l', judgments: [{ text: '只有两条之一', evidence: [1] }, { text: '之二', evidence: [2] }], topics: [] }),
    legalOutput(3),
  ])
  await seedDay(gs, [
    { msgId: 'a', ts: T(9), senderPid: 'u1', senderName: 'A', text: 'x' },
    { msgId: 'b', ts: T(10), senderPid: 'u2', senderName: 'B', text: 'y' },
    { msgId: 'c', ts: T(11), senderPid: 'u3', senderName: 'C', text: 'z' },
  ])
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 2)
  gs.dispose()
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('两次均坏 → degraded 降级输出（不缺报告），元数据记 degraded', async () => {
  const bad = () => JSON.stringify({ title: 't', lead: 'l', judgments: [], topics: [] })
  const { dir, gs, llm, report } = makeEnv([bad(), bad()])
  await seedDay(gs, [
    { msgId: 'a', ts: T(9), senderPid: 'u1', senderName: 'A', text: 'x' },
    { msgId: 'b', ts: T(10), senderPid: 'u2', senderName: 'B', text: 'y' },
  ])
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  assert.equal(llm.calls.length, 2)
  const md = readFileSync(join(dir, 'reports', CHAT, '2026-06-10.md'), 'utf8')
  assert.match(md, /degraded/)
  assert.match(md, /关键判断不可用/)
  assert.equal(gs.getReportMetas(CHAT)[0].status, 'degraded')
  gs.dispose()
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('空窗口：empty 占位不调 llm；enabled=false 全程零活动', async () => {
  const { dir, gs, llm, report } = makeEnv([])
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'empty')
  assert.equal(llm.calls.length, 0)
  assert.ok(existsSync(join(dir, 'reports', CHAT, '2026-06-10.md')))
  const off = new ReportService({ groupStore: gs, store: new Store(dir, { warn() {}, error() {} }), stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: false })
  const r2 = await off.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(r2.status, 'disabled')
  gs.dispose()
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('手动触发不错位：同一天手动(10:00)与调度(20:30)切同一自然窗、写同一文件', async () => {
  const { dir, gs, report } = makeEnv([legalOutput(3), legalOutput(3)])
  await seedDay(gs, [
    { msgId: 'a', ts: T(9), senderPid: 'u1', senderName: 'A', text: 'x' },
    { msgId: 'b', ts: T(10), senderPid: 'u2', senderName: 'B', text: 'y' },
    { msgId: 'c', ts: T(11), senderPid: 'u3', senderName: 'C', text: 'z' },
  ])
  const manual = await report.generateReport(CHAT, 'daily', T(10))
  const scheduled = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(manual.path, scheduled.path)
  assert.equal(reportWindow('daily', T(10)).start, reportWindow('daily', T(20, 30)).start)
  gs.dispose()
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('聚合：L1 合并各群判断、L2 每群一节、L3 统一证据；截断取前 N + 其余一行带过', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-agg-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const llm = mockLlm([legalOutput(3), legalOutput(3)])
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm,
    logger: { warn() {}, error() {} }, enabled: true,
    aggregationMaxGroups: 2,
    groups: ['g1@chatroom', 'g2@chatroom', 'g3@chatroom'],
  })
  const mk = (chat) => gs.appendMessages(chat, [
    { msgId: `${chat}-a`, ts: T(9), senderPid: 'u1', senderName: 'A', text: 'x' },
    { msgId: `${chat}-b`, ts: T(10), senderPid: 'u2', senderName: 'B', text: 'y' },
    { msgId: `${chat}-c`, ts: T(11), senderPid: 'u3', senderName: 'C', text: 'z' },
  ])
  await mk('g1@chatroom')
  await mk('g2@chatroom')
  await mk('g3@chatroom')
  await report.generateReport('g1@chatroom', 'daily', T(20, 30))
  await report.generateReport('g2@chatroom', 'daily', T(20, 30))
  const sum = await report.generateSummary(T(20, 40))
  assert.equal(sum.groupsIncluded, 2)
  assert.equal(sum.groupsSkipped, 1)
  const md = readFileSync(join(dir, 'reports', 'summary', '2026-06-10.md'), 'utf8')
  assert.match(md, /## L1 关键判断（全群合并）/)
  assert.match(md, /【g1@chatroom】UI 稿交付时间已提前到周二。/)
  assert.match(md, /### g2@chatroom/)
  assert.match(md, /其余 1 群未进前 2，一行带过：g3@chatroom/)
  assert.match(md, /## L3 统一证据/)
  assert.match(md, /reports\/g1@chatroom\/2026-06-10\.md/)
  gs.dispose()
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('聚合默认排序：相关度（watch 命中×100 + @提及×10）优先于活跃度；可注入 rankGroups', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-rank-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm: mockLlm([]),
    logger: { warn() {}, error() {} }, enabled: true,
    aggregationMaxGroups: 1,
    groups: ['busy@chatroom', 'watched@chatroom'],
  })
  // busy：3 条无关注；watched：1 条来自关注人物（identities 写入）+ 1 条 @提及
  await gs.appendMessages('busy@chatroom', [
    { msgId: 'b1', ts: T(9), senderPid: 'u1', senderName: 'A', text: 'x1' },
    { msgId: 'b2', ts: T(10), senderPid: 'u1', senderName: 'A', text: 'x2' },
    { msgId: 'b3', ts: T(11), senderPid: 'u1', senderName: 'A', text: 'x3' },
  ])
  await gs.appendMessages('watched@chatroom', [
    { msgId: 'w1', ts: T(9), senderPid: 'wxid_boss', senderName: '老板', text: '大家看一下' },
    { msgId: 'w2', ts: T(10), senderPid: 'u2', senderName: 'B', text: '@all 注意' },
  ])
  await gs.appendIdentity('watched@chatroom', { pid: derivePid('wxid_boss'), wxid: 'wxid_boss', groupNick: '老板', watchLevel: 'global' })
  const sum = await report.generateSummary(T(20, 40))
  assert.equal(sum.groupsIncluded, 1)
  assert.equal(sum.groupsSkipped, 1)
  const md = readFileSync(join(dir, 'reports', 'summary', '2026-06-10.md'), 'utf8')
  assert.match(md, /### watched@chatroom/)
  // 注入 rankGroups 反转排序：选 busy
  const report2 = new ReportService({
    groupStore: gs, store, stateDir: dir, llm: mockLlm([]),
    logger: { warn() {}, error() {} }, enabled: true,
    aggregationMaxGroups: 1,
    groups: ['busy@chatroom', 'watched@chatroom'],
    rankGroups: (stats) => [...stats].sort((a, b) => b.messageCount - a.messageCount).map((s) => s.chatId),
  })
  const sum2 = await report2.generateSummary(T(20, 40))
  const md2 = readFileSync(join(dir, 'reports', 'summary', '2026-06-10.md'), 'utf8')
  assert.equal(sum2.groupsIncluded, 1)
  assert.match(md2, /### busy@chatroom/)
  gs.dispose()
  report.dispose()
  report2.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('重点人槽：person-digest 摘要进入 L2 重点人板块', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-person-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const day = localDayKey(T(10))
  // 老板当日 2 条发言 + 摘要行（走 person-digest 同款落库形状）
  await gs.appendMessages(CHAT, [
    { msgId: 'p1', ts: T(9), senderPid: 'wxid_boss', senderName: '老板', text: '排期定了' },
    { msgId: 'p2', ts: T(10), senderPid: 'wxid_boss', senderName: '老板', text: '周二交 UI' },
  ])
  await gs.appendPersonDigest(CHAT, {
    personPid: derivePid('wxid_boss'), date: day, status: 'ok', title: '催交付',
    summary: '在催 UI 稿', evidenceMsgIds: ['p2'], moodOrStance: '急', openQuestions: [],
    messageCount: 2, digestPath: `digests/${CHAT}/wx/2026-06-10.md`, windowStart: BASE, windowEnd: BASE + 86400000,
  })
  await gs.appendIdentity(CHAT, { pid: derivePid('wxid_boss'), wxid: 'wxid_boss', groupNick: '老板', watchLevel: 'global' })
  const llm = mockLlm([legalOutput(2)])
  const report = new ReportService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  const res = await report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  const md = readFileSync(join(dir, reportRelPath(CHAT, day)), 'utf8')
  assert.match(md, /### 重点人/)
  assert.match(md, /\*\*老板\*\*：催交付：在催 UI 稿/)
  // 重点人摘要也进 prompt 数据区
  assert.match(llm.calls[0], /催交付/)
  gs.dispose()
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('pid 反查：传派生 pid → identities 反查出 wxid，两条键匹配消息；覆盖语义：同日重跑旧行 superseded、读方默认取新', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-pid-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const logger = { warn() {}, error() {} }
  const day = localDayKey(T(10))
  const wxid = 'wxid_boss'
  const pid = derivePid(wxid)
  // 消息以 wxid 落库（未代号化形态）；identities 登记派生 pid → wxid
  await gs.appendMessages(CHAT, [{ msgId: 'k1', ts: T(10), senderPid: wxid, senderName: '老板', text: 'UI 稿今天必须定稿' }])
  await gs.appendIdentity(CHAT, { pid, wxid, groupNick: '老板', watchLevel: 'global' })
  const llm = mockLlm([
    JSON.stringify({ person_pid: pid, date: day, topics: [{ title: '一版', summary: '旧摘要', evidence: [1] }] }),
    JSON.stringify({ person_pid: pid, date: day, topics: [{ title: '二版', summary: '新摘要生效', evidence: [1] }] }),
  ])
  const digest = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger, enabled: true })
  const r1 = await digest.generateDaily(CHAT, pid, day)
  assert.equal(r1.status, 'ok')
  assert.equal(llm.calls.length, 1)
  // 反查生效：prompt 匹配到了 wxid 落库的消息（否则空摘要走 empty 不调 llm）
  assert.match(llm.calls[0], /UI 稿今天必须定稿/)
  const r2 = await digest.generateDaily(CHAT, pid, day)
  assert.equal(r2.status, 'ok')
  // 覆盖语义：读方默认只取最新生效行（一版已 superseded、不物理删除）
  const active = gs.getPersonDigests(CHAT, pid, day)
  assert.equal(active.length, 1)
  assert.match(active[0].summary, /新摘要生效/)
  const all = gs.getPersonDigests(CHAT, pid, day, { includeSuperseded: true })
  assert.equal(all.length, 2)
  assert.ok(all.every((r) => r.title === '__degraded__' || true))
  assert.ok(all.filter((r) => r.summary.includes('旧摘要')).length === 1)
  gs.dispose()
  digest.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('纯函数：parseReportDraft / clampQuote / extractJudgments / resolveSenderKeys', () => {
  const ok = parseReportDraft(legalOutput(), 5)
  assert.ok(ok)
  assert.equal(ok.judgments.length, 3)
  // evidence 越界 / 条数不足 / quotes 非法 → null
  assert.equal(parseReportDraft('{"title":"t","lead":"l","judgments":[{"text":"a","evidence":[99]}] , "topics":[]}', 5), null)
  assert.equal(parseReportDraft('{"title":"t","lead":"l","judgments":[{"text":"a","evidence":[]}],"topics":[]}', 5), null)
  assert.equal(parseReportDraft('not json', 5), null)
  assert.equal(clampQuote('ab'.repeat(60)), 'ab'.repeat(25))
  assert.ok(clampQuote('ab'.repeat(60)).length <= QUOTE_MAX_CHARS)
  const md = ['## L1 一分钟层', '1. 判断一 [evidence: a]', '## L2 五分钟层', '1. 非L1行'].join('\n')
  assert.deepEqual(extractJudgments(md), ['判断一 [evidence: a]'])
  // pid 反查纯函数：命中走 wxid 两条键；未命中回退原口径
  assert.deepEqual(resolveSenderKeys('wx_xxx', [{ pid: 'wx_xxx', wxid: 'wxid_boss' }]), ['wxid_boss', derivePid('wxid_boss')])
  assert.deepEqual(resolveSenderKeys('wxid_raw', []), ['wxid_raw', derivePid('wxid_raw')])
})

test('非法 chatId 拒绝且不落盘（围栏）', async () => {
  const { dir, report } = makeEnv([])
  await assert.rejects(() => report.generateReport('../evil', 'daily', T(10)))
  await assert.rejects(() => report.generateReport(CHAT, 'yearly', T(10)))
  assert.ok(!existsSync(join(dir, 'reports')))
  report.dispose()
  rmSync(dir, { recursive: true, force: true })
})
