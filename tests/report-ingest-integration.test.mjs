// report-ingest-integration.test.mjs —— P0 返工集成断言：从报告生成入口打穿到 knowledge.db
// 镜像（单群 daily/weekly/monthly 三类型 period 正确 + 月报补发 dateKey 锚定当月 1 号）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService } = await import('../lib/report.js')
const { openDb } = await import('../lib/db/db.js')
const { KnowledgeDao } = await import('../lib/db/dao.js')

const CHAT = '12345678@chatroom'
// 2026-06-10 是周三；6/08 周一；7/01 周三
const BASE = new Date(2026, 5, 10).getTime()
const T = (dayOff, h, m = 0) => BASE + dayOff * 86_400_000 + h * 3600_000 + m * 60_000

function legalDraft(ev = [1]) {
  return JSON.stringify({
    title: '排期敲定',
    lead: 'UI 稿今天定稿。',
    judgments: [
      { text: 'UI 稿交付时间已提前到周二。', evidence: ev },
      { text: '后端接口联调定在周四进行。', evidence: ev },
      { text: 'Bob 承诺下午给出测试环境。', evidence: ev },
    ],
    topics: [{ title: '排期', change: '提前一天', status: '', people: '', watch: '', evidence: ev }],
    quotes: ev,
  })
}

function makeEnv() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'ingest-')))
  const dbPath = join(dir, 'knowledge.db')
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} }, dbPath) // 镜像启用
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir,
    llm: { async complete() { return legalDraft([1]) } },
    logger: { warn() {}, error() {} },
    enabled: true,
  })
  const db = openDb(dbPath, { logger: { warn() {}, error() {} } })
  const dao = new KnowledgeDao(db, { warn() {}, error() {} })
  return { dir, dbPath, gs, store, report, dao, db }
}

async function seedDay(gs, dayOff) {
  await gs.appendMessages(CHAT, [
    { msgId: `m${dayOff}-1`, ts: T(dayOff, 9), senderPid: 'wxid_a', senderName: '爱丽丝', text: '早' },
    { msgId: `m${dayOff}-2`, ts: T(dayOff, 10), senderPid: 'wxid_b', senderName: '老板', text: 'UI 稿提前到周二' },
    { msgId: `m${dayOff}-3`, ts: T(dayOff, 11), senderPid: 'wxid_c', senderName: '阿丙', text: '周四联调' },
  ])
}

test('P0 集成：生成入口打穿镜像——单群 daily/weekly/monthly 三类型 period 全部正确入库', async () => {
  const env = makeEnv()
  // daily：6/10（周三）生成 → [6/10, 6/10]
  await seedDay(env.gs, 0)
  let res = await env.report.generateReport(CHAT, 'daily', T(0, 20, 30))
  assert.equal(res.status, 'ok')
  const daily = env.dao.getReport('daily', '2026-06-10', CHAT)
  assert.ok(daily, 'daily 实时入库（P0 回归断言）')
  assert.equal(daily.period_start, '2026-06-10')
  assert.equal(daily.period_end, '2026-06-10')

  // weekly：6/15（周一）生成 → [6/15, 6/21]
  await seedDay(env.gs, 5)
  res = await env.report.generateReport(CHAT, 'weekly', T(5, 20, 40))
  assert.equal(res.status, 'ok')
  const weekly = env.dao.getReport('weekly', '2026-06-15', CHAT)
  assert.ok(weekly, 'weekly 实时入库')
  assert.equal(weekly.period_start, '2026-06-15', '周一')
  assert.equal(weekly.period_end, '2026-06-21', '周一+6')

  // monthly：7/01 生成 → [7/01, 7/31]
  await seedDay(env.gs, 21)
  res = await env.report.generateReport(CHAT, 'monthly', T(21, 20, 50))
  assert.equal(res.status, 'ok')
  const monthly = env.dao.getReport('monthly', '2026-07-01', CHAT)
  assert.ok(monthly, 'monthly 实时入库')
  assert.equal(monthly.period_start, '2026-07-01', '1 号')
  assert.equal(monthly.period_end, '2026-07-31', '月末')

  // 幂等：重生成行数不变
  const before = env.dao.count('report')
  await env.report.generateReport(CHAT, 'daily', T(0, 20, 35))
  assert.equal(env.dao.count('report'), before, '同键重生成 upsert 行数不变')

  env.db.close()
  rmSync(env.dir, { recursive: true, force: true })
})

test('月报补发 dateKey 锚定当月 1 号（验收裁定 §三-2）：backfill → dateKey=1 号且窗口覆盖整月', async () => {
  const env = makeEnv()
  // 月内消息（6/10–6/12）；补发时刻 7/05（正号 7 月才登录）
  for (const off of [0, 1, 2]) await seedDay(env.gs, off)
  const asOf = T(25, 10, 0) // 2026-07-05 10:00
  const res = await env.report.generateReport(CHAT, 'monthly', asOf, '2026-06-01')
  assert.equal(res.status, 'ok')
  assert.equal(res.path, `reports/${CHAT}/monthly/2026-06-01.md`, '月报文件落 monthly 子目录、锚定 1 号')
  const monthly = env.dao.getReport('monthly', '2026-06-01', CHAT)
  assert.ok(monthly, '月报补发实时入库')
  assert.equal(monthly.period_start, '2026-06-01', 'dateKey 锚定当月 1 号')
  assert.equal(monthly.period_end, '2026-06-30')
  assert.equal(res.messageCount, 9, '窗口覆盖整月（periodStart 00:00 → 再生成时刻）')
  env.db.close()
  rmSync(env.dir, { recursive: true, force: true })
})
