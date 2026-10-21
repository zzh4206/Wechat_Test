#!/usr/bin/env node
// server.mjs —— 本地前端工作台 web 进程（前端设计 §3.2 方案 B / §4；FE-1 只读回溯 + FE-2 审批收件箱）。
//
// 用法：
//   LURKER_WEB_TOKEN=<token> node web/server.mjs --state-dir <stateDir> [--db <knowledge.db>] [--port 8787]
//
// 边界（tests/web-boundary.test.mjs 钉死）：
// - 只监听 127.0.0.1，不提供改地址的参数；
// - 不 import src/ 或插件 lib/ 的任何模块，没有 child_process、没有出网；
// - 只读打开 knowledge.db、groups/*/store.db、digests/*.md；唯一写入是 lib/actions.mjs 向
//   web/actions.jsonl 追加动作行（RUNBOOK §13），由插件 ActionInbox 消费执行；
// - 写动作要求：Origin 必须是本服务、Content-Type 为 JSON、token 来自 LURKER_WEB_TOKEN 且其指纹
//   与插件清单里 webActionsToken 的指纹一致（审计 operator 对齐），插件清单声明收件箱在消费；
// - 白名单取 <stateDir>/web/allowed-chats.json（插件启动时写入），缺失或为空拒绝启动（R2）。
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { SECURITY_HEADERS, hostAllowed, operatorOf, originAllowed, tokenAllowed } from './lib/http-guard.mjs'
import { AGGREGATE, loadManifest } from './lib/manifest.mjs'
import * as Q from './lib/queries.mjs'
import { ACTION_ID_RE, appendAction, buildAction, readResult } from './lib/actions.mjs'

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public')

// 静态资源固定映射：URL 不参与路径拼接，杜绝目录穿越。
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/render.js', ['render.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
])

const ID_PARAM_RE = /^[1-9]\d{0,15}$/
const BODY_MAX = 8 * 1024

function emit(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type })
  res.end(body)
}

const json = (res, status, obj) => emit(res, status, JSON.stringify(obj))

/** 查询串 → 普通对象（只取每个键的第一个值） */
function queryOf(url) {
  const q = {}
  for (const [k, v] of url.searchParams) if (!(k in q)) q[k] = v
  return q
}

/**
 * 只读 API 路由。返回 [status, body]。
 * kdb 为 null 表示 knowledge.db 未配置或不存在（回溯类接口返回 503）。
 */
function route(path, q, ctx) {
  const { kdb, allowed, stateDir } = ctx
  const needKdb = () => { if (!kdb) throw Object.assign(new Error(), { status: 503, code: 'knowledge_db_unavailable' }) }
  const orForbidden = (v) => (v === null ? [403, { error: 'chat_not_allowed' }] : [200, v])
  let m
  if (path === '/api/chats') return [200, { chats: Q.listChats(kdb, allowed), knowledgeDb: Boolean(kdb), actions: ctx.actions }]
  if (path === '/api/reports') { needKdb(); return orForbidden(Q.listReports(kdb, allowed, q)) }
  if ((m = /^\/api\/reports\/([^/]+)$/.exec(path))) {
    needKdb()
    if (!ID_PARAM_RE.test(m[1])) return [400, { error: 'bad_request' }]
    const r = Q.getReport(kdb, allowed, Number(m[1]))
    return r ? [200, r] : [404, { error: 'not_found' }]
  }
  if (path === '/api/calendar') { needKdb(); return orForbidden(Q.calendar(kdb, allowed, q)) }
  if (path === '/api/docs') { needKdb(); return [200, { docs: Q.listDocs(kdb, q), ...Q.docFacets(kdb) }] }
  if ((m = /^\/api\/docs\/([^/]+)$/.exec(path))) {
    needKdb()
    if (!ID_PARAM_RE.test(m[1])) return [400, { error: 'bad_request' }]
    const d = Q.getDoc(kdb, Number(m[1]))
    return d ? [200, d] : [404, { error: 'not_found' }]
  }
  if (path === '/api/media') { needKdb(); return orForbidden(Q.listMedia(kdb, allowed, q)) }
  if (path === '/api/digests') { needKdb(); return [200, { digests: Q.listDigests(kdb, q) }] }
  // 人员关注只针对真实群（聚合不是群，没有每群库）
  const groups = new Set([...allowed].filter(c => c !== AGGREGATE))
  if (path === '/api/persons') return orForbidden(Q.listPersons(stateDir, groups, q.chat))
  if ((m = /^\/api\/persons\/([^/]+)\/digests$/.exec(path))) {
    let pid
    try { pid = decodeURIComponent(m[1]) } catch { return [400, { error: 'bad_request' }] }
    const d = Q.getPersonDigest(stateDir, groups, q.chat, pid, q.day)
    if (d === null && !groups.has(q.chat)) return [403, { error: 'chat_not_allowed' }]
    return d ? [200, d] : [404, { error: 'not_found' }]
  }
  // —— FE-2：收件箱与回执 ——
  if (path === '/api/inbox') return orForbidden(Q.listInbox(stateDir, groups, q.chat))
  if (path === '/api/evidence') return orForbidden(Q.evidenceContext(stateDir, groups, q))
  if ((m = /^\/api\/actions\/([^/]+)$/.exec(path))) {
    if (!ACTION_ID_RE.test(m[1])) return [400, { error: 'bad_request' }]
    return [200, { actionId: m[1], ...readResult(stateDir, m[1]) }]
  }
  return [404, { error: 'not_found' }]
}

/**
 * 写动作是否可用；不可用时给出原因（前端据此禁用按钮并提示）。
 * token 指纹必须与插件 webActionsToken 的一致：否则审计 operator 记的是另一个 token，
 * 无法用浏览器实际 token 核对是谁提交的（插件侧也会以 operator_mismatch 拒绝执行）。
 */
function actionsState(allowActions, manifest, operator) {
  if (!allowActions) return { enabled: false, reason: 'no_shared_token' }
  if (!manifest.actionsEnabled) return { enabled: false, reason: 'inbox_disabled' }
  if (!manifest.operator) return { enabled: false, reason: 'plugin_token_unset' }
  if (manifest.operator !== operator) return { enabled: false, reason: 'token_mismatch' }
  return { enabled: true, reason: null }
}

/** 读 JSON 请求体（上限 BODY_MAX）；超限或非法返回 null */
function readJsonBody(req) {
  return new Promise((ok) => {
    const chunks = []
    let size = 0
    let done = false
    // 超限后丢弃剩余数据但读完（直接断连接会让客户端收不到 400）
    req.on('data', (c) => {
      size += c.length
      if (size <= BODY_MAX) chunks.push(c)
    })
    req.on('end', () => {
      if (done) return
      done = true
      if (size > BODY_MAX) return ok(null)
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { ok(null) }
    })
    req.on('error', () => { if (!done) { done = true; ok(null) } })
  })
}

/** POST /api/actions：校验后追加一行到 web/actions.jsonl，立即返回 actionId（不等执行） */
async function postAction(req, res, ctx) {
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'unsupported_media_type' })
  const state = actionsState(ctx.allowActions, ctx.manifest, ctx.operator)
  if (!state.enabled) return json(res, 409, { error: 'actions_disabled', reason: state.reason })
  const body = await readJsonBody(req)
  if (body === null) return json(res, 400, { error: 'bad_request', reason: 'body' })
  const built = buildAction(body, new Set(ctx.manifest.groups), ctx.operator)
  if (built.error) return json(res, built.error === 'chat_not_allowed' ? 403 : 400, built)
  appendAction(ctx.stateDir, built.line)
  return json(res, 202, { actionId: built.line.actionId })
}

/**
 * 创建服务（不监听）。测试与 main 共用。
 * @param {{ stateDir: string, dbPath?: string|null, token: string, allowActions?: boolean }} opts
 *   allowActions：token 来自共享配置（LURKER_WEB_TOKEN）时才为 true；随机 token 只读。
 */
export function createWebServer(opts) {
  const stateDir = resolve(opts.stateDir)
  if (typeof opts.token !== 'string' || opts.token.length < 16) throw new Error('web: token 至少 16 字符')
  const allowActions = opts.allowActions === true
  const operator = operatorOf(opts.token)
  const server = createServer(async (req, res) => {
    const port = server.address()?.port
    if (!hostAllowed(req.headers.host, port)) return json(res, 403, { error: 'bad_host' })
    if (!originAllowed(req.headers.origin, port)) return json(res, 403, { error: 'bad_origin' })
    const isPost = req.method === 'POST'
    if (!isPost && req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' })
    let url
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`)
    } catch {
      return json(res, 400, { error: 'bad_request' })
    }
    if (isPost && url.pathname !== '/api/actions') return json(res, 405, { error: 'method_not_allowed' })
    // 写请求必须带 Origin 且是本服务（GET 可无 Origin，POST 不行）
    if (isPost && req.headers.origin === undefined) return json(res, 403, { error: 'bad_origin' })
    if (!url.pathname.startsWith('/api/')) {
      const hit = STATIC.get(url.pathname)
      if (!hit) return json(res, 404, { error: 'not_found' })
      return emit(res, 200, readFileSync(join(PUBLIC_DIR, hit[0])), hit[1])
    }
    if (!tokenAllowed(req.headers.authorization, opts.token)) return json(res, 401, { error: 'unauthorized' })
    const manifest = loadManifest(stateDir)
    if (!manifest) return json(res, 503, { error: 'no_allowlist' })
    const allowed = new Set([...manifest.groups, AGGREGATE])
    if (isPost) {
      try {
        return await postAction(req, res, { stateDir, manifest, allowActions, operator })
      } catch {
        return json(res, 500, { error: 'error' })
      }
    }
    let kdb = null
    try {
      // 收件箱/回执/人员不依赖 knowledge.db；打开失败（损坏/锁）只影响回溯类接口
      try { kdb = Q.openReadOnly(opts.dbPath ?? manifest.knowledgeDb) } catch { kdb = null }
      const [status, body] = route(url.pathname, queryOf(url), { kdb, allowed, stateDir, actions: actionsState(allowActions, manifest, operator) })
      return json(res, status, body)
    } catch (error) {
      if (error instanceof Q.BadRequest) return json(res, 400, { error: 'bad_request', reason: error.message })
      if (error?.code === 'knowledge_db_unavailable') return json(res, 503, { error: error.code })
      return json(res, 500, { error: 'error' })
    } finally {
      kdb?.close()
    }
  })
  return {
    server,
    /** 监听 127.0.0.1:<port>（port=0 由系统分配）；resolve 实际端口 */
    start(port) {
      return new Promise((ok, fail) => {
        server.once('error', fail)
        server.listen(port, '127.0.0.1', () => ok(server.address().port))
      })
    },
    close() {
      return new Promise(ok => server.close(() => ok()))
    },
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'state-dir': { type: 'string' },
      db: { type: 'string' },
      port: { type: 'string', default: '8787' },
    },
  })
  if (!values['state-dir']) {
    console.error('用法：node web/server.mjs --state-dir <stateDir> [--db <knowledge.db>] [--port 8787]')
    process.exit(2)
  }
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('web: --port 须为 1–65535 的整数')
    process.exit(2)
  }
  const stateDir = resolve(values['state-dir'])
  if (!loadManifest(stateDir)) {
    console.error('web: 未找到有效白名单（<stateDir>/web/allowed-chats.json 缺失或 groups 为空）——拒绝启动。先启动一次插件让它写入清单。')
    process.exit(1)
  }
  const fromEnv = process.env.LURKER_WEB_TOKEN ?? ''
  const token = fromEnv || randomBytes(24).toString('base64url')
  const app = createWebServer({ stateDir, dbPath: values.db ? resolve(values.db) : null, token, allowActions: Boolean(fromEnv) })
  const actual = await app.start(port)
  if (fromEnv) {
    console.log(`web: 已监听 http://127.0.0.1:${actual}/ ——浏览器打开 http://127.0.0.1:${actual}/#token=<LURKER_WEB_TOKEN 的值>`)
  } else {
    console.log(`web: 已监听（只读：未设 LURKER_WEB_TOKEN，审批动作不可用）；本次随机 token 仅打印这一次：\n  http://127.0.0.1:${actual}/#token=${token}`)
  }
  const stop = () => app.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`web: 启动失败：${error?.message ?? error}`)
    process.exit(1)
  })
}
