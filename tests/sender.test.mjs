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

const FIXED_NOW = () => new Date(2026, 9, 14, 12, 0).getTime()
function makeEnv(overrides = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'sender-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  // Outbox 与 SenderService 必须同一时钟，否则频控的"今日已发"永远对不上（时点不一致 = quota 永不触发）
  const outbox = new Outbox({ store, now: overrides.now ?? FIXED_NOW })
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
    // 2026-10-19：发送只有键盘流程一条路（wechat-ui 录屏点击时代废弃）；键序细节见 keyboard-sender.test.mjs
    maxSendsPerDay: overrides.maxSendsPerDay ?? 20,
    now: overrides.now ?? FIXED_NOW,
    sourceToolDir: overrides.sourceToolDir ?? '/fake/macos-wechat-export',
    sourceDbRoot: overrides.sourceDbRoot ?? '/fake/wechat-db-storage',
    sourcePython: overrides.sourcePython ?? 'python3',
    sendTargetChat: overrides.sendTargetChat ?? '目标会话',
    readbackChatId: overrides.readbackChatId ?? 'wxid_target',
    accountGate: overrides.accountGate,
    sleepMs: () => Promise.resolve(), // 键序/验证延迟不真等待
    runCommand: (file, args) => {
      spawnCalls.push({ file, args })
      if (file === 'osascript') return Promise.resolve({ code: 0, stdout: '«class UTF8»"saved-content"', stderr: '' })
      if (file === 'python3') {
        // wechat_db.py 回读：默认返回含全部条目签名的消息（任意条目验证均命中）；
        // dbReadResult 显式覆盖（用于未命中/失败语义测试）
        const db = env.dbReadResult
        if (db && db.stdout !== 'MATCH_FEATURE') return Promise.resolve(db)
        const sigs = env.outbox.listOutbox().map((x) => `#l${(x.id ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`).join(' ')
        return Promise.resolve({ code: 0, stdout: `{"messages":[{"content":"【lurker】x ${sigs}"}]}`, stderr: '' })
      }
      return Promise.resolve(env.spawnResult ?? overrides.spawnResult ?? { code: 0, stdout: 'sent_ui_verified', stderr: '' })
    },
    isFrontmost: () => Promise.resolve(env.frontmost),
  })
  return env
}

function readOutbox(dir) {
  if (!existsSync(join(dir, OUTBOX_REL))) return []
  // W-4：补丁行按 id fold 归并（与 Outbox.tailOutbox 读侧语义一致）
  const entries = []
  const byId = new Map()
  for (const l of readFileSync(join(dir, OUTBOX_REL), 'utf8').split('\n')) {
    if (l.trim() === '') continue
    const v = JSON.parse(l)
    if (v && v.patch === true && typeof v.id === 'string') {
      const prev = byId.get(v.id)
      if (prev) { const { patch, id, ...rest } = v; Object.assign(prev, rest) }
      continue
    }
    entries.push(v)
    if (v && typeof v.id === 'string') byId.set(v.id, v)
  }
  return entries
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

test('全流程：pending → sent，回读 spawn 参数形态正确（--db-root/--key-file/--chat-id）', async () => {
  const env = makeEnv()
  const e = env.outbox.appendOutbox({ kind: 'daily', title: '日报已生成', body: '关键判断 3 条', evidence_ref: 'reports/x.md' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  // 键序 osascript 多次 + 回读 spawn 一次
  const readCalls = env.spawnCalls.filter((c) => c.file === 'python3')
  assert.equal(readCalls.length, 2, '预检 1 次 + 回读 1 次')
  const rb = readCalls.find((c) => c.args[c.args.indexOf('--limit') + 1] === '30')
  assert.ok(rb, '回读 spawn（--limit 30）')
  assert.equal(rb.args[0], join('/fake/macos-wechat-export', 'wechat_db.py'))
  assert.ok(rb.args.includes('--db-root'))
  assert.ok(rb.args.includes('--key-file'))
  const ci = rb.args.indexOf('--chat-id')
  assert.equal(rb.args[ci + 1], 'wxid_target')
  assert.ok(env.spawnCalls.some((c) => c.file === 'osascript' && c.args.some((a) => String(a).includes('shift down'))), 'Cmd+Shift+W 在键序中')
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
  // dry_run 键序执行到进入对话（osascript 若干），但绝不回读、绝无 python3
  assert.equal(env.spawnCalls.filter((c) => c.file !== 'osascript').length, 0, 'dry_run 只发 osascript 键序')
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

test('回读穷尽未命中（真失败）→ attempts 落盘，3 次转 failed_wrong_target 不再重试（防风暴）', async () => {
  const env = makeEnv({ dbReadResult: { code: 0, stdout: '{"messages":[{"content":"别的消息"}]}', stderr: '' } })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r1 = await env.sender.processOnce()
  assert.equal(r1.action, 'failed')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'failed_wrong_target')
  assert.equal(after.attempts, 1, '单轮内回读窗口 4 次穷尽即终态（attempts=1）')
  // 终态不再被消费
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'empty')
  rmSync(env.dir, { recursive: true, force: true })
})

test('频控：maxSendsPerDay 超限的当日 pending 标 skipped_quota', async () => {
  const env = makeEnv({ maxSendsPerDay: 2 })
  const ids = []
  for (let i = 0; i < 4; i++) {
    ids.push(env.outbox.appendOutbox({ kind: 'remind', title: `t${i}`, body: 'b', evidence_ref: 'x' }).id)
  }
  const r = await env.sender.processOnce()
  assert.equal(env.spawnCalls.filter((c) => c.file === 'python3').length, 3, '预检 1 次 + 回读 2 次')
  assert.ok(env.spawnCalls.filter((c) => c.file === 'osascript').length >= 18, `两条日报键序完整（实际 ${env.spawnCalls.filter((c) => c.file === 'osascript').length}）`)
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
  assert.ok(env2.logger.logs.warn.some((m) => m.includes('not frontmost') && m.includes('前台')))
  rmSync(env2.dir, { recursive: true, force: true })
})

test('audit 无正文：只记 id/kind/result/attempts 元数据', async () => {
  const env = makeEnv()
  env.outbox.appendOutbox({ kind: 'daily', title: '机密标题abc', body: '机密正文xyz', evidence_ref: 'x' })
  await env.sender.processOnce()
  const audit = readAudit(env.dir)
  // 发送/验证解耦：transmitted（落盘 sent_pending_verify）+ sent（回读命中）两行元数据
  assert.equal(audit.length, 2)
  const raw = JSON.stringify(audit)
  assert.ok(!raw.includes('机密标题abc'))
  assert.ok(!raw.includes('机密正文xyz'))
  assert.deepEqual(audit.map((a) => a.result), ['transmitted', 'sent'])
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
  assert.ok(env.spawnCalls.length >= 10, '键盘键序完整执行（osascript 多次 + 回读 1 次）')
  assert.ok(env.spawnCalls.some((c) => c.file === 'python3' && c.args.includes('wxid_target')), '回读目标 = readbackChatId')
  assert.ok(!env.spawnCalls.some((c) => c.args.includes('--id')), '键盘流程无 --id（wechat-ui 幂等参数已废）')
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
  assert.equal(env.spawnCalls.filter((c) => c.file !== 'osascript').length, 0, 'dry_run 只发 osascript 键序（到进入对话为止）')
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

// —— allowTakeFocus 抢前台模式（默认 false = 现行为零变化） ——

function makeTakeFocusEnv({ allowTakeFocus, idleSec, frontmost, logger = silentLogger }) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'sender-tf-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store })
  const spawnCalls = []
  const sender = new SenderService({
    outbox, store, logger,
    enabled: true, dryRun: false,
    allowTakeFocus,
    sourceToolDir: '/fake/macos-wechat-export',
    sourceDbRoot: '/fake/wechat-db-storage',
    sendTargetChat: '目标会话',
    readbackChatId: 'wxid_target',
    sleepMs: () => Promise.resolve(),
    runCommand: (file, args) => {
      spawnCalls.push({ file, args })
      if (file === 'osascript') return Promise.resolve({ code: 0, stdout: '«class UTF8»"saved-content"', stderr: '' })
      if (file === 'python3') {
        const sigs = outbox.listOutbox().map((x) => `#l${(x.id ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`).join(' ')
        return Promise.resolve({ code: 0, stdout: `{"messages":[{"content":"【lurker】x ${sigs}"}]}`, stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: 'sent_ui_verified', stderr: '' })
    },
    isFrontmost: () => Promise.resolve(frontmost),
    systemIdleSec: () => Promise.resolve(idleSec),
  })
  return { dir, store, outbox, spawnCalls, sender }
}

test('allowTakeFocus=true：微信非前台也照发（跳过前台闸），审计记 take_focus_sent', async () => {
  const env = makeTakeFocusEnv({ allowTakeFocus: true, idleSec: 120, frontmost: false })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  const osaSpawns = env.spawnCalls.filter((c) => c.file === 'osascript')
  assert.ok(osaSpawns.length >= 9, '非前台照发（抢前台模式，键序完整）')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  const audit = readAudit(env.dir).find((a) => a.id === e.id && a.result === 'take_focus_sent')
  assert.ok(audit, '审计可区分两种模式（transmitted 之外应有 take_focus_sent 行）')
  rmSync(env.dir, { recursive: true, force: true })
})

test('allowTakeFocus=true：空闲 <10s（用户正在打字）仍跳过并计数——绝不抢正在打字的手', async () => {
  const logs = recordingLogger()
  const env = makeTakeFocusEnv({ allowTakeFocus: true, idleSec: 3, frontmost: false, logger: logs })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 0; i < 3; i++) {
    const r = await env.sender.processOnce()
    assert.equal(r.action, 'user_active')
    assert.equal(env.spawnCalls.length, 0, '用户忙绝不发键')
  }
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'pending', '条目保持 pending 下轮再试')
  assert.ok(logs.logs.warn.some((m) => m.includes('让路')), '连续 3 轮后 warn 提醒')
  const gates = readAudit(env.dir).filter((a) => a.result === 'user_active')
  assert.equal(gates.length, 3)
  assert.ok(gates.every((a) => a.takeFocus === true))
  rmSync(env.dir, { recursive: true, force: true })
})

test('发送前失败（非前台闸）→ 保持 pending 不计 attempts，环境恢复后整条重发（与验证失败解耦）', async () => {
  const env = makeEnv()
  env.frontmost = false
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'not_frontmost')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'pending', '消息没打出去 → 保持 pending 可整条重发')
  assert.equal(after.attempts ?? 0, 0, '发送前失败不计 attempts')
  assert.equal(after.transmittedAt, undefined, '未 transmitted')
  // 环境恢复后下轮整条重发成功
  env.frontmost = true
  const r2 = await env.sender.processOnce()
  assert.equal(r2.action, 'sent')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('sent_pending_verify 历史条目：消费循环视作已发送——绝不重发', async () => {
  const env = makeEnv()
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  // 模拟"已发送但验证中断"的落盘形态
  env.outbox.updateSendState(e.id, { status: 'sent_pending_verify', transmittedAt: Date.now(), verifyAttempts: 1 })
  const spawnsBefore = env.spawnCalls.length
  const osaBefore = env.spawnCalls.filter((c) => c.file === 'osascript').length
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent', '验证通过 → sent')
  assert.equal(env.spawnCalls.filter((c) => c.file === 'osascript').length, osaBefore, '零键序新增——绝不重发')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent', '仅补验证即转 sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('allowTakeFocus 默认 false：行为零变化（非前台仍跳过 not_frontmost，审计无 take_focus_sent）', async () => {
  const env = makeTakeFocusEnv({ allowTakeFocus: undefined, idleSec: 120, frontmost: false })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'not_frontmost')
  assert.equal(env.spawnCalls.length, 0, '默认模式非前台绝不发送')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'pending')
  assert.ok(readAudit(env.dir).some((a) => a.result === 'not_frontmost'))
  assert.ok(!readAudit(env.dir).some((a) => String(a.result).startsWith('take_focus')))
  rmSync(env.dir, { recursive: true, force: true })
})

// —— 2026-10-21 误发事故修复：账号闸 fail-closed / 密钥预检 / 配置缺失 ——

test('账号不可判定（gate.activeAccount=null）→ fail-closed 挂起：零微信交互、pending 不耗 attempts、审计 account_unknown_deferred', async () => {
  const gate = {
    activeAccount: async () => null,
    isAllowed: () => false,
    wasSuspended: () => false,
    setSuspended: () => {},
    rekeyAndVerify: async () => 'healthy',
    whitelistSummary: () => 'wxid_x…',
  }
  const env = makeEnv({ accountGate: gate })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'wrong_account_suspended', 'null（不可判定）= 挂起，绝不发送')
  assert.equal(env.spawnCalls.length, 0, '零微信交互（不 activate 不 spawn）')
  const audit = readAudit(env.dir)
  assert.ok(audit.some((a) => a.result === 'account_unknown_deferred'), '审计可区分"不可判定"与"白名单外"')
  const entry = readOutbox(env.dir)[0]
  assert.equal(entry.status, 'pending')
  assert.equal(entry.attempts ?? 0, 0)
  rmSync(env.dir, { recursive: true, force: true })
})

test('发送前密钥预检失败 → 本轮延后：零键序、pending 不耗 attempts、审计 account_key_check_deferred', async () => {
  const env = makeEnv({ dbReadResult: { code: 15, stdout: '', stderr: 'sqlcipher: file is not a database' } })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred')
  assert.equal(env.spawnCalls.filter((c) => c.file === 'osascript').length, 0, '预检失败绝不进键序')
  const audit = readAudit(env.dir)
  assert.ok(audit.some((a) => a.result === 'account_key_check_deferred'))
  const entry = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(entry.status, 'pending')
  assert.equal(entry.attempts ?? 0, 0)
  rmSync(env.dir, { recursive: true, force: true })
})

test('缺 sendTargetChat → fail-closed（unverified_missing_config），零键序（空目标会发进当前会话）', async () => {
  const env = makeEnv({ sendTargetChat: '' })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'failed')
  assert.equal(env.spawnCalls.filter((c) => c.file === 'osascript').length, 0, '零键序')
  const audit = readAudit(env.dir)
  const miss = audit.find((a) => a.result === 'unverified_missing_config')
  assert.ok(miss && String(miss.missing).includes('sendTargetChat'))
  rmSync(env.dir, { recursive: true, force: true })
})
