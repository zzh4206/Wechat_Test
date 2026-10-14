// sender.test.mjs —— 红线升级（2026-10-14）：filehelper 发送 worker（全离线 mock）。
// 覆盖：pending→sent 全流程、dry_run 不真调 send、非 filehelper 永不发（通道闸）、
//       失败 3 次转 failed、频控 skipped_quota、幂等 --id 传递、交互闸跳过、
//       audit 无正文、buildSendText 单行/截断、总闸默认关、sendTestSample 与真实条目解耦。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { SenderService, buildSendText, ALLOWED_CHANNELS, SENDER_AUDIT_REL, MAX_ATTEMPTS } = await import('../lib/sender.js')
const { Outbox, OUTBOX_REL } = await import('../lib/outbox.js')
const { Store } = await import('../lib/store.js')

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
function recordingLogger() {
  const logs = { info: [], warn: [], error: [] }
  return { logs, info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) }
}

function makeEnv(overrides = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'sender-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store, now: () => Date.now() })
  const spawnCalls = []
  const env = {
    dir, store, outbox, spawnCalls,
    frontmost: true,
    sender: null,
    ...overrides,
  }
  env.sender = new SenderService({
    outbox,
    store,
    logger: overrides.logger ?? silentLogger,
    enabled: overrides.enabled ?? true,
    dryRun: overrides.dryRun ?? false,
    maxSendsPerDay: overrides.maxSendsPerDay ?? 20,
    wechatUiPath: overrides.wechatUiPath ?? 'wechat-ui',
    composerTop: overrides.composerTop ?? 0.7,
    now: overrides.now ?? (() => new Date(2026, 9, 14, 12, 0).getTime()),
    runCommand: (file, args) => {
      spawnCalls.push({ file, args })
      return Promise.resolve(overrides.spawnResult ?? { code: 0, stdout: 'sent_ui_verified', stderr: '' })
    },
    isFrontmost: () => Promise.resolve(env.frontmost),
  })
  return env
}

function readOutbox(dir) {
  if (!existsSync(join(dir, OUTBOX_REL))) return []
  return readFileSync(join(dir, OUTBOX_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}
function readAudit(dir) {
  const p = join(dir, SENDER_AUDIT_REL)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l))
}

test('buildSendText：前缀 + 160 字摘要 + 单行 + 总长 ≤200 + 换行/控制符替换', () => {
  const t = buildSendText('日报已生成', '第一行\n第二行\t第三行')
  assert.ok(t.startsWith('【lurker】日报已生成'))
  assert.ok(!t.includes('\n') && !t.includes('\t'))
  assert.ok(t.length <= 200)
  const long = buildSendText('x'.repeat(300), 'y'.repeat(500))
  assert.equal(long.length, 200)
  const summary = buildSendText('t', 'b'.repeat(300))
  // head '【lurker】t' 9 字符 + 空格 + 摘要 ≤160
  assert.ok(summary.length <= 170)
  // 注入文本只能作为参数值，不会逃逸
  assert.ok(buildSendText('a; rm -rf /', '$(boom)').startsWith('【lurker】a; rm -rf /'))
})

test('总闸：enabled=false 零活动（不调 spawn、不改 outbox）', async () => {
  const env = makeEnv({ enabled: false })
  env.outbox.appendOutbox({ kind: 'daily', title: '日报', body: '正文', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'disabled')
  assert.equal(env.spawnCalls.length, 0)
  assert.equal(readOutbox(env.dir)[0].status, 'pending')
  const stop = env.sender.start()
  stop()
  assert.equal(env.spawnCalls.length, 0)
  rmSync(env.dir, { recursive: true, force: true })
})

test('全流程：pending → sent，spawn 参数形态正确（--id 幂等传递 + --composer-top）', async () => {
  const env = makeEnv()
  const e = env.outbox.appendOutbox({ kind: 'daily', title: '日报已生成', body: '关键判断 3 条', evidence_ref: 'reports/x.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  assert.equal(env.spawnCalls.length, 1)
  const call = env.spawnCalls[0]
  assert.equal(call.file, 'wechat-ui')
  assert.equal(call.args[0], 'send')
  assert.deepEqual(call.args.slice(1, 3), ['--chat', '文件传输助手'])
  assert.ok(call.args.includes('--id'))
  assert.equal(call.args[call.args.indexOf('--id') + 1], e.id)
  assert.deepEqual(call.args.slice(call.args.indexOf('--composer-top'), call.args.indexOf('--composer-top') + 2), ['--composer-top', '0.7'])
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'sent')
  assert.equal(after.attempts, 1)
  rmSync(env.dir, { recursive: true, force: true })
})

test('dry_run：不调 send，条目转 dry_run，审计只记元数据', async () => {
  const env = makeEnv({ dryRun: true })
  const e = env.outbox.appendOutbox({ kind: 'weekly', title: '周报', body: '机密正文内容', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent') // 消费完成但走 dry_run 路径
  assert.equal(env.spawnCalls.length, 0, 'dry_run 绝不调 wechat-ui send')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'dry_run')
  rmSync(env.dir, { recursive: true, force: true })
})

test('通道闸：非 filehelper 的 pending 条目直接 skip 并 error 日志，spawn 永不发出', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'sender-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const logger = recordingLogger()
  const outbox = new Outbox({ store })
  const e = outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  // 手工伪造一个"非法通道"条目（绕过类型，模拟未来误加通道）
  const raw = readFileSync(join(dir, OUTBOX_REL), 'utf8').replace('"channel":"filehelper"', '"channel":"groupchat"')
  store.writeText(OUTBOX_REL, raw)
  const spawnCalls = []
  const sender = new SenderService({
    outbox, store, logger,
    enabled: true, dryRun: false,
    runCommand: (file, args) => { spawnCalls.push({ file, args }); return Promise.resolve({ code: 0, stdout: 'sent_ui_verified', stderr: '' }) },
    isFrontmost: () => Promise.resolve(true),
  })
  const r = await sender.processOnce()
  assert.equal(r.action, 'empty')
  assert.equal(spawnCalls.length, 0, '非白名单通道永不发送')
  assert.equal(readOutbox(dir).find((x) => x.id === e.id).status, 'skipped_channel')
  assert.ok(logger.logs.error.some((m) => m.includes('groupchat') && m.includes('never sent')))
  assert.equal(ALLOWED_CHANNELS.length, 1)
  assert.equal(ALLOWED_CHANNELS[0], 'filehelper')
  rmSync(dir, { recursive: true, force: true })
})

test('失败重试：attempts 落盘，≥3 次转 failed 不再重试（防风暴）', async () => {
  const env = makeEnv({ spawnResult: { code: 1, stdout: 'contact_mismatch', stderr: '' } })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 1; i <= MAX_ATTEMPTS; i++) await env.sender.processOnce()
  assert.equal(env.spawnCalls.length, MAX_ATTEMPTS)
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'failed')
  assert.equal(after.attempts, MAX_ATTEMPTS)
  // failed 不再被消费
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'empty')
  assert.equal(env.spawnCalls.length, MAX_ATTEMPTS)
  rmSync(env.dir, { recursive: true, force: true })
})

test('频控：maxSendsPerDay 超限的当日 pending 标 skipped_quota', async () => {
  const env = makeEnv({ maxSendsPerDay: 2 })
  const ids = []
  for (let i = 0; i < 4; i++) {
    ids.push(env.outbox.appendOutbox({ kind: 'remind', title: `t${i}`, body: 'b', evidence_ref: 'x' }).id)
  }
  const r = await env.sender.processOnce()
  assert.equal(env.spawnCalls.length, 2)
  const states = Object.fromEntries(readOutbox(env.dir).map((x) => [x.id, x.status]))
  assert.equal(states[ids[0]], 'sent')
  assert.equal(states[ids[1]], 'sent')
  assert.equal(states[ids[2]], 'skipped_quota')
  assert.equal(states[ids[3]], 'skipped_quota')
  rmSync(env.dir, { recursive: true, force: true })
})

test('交互闸：微信非前台 → 跳过本轮条目保持 pending，连续 N 轮后 warn', async () => {
  const env = makeEnv()
  env.frontmost = false
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 0; i < 3; i++) {
    const r = await env.sender.processOnce()
    assert.equal(r.action, 'not_frontmost')
    assert.equal(env.spawnCalls.length, 0)
  }
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'pending')
  rmSync(env.dir, { recursive: true, force: true })
  // warn 断言（独立环境，注入 recording logger）
  const env2 = makeEnv({ logger: recordingLogger() })
  env2.frontmost = false
  env2.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 0; i < 3; i++) await env2.sender.processOnce()
  assert.ok(env2.logger.logs.warn.some((m) => m.includes('文件传输助手')))
  rmSync(env2.dir, { recursive: true, force: true })
})

test('audit 无正文：只记 id/kind/result/attempts 元数据', async () => {
  const env = makeEnv()
  env.outbox.appendOutbox({ kind: 'daily', title: '机密标题abc', body: '机密正文xyz', evidence_ref: 'x' })
  await env.sender.processOnce()
  const audit = readAudit(env.dir)
  assert.equal(audit.length, 1)
  const raw = JSON.stringify(audit)
  assert.ok(!raw.includes('机密标题abc'))
  assert.ok(!raw.includes('机密正文xyz'))
  assert.equal(audit[0].result, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('start()/stop：enabled=false 为 noop；enabled=true 心跳运行并可清理（dispose 无残留）', async () => {
  const env = makeEnv({ enabled: false })
  let stopped = env.sender.start()
  stopped()
  stopped() // 幂等
  assert.equal(env.spawnCalls.length, 0)

  let fired = 0
  let tick
  const fakeSetInterval = (fn) => { tick = fn; return 42 }
  const fakeClearInterval = (handle) => { if (handle === 42) fired = -1 }
  const sender = new SenderService({
    outbox: env.outbox, store: env.store, logger: silentLogger,
    enabled: true, dryRun: true,
    runCommand: () => Promise.resolve({ code: 0, stdout: 'sent_ui_verified', stderr: '' }),
    isFrontmost: () => Promise.resolve(true),
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    tickMs: 10,
    now: () => Date.now(),
  })
  const stop = sender.start()
  assert.equal(typeof tick, 'function')
  await tick()
  stop()
  assert.equal(fired, -1, 'clearInterval 被调用（唯一释放点）')
  rmSync(env.dir, { recursive: true, force: true })
})

test('sendTestSample：样例条目走完整链路 pending→sent；真实 daily 条目不受影响仍 pending', async () => {
  const env = makeEnv()
  const real = env.outbox.appendOutbox({ kind: 'daily', title: '真实日报', body: '真实正文', evidence_ref: 'reports/real.md' })
  const r = await env.sender.sendTestSample()
  assert.equal(r.action, 'sent')
  assert.ok(r.id && r.id !== real.id)
  assert.equal(env.spawnCalls.length, 1)
  const call = env.spawnCalls[0]
  assert.equal(call.args[call.args.indexOf('--id') + 1], r.id, '样例用自己唯一的幂等 --id')
  const sample = readOutbox(env.dir).find((x) => x.id === r.id)
  assert.equal(sample.status, 'sent')
  assert.equal(sample.kind, 'test_sample')
  assert.equal(sample.channel, 'filehelper')
  assert.ok(sample.title.includes('测试样例'))
  assert.ok(sample.body.includes('2026-10-14') || sample.body.includes('T0'), 'body 含时间戳')
  assert.equal(sample.evidence_ref, 'test')
  // 真实条目不动
  assert.equal(readOutbox(env.dir).find((x) => x.id === real.id).status, 'pending')
  rmSync(env.dir, { recursive: true, force: true })
})

test('sendTestSample：dry_run 下只记审计不真发；总闸关闭时拒绝', async () => {
  const env = makeEnv({ dryRun: true })
  const r = await env.sender.sendTestSample()
  assert.equal(r.action, 'dry_run')
  assert.equal(env.spawnCalls.length, 0)
  assert.equal(readOutbox(env.dir).find((x) => x.id === r.id).status, 'dry_run')
  rmSync(env.dir, { recursive: true, force: true })

  const env2 = makeEnv({ enabled: false })
  const r2 = await env2.sender.sendTestSample()
  assert.equal(r2.action, 'disabled')
  assert.equal(env2.spawnCalls.length, 0)
  assert.equal(readOutbox(env2.dir).length, 0, '总闸关 = 连样例条目都不入箱')
  rmSync(env2.dir, { recursive: true, force: true })
})

test('sendTestSample：交互闸/频控同样生效（不开后门）', async () => {
  const env = makeEnv()
  env.frontmost = false
  const r = await env.sender.sendTestSample()
  assert.equal(r.action, 'not_frontmost')
  assert.equal(env.spawnCalls.length, 0)
  assert.equal(readOutbox(env.dir).find((x) => x.id === r.id).status, 'pending')
  rmSync(env.dir, { recursive: true, force: true })

  const env2 = makeEnv({ maxSendsPerDay: 1 })
  env2.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  await env2.sender.processOnce() // 用掉当日 1 次配额
  const r2 = await env2.sender.sendTestSample()
  assert.equal(r2.action, 'quota')
  assert.equal(readOutbox(env2.dir).find((x) => x.id === r2.id).status, 'skipped_quota')
  rmSync(env2.dir, { recursive: true, force: true })
})
