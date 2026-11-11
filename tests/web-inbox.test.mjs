// web-inbox.test.mjs —— 前端 FE-2 审批收件箱：web 进程 POST → web/actions.jsonl → 插件 ActionInbox
// （生产同款 createApprovalWiring 组装）→ 回执 → 页面查询，端到端闭环；外加写通道的安全用例。
// 全离线：每群库经 GroupStoreService 现建，消息/人名均为合成数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import { createHash } from 'node:crypto'

const { createWebServer } = await import('../web/server.mjs')
const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { TaskRecognitionService } = await import('../lib/task-recognition.js')
const { PromiseRecognitionService } = await import('../lib/promise-track.js')
const { createApprovalWiring } = await import('../lib/approval-wiring.js')
const { createReportOps } = await import('../lib/approval-actions.js')
const { ActionInbox } = await import('../lib/action-inbox.js')
const { writeWebManifest } = await import('../lib/web-manifest.js')
const { reportRelPath } = await import('../lib/report.js')
const { RegenQueue } = await import('../lib/regen-queue.js')
const { Outbox } = await import('../lib/outbox.js')
const { createReportOutbox } = await import('../lib/report-outbox.js')

const CHAT = '12345678@chatroom'
const OUTSIDE = '1234567890@chatroom'
const TOKEN = 'synth-token-0002-abcdef'
const ORIGIN_TS = new Date(2026, 9, 14, 10, 0, 0).getTime() // 本地 2026-10-14 10:00
const ORIGIN_KEY = '2026-10-14'
// 与插件 index.ts 的 webActionsOperator 同算法：sha256 十六进制前 8 位
const fingerprint = (t) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 8)

/** pluginToken：插件配置 webActionsToken（null = 未配置）；web 进程固定用 TOKEN */
async function makeEnv({ allowActions = true, actionsEnabled = true, pluginToken = TOKEN, outboxEnabled = false } = {}) {
  const pluginOperator = pluginToken ? fingerprint(pluginToken) : undefined
  const dir = resolve(mkdtempSync(join(tmpdir(), 'web-inbox-')))
  const logger = { warn() {}, error() {}, info() {}, debug() {} }
  const groupStore = new GroupStoreService(dir, logger)
  const store = new Store(dir, logger, join(dir, 'knowledge.db'))
  const llm = { async complete() { return '{}' } }
  const task = new TaskRecognitionService({ groupStore, llm, logger, enabled: true, store })
  const promise = new PromiseRecognitionService({ groupStore, llm, logger, enabled: true })
  const regenQueue = new RegenQueue({ store, logger })
  const { reportRevision, approvalActions, resolveInboxTarget } = createApprovalWiring({
    store, groupStore, task, promise, notify: () => {}, logger,
    // 与 index.ts 同口径：前端/对话框重跑一律 reason='manual'
    enqueueReportRegen: (c, d, k) => regenQueue.enqueue(c, d, Date.now(), k, 'manual') !== 'deduped',
  })
  const reportOps = createReportOps({
    enqueueReportRegen: (c, d, k) => regenQueue.enqueue(c, d, Date.now(), k, 'manual') !== 'deduped',
    reports: {
      finalizeReport: (c, k, ps) => store.finalizeReport(c, k, ps),
      recordRevision: (c, k, ps, ts, summary, src) => store.mirrorReport(c, k, ps, ts, 'status', { summary, source: src }),
    },
    notify: () => {},
    logger,
  })
  const inbox = new ActionInbox({
    store, actions: approvalActions, reportOps, groups: [CHAT], logger, resolveTarget: resolveInboxTarget, operator: pluginOperator,
    // 与 index.ts 同口径：仅 webOutboxEnabled 时注入
    reportOutbox: outboxEnabled ? createReportOutbox({ store, outbox: new Outbox({ store }) }) : undefined,
    marks: { markTarget: (c, k, id, s, src) => reportRevision.markTarget(c, k, id, s, src) },
  })
  writeWebManifest(store, { groups: [CHAT], knowledgeDb: join(dir, 'knowledge.db'), actionsEnabled, operator: pluginOperator ?? null, outboxEnabled })

  // 合成数据：证据消息前后各有消息；一条待确认任务、一条无时限进行中任务、一条待确认承诺、一条待确认事件
  await groupStore.appendIdentity(CHAT, { pid: 'wx_p1', wxid: 'wxid_a', groupNick: '张三', watchLevel: 'off' })
  await groupStore.appendMessages(CHAT, [
    { msgId: 'synth-0001', ts: ORIGIN_TS - 2000, senderPid: 'wx_p1', senderName: '张三', text: '大家好' },
    { msgId: 'synth-0002', ts: ORIGIN_TS, senderPid: 'wx_p1', senderName: '张三', text: '请周五前交材料' },
    { msgId: 'synth-0003', ts: ORIGIN_TS + 2000, senderPid: 'wx_p1', senderName: '张三', text: '收到' },
  ])
  const pendingTask = await groupStore.appendTask(CHAT, { statement: '交材料', assignerPid: 'wx_p1', evidenceMsgId: 'synth-0002', status: 'pending_confirm' }, ORIGIN_TS)
  const undatedTask = await groupStore.appendTask(CHAT, { statement: '整理文档', status: 'active' }, ORIGIN_TS)
  const pendingPromise = await groupStore.appendPromise(CHAT, { statement: '明天发链接', status: 'pending_confirm' }, ORIGIN_TS)
  const pendingEvent = await groupStore.appendEvent(CHAT, { category: 'meeting', statement: '周三开会', status: 'pending_confirm', confidence: 0.8 })
  // 出身日报（修订段写入目标）
  store.ensureDir(`reports/${CHAT}`)
  store.writeText(reportRelPath(CHAT, ORIGIN_KEY, 'daily'), `# 日报 ${ORIGIN_KEY}\n\n正文\n`)

  const app = createWebServer({ stateDir: dir, token: TOKEN, allowActions })
  const port = await app.start(0)
  const self = `http://127.0.0.1:${port}`
  const headers = (extra = {}) => ({ host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...extra })
  return {
    dir, port, store, groupStore, inbox, regenQueue, ids: { pendingTask, undatedTask, pendingPromise, pendingEvent },
    get: (path) => call(port, 'GET', path, headers()),
    post: (body, extra = { origin: self, 'content-type': 'application/json' }) => call(port, 'POST', '/api/actions', headers(extra), typeof body === 'string' ? body : JSON.stringify(body)),
    async stop() {
      await app.close()
      groupStore.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function call(port, method, path, headers, body) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
        ok({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', fail)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const actionLines = (dir) => {
  const f = join(dir, 'web', 'actions.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
}

// —— 读侧 ——

test('/api/inbox：待确认三类 + 进行中任务（无时限），证据带发送者与预览', async () => {
  const env = await makeEnv()
  try {
    const r = await env.get(`/api/inbox?chat=${encodeURIComponent(CHAT)}`)
    assert.equal(r.status, 200)
    const byKey = Object.fromEntries(r.body.map(it => [`${it.kind}:${it.id}`, it]))
    const t = byKey[`task:${env.ids.pendingTask}`]
    assert.equal(t.status, 'pending_confirm')
    assert.equal(t.assigner, '张三')
    assert.deepEqual(t.evidence, { msgId: 'synth-0002', ts: ORIGIN_TS, sender: '张三', preview: '请周五前交材料' })
    assert.equal(byKey[`task:${env.ids.undatedTask}`].deadline, null)
    assert.equal(byKey[`promise:${env.ids.pendingPromise}`].status, 'pending_confirm')
    assert.equal(byKey[`event:${env.ids.pendingEvent}`].confidence, 0.8)
    assert.equal(JSON.stringify(r.body).includes('wxid_'), false, '不外露 wxid')
    assert.equal((await env.get(`/api/inbox?chat=${encodeURIComponent(OUTSIDE)}`)).status, 403)
    assert.equal((await env.get('/api/inbox')).body.length, r.body.length, '缺省 = 全部白名单群')
  } finally { await env.stop() }
})

test('/api/evidence：证据消息前后上下文，标出证据行', async () => {
  const env = await makeEnv()
  try {
    const r = await env.get(`/api/evidence?chat=${encodeURIComponent(CHAT)}&msg=synth-0002&around=1`)
    assert.deepEqual(r.body.messages.map(m => [m.msgId, m.isEvidence]), [['synth-0001', false], ['synth-0002', true], ['synth-0003', false]])
    assert.equal((await env.get(`/api/evidence?chat=${encodeURIComponent(OUTSIDE)}&msg=synth-0002`)).status, 403)
  } finally { await env.stop() }
})

test('/api/chats 报告写动作可用性', async () => {
  const on = await makeEnv()
  try { assert.deepEqual((await on.get('/api/chats')).body.actions, { enabled: true, reason: null, outboxEnabled: false }) } finally { await on.stop() }
  const noToken = await makeEnv({ allowActions: false })
  try { assert.deepEqual((await noToken.get('/api/chats')).body.actions, { enabled: false, reason: 'no_shared_token' }) } finally { await noToken.stop() }
  const off = await makeEnv({ actionsEnabled: false })
  try { assert.deepEqual((await off.get('/api/chats')).body.actions, { enabled: false, reason: 'inbox_disabled' }) } finally { await off.stop() }
})

// —— 端到端闭环 ——

test('闭环：task.confirm 提交 → 插件消费 → 回执 ok → 任务 active + learned_pattern 登记 + 修订记来源前端', async () => {
  const env = await makeEnv()
  try {
    const p = await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask, actionId: 'forged-id' })
    assert.equal(p.status, 202)
    assert.match(p.body.actionId, /^a-\d{13}-[0-9a-f]{8}$/, 'actionId 由服务端生成，忽略请求体里的')
    assert.equal(actionLines(env.dir)[0].actionId, p.body.actionId)
    assert.deepEqual((await env.get(`/api/actions/${p.body.actionId}`)).body, { actionId: p.body.actionId, status: 'pending' })

    assert.equal(await env.inbox.poll(), 1)
    assert.deepEqual((await env.get(`/api/actions/${p.body.actionId}`)).body, { actionId: p.body.actionId, status: 'done', ok: true, code: 'ok' })
    const row = env.groupStore.getTask(CHAT, env.ids.pendingTask)
    assert.equal(row.status, 'active')
    assert.ok(row.learnedPattern, 'learned_pattern 被登记（FE-2 验收）')
    await new Promise(r => setTimeout(r, 50)) // 修订接线是 fire-and-forget
    const md = env.store.readText(reportRelPath(CHAT, ORIGIN_KEY, 'daily'))
    assert.ok(md.includes('（来源：前端）'), `修订段来源应为前端：\n${md}`)

    // 同一目标再确认 → 插件判 status_conflict，回执透传
    const again = await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })
    await env.inbox.poll()
    assert.equal((await env.get(`/api/actions/${again.body.actionId}`)).body.code, 'status_conflict')
  } finally { await env.stop() }
})

test('闭环：task.set_deadline 人工定时间（置信度 1）；event.confirm；person.follow', async () => {
  const env = await makeEnv()
  try {
    const dl = new Date(2026, 9, 20, 18, 0).getTime()
    const a = await env.post({ type: 'task.set_deadline', chatId: CHAT, targetId: env.ids.undatedTask, params: { deadline: dl } })
    const b = await env.post({ type: 'event.confirm', chatId: CHAT, targetId: env.ids.pendingEvent })
    const c = await env.post({ type: 'person.follow', chatId: CHAT, params: { pid: 'wx_p1' } })
    assert.deepEqual([a.status, b.status, c.status], [202, 202, 202])
    assert.equal(await env.inbox.poll(), 3)
    for (const id of [a.body.actionId, b.body.actionId, c.body.actionId]) {
      assert.equal((await env.get(`/api/actions/${id}`)).body.ok, true, id)
    }
    const t = env.groupStore.getTask(CHAT, env.ids.undatedTask)
    assert.deepEqual([t.deadline, t.deadlineConfidence], [dl, 1])
    assert.equal(env.groupStore.getEvent(CHAT, env.ids.pendingEvent).status, 'active')
    const persons = (await env.get(`/api/persons?chat=${encodeURIComponent(CHAT)}`)).body
    assert.equal(persons.find(p => p.pid === 'wx_p1').watchLevel, 'group')
  } finally { await env.stop() }
})

// —— 写通道安全 ——

test('写请求：缺/错 Origin 403、非 JSON 415、无 token 401', async () => {
  const env = await makeEnv()
  try {
    const body = { type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask }
    assert.equal((await env.post(body, { 'content-type': 'application/json' })).status, 403, 'POST 必须带 Origin')
    assert.equal((await env.post(body, { origin: 'https://evil.example', 'content-type': 'application/json' })).status, 403)
    assert.equal((await env.post(body, { origin: `http://127.0.0.1:${env.port}`, 'content-type': 'text/plain' })).status, 415, '表单类简单请求被拒')
    const noAuth = await call(env.port, 'POST', '/api/actions', { host: `127.0.0.1:${env.port}`, origin: `http://127.0.0.1:${env.port}`, 'content-type': 'application/json' }, JSON.stringify(body))
    assert.equal(noAuth.status, 401)
    assert.equal(actionLines(env.dir).length, 0, '被拒请求零落盘')
  } finally { await env.stop() }
})

test('写请求：白名单外类型/群、非法 targetId/deadline/pid、超大或损坏请求体 → 拒绝且零落盘', async () => {
  const env = await makeEnv()
  try {
    const cases = [
      [{ type: 'task.rewrite', chatId: CHAT, targetId: 1, params: { text: 'x' } }, 400, 'type_not_allowed'],
      [{ type: '__proto__', chatId: CHAT, targetId: 1 }, 400, 'type_not_allowed'],
      [{ type: 'task.confirm', chatId: OUTSIDE, targetId: 1 }, 403, 'chat_not_allowed'],
      [{ type: 'task.confirm', chatId: 'aggregate', targetId: 1 }, 403, 'chat_not_allowed'],
      [{ type: 'task.confirm', chatId: CHAT, targetId: 0 }, 400, 'bad_request'],
      [{ type: 'task.confirm', chatId: CHAT, targetId: '1' }, 400, 'bad_request'],
      [{ type: 'task.set_deadline', chatId: CHAT, targetId: 1, params: { deadline: 5 } }, 400, 'bad_request'],
      [{ type: 'task.set_deadline', chatId: CHAT, targetId: 1, params: { deadline: 'tomorrow' } }, 400, 'bad_request'],
      [{ type: 'person.follow', chatId: CHAT, params: { pid: '../x' } }, 400, 'bad_request'],
      ['{not json', 400, 'bad_request'],
      [JSON.stringify({ type: 'task.confirm', chatId: CHAT, targetId: 1, pad: 'x'.repeat(10000) }), 400, 'bad_request'],
    ]
    for (const [body, status, error] of cases) {
      const r = await env.post(body)
      assert.equal(r.status, status, JSON.stringify(body).slice(0, 80))
      assert.equal(r.body.error, error)
    }
    assert.equal(actionLines(env.dir).length, 0)
  } finally { await env.stop() }
})

test('写动作不可用时 409：未用共享 token / 插件收件箱未开', async () => {
  for (const [opts, reason] of [[{ allowActions: false }, 'no_shared_token'], [{ actionsEnabled: false }, 'inbox_disabled']]) {
    const env = await makeEnv(opts)
    try {
      const r = await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })
      assert.deepEqual([r.status, r.body.reason], [409, reason])
      assert.equal(actionLines(env.dir).length, 0)
    } finally { await env.stop() }
  }
})

test('R3：actions.jsonl 是符号链接时拒写，链接目标不被改动', async () => {
  const env = await makeEnv()
  const outside = resolve(mkdtempSync(join(tmpdir(), 'web-inbox-outside-')))
  try {
    writeFileSync(join(outside, 'target.txt'), 'untouched')
    symlinkSync(join(outside, 'target.txt'), join(env.dir, 'web', 'actions.jsonl'))
    const r = await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })
    assert.equal(r.status, 500)
    assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'untouched')
  } finally {
    await env.stop()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('web 进程只写 web/actions.jsonl：一次提交前后 stateDir 只多这一个文件', async () => {
  const env = await makeEnv()
  try {
    const snapshot = () => readdirSync(env.dir, { recursive: true }).filter(f => !/-(wal|shm|journal)$/.test(f)).sort()
    const before = snapshot()
    await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })
    const added = snapshot().filter(f => !before.includes(f))
    assert.deepEqual(added, [join('web', 'actions.jsonl')])
  } finally { await env.stop() }
})

test('/api/actions/:id 只认服务端 actionId 格式', async () => {
  const env = await makeEnv()
  try {
    assert.equal((await env.get('/api/actions/..%2F..%2Fetc')).status, 400)
    assert.equal((await env.get('/api/actions/bad-line')).status, 400)
  } finally { await env.stop() }
})

// —— 审计对齐：审计 operator 必须能用浏览器实际 token 的哈希核对 ——

test('审计 operator = 浏览器实际 token 的指纹；动作行带同一指纹', async () => {
  const env = await makeEnv()
  try {
    const p = await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })
    assert.equal(actionLines(env.dir)[0].operator, fingerprint(TOKEN))
    await env.inbox.poll()
    const audit = readFileSync(join(env.dir, 'audit', 'web-actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const row = audit.find(a => a.actionId === p.body.actionId)
    assert.deepEqual([row.code, row.operator], ['ok', fingerprint(TOKEN)])
    assert.equal(readFileSync(join(env.dir, 'audit', 'web-actions.jsonl'), 'utf8').includes(TOKEN), false, '审计不落原 token')
  } finally { await env.stop() }
})

test('LURKER_WEB_TOKEN ≠ webActionsToken → 只读（token_mismatch），提交 409 零落盘', async () => {
  const env = await makeEnv({ pluginToken: 'synth-token-other-999999' })
  try {
    assert.deepEqual((await env.get('/api/chats')).body.actions, { enabled: false, reason: 'token_mismatch' })
    const r = await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })
    assert.deepEqual([r.status, r.body.reason], [409, 'token_mismatch'])
    assert.equal(actionLines(env.dir).length, 0)
  } finally { await env.stop() }
})

test('插件未配置 webActionsToken → 只读（plugin_token_unset）：审计 operator 只会是 unknown，无法核对', async () => {
  const env = await makeEnv({ pluginToken: null })
  try {
    assert.deepEqual((await env.get('/api/chats')).body.actions, { enabled: false, reason: 'plugin_token_unset' })
    assert.equal((await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })).status, 409)
  } finally { await env.stop() }
})

test('插件侧兜底：入队后插件换了 token（清单未及刷新）→ operator_mismatch 不执行，回执透传', async () => {
  const env = await makeEnv()
  try {
    const p = await env.post({ type: 'task.confirm', chatId: CHAT, targetId: env.ids.pendingTask })
    // 模拟插件以新 token 重启：收件箱的 operator 变了，队列里的旧行不再被执行
    const { ActionInbox: Inbox } = await import('../lib/action-inbox.js')
    const rotated = new Inbox({ store: env.store, actions: env.inbox.deps.actions, groups: [CHAT], logger: { warn() {}, error() {} }, operator: fingerprint('synth-token-rotated-0000') })
    await rotated.poll()
    assert.deepEqual((await env.get(`/api/actions/${p.body.actionId}`)).body, { actionId: p.body.actionId, status: 'done', ok: false, code: 'operator_mismatch' })
    assert.equal(env.groupStore.getTask(CHAT, env.ids.pendingTask).status, 'pending_confirm', '未执行')
  } finally { await env.stop() }
})

// —— FE-3：报告定稿 / 重新生成 ——

test('定稿闭环：前端提交 → 插件定稿 → 详情页 status=final 且修订历史有定稿记录；重复定稿 status_conflict', async () => {
  const env = await makeEnv()
  try {
    env.store.writeReport('daily', CHAT, ORIGIN_KEY, `# 日报 ${ORIGIN_KEY}\n\n正文\n`)
    const list = (await env.get(`/api/reports?chat=${encodeURIComponent(CHAT)}`)).body
    const rep = list.find(r => r.periodStart === ORIGIN_KEY && r.periodType === 'daily')
    assert.equal(rep.status, 'draft')
    const p = await env.post({ type: 'report.finalize', chatId: CHAT, params: { kind: 'daily', dateKey: ORIGIN_KEY } })
    assert.equal(p.status, 202)
    assert.deepEqual(actionLines(env.dir).at(-1).params, { kind: 'daily', dateKey: ORIGIN_KEY })
    await env.inbox.poll()
    assert.equal((await env.get(`/api/actions/${p.body.actionId}`)).body.code, 'ok')
    const detail = (await env.get(`/api/reports/${rep.id}`)).body
    assert.equal(detail.status, 'final')
    assert.ok(detail.revisions.some(v => v.type === 'status' && v.source === 'web'), '修订历史记定稿（来源前端）')
    const again = await env.post({ type: 'report.finalize', chatId: CHAT, params: { kind: 'daily', dateKey: ORIGIN_KEY } })
    await env.inbox.poll()
    assert.equal((await env.get(`/api/actions/${again.body.actionId}`)).body.code, 'status_conflict')
  } finally { await env.stop() }
})

test('重新生成：前端提交 → 插件入手动重跑队列（reason=manual）；不进发件箱；重复提交 duplicate', async () => {
  const env = await makeEnv()
  try {
    const a = await env.post({ type: 'report.regen', chatId: CHAT, params: { kind: 'weekly', dateKey: '2026-10-12' } })
    const b = await env.post({ type: 'report.regen', chatId: CHAT, params: { kind: 'weekly', dateKey: '2026-10-12' } })
    await env.inbox.poll()
    assert.equal((await env.get(`/api/actions/${a.body.actionId}`)).body.code, 'ok')
    assert.equal((await env.get(`/api/actions/${b.body.actionId}`)).body.code, 'duplicate')
    assert.deepEqual(env.regenQueue.list().map(e => [e.kind, e.dateKey, e.reason]), [['weekly', '2026-10-12', 'manual']])
    assert.equal(new Outbox({ store: env.store }).listOutbox().length, 0, '入队即止，发件箱零条目')
  } finally { await env.stop() }
})

test('报告操作参数校验：周报须周一、月报须 1 号、非法日期/周期、聚合非日报与白名单外群 → 拒绝且零落盘', async () => {
  const env = await makeEnv()
  try {
    const cases = [
      [{ type: 'report.finalize', chatId: CHAT, params: { kind: 'weekly', dateKey: '2026-10-14' } }, 400, 'not_monday'],
      [{ type: 'report.regen', chatId: CHAT, params: { kind: 'monthly', dateKey: '2026-10-02' } }, 400, 'not_month_start'],
      [{ type: 'report.regen', chatId: CHAT, params: { kind: 'daily', dateKey: '2026-02-30' } }, 400, 'date_format'],
      [{ type: 'report.regen', chatId: CHAT, params: { kind: 'yearly', dateKey: '2026-01-01' } }, 400, 'kind_not_allowed'],
      [{ type: 'report.finalize', chatId: 'aggregate', params: { kind: 'weekly', dateKey: '2026-10-12' } }, 400, 'aggregate_daily_only'],
      [{ type: 'report.finalize', chatId: OUTSIDE, params: { kind: 'daily', dateKey: ORIGIN_KEY } }, 403, undefined],
    ]
    for (const [body, status, reason] of cases) {
      const r = await env.post(body)
      assert.equal(r.status, status, JSON.stringify(body))
      if (reason) assert.equal(r.body.reason, reason)
    }
    assert.equal(actionLines(env.dir).length, 0)
  } finally { await env.stop() }
})

// —— FE-3：排入发件箱（插件 webOutboxEnabled，默认关） ——

test('排入发件箱：开关关（默认）→ web 侧 409 outbox_disabled 零落盘；手写行绕过 web 也被插件拒（unsupported）', async () => {
  const env = await makeEnv()
  try {
    env.store.writeReport('daily', CHAT, ORIGIN_KEY, `# 日报 ${ORIGIN_KEY}\n\n正文\n`)
    const r = await env.post({ type: 'report.toOutbox', chatId: CHAT, params: { kind: 'daily', dateKey: ORIGIN_KEY } })
    assert.deepEqual([r.status, r.body.reason], [409, 'outbox_disabled'])
    assert.equal(actionLines(env.dir).length, 0)
    // 直接往 actions.jsonl 写（模拟绕过 web 进程）：插件侧仍拒
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(env.dir, 'web', 'actions.jsonl'), JSON.stringify({ actionId: 'a-1760000000000-deadbeef', ts: 1, chatId: CHAT, type: 'report.toOutbox', params: { kind: 'daily', dateKey: ORIGIN_KEY }, operator: fingerprint(TOKEN) }) + '\n')
    await env.inbox.poll()
    assert.equal((await env.get('/api/actions/a-1760000000000-deadbeef')).body.code, 'unsupported')
    assert.equal(new Outbox({ store: env.store }).listOutbox().length, 0, '零入队')
  } finally { await env.stop() }
})

test('排入发件箱：开关开 → 提交 → 插件入队一条同形条目（pending，不含正文）；10 分钟内重复 duplicate', async () => {
  const env = await makeEnv({ outboxEnabled: true })
  try {
    env.store.writeReport('daily', CHAT, ORIGIN_KEY, `# 日报 ${ORIGIN_KEY}\n\n- 合成正文 synth-0009\n`)
    assert.equal((await env.get('/api/chats')).body.actions.outboxEnabled, true)
    const a = await env.post({ type: 'report.toOutbox', chatId: CHAT, params: { kind: 'daily', dateKey: ORIGIN_KEY } })
    const b = await env.post({ type: 'report.toOutbox', chatId: CHAT, params: { kind: 'daily', dateKey: ORIGIN_KEY } })
    assert.deepEqual([a.status, b.status], [202, 202])
    await env.inbox.poll()
    assert.equal((await env.get(`/api/actions/${a.body.actionId}`)).body.code, 'ok')
    assert.equal((await env.get(`/api/actions/${b.body.actionId}`)).body.code, 'duplicate')
    const entries = new Outbox({ store: env.store }).listOutbox()
    assert.equal(entries.length, 1)
    assert.deepEqual([entries[0].kind, entries[0].status, entries[0].channel], ['daily', 'pending', 'filehelper'])
    assert.equal(JSON.stringify(entries[0]).includes('synth-0009'), false)
  } finally { await env.stop() }
})

// —— 跨群汇总的报告操作（只有日报；聚合不是群，只放行 report.*） ——

test('跨群汇总：定稿 / 重新生成（入手动重跑队列）/ 排入发件箱 闭环', async () => {
  const env = await makeEnv({ outboxEnabled: true })
  try {
    env.store.writeReport('daily', 'aggregate', ORIGIN_KEY, `# 跨群汇总 · ${ORIGIN_KEY}\n\n正文\n`)
    const rep = (await env.get('/api/reports?chat=aggregate')).body.find(r => r.periodStart === ORIGIN_KEY)
    assert.equal(rep.status, 'draft')
    const params = { kind: 'daily', dateKey: ORIGIN_KEY }
    const f = await env.post({ type: 'report.finalize', chatId: 'aggregate', params })
    const g = await env.post({ type: 'report.regen', chatId: 'aggregate', params })
    const o = await env.post({ type: 'report.toOutbox', chatId: 'aggregate', params })
    assert.deepEqual([f.status, g.status, o.status], [202, 202, 202])
    await env.inbox.poll()
    for (const p of [f, g, o]) assert.equal((await env.get(`/api/actions/${p.body.actionId}`)).body.code, 'ok')
    assert.equal((await env.get(`/api/reports/${rep.id}`)).body.status, 'final')
    assert.deepEqual(env.regenQueue.list().map(e => [e.chatId, e.kind, e.dateKey, e.reason]), [['aggregate', 'daily', ORIGIN_KEY, 'manual']])
    const entries = new Outbox({ store: env.store }).listOutbox()
    assert.deepEqual(entries.map(e => [e.title, e.evidence_ref]), [[`跨群汇总 ${ORIGIN_KEY}（前端补推）`, `reports/summary/${ORIGIN_KEY}.md`]])
  } finally { await env.stop() }
})

test('跨群汇总：手写行绕过 web——非报告操作 chat_not_allowed、周报 bad_request，均不执行', async () => {
  const env = await makeEnv()
  try {
    const { appendFileSync } = await import('node:fs')
    const op = fingerprint(TOKEN)
    const lines = [
      { actionId: 'a-1760000000001-00000001', type: 'task.confirm', targetId: env.ids.pendingTask },
      { actionId: 'a-1760000000002-00000002', type: 'report.regen', params: { kind: 'weekly', dateKey: '2026-10-12' } },
    ]
    for (const l of lines) appendFileSync(join(env.dir, 'web', 'actions.jsonl'), JSON.stringify({ ts: 1, chatId: 'aggregate', operator: op, ...l }) + '\n')
    await env.inbox.poll()
    assert.equal((await env.get('/api/actions/a-1760000000001-00000001')).body.code, 'chat_not_allowed')
    assert.equal((await env.get('/api/actions/a-1760000000002-00000002')).body.code, 'bad_request')
    assert.equal(env.regenQueue.list().length, 0)
    assert.equal(env.groupStore.getTask(CHAT, env.ids.pendingTask).status, 'pending_confirm')
  } finally { await env.stop() }
})
