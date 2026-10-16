// chat-gate.test.mjs —— 发送前合规闸（路线 A，2026-10-15）：wechat-ui read 标题核验（全离线 mock spawn）。
// 覆盖：合规通过→发送链照旧；聊错天→deferred 不发不耗 attempts；OCR 三连败→deferred；
//       二过一败→通过（重试语义）；工具缺失→deferred + reason=ui_tool_missing；
//       TCC 屏幕录制缺失→deferred + reason=tcc_denied + 提示；dry_run 合规闸照常执行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { SenderService, SENDER_AUDIT_REL, CHAT_VERIFY_RETRY_DELAY_MS, FILEHELPER_CHAT } = await import('../lib/sender.js')
const { Outbox, OUTBOX_REL } = await import('../lib/outbox.js')
const { Store } = await import('../lib/store.js')

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
function recordingLogger() {
  const logs = { info: [], warn: [], error: [] }
  return { logs, info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) }
}

function stepOf(call) {
  const s = call.args[call.args.indexOf('-e') + 1] ?? ''
  if (s.includes('to activate')) return 'activate'
  if (s === 'the clipboard as «class UTF8»') return 'clipboard_save'
  if (s.startsWith('set the clipboard to')) return `clipboard_set:${JSON.parse(s.slice('set the clipboard to '.length))}`
  if (s.includes('keystroke "v" using command down')) return 'key:cmd+v'
  if (s.includes('key code 36')) return 'key:return'
  return `other:${s}`
}

function makeEnv(overrides = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'chat-gate-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store, now: () => Date.now() })
  const steps = [] // { kind:'osascript', step } | { kind:'spawn', file, args } | { kind:'sleep', ms }
  const env = {
    dir, store, outbox, steps,
    frontmost: true,
    idleSec: 999,
    // 合规闸结果按序弹出（耗尽后回落 chatReadResult）；null = 默认通过
    chatReadSeq: overrides.chatReadSeq ?? null,
    chatReadResult: overrides.chatReadResult ?? { code: 0, stdout: `chat matched: ${FILEHELPER_CHAT}`, stderr: '' },
    dbReadResult: overrides.dbReadResult ?? { code: 0, stdout: 'MATCH_FEATURE', stderr: '' },
    ...overrides,
  }
  env.sender = new SenderService({
    outbox,
    store,
    logger: overrides.logger ?? silentLogger,
    enabled: true,
    dryRun: overrides.dryRun ?? false,
    sendMethod: 'keyboard',
    sourceToolDir: '/fake/macos-wechat-export',
    sourceDbRoot: '/fake/wechat-db-storage',
    sourcePython: 'python3',
    chatVerifyRetries: overrides.chatVerifyRetries ?? 2,
    wechatUiPath: overrides.wechatUiPath ?? 'wechat-ui',
    now: () => new Date(2026, 9, 15, 12, 0).getTime(),
    runCommand: (file, args) => {
      if (file === 'osascript') {
        const step = stepOf({ args })
        steps.push({ kind: 'osascript', step })
        const stdout = step === 'clipboard_save' ? '«class UTF8»"saved-content"' : 'ok'
        return Promise.resolve({ code: 0, stdout, stderr: '' })
      }
      steps.push({ kind: 'spawn', file, args })
      if (args[0] === 'deliver' && args.includes('--chat')) {
        // 发送段（2026-10-16）：默认 delivered_ui 成功
        return Promise.resolve(env.deliverResult ?? { code: 0, stdout: '{"type":"delivered_ui"}', stderr: '' })
      }
      if (args[0] === 'open' && args.includes('--chat')) {
        // 定位闸（2026-10-16）：默认幂等通过
        const out = env.locateSeq && env.locateSeq.length > 0 ? env.locateSeq.shift() : env.locateResult
        return Promise.resolve(out ?? { code: 0, stdout: '{"type":"opened","already_open":true}', stderr: '' })
      }
      if (args[0] === 'read' && args.includes('--chat')) {
        const out = env.chatReadSeq && env.chatReadSeq.length > 0 ? env.chatReadSeq.shift() : env.chatReadResult
        return Promise.resolve(out)
      }
      // wechat_db.py 回读（发送后验证）
      const out = env.dbReadResult.stdout === 'MATCH_FEATURE'
        ? { ...env.dbReadResult, stdout: `{"messages":[{"content":"【lurker】x ${env.lastFeature ?? ''}"}]}` }
        : env.dbReadResult
      return Promise.resolve(out)
    },
    isFrontmost: () => Promise.resolve(env.frontmost),
    systemIdleSec: () => Promise.resolve(env.idleSec),
    sleepMs: (ms) => { steps.push({ kind: 'sleep', ms }); return Promise.resolve() },
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

test('合规闸通过：spawn wechat-ui read --chat 文件传输助手（参数数组、与发送目标同常量）→ 发送链照旧 sent', async () => {
  const env = makeEnv()
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  const gate = env.steps.find((s) => s.kind === 'spawn' && s.args[0] === 'read')
  assert.equal(gate.file, 'wechat-ui')
  assert.deepEqual(gate.args, ['read', '--chat', FILEHELPER_CHAT], '参数数组；--chat 与发送目标同源同常量')
  // 闸在发送段之前（deliver spawn 在核验之后）
  const gateIdx = env.steps.indexOf(gate)
  assert.ok(env.steps.findIndex((s) => s.kind === 'spawn' && s.args[0] === 'deliver') > gateIdx, '核验通过后才发送')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  assert.ok(!readAudit(env.dir).some((a) => a.result === 'wrong_chat_open'), '合规通过无 deferred 审计')
  rmSync(env.dir, { recursive: true, force: true })
})

test('聊错天（OCR 三连败）：deferred 不发不耗 attempts，审计 result=wrong_chat_open + reason + deferred', async () => {
  const env = makeEnv({
    logger: recordingLogger(),
    chatReadResult: { code: 1, stdout: 'chat title: 测试群', stderr: 'mismatch' },
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'pending', '保持 pending 下轮重试')
  assert.equal(after.attempts ?? 0, 0, '用户环境状态不是发送失败——attempts 不增')
  // 定位闸 1 次 + 核验 3 次（1 + chatVerifyRetries 2），每次失败间隔 1s，绝不触碰键序
  assert.equal(env.steps.filter((s) => s.kind === 'spawn').length, 4)
  assert.deepEqual(env.steps.filter((s) => s.kind === 'sleep' && s.ms === CHAT_VERIFY_RETRY_DELAY_MS).length, 2)
  assert.ok(!env.steps.some((s) => s.kind === 'osascript' && (s.step === 'key:cmd+v' || s.step === 'key:return')), '绝不粘贴/回车')
  const audit = readAudit(env.dir)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].result, 'wrong_chat_open')
  assert.equal(audit[0].reason, 'wrong_chat_open')
  assert.equal(audit[0].deferred, true)
  assert.equal(audit[0].attempts, 0, '审计 attempts 同样不增')
  assert.ok(!JSON.stringify(audit).includes('【lurker】'), '审计零正文')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('请将微信当前会话切换到文件传输助手')), 'warn 提示切会话')
  rmSync(env.dir, { recursive: true, force: true })
})

test('OCR 误读抖动防御：二过一败（首败后重试命中）→ 放行发送', async () => {
  const env = makeEnv({
    chatReadSeq: [
      { code: 1, stdout: '', stderr: 'blur' },
      { code: 0, stdout: `chat matched: ${FILEHELPER_CHAT}`, stderr: '' },
    ],
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent', '重试命中 → 放行')
  assert.equal(env.steps.filter((s) => s.kind === 'spawn').length, 5, '定位 1 + 核验 2 + deliver 1 + 回读 1')
  assert.equal(env.steps.filter((s) => s.kind === 'sleep' && s.ms === CHAT_VERIFY_RETRY_DELAY_MS).length, 1, '首败后等 1s 重试一次')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('wechat-ui 二进制缺失：deferred + 独立 reason=ui_tool_missing（确定性失败不重试）', async () => {
  const env = makeEnv({
    logger: recordingLogger(),
    chatReadResult: { code: 1, stdout: '', stderr: '', error: 'spawn wechat-ui ENOENT' },
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'pending')
  assert.equal(after.attempts ?? 0, 0, '不计 attempts')
  assert.equal(env.steps.filter((s) => s.kind === 'spawn').length, 2, '确定性失败：定位 1 + 核验 1，不空转重试')
  const audit = readAudit(env.dir)
  assert.equal(audit[0].result, 'wrong_chat_open')
  assert.equal(audit[0].reason, 'ui_tool_missing', 'reason 独立区分部署问题')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('wechat-ui') && m.includes('缺失')), 'warn 指向 wechatUiPath')
  rmSync(env.dir, { recursive: true, force: true })
})

test('TCC 屏幕录制缺失：deferred + reason=tcc_denied + warn 提示授权路径', async () => {
  const env = makeEnv({
    logger: recordingLogger(),
    chatReadResult: { code: 1, stdout: '', stderr: 'screen capture permission denied (TCC)' },
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'pending')
  assert.equal(after.attempts ?? 0, 0)
  const audit = readAudit(env.dir)
  assert.equal(audit[0].result, 'wrong_chat_open')
  assert.equal(audit[0].reason, 'tcc_denied', 'reason 区分 TCC 缺失与聊错天')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('屏幕录制')), 'warn 提示屏幕录制授权')
  rmSync(env.dir, { recursive: true, force: true })
})

test('dry_run 合规闸照常执行：通过→条目转 dry_run（键序跳过）；失败→deferred 保持 pending', async () => {
  // 通过路径：核验照跑，条目转 dry_run（与现 dry_run 语义一致）
  const env = makeEnv({ dryRun: true })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent') // 消费完成（dry_run 路径 action 计 sent，与现行为一致）
  assert.equal(env.steps.filter((s) => s.kind === 'spawn').length, 2, 'dry_run 也执行定位 + 只读核验')
  assert.ok(!env.steps.some((s) => s.kind === 'osascript' && (s.step === 'key:cmd+v' || s.step === 'key:return')), '键序仍跳过')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'dry_run')
  rmSync(env.dir, { recursive: true, force: true })

  // 失败路径：dry_run 也 deferred（正好用于上线前验证 TCC 与定位）
  const env2 = makeEnv({ dryRun: true, logger: recordingLogger(), chatReadResult: { code: 1, stdout: '', stderr: 'mismatch' } })
  const e2 = env2.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  const r2 = await env2.sender.processOnce()
  assert.equal(r2.action, 'deferred')
  const after2 = readOutbox(env2.dir).find((x) => x.id === e2.id)
  assert.equal(after2.status, 'pending', '不标 dry_run 消费掉')
  assert.equal(after2.attempts ?? 0, 0)
  assert.equal(readAudit(env2.dir)[0].reason, 'wrong_chat_open')
  rmSync(env2.dir, { recursive: true, force: true })
})

test('chatVerifyRetries 可配：=0 时只核验 1 次', async () => {
  const env = makeEnv({ chatVerifyRetries: 0, chatReadResult: { code: 1, stdout: '', stderr: 'mismatch' } })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred')
  assert.equal(env.steps.filter((s) => s.kind === 'spawn').length, 2, '定位 1 + 核验 1')
  assert.equal(env.steps.filter((s) => s.kind === 'sleep' && s.ms === CHAT_VERIFY_RETRY_DELAY_MS).length, 0, '无重试间隔')
  rmSync(env.dir, { recursive: true, force: true })
})
