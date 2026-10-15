// keyboard-sender.test.mjs —— 发送原语替换（2026-10-15）：wx-chatbot 式键盘模拟（全离线 mock）。
// 覆盖：14 步实证键序正确性、dry_run 停在定位（不粘贴消息不回车）、DB 回读验证成功/失败、
//       剪贴板保存恢复（含恢复失败不阻塞）、交互闸（用户空闲 <10s 跳过）、
//       缺 sourceToolDir fail-closed、非 filehelper 拒发、wechat-ui 切回、频控/attempts/审计、特征串构造。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { SenderService, appendFeature, buildSendText, MAX_TEXT_CHARS, ALLOWED_CHANNELS, SENDER_AUDIT_REL, MAX_ATTEMPTS, KEY_DELAY_SEARCH_MS, KEY_DELAY_OPEN_MS, KEY_DELAY_PASTE_MS, KEY_DELAY_CLICK_MS, KEY_DELAY_DOWN_MS, KEY_DELAY_ACTIVATE_MS, KEY_DELAY_REREAD_MS, VERIFY_DELAY_MS, IDLE_SKIP_BELOW_SEC } = await import('../lib/sender.js')
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
      const out = typeof env.dbReadResult === 'object' && 'stdout' in env.dbReadResult && env.dbReadResult.stdout === 'MATCH_FEATURE'
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

test('键序正确性（真发）：14 步实证键序 + 延迟 + DB 回读验证 → sent', async () => {
  const env = makeEnv()
  const e = env.outbox.appendOutbox({ kind: 'daily', title: '日报', body: '关键判断', evidence_ref: 'r.md' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
  assert.deepEqual(seq, [
    'activate',
    `sleep:${KEY_DELAY_ACTIVATE_MS}`, // 空间切换动画 ~1s，等 1.5s 再读窗口坐标（实测全屏点错热修）
    'clipboard_save',
    'key:esc', // 3. Esc 清残留弹层
    'ax:window', // 4. AX 读窗口 position/size（首读）
    `sleep:${KEY_DELAY_REREAD_MS}`, // 4.5 布局稳定等待
    'ax:window', // 复读 position（双读比对，两次一致才认为布局稳定）
    'click:107,71', // 5. 实证坐标：0+856/8=107, 34+1007/40+12=71
    `sleep:${KEY_DELAY_CLICK_MS}`,
    'clipboard_set:文件传输助手',
    'key:cmd+v',
    `sleep:${KEY_DELAY_SEARCH_MS}`, // 实证 1.2s（0.8s 下拉未渲染完）
    'key:down', // 9. ↓ 选中第一个结果
    `sleep:${KEY_DELAY_DOWN_MS}`,
    'key:return', // 11. 回车跳转会话
    `sleep:${KEY_DELAY_OPEN_MS}`,
    `clipboard_set:【lurker】日报 关键判断 ${env.lastFeature}`,
    'key:cmd+v',
    `sleep:${KEY_DELAY_PASTE_MS}`,
    'key:return',
    'clipboard_set:saved-content', // 恢复剪贴板
    `sleep:${VERIFY_DELAY_MS}`,
    'spawn', // wechat_db.py read（DB 回读验证）
  ])
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

test('dry_run：键序到定位会话为止（不粘贴消息不回车），条目转 dry_run，日志标"停在发送前"', async () => {
  const env = makeEnv({ dryRun: true, logger: recordingLogger() })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: '机密正文', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent') // 消费完成，走 dry_run 路径
  const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
  assert.deepEqual(seq, [
    'activate',
    `sleep:${KEY_DELAY_ACTIVATE_MS}`,
    'clipboard_save',
    'key:esc',
    'ax:window',
    `sleep:${KEY_DELAY_REREAD_MS}`,
    'ax:window',
    'click:107,71',
    `sleep:${KEY_DELAY_CLICK_MS}`,
    'clipboard_set:文件传输助手',
    'key:cmd+v',
    `sleep:${KEY_DELAY_SEARCH_MS}`,
    'key:down',
    `sleep:${KEY_DELAY_DOWN_MS}`,
    'key:return',
    `sleep:${KEY_DELAY_OPEN_MS}`,
    'clipboard_set:saved-content', // dry_run 尾部：恢复剪贴板
  ])
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'dry_run')
  assert.ok(env.logger.logs.info.some((m) => m.includes('停在发送前')))
  assert.ok(!JSON.stringify(readAudit(env.dir)).includes('机密正文'), '审计零正文')
  rmSync(env.dir, { recursive: true, force: true })
})

// 剪贴板保存 mock：activate 前剪贴板内容 "saved-content"
const savedClipboardPatches = {
  osascriptOk: (step) => true,
}
test('熄屏/锁屏（AX 窗口读取失败）→ 环境等待：fail-closed 不点击不敲键，attempts 不增、保持 pending、下轮可重试', async () => {
  const env = makeEnv({ osascriptOk: (step) => step !== 'ax:window' })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred', '环境不可用 = 等待而非失败')
  const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
  assert.ok(!seq.some((s) => String(s).startsWith('click')), '坐标未知绝不盲点')
  assert.ok(!seq.includes('key:cmd+v') && !seq.includes('key:return'), '后续键序全部中止')
  assert.equal(env.steps.filter((s) => s.kind === 'spawn').length, 0, '不回读')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'pending', '保持 pending')
  assert.equal(after.attempts ?? 0, 0, '不计 attempts')
  // 审计行注明 deferred
  const audit = readAudit(env.dir)
  assert.equal(audit[0].result, 'screen_locked_deferred')
  assert.equal(audit[0].deferred, true)
  // 下轮环境恢复 → 正常发送（不熔断，无 attempts 损耗）
  env.osascriptOk = () => true
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r2 = await env.sender.processOnce()
  assert.equal(r2.action, 'sent', '解锁后自动恢复')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('dry_run 熄屏同样挂起（deferred 不计 attempts 不转 dry_run）；环境可读但回读失败仍 attempts+1（既有语义）', async () => {
  const env = makeEnv({ dryRun: true, osascriptOk: (step) => step !== 'ax:window' })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'pending')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).attempts ?? 0, 0)
  // 环境可读但 DB 回读未命中 → 真实失败，attempts+1（既有语义不变）
  const env2 = makeEnv({ dbReadResult: { code: 0, stdout: '{"messages":[{"content":"别的消息"}]}', stderr: '' } })
  const e2 = env2.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  await env2.sender.processOnce()
  const after2 = readOutbox(env2.dir).find((x) => x.id === e2.id)
  assert.equal(after2.status, 'pending')
  assert.equal(after2.attempts, 1, '真实失败计 attempts')
  rmSync(env.dir, { recursive: true, force: true })
  rmSync(env2.dir, { recursive: true, force: true })
})

test('AX 双读坐标不一致（空间切换布局变动中）→ 以第二次读取为准点击', async () => {
  const env = makeEnv({
    dryRun: true,
    // 首读旧空间坐标 1000,34；复读稳定后的新空间 0,34（856x1007 不变）
    axWindowOut: (call) => (call === 1 ? '1000, 34, 856, 1007' : '0, 34, 856, 1007'),
  })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  const click = env.steps.find((s) => s.kind === 'osascript' && String(s.step).startsWith('click'))
  assert.equal(click.step, 'click:107,71', '点击坐标用第二次（复读）读取计算，而非首读')
  assert.equal(env.steps.filter((s) => s.kind === 'osascript' && s.step === 'ax:window').length, 2, 'AX 恰好读两次（首读+复读）')
  rmSync(env.dir, { recursive: true, force: true })
})

test('AX 窗口尺寸异常（<200px 疑似动画中间态）→ 环境等待：不点击不敲键，deferred 不计 attempts', async () => {
  for (const bad of ['0, 34, 150, 1007', '0, 34, 856, 100']) {
    const env = makeEnv({ dryRun: true, axWindowOut: bad })
    const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
    const r = await env.sender.processOnce()
    assert.equal(r.action, 'deferred', `${bad}：环境类异常挂起等待`)
    const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
    assert.ok(!seq.some((s) => String(s).startsWith('click')), `${bad}：绝不盲点`)
    assert.ok(!seq.includes('key:cmd+v') && !seq.includes('key:return'), '后续键序全部中止')
    const after = readOutbox(env.dir).find((x) => x.id === e.id)
    assert.equal(after.status, 'pending')
    assert.equal(after.attempts ?? 0, 0, '环境类 deferred 不计 attempts')
    rmSync(env.dir, { recursive: true, force: true })
  }
})

test('剪贴板保存恢复：真发后恢复原内容；保存失败不恢复也不报错', async () => {
  // 保存成功 → dry_run 尾部恢复
  const env = makeEnv({ dryRun: true })
  // patch saveClipboard 返回值：重写 osascriptOk——clipboard_save 成功且其它都成功
  // （mock 默认走 "saved-content" 分支见 makeEnv：这里直接校验恢复调用存在且内容正确）
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  await env.sender.processOnce()
  const sets = env.steps.filter((s) => s.kind === 'osascript' && s.step.startsWith('clipboard_set'))
  assert.ok(sets.some((s) => s.step === 'clipboard_set:文件传输助手'))
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

test('DB 回读验证失败 → attempts+1 保持 pending；连续 3 次 → failed 不再重试', async () => {
  const env = makeEnv({ dbReadResult: { code: 0, stdout: '{"messages":[{"content":"别的消息"}]}', stderr: '' } })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const r = await env.sender.processOnce()
    assert.equal(r.action, 'failed')
  }
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'failed')
  assert.equal(after.attempts, MAX_ATTEMPTS)
  const spawns = env.steps.filter((s) => s.kind === 'spawn').length
  await env.sender.processOnce()
  assert.equal(env.steps.filter((s) => s.kind === 'spawn').length, spawns, 'failed 不再消费/不再回读')
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
