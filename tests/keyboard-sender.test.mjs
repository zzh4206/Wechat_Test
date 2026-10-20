// keyboard-sender.test.mjs —— 发送原语替换（2026-10-15）：wx-chatbot 式键盘模拟（全离线 mock）。
// 覆盖：14 步实证键序正确性、dry_run 停在定位（不粘贴消息不回车）、DB 回读验证成功/失败、
//       剪贴板保存恢复（含恢复失败不阻塞）、交互闸（用户空闲 <10s 跳过）、
//       缺 sourceToolDir fail-closed、非 filehelper 拒发、wechat-ui 切回、频控/attempts/审计、特征串构造。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { SenderService, appendFeature, buildSendText, MAX_TEXT_CHARS, ALLOWED_CHANNELS, SENDER_AUDIT_REL, MAX_ATTEMPTS, KEY_DELAY_PASTE_MS, VERIFY_DELAY_MS, KEY_DELAY_OPEN_MS, VERIFY_RETRIES, IDLE_SKIP_BELOW_SEC } = await import('../lib/sender.js')
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
  if (s.includes('using {command down, shift down}')) return 'key:cmd+shift+w'
  if (s.includes('keystroke "f" using command down')) return 'key:cmd+f'
  if (s.includes('keystroke "v" using command down')) return 'key:cmd+v'
  if (s.includes('keystroke "')) return `keystroke:${JSON.parse(s.slice(s.indexOf('keystroke ') + 'keystroke '.length))}`
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
    // 发送前合规闸（wechat-ui read）默认通过；chatReadSeq/chatReadResult 可覆盖
    chatReadSeq: overrides.chatReadSeq ?? null,
    chatReadResult: overrides.chatReadResult ?? { code: 0, stdout: 'chat matched: 老大', stderr: '' },
    // 定位闸（wechat-ui open）默认成功（already_open 幂等路径）；locateResult 可覆盖
    locateSeq: overrides.locateSeq ?? null,
    locateResult: overrides.locateResult ?? { code: 0, stdout: '{"type":"opened","already_open":true}', stderr: '' },
    // 发送段（wechat-ui deliver）默认成功；deliverResult 可覆盖
    deliverSeq: overrides.deliverSeq ?? null,
    deliverResult: overrides.deliverResult ?? { code: 0, stdout: '{"type":"delivered_ui"}', stderr: '' },
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
    sourceDbRoot: overrides.sourceDbRoot ?? '/fake/wechat-db-storage',
    sourcePython: overrides.sourcePython ?? 'python3',
    sendTargetChat: overrides.sendTargetChat ?? '老大',
    readbackChatId: overrides.readbackChatId ?? 'wxid_target',
    sendSearchViaClipboard: overrides.sendSearchViaClipboard,
    idleSkipBelowSec: overrides.idleSkipBelowSec,
    allowTakeFocus: overrides.allowTakeFocus,
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
      // 定位闸 spawn（wechat-ui open --chat 老大）独立注入：locateSeq 按序弹出 / locateResult 固定
      if (args[0] === 'open' && args.includes('--chat')) {
        if (env.locateSeq) {
          const seqOut = env.locateSeq.length > 0 ? env.locateSeq.shift() : env.locateResult
          return Promise.resolve(seqOut)
        }
        return Promise.resolve(env.locateResult)
      }
      if (args[0] === 'deliver' && args.includes('--chat')) {
        if (env.deliverSeq) {
          const seqOut = env.deliverSeq.length > 0 ? env.deliverSeq.shift() : env.deliverResult
          return Promise.resolve(seqOut)
        }
        return Promise.resolve(env.deliverResult)
      }
      // 发送前合规闸 spawn（wechat-ui read --chat 老大）独立注入：chatReadSeq 按序弹出 / chatReadResult 固定
      if (args[0] === 'read' && args.includes('--chat')) {
        if (env.chatReadSeq) {
          const seqOut = env.chatReadSeq.length > 0 ? env.chatReadSeq.shift() : env.chatReadResult
          return Promise.resolve(seqOut)
        }
        return Promise.resolve(env.chatReadResult)
      }
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

test('键序正确性（真发）：⌘⇧W+⌘F 键序 + DB 回读验证兜底 → sent', async () => {
  const env = makeEnv()
  const e = env.outbox.appendOutbox({ kind: 'daily', title: '日报', body: '关键判断', evidence_ref: 'r.md' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent')
  const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
  assert.deepEqual(seq, [
    'clipboard_save',
    `clipboard_set:【lurker】日报 关键判断 ${env.lastFeature}`, // 1. 剪贴板=消息文本
    'key:cmd+shift+w', // 2. Cmd+Shift+W 调出微信窗口
    'key:cmd+f', // 3. Cmd+F 打开搜索框
    'keystroke:老大', // 4. 键入搜索词（默认直接键入形态）
    'key:return', // 5. 进入目标对话
    `sleep:${KEY_DELAY_OPEN_MS}`, // 6. 渲染等待
    'key:cmd+v', // 7. 粘贴消息文本
    `sleep:${KEY_DELAY_PASTE_MS}`,
    'key:return', // 8. 发送
    'clipboard_set:saved-content', // 恢复剪贴板
    `sleep:${VERIFY_DELAY_MS}`,
    'spawn', // wechat_db.py read（DB 回读验证兜底——唯一目标闸）
  ])
  // 旧键序残留禁止：无 Esc/AX/点击/↓/activate
  for (const banned of ['key:esc', 'ax:window', 'key:down', 'activate']) assert.ok(!seq.includes(banned), `不应出现 ${banned}`)
  assert.ok(!seq.some((x) => String(x).startsWith('click')), '不应点击搜索框')
  assert.ok(!seq.includes('clipboard_set:老大'), '默认直接键入形态：搜索词不走剪贴板')
  // 回读参数形态：只读、filehelper、limit 3（合规闸 spawn 是 wechat-ui read，回读 spawn 是 python3）
  const spawn = env.steps.filter((s) => s.kind === 'spawn').find((s) => s.file === 'python3')
  assert.equal(spawn.file, 'python3')
  // --db-root/--key-file 是 CLI 全局参数，必须在子命令 read 之前（实测放后面报 unrecognized arguments）
  assert.deepEqual(spawn.args, [
    join('/fake/macos-wechat-export', 'wechat_db.py'),
    '--db-root', '/fake/wechat-db-storage',
    '--key-file', join('/fake/macos-wechat-export', '.wechat-local/keys.json'),
    'read', '--chat-id', 'wxid_target', '--limit', '30', // 宽窗口：目标会话（大号）抗干扰
  ])
  // 验证延迟在回读前
  const sleepIdx = seq.indexOf(`sleep:${VERIFY_DELAY_MS}`)
  assert.ok(sleepIdx >= 0 && sleepIdx < seq.length - 1, `真发后应有 sleep:${VERIFY_DELAY_MS} 再回读`)
  // 状态机 + 审计
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  const audit = readAudit(env.dir)
  assert.deepEqual(audit.map((a) => a.result), ['transmitted', 'sent'], '先落 transmitted 再验证置 sent')
  assert.equal(audit[1].method, 'keyboard')
  rmSync(env.dir, { recursive: true, force: true })
})

test('dry_run：确认前台后直接结束（不碰输入框不回车），条目转 dry_run', async () => {
  const env = makeEnv({ dryRun: true, logger: recordingLogger() })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: '机密正文', evidence_ref: 'r.md' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent') // 消费完成，走 dry_run 路径
  const seq = env.steps.map((s) => (s.kind === 'sleep' ? `sleep:${s.ms}` : s.kind === 'spawn' ? 'spawn' : s.step))
  assert.deepEqual(seq, [
    'clipboard_save',
    `clipboard_set:【lurker】t 机密正文 #l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`, // 1. 剪贴板=消息文本
    'key:cmd+shift+w', // 2.
    'key:cmd+f', // 3.
    'keystroke:老大', // 4. 键入搜索词
    'key:return', // 5. 进入目标对话
    `sleep:${KEY_DELAY_OPEN_MS}`, // 6. 渲染等待——dry_run 停点：光标已在输入框
    'clipboard_set:saved-content', // 恢复剪贴板
  ])
  // dry_run 语义（用户指定键序）：执行到第 6 步（进入对话、光标在输入框）即停——
  // 不粘贴（无 cmd+v）、不发送（仅步骤 5 的定位 Return，无第二次 Return）
  assert.ok(!seq.includes('key:cmd+v'), 'dry_run 不粘贴消息')
  assert.equal(seq.filter((x) => x === 'key:return').length, 1, '仅定位 Return，无发送 Return')
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
  assert.deepEqual(audit.map((a) => a.result), ['transmitted', 'failed_wrong_target'])
  const p0 = audit.find((a) => a.result === 'failed_wrong_target')
  assert.equal(p0.p0, true, '审计行醒目标 P0')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('P0') && m.includes('failed_wrong_target')), '立即 warn')
  // 重试窗口：4 次尝试（每次前 sleep VERIFY_DELAY_MS），穷尽后才终判
  assert.equal(env.steps.filter((x) => x.kind === 'spawn').length, VERIFY_RETRIES, '穷尽 verifyRetries 次回读（OCR 闸已移除）')
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
  assert.equal(env.steps.filter((x) => x.kind === 'spawn').length, 2, '只回读 2 次即命中（+1 定位闸 +1 合规闸；无 deliver spawn）')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  const audit = readAudit(env.dir)
  assert.deepEqual(audit.map((a) => a.result), ['transmitted', 'sent'])
  assert.ok(!audit.some((a) => a.p0), '无 P0')
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
    sourceToolDir: '/fake/macos-wechat-export', sourceDbRoot: '/fake/wechat-db-storage', sourcePython: 'python3',
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
  assert.equal(env.steps.filter((x) => x.kind === 'spawn').length, 2, '回读 2 次（OCR 闸已移除——纯回读 spawn）')
  assert.deepEqual(env.steps.filter((x) => x.kind === 'sleep').map((x) => x.ms), [KEY_DELAY_OPEN_MS, KEY_DELAY_PASTE_MS, 1000, 1000])
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('回读本身失败（CLI 报错）→ 保持 sent_pending_verify 只重试验证、绝不重发；verifyAttempts≥5 人工告警', async () => {
  const env = makeEnv({
    logger: recordingLogger(),
    dbReadResult: { code: 1, stdout: '', stderr: 'db locked' },
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'deferred', '回读失败 = 环境等待，不是 wrong_target')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'sent_pending_verify', '已 transmitted 绝不回退 pending（防重发循环）')
  assert.equal(after.transmittedAt > 0, true, 'transmittedAt 落盘')
  assert.equal(after.verifyAttempts, 1, '验证轮数计数')
  const audit = readAudit(env.dir)
  assert.deepEqual(audit.map((a) => a.result), ['transmitted', 'verify_read_deferred'])
  assert.ok(!audit.some((a) => a.p0), '绝不误判 P0')
  assert.ok(env.logger.logs.warn.some((m) => m.includes('绝不重发')))
  // 下一轮：零重发，只重试验证（verifyAttempts 累计到 5 → error 人工告警）
  const spawnsBefore = env.steps.filter((x) => x.kind === 'osascript' && x.step === 'activate').length
  for (let i = 0; i < 4; i++) await env.sender.processOnce()
  const after5 = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after5.status, 'sent_pending_verify', '仍未验证通过，保持待验证')
  assert.equal(after5.verifyAttempts, 5)
  assert.equal(env.steps.filter((x) => x.kind === 'osascript' && x.step === 'activate').length, spawnsBefore, '验证-only 轮零键序（零重发）')
  assert.ok(env.logger.logs.error.some((m) => m.includes('人工介入')), 'verifyAttempts≥5 转人工告警')
  rmSync(env.dir, { recursive: true, force: true })
})

test('idleSkipBelowSec=0：用户活动也不让路（空闲检测失效）→ 抢前台照发，审计 take_focus_sent', async () => {
  const env = makeEnv({ idleSec: 0.1, idleSkipBelowSec: 0, allowTakeFocus: true })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  env.lastFeature = `#l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent', '阈值 0 = 不让路，用户活动也照发')
  assert.equal(env.steps.length > 0, true, '键序确实发出')
  const audit = readAudit(env.dir)
  assert.deepEqual(audit.map((a) => a.result), ['transmitted', 'take_focus_sent'])
  assert.ok(!audit.some((a) => a.result === 'user_active'), '无 user_active 让路')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'sent')
  rmSync(env.dir, { recursive: true, force: true })
})

test('idleSkipBelowSec 默认 10：行为零变化（空闲 <10s 仍让路跳过）', async () => {
  const env = makeEnv({ idleSec: IDLE_SKIP_BELOW_SEC - 0.5 })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'user_active', '默认阈值不传 = 仍是 10s 让路')
  assert.equal(env.steps.length, 0, '零按键')
  assert.equal(readOutbox(env.dir)[0].status, 'pending')
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

test('keyboard 模式缺 sourceDbRoot：fail-closed 不发键序，计数 attempts（多账号环境回读必需）', async () => {
  const env = makeEnv({ sourceDbRoot: '' })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 1; i <= MAX_ATTEMPTS; i++) await env.sender.processOnce()
  assert.equal(env.steps.length, 0, '无法验证 = 一个按键都不发')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'failed')
  assert.equal(after.attempts, MAX_ATTEMPTS)
  const audit = readAudit(env.dir)
  assert.ok(audit.every((a) => a.result === 'unverified_no_db_tool' && a.missing === 'sourceDbRoot'))
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

// —— 回读验证抗干扰（签名 + 时间窗双重过滤）——

const NOW_MS = new Date(2026, 9, 15, 12, 0).getTime()

function dbMsg(content, createTimeSec, serverId) {
  return { content, create_time: createTimeSec, server_id: serverId }
}

test('抗干扰①：签名被用户消息挤出 top-3 → 宽窗口 --limit 30 仍命中，且抓取 server_id', async () => {
  const env = makeEnv({
    // 用户随后发了 10 条消息；我们的签名在 resp 的最后一条（create_time = 发送时刻 +2s）
    dbReadResult: {
      code: 0,
      stdout: JSON.stringify({
        messages: [
          ...Array.from({ length: 10 }, (_, i) => dbMsg(`用户闲聊 ${i}`, Math.floor(NOW_MS / 1000) + 5 + i, `u${i}`)),
        ],
      }),
      stderr: '',
    },
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: '日报', body: 'b', evidence_ref: 'x' })
  env.dbReadResult.stdout = JSON.stringify({
    messages: [
      ...Array.from({ length: 10 }, (_, i) => dbMsg(`用户闲聊 ${i}`, Math.floor(NOW_MS / 1000) + 5 + i, `u${i}`)),
      dbMsg(`【lurker】日报 x #l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`, Math.floor(NOW_MS / 1000) + 2, '987654321'),
    ],
  })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'sent', '签名在 top-3 之外仍命中')
  const after = readOutbox(env.dir).find((x) => x.id === e.id)
  assert.equal(after.status, 'sent')
  assert.equal(after.serverId, '987654321', '送达回执 server_id 落盘')
  assert.ok(after.sentAt > 0)
  const audit = readAudit(env.dir).find((a) => a.result === 'sent')
  assert.equal(audit.serverId, '987654321', '审计记 serverId（元数据）')
  rmSync(env.dir, { recursive: true, force: true })
})

test('抗干扰②：窗口内用户自己的旧消息（无签名、时间早于 transmittedAt）→ 不误匹配', async () => {
  const env = makeEnv({
    dbReadResult: {
      code: 0,
      stdout: JSON.stringify({
        messages: [
          dbMsg('用户更早发的消息', Math.floor(NOW_MS / 1000) - 3600, 'old1'),
          dbMsg('包含【lurker】但非本次签名', Math.floor(NOW_MS / 1000) - 60, 'old2'),
        ],
      }),
      stderr: '',
    },
  })
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'failed', '无签名命中 → 穷尽后 failed')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'failed_wrong_target')
  rmSync(env.dir, { recursive: true, force: true })
})

test('抗干扰③：签名命中但 create_time 早于 transmittedAt-60s → 陈旧误配不算命中', async () => {
  const env = makeEnv({})
  const e = env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const stale = JSON.stringify({
    messages: [dbMsg(`旧的同签名消息 #l${e.id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`, Math.floor(NOW_MS / 1000) - 7200, 'stale1')],
  })
  env.dbReadResult = { code: 0, stdout: stale, stderr: '' }
  const r = await env.sender.processOnce()
  assert.equal(r.action, 'failed', '陈旧签名不作为验证通过')
  assert.equal(readOutbox(env.dir).find((x) => x.id === e.id).status, 'failed_wrong_target')
  rmSync(env.dir, { recursive: true, force: true })
})

// ===== 定位闸（wechat-ui open，2026-10-16 HANDOFF-sender-autotarget）四场景 =====






