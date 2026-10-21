// report-outbox.test.mjs —— FE-3「排入发件箱」：插件侧开关、入队形状、去重，以及入队后走既有 sender 链路
// （真实 SenderService，dry-run / 总闸关两种）。全离线：runCommand / isFrontmost 注入 mock。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { createReportOutbox, REPORT_OUTBOX_DEDUPE_MS, WEB_PUSH_MARK } = await import('../lib/report-outbox.js')
const { ActionInbox, ACTIONS_REL, ACTION_RESULTS_REL } = await import('../lib/action-inbox.js')
const { SenderService, buildSendText } = await import('../lib/sender.js')
const { Outbox } = await import('../lib/outbox.js')
const { Store } = await import('../lib/store.js')
const { reportRelPath } = await import('../lib/report.js')

const CHAT = '12345678@chatroom'
const DAY = '2026-10-14'
const SECRET = '只在报告正文里的合成内容 synth-0001'
const silent = { info() {}, warn() {}, error() {} }

function makeEnv() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'report-outbox-')))
  let clock = new Date(2026, 9, 14, 12, 0).getTime()
  const now = () => clock
  const store = new Store(dir, silent)
  store.ensureDir('.')
  const outbox = new Outbox({ store, now })
  store.writeReport('daily', CHAT, DAY, `# 日报 ${DAY}\n\n- ${SECRET}\n`)
  return { dir, store, outbox, now, advance: (ms) => { clock += ms }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('入队形状与定时报告同形：kind=周期、evidence_ref=报告路径、标题带前端补推标记；正文只含元数据', () => {
  const env = makeEnv()
  try {
    const push = createReportOutbox({ store: env.store, outbox: env.outbox, now: env.now })
    assert.equal(push(CHAT, 'daily', DAY), 'ok')
    const [e] = env.outbox.listOutbox()
    assert.equal(e.kind, 'daily')
    assert.equal(e.channel, 'filehelper')
    assert.equal(e.status, 'pending')
    assert.equal(e.evidence_ref, reportRelPath(CHAT, DAY, 'daily'))
    assert.ok(e.title.endsWith(WEB_PUSH_MARK))
    assert.equal(JSON.stringify(e).includes(SECRET), false, '报告正文不进 outbox 条目')
    assert.equal(buildSendText(e.title, e.body).includes(SECRET), false, '发送文本不含报告正文')
  } finally { env.cleanup() }
})

test('报告不存在 → not_found 零入队；10 分钟内重复 → duplicate；窗口过后可再排', () => {
  const env = makeEnv()
  try {
    const push = createReportOutbox({ store: env.store, outbox: env.outbox, now: env.now })
    assert.equal(push(CHAT, 'daily', '2026-10-15'), 'not_found')
    assert.equal(push(CHAT, 'weekly', '2026-10-12'), 'not_found', '同日日报存在不代表周报存在')
    assert.equal(env.outbox.listOutbox().length, 0)
    assert.equal(push(CHAT, 'daily', DAY), 'ok')
    env.advance(REPORT_OUTBOX_DEDUPE_MS - 1000)
    assert.equal(push(CHAT, 'daily', DAY), 'duplicate')
    env.advance(2000)
    assert.equal(push(CHAT, 'daily', DAY), 'ok')
    assert.equal(env.outbox.listOutbox().length, 2)
  } finally { env.cleanup() }
})

test('跨群汇总：标题为「跨群汇总 <日期>（前端补推）」，evidence_ref 指向 reports/summary/', () => {
  const env = makeEnv()
  try {
    env.store.writeReport('daily', 'aggregate', DAY, `# 跨群汇总 · ${DAY}\n\n- ${SECRET}\n`)
    const push = createReportOutbox({ store: env.store, outbox: env.outbox, now: env.now })
    assert.equal(push('aggregate', 'daily', DAY), 'ok')
    const [e] = env.outbox.listOutbox()
    assert.equal(e.title, `跨群汇总 ${DAY}${WEB_PUSH_MARK}`)
    assert.equal(e.evidence_ref, `reports/summary/${DAY}.md`)
    assert.equal(JSON.stringify(e).includes(SECRET), false)
  } finally { env.cleanup() }
})

test('定时报告的 outbox 条目不影响去重（只认前端补推标记）', () => {
  const env = makeEnv()
  try {
    env.outbox.appendOutbox({ kind: 'daily', title: `日报已生成（${CHAT}）`, body: '关键判断 3 条', evidence_ref: reportRelPath(CHAT, DAY, 'daily') })
    const push = createReportOutbox({ store: env.store, outbox: env.outbox, now: env.now })
    assert.equal(push(CHAT, 'daily', DAY), 'ok')
  } finally { env.cleanup() }
})

function inboxWith(env, reportOutbox) {
  const actions = { reportRegen: async () => true } // 本文件只走 report.toOutbox，门面其余方法不被调用
  return new ActionInbox({ store: env.store, actions, groups: [CHAT], logger: silent, reportOutbox })
}

function runLines(env, inbox, lines) {
  env.store.ensureDir('web')
  env.store.writeText(ACTIONS_REL, lines.map(l => JSON.stringify({ ts: 1, chatId: CHAT, ...l })).join('\n') + '\n')
  return inbox.poll().then(() => env.store.readText(ACTION_RESULTS_REL).trim().split('\n').map(JSON.parse).map(r => [r.actionId, r.code]))
}

test('开关关（未注入 reportOutbox）：report.toOutbox 一律 unsupported，outbox 零条目', async () => {
  const env = makeEnv()
  try {
    const codes = await runLines(env, inboxWith(env, undefined), [{ actionId: 'o1', type: 'report.toOutbox', params: { kind: 'daily', dateKey: DAY } }])
    assert.deepEqual(codes, [['o1', 'unsupported']])
    assert.equal(env.outbox.listOutbox().length, 0)
  } finally { env.cleanup() }
})

test('开关开：入队 ok / 重复 duplicate / 不存在 not_found / 非周期起点 bad_request / 白名单外 chat_not_allowed', async () => {
  const env = makeEnv()
  try {
    const push = createReportOutbox({ store: env.store, outbox: env.outbox, now: env.now })
    const codes = await runLines(env, inboxWith(env, push), [
      { actionId: 'o1', type: 'report.toOutbox', params: { kind: 'daily', dateKey: DAY } },
      { actionId: 'o2', type: 'report.toOutbox', params: { kind: 'daily', dateKey: DAY } },
      { actionId: 'o3', type: 'report.toOutbox', params: { kind: 'daily', dateKey: '2026-10-15' } },
      { actionId: 'o4', type: 'report.toOutbox', params: { kind: 'weekly', dateKey: DAY } },
      { actionId: 'o5', type: 'report.toOutbox', chatId: '1234567890@chatroom', params: { kind: 'daily', dateKey: DAY } },
    ])
    assert.deepEqual(codes, [['o1', 'ok'], ['o2', 'duplicate'], ['o3', 'not_found'], ['o4', 'bad_request'], ['o5', 'chat_not_allowed']])
    assert.equal(env.outbox.listOutbox().length, 1)
  } finally { env.cleanup() }
})

function makeSender(env, { enabled, dryRun }) {
  const spawnCalls = []
  const sender = new SenderService({
    outbox: env.outbox, store: env.store, logger: silent, enabled, dryRun,
    maxSendsPerDay: 20, now: env.now,
    sourceToolDir: '/fake/macos-wechat-export', sourceDbRoot: '/fake/wechat-db-storage', sourcePython: 'python3',
    sendTargetChat: '目标会话', readbackChatId: 'wxid_target',
    sleepMs: () => Promise.resolve(),
    runCommand: (file, args) => { spawnCalls.push({ file, args }); return Promise.resolve({ code: 0, stdout: '', stderr: '' }) },
    isFrontmost: () => Promise.resolve(true),
  })
  return { sender, spawnCalls }
}

test('入队后走既有 sender 链路：总闸关 → 零活动、条目保持 pending', async () => {
  const env = makeEnv()
  try {
    createReportOutbox({ store: env.store, outbox: env.outbox, now: env.now })(CHAT, 'daily', DAY)
    const { sender, spawnCalls } = makeSender(env, { enabled: false, dryRun: true })
    assert.equal((await sender.processOnce()).action, 'disabled')
    assert.equal(spawnCalls.length, 0)
    assert.equal(env.outbox.listOutbox()[0].status, 'pending')
  } finally { env.cleanup() }
})

test('入队后走既有 sender 链路：dryRun → 只到进入对话为止（无回读）、条目转 dry_run', async () => {
  const env = makeEnv()
  try {
    createReportOutbox({ store: env.store, outbox: env.outbox, now: env.now })(CHAT, 'daily', DAY)
    const { sender, spawnCalls } = makeSender(env, { enabled: true, dryRun: true })
    await sender.processOnce()
    assert.equal(env.outbox.listOutbox()[0].status, 'dry_run')
    assert.equal(spawnCalls.filter(c => c.file !== 'osascript').length, 0, 'dry_run 只有 osascript 键序，无回读')
    assert.equal(spawnCalls.some(c => c.args.some(a => String(a).includes(SECRET))), false, '键序参数不含报告正文')
  } finally { env.cleanup() }
})

test('接线：index.ts 只在 webOutboxEnabled 时注入 reportOutbox，配置默认 false', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
  assert.match(src, /reportOutbox: config\.webOutboxEnabled \? createReportOutbox\(/)
  assert.match(src, /webOutboxEnabled: Schema\.boolean\(\)\.default\(false\)/)
})
