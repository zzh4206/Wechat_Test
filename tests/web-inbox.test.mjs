// web-inbox.test.mjs —— 前端 FE-2 审批收件箱：web 进程 POST → web/actions.jsonl → 插件 ActionInbox
// （生产同款 createApprovalWiring 组装）→ 回执 → 页面查询，端到端闭环；外加写通道的安全用例。
// 全离线：每群库经 GroupStoreService 现建，消息/人名均为合成数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'node:http'

const { createWebServer } = await import('../web/server.mjs')
const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { TaskRecognitionService } = await import('../lib/task-recognition.js')
const { PromiseRecognitionService } = await import('../lib/promise-track.js')
const { createApprovalWiring } = await import('../lib/approval-wiring.js')
const { ActionInbox } = await import('../lib/action-inbox.js')
const { writeWebManifest } = await import('../lib/web-manifest.js')
const { reportRelPath } = await import('../lib/report.js')

const CHAT = '12345678@chatroom'
const OUTSIDE = '1234567890@chatroom'
const TOKEN = 'synth-token-0002-abcdef'
const ORIGIN_TS = new Date(2026, 9, 14, 10, 0, 0).getTime() // 本地 2026-10-14 10:00
const ORIGIN_KEY = '2026-10-14'

async function makeEnv({ allowActions = true, actionsEnabled = true } = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'web-inbox-')))
  const logger = { warn() {}, error() {}, info() {}, debug() {} }
  const groupStore = new GroupStoreService(dir, logger)
  const store = new Store(dir, logger, join(dir, 'knowledge.db'))
  const llm = { async complete() { return '{}' } }
  const task = new TaskRecognitionService({ groupStore, llm, logger, enabled: true, store })
  const promise = new PromiseRecognitionService({ groupStore, llm, logger, enabled: true })
  const { reportRevision, approvalActions, resolveInboxTarget } = createApprovalWiring({ store, groupStore, task, promise, notify: () => {}, logger })
  const inbox = new ActionInbox({
    store, actions: approvalActions, groups: [CHAT], logger, resolveTarget: resolveInboxTarget,
    marks: { markTarget: (c, k, id, s, src) => reportRevision.markTarget(c, k, id, s, src) },
  })
  writeWebManifest(store, { groups: [CHAT], knowledgeDb: join(dir, 'knowledge.db'), actionsEnabled })

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
    dir, port, store, groupStore, inbox, ids: { pendingTask, undatedTask, pendingPromise, pendingEvent },
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
  try { assert.deepEqual((await on.get('/api/chats')).body.actions, { enabled: true, reason: null }) } finally { await on.stop() }
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
      [{ type: 'report.regen', chatId: CHAT, params: { kind: 'daily', dateKey: '2026-10-14' } }, 400, 'type_not_allowed'],
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
