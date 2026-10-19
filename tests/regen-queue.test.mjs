// regen-queue.test.mjs —— 错号空报告补发队列（状态机 + 持久化 + 补生成报告链路，全离线 mock）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { RegenQueue, REGEN_QUEUE_REL, REGEN_QUEUE_MAX } = await import('../lib/regen-queue.js')
const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService, reportWindow } = await import('../lib/report.js')

const CHAT = '12345678@chatroom'
const BASE = new Date(2026, 5, 10).getTime()
const T = (h, m = 0) => BASE + h * 3600_000 + m * 60_000
const DAY = '2026-06-10'

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

test('RegenQueue：同键去重、上限淘汰最旧、持久化跨重启', () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'regenq-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const logger = { warn(m) { warnings.push(m) }, error() {} }
  const warnings = []
  const q = new RegenQueue({ store, logger })
  assert.equal(q.enqueue(CHAT, DAY, 1000), 'queued')
  assert.equal(q.enqueue(CHAT, DAY, 2000), 'deduped', '同键去重')
  assert.equal(q.list().length, 1)
  // 上限淘汰
  for (let i = 0; i < REGEN_QUEUE_MAX + 2; i++) {
    q.enqueue(`c${i}@chatroom`, `2026-06-${String(10 + (i % 18)).padStart(2, '0')}`, 3000 + i)
  }
  assert.equal(q.list().length, REGEN_QUEUE_MAX)
  assert.ok(warnings.some((w) => w.includes('丢弃最旧')), '超限 warn')
  assert.equal(q.has(CHAT, DAY), false, '最旧（首条）被淘汰')
  // 持久化：新实例读取同文件
  const q2 = new RegenQueue({ store, logger })
  assert.equal(q2.list().length, REGEN_QUEUE_MAX)
  assert.ok(existsSync(join(dir, REGEN_QUEUE_REL)))
  rmSync(dir, { recursive: true, force: true })
})

test('补发链路：backfillDateKey 锚定窗口（含正号登录后同步的消息）→ 覆盖写报告 + meta 同键', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'regen-r-')))
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const calls = []
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir,
    llm: { async complete(prompt) { calls.push(prompt); return legalDraft([1]) } },
    logger: { warn() {}, error() {} },
    enabled: true,
  })
  // 消息落在 backfill 窗口内（6/09 20:20 之后、6/11 之前）
  await gs.appendMessages(CHAT, [
    { msgId: 'm1', ts: T(9), senderPid: 'wxid_a', senderName: '爱丽丝', text: '早' },
    { msgId: 'm2', ts: T(10), senderPid: 'wxid_b', senderName: '老板', text: 'UI 稿提前到周二' },
    { msgId: 'm3', ts: T(11), senderPid: 'wxid_c', senderName: '阿丙', text: '周四联调' },
  ])
  // 再生成时刻为 6/11 15:00（正号次日下午登录）；backfill dateKey = 6/10
  const asOf = new Date(2026, 5, 11, 15, 0).getTime()
  const res = await report.generateReport(CHAT, 'daily', asOf, DAY)
  assert.equal(res.status, 'ok', '补发窗口覆盖同步消息 → 正常产出')
  assert.equal(res.messageCount, 3)
  assert.equal(res.path, `reports/${CHAT}/${DAY}.md`, '报告仍按 backfill dateKey 命名')
  assert.equal(calls.length, 1)
  // meta 同键覆盖（date_key=6/10）
  const metas = gs.getReportMetas(CHAT, { kind: 'daily', limit: 5 })
  assert.equal(metas.length, 1)
  assert.equal(metas[0].date, DAY)
  assert.equal(metas[0].status, 'ok')
  rmSync(dir, { recursive: true, force: true })
})
