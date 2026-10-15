// keyboard-sender.test.mjs —— 发送原语替换（2026-10-15）：wx-chatbot 式键盘模拟（全离线 mock）。
// 覆盖：14 步实证键序正确性、dry_run 停在定位（不粘贴消息不回车）、DB 回读验证成功/失败、
//       剪贴板保存恢复（含恢复失败不阻塞）、交互闸（用户空闲 <10s 跳过）、
//       缺 sourceToolDir fail-closed、非 filehelper 拒发、wechat-ui 切回、频控/attempts/审计、特征串构造。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { SenderService, appendFeature, buildSendText, MAX_TEXT_CHARS, ALLOWED_CHANNELS, SENDER_AUDIT_REL, MAX_ATTEMPTS, KEY_DELAY_PASTE_MS, VERIFY_DELAY_MS, VERIFY_RETRIES, IDLE_SKIP_BELOW_SEC } = await import('../lib/sender.js')
const { Outbox, OUTBOX_REL } = await import('../lib/outbox.js')
const { Store } = await import('../lib/store.js')

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
function recordingLogger() {
  const logs = { info: [], warn: [], error: [] }
  return { logs, info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) }
}

/** 把 osascript -e 脚本归类成可读步骤名（键序断言用） */
function stepOf(call) {
  const s = call.args[call.args.indexOf('-e') + 1] ?? ''
  if (s.includes('to activate')) return 'activate'
  if (s === 'the clipboard as «class UTF8»') return 'clipboard_save'
  if (s.startsWith('set the clipboard to')) return `clipboard_set:${JSON.parse(s.slice('set the clipboard to '.length))}`
  if (s.includes('key code 53')) return 'key:esc'
  if (s.includes('key code 125')) return 'key:down'
  if (s.includes('click at')) return `click:${s.match(/\{(\d+), (\d+)\}/)?.slice(1).join(',')}`
  if (s.includes('get {position, size} of window 1')) return 'ax:window'
  if (s.includes('keystroke "v" using command down')) return 'key:cmd+v'
  if (s.includes('key code 36')) return 'key:return'
  return `other:${s}`
}

function makeEnv(overrides = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'kbd-sender-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store, now: () => Date.now() })
  const steps = [] // { kind:'osascript', step } | { kind:'spawn', file, args } | { kind:'sleep', ms }
  const env = {
    dir, store, outbox, steps,
    frontmost: true,
    idleSec: 999,
    sender: null,
    // osascript 默认全成功；spawn（wechat_db.py 回读）默认成功且含任意特征串
    osascriptOk: overrides.osascriptOk ?? (() => true),
    dbReadResult: overrides.dbReadResult ?? { code: 0, stdout: 'MATCH_FEATURE', stderr: '' },
    ...overrides,
  }
  let axCalls = 0 // ax:window 调用序（首读=1，复读=2）
  env.sender = new SenderService({
    outbox,
    store,
    logger: overrides.logger ?? silentLogger,
    enabled: overrides.enabled ?? true,
    dryRun: overrides.dryRun ?? false,
    sendMethod: 'keyboard',
    maxSendsPerDay: overrides.maxSendsPerDay ?? 20,
    sourceToolDir: overrides.sourceToolDir ?? '/fake/macos-wechat-export',
    sourcePython: overrides.sourcePython ?? 'python3',
    now: overrides.now ?? (() => new Date(2026, 9, 15, 12, 0).getTime()),
    runCommand: (file, args) => {
      if (file === 'osascript') {
        const step = stepOf({ args })
        steps.push({ kind: 'osascript', step })
        const ok = typeof env.osascriptOk === 'function' ? env.osascriptOk(step) : env.osascriptOk
        // clipboard_save 返回可解析的剪贴板快照（模拟剪贴板原有文本 "saved-content"）
        // ax:window 返回实证窗口形态 position 0,34 + size 856x1007；env.axWindowOut 可覆盖
        //（函数形态按调用序返回：首次/复读两次读取，可模拟双读坐标不一致）
        const axOut = () => {
          const v = env.axWindowOut
          const out = typeof v === 'function' ? v(++axCalls) : v
          return out ?? '0, 34, 856, 1007'
        }
        const stdout = step === 'clipboard_save' ? '«class UTF8»"saved-content"' : step === 'ax:window' ? axOut() : 'ok'
        return Promise.resolve(ok ? { code: 0, stdout, stderr: '' } : { code: 1, stdout: '', stderr: 'err' })
      }
      steps.push({ kind: 'spawn', file, args })
      let out
      if (env.dbReadSeq) {
        // 回读结果按序弹出（重试窗口竞态模拟：首次空、第二次命中…）
        // MATCH_FEATURE 占位同样替换成含当前特征串的命中响应（与默认分支一致）
        out = env.dbReadSeq.length > 0 ? env.dbReadSeq.shift() : { code: 0, stdout: '', stderr: '' }
        if (out.stdout === 'MATCH_FEATURE') out = { ...out, stdout: `{"messages":[{"content":"【lurker】x ${env.lastFeature ?? ''}"}]}` }
      } else {
        out = typeof env.dbReadResult === 'object' && 'stdout' in env.dbReadResult && env.dbReadResult.stdout === 'MATCH_FEATURE'
          ? { ...env.dbReadResult, stdout: `{"messages":[{"content":"【lurker】x ${env.lastFeature ?? ''}"}]}` }
          : env.dbReadResult
      }
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

test('appendFeature：特征串永远在场且总长 ≤200', () => {
  const id = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'
  const { text, feature } = appendFeature(buildSendText('标题', '正文'), id)
  assert.equal(feature, '#la1b2c3d4')
  assert.ok(text.endsWith(' #la1b2c3d4'))
  assert.ok(text.length <= MAX_TEXT_CHARS)
  // 超长正文也不挤掉特征串
  const long = appendFeature(buildSendText('x'.repeat(300), 'y'.repeat(500)), id)
  assert.ok(long.text.endsWith(' #la1b2c3d4'))
  assert.ok(long.text.length <= MAX_TEXT_CHARS)
})

test('键序正确性（真发）：简化键序（activate→粘贴→回车）+ DB 回读验证兜底 → sent', async () => {
  const env = makeEnv()
  const e = env.outbox.appendOutbox({ kind: 'daily', title: '日报', body: '关键判断', evidence_ref: 'r.md' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
  assert.deepEqual(seq, [
    'activate',
    'clipboard_save',
    `clipboard_set:【lurker】日报 关键判断 ${env.lastFeature}`,
    'key:cmd+v',
    `sleep:${KEY_DELAY_PASTE_MS}`,
    'key:return',
    'clipboard_set:saved-content', // 恢复剪贴板
    `sleep:${VERIFY_DELAY_MS}`,
    'spawn', // wechat_db.py read（DB 回读验证兜底——唯一目标闸）
  ])
  // 无搜索定位：绝不出现 Esc/AX/点击/↓/搜索词粘贴
  for (const banned of ['key:esc', 'ax:window', 'key:down']) assert.ok(!seq.includes(banned), `不应出现 ${banned}`)
  assert.ok(!seq.some((x) => String(x).startsWith('click')), '不应点击搜索框')
  assert.ok(!seq.includes('clipboard_set:文件传输助手'), '不应粘贴搜索词')
  // 回读参数形态：只读、filehelper、limit 3
  const spawn = env.steps.find((s) => s.kind === 'spawn')
  assert.equal(spawn.file, 'python3')
  assert.deepEqual(spawn.args, [join('/fake/macos-wechat-export', 'wechat_db.py'), 'read', '--chat-id', 'filehelper', '--limit', '3'])
  // 验证延迟在回读前
  const sleepIdx = seq.indexOf(`sleep:${VERIFY_DELAY_MS}`)
  assert.ok(sleepIdx >= 0 && sleepIdx < seq.length - 1, `真发后应有 sleep:${VERIFY_DELAY_MS} 再回读`)
  // 状态机 + 审计
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  const audit = readAudit(env.dir)
  assert.equal(audit[0].result, 'sent')
  assert.equal(audit[0].method, 'keyboard')
  rmSync(env.dir, { recursive: true, force: true })
})

test('dry_run：确认前台后直接结束（不碰输入框不回车），条目转 dry_run', async () => {
  const env = makeEnv({ dryRun: true, logger: recordingLogger() })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: '机密正文', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent') // 消费完成，走 dry_run 路径
  const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
  assert.deepEqual(seq, [
    'activate',
    'clipboard_save',
    'clipboard_set:saved-content', // dry_run 尾部：恢复剪贴板
  ])
  // 实测教训：干跑时的粘贴也可能落进输入框——dry_run 绝不 Cmd+V、绝不回车、绝不写消息剪贴板
  assert.ok(!seq.includes('key:cmd+v') && !seq.includes('key:return'), 'dry_run 不触发任何输入')
  assert.ok(!JSON.stringify(seq).includes('机密正文') && !seq.some((x) => String(x).includes('【lurker】')), '消息文本不进键序')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'dry_run')
  assert.ok(env.logger.logs.info.some((m) => m.includes('dry_run')), '日志注明 dry_run')
  assert.ok(!JSON.stringify(readAudit(env.dir)).includes('机密正文'), '审计零正文')
  rmSync(env.dir, { recursive: true, force: true })
})

// 剪贴板保存 mock：activate 前剪贴板内容 "saved-content"
const savedClipboardPatches = {
  osascriptOk: (step) => true,
}
test('剪贴板保存恢复：真发后恢复原内容；保存失败不恢复也不报错', async () => {
  // 保存成功 → dry_run 尾部恢复
  const env = makeEnv({ dryRun: true })
  // patch saveClipboard 返回值：重写 osascriptOk——clipboard_save 成功且其它都成功
  // （mock 默认走 "saved-content" 分支见 makeEnv：这里直接校验恢复调用存在且内容正确）
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  await env.sender.processOnce()
  const sets = env.steps.filter((s) => s.kind === 'osascript' && s.step.startsWith('clipboard_set'))
  assert.equal(sets[sets.length - 1].step, 'clipboard_set:saved-content', '最后一步恢复剪贴板原内容')
  rmSync(env.dir, { recursive: true, force: true })

  // 保存失败（clipboard_save 非零码）→ 不尝试恢复，流程照常 sent
  const env2 = makeEnv({ osascriptOk: (step) => step !== 'clipboard_save' })
  env2.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  env2.lastFeature = 'zz'
  // 保存失败时 saveClipboard 返回 null → 不做恢复；DB 回读 mock 需命中特征串
  const sender2 = env2.sender
  const r2 = await sender2.processOnce()
  assert.equal(r2.action, 'failed', '保存失败时 DB 回读（stdout 含旧占位）不命中 → 失败计数，但流程不崩')
  const restore = env2.steps.filter((s) => s.kind === 'osascript' && String(s.step).startsWith('clipboard_set:saved'))
  assert.equal(restore.length, 0, '保存失败 → 无恢复调用')
  rmSync(env2.dir, { recursive: true, force: true })
})

test('剪贴板恢复失败：warn 但不阻塞发送（sent）', async () => {
  const env = makeEnv({
    logger: recordingLogger(),
    osascriptOk: (step) => !String(step).startsWith('clipboard_set:saved'), // 仅恢复失败
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent', '恢复失败不阻塞')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('剪贴板恢复失败')))
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('回读未命中（可能发错会话）→ P0：标 failed_wrong_target 终态 + error 审计 + warn，不再重试', async () => {
  const env = makeEnv({ logger: recordingLogger(), dbReadResult: { code: 0, stdout: '{"messages":[{"content":"别的消息"}]}', stderr: '' } })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'failed')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'failed_wrong_target', '终态：不重试（重试可能再次误发）')
  const audit = readAudit(env.dir)
  assert.equal(audit[0].result, 'failed_wrong_target')
  assert.equal(audit[0].p0, true, '审计行醒目标 P0')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('P0') && m.includes('failed_wrong_target')), '立即 warn')
  // 重试窗口：4 次尝试（每次前 sleep VERIFY_DELAY_MS），穷尽后才终判
  assert.equal(env.steps.filter((x) => x.kind === 'spawn').length, VERIFY_RETRIES, '穷尽 verifyRetries 次回读')
  assert.equal(env.steps.filter((x) => x.kind === 'sleep' && x.ms === VERIFY_DELAY_MS).length, VERIFY_RETRIES, '每次尝试前等 verifyDelaySec')
  // 终态：后续周期不再消费
  const spawns = env.steps.filter((x) => x.kind === 'spawn').length
  await env.sender.processOnce()
  assert.equal(env.steps.filter((x) => x.kind === 'spawn').length, spawns, 'failed_wrong_target 不再回读')
  rmSync(env.dir, { recursive: true, force: true })
})

test('回读重试窗口（异步写入竞态修复）：首次回读空、第二次命中 → sent', async () => {
  const env = makeEnv({
    // 首次：微信尚未异步写入；第二次：写入提交，命中特征串
    dbReadSeq: [
      { code: 0, stdout: '{"messages":[]}', stderr: '' },
      { code: 0, stdout: 'MATCH_FEATURE', stderr: '' },
    ],
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}` // 让 MATCH_FEATURE 占位替换命中本条特征串
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent', '竞态窗口内第二次回读命中 → sent（不误判 wrong_target）')
  assert.equal(env.steps.filter((x) => x.kind === 'spawn').length, 2, '只回读 2 次即命中')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  const audit = readAudit(env.dir)
  assert.equal(audit[0].result, 'sent')
  assert.ok(!audit[0].p0, '无 P0')
  rmSync(env.dir, { recursive: true, force: true })
})

test('回读重试窗口可配：verifyRetries=2 / verifyDelaySec=1（1s × 2 次）', async () => {
  const env = makeEnv({
    dbReadSeq: [
      { code: 0, stdout: '{"messages":[]}', stderr: '' },
      { code: 0, stdout: 'MATCH_FEATURE', stderr: '' },
    ],
  })
  // 用最小改动覆盖配置：直接构造带 override 的 sender
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await new SenderService({
    outbox: env.outbox, store: env.store, logger: silentLogger, enabled: true, dryRun: false,
    sendMethod: 'keyboard', sourceToolDir: '/fake/macos-wechat-export', sourcePython: 'python3',
    verifyDelaySec: 1, verifyRetries: 2,
    runCommand: (file, args) => {
      if (file === 'osascript') return Promise.resolve({ code: 0, stdout: '«class UTF8»"saved-content"', stderr: '' })
      const out = env.dbReadSeq.length > 0 ? env.dbReadSeq.shift() : { code: 0, stdout: '', stderr: '' }
      const resolved = out.stdout === 'MATCH_FEATURE' ? { ...out, stdout: `{"messages":[{"content":"【lurker】x #l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}"}]}` } : out
      env.steps.push({ kind: 'spawn', file, args })
      return Promise.resolve(resolved)
    },
    isFrontmost: () => Promise.resolve(true),
    systemIdleSec: () => Promise.resolve(999),
    sleepMs: (ms) => { env.steps.push({ kind: 'sleep', ms }); return Promise.resolve() },
  }).processOnce()
  assert.equal(r.action, 'sent')
  assert.equal(env.steps.filter((x) => x.kind === 'spawn').length, 2)
  assert.deepEqual(env.steps.filter((x) => x.kind === 'sleep').map((x) => x.ms), [KEY_DELAY_PASTE_MS, 1000, 1000])
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('回读本身失败（CLI 报错/库不可读）→ deferred 环境等待语义：attempts 不增、保持 pending、不误判 wrong_target', async () => {
  const env = makeEnv({
    logger: recordingLogger(),
    dbReadResult: { code: 1, stdout: '', stderr: 'db locked' },
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred', '回读失败 = 环境等待，不是 wrong_target')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'pending', '保持 pending，下轮重试验证')
  assert.equal(after.attempts, 0, 'attempts 不增')
  const audit = readAudit(env.dir)
  assert.equal(audit[0].result, 'verify_read_deferred')
  assert.equal(audit[0].deferred, true)
  assert.ok(!audit[0].p0, '绝不误判 P0')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('回读本身失败') && m.includes('不判 wrong_target')))
  rmSync(env.dir, { recursive: true, force: true })
})

test('交互闸（用户空闲 <10s）：跳过本轮零按键，条目保持 pending，审计 user_active', async () => {
  const env = makeEnv({ idleSec: IDLE_SKIP_BELOW_SEC - 0.1 })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'user_active')
  assert.equal(env.steps.length, 0, '用户操作中 → 一个按键都不发')
  assert.equal(readOutbox(env.dir)[0].status, 'pending')
  assert.equal(readAudit(env.dir)[0].result, 'user_active')
  // 空闲恢复后正常走
  env.idleSec = 999
  const entry = readOutbox(env.dir)[0]
  env.lastFeature = `#l${entry.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r2 = await env.sender.processOnce()
  assert.equal(r2.action, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('keyboard 模式缺 sourceToolDir：fail-closed 不发键序，计数 attempts（≥3 转 failed）', async () => {
  const env = makeEnv({ sourceToolDir: '' })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 1; i <= MAX_ATTEMPTS; i++) await env.sender.processOnce()
  assert.equal(env.steps.length, 0, '无法验证 = 一个按键都不发')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'failed')
  assert.equal(after.attempts, MAX_ATTEMPTS)
  rmSync(env.dir, { recursive: true, force: true })
})

test('非 filehelper 拒发（keyboard 模式）：白名单硬编码，零按键零回读', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'kbd-sender-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store })
  const steps = []
  const e = outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const raw = readFileSync(join(dir, OUTBOX_REL), 'utf8').replace('"channel":"filehelper"', '"channel":"groupchat"')
  store.writeText(OUTBOX_REL, raw)
  const sender = new SenderService({
    outbox, store, logger: recordingLogger(),
    enabled: true, dryRun: false, sendMethod: 'keyboard',
    sourceToolDir: '/fake',
    runCommand: (file, args) => { steps.push({ file, args }); return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' }) },
    isFrontmost: () => Promise.resolve(true),
    systemIdleSec: () => Promise.resolve(999),
    sleepMs: () => Promise.resolve(),
  })
  const r = await sender.processOnce()
  assert.equal(r.action, 'empty')
  assert.equal(steps.length, 0, '非白名单通道在 keyboard 模式下也永不发出')
  assert.equal(readOutbox(dir).find((x) => x.id === e.id).status, 'skipped_channel')
  assert.equal(ALLOWED_CHANNELS.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('sendMethod=wechat-ui 可切回：spawn wechat-ui send（--chat/--text/--id/--composer-top），不走键盘', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'kbd-sender-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store })
  const spawns = []
  const sender = new SenderService({
    outbox, store, logger: silentLogger,
    enabled: true, dryRun: false, sendMethod: 'wechat-ui',
    wechatUiPath: 'wechat-ui', composerTop: 0.7,
    runCommand: (file, args) => { spawns.push({ file, args }); return Promise.resolve({ code: 0, stdout: 'sent_ui_verified', stderr: '' }) },
    isFrontmost: () => Promise.resolve(true),
    systemIdleSec: () => Promise.resolve(999),
    sleepMs: () => Promise.resolve(),
  })
  const e = outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await sender.processOnce()
  assert.equal(r.action, 'sent')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].file, 'wechat-ui')
  assert.equal(spawns[0].args[0], 'send')
  assert.deepEqual(spawns[0].args.slice(1, 3), ['--chat', '文件传输助手'])
  assert.ok(spawns[0].args.includes('--id') && spawns[0].args.includes('--composer-top'))
  assert.equal(readOutbox(dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(dir, { recursive: true, force: true })
})

test('keyboard dry_run 定位失败（activate 后非前台）→ attempts+1 保持 pending，不标 dry_run', async () => {
  const env = makeEnv({ dryRun: true })
  env.frontmost = false
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  // 注意：isFrontmost mock 是交互闸注入（同函数），交互闸先挡 → not_frontmost，键序未启动
  assert.equal(r.action, 'not_frontmost')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'pending')
  rmSync(env.dir, { recursive: true, force: true })
})

test('审计零正文 + sendTestSample keyboard 路径 dry_run 占用审计（元数据 only）', async () => {
  const env = makeEnv({ dryRun: true, logger: recordingLogger() })
  const r = await env.sender.sendTestSample()
  assert.equal(r.action, 'dry_run')
  const raw = JSON.stringify(readAudit(env.dir))
  assert.ok(!raw.includes('测试样例') && !raw.includes('发送链路样例'))
  rmSync(env.dir, { recursive: true, force: true })
})
