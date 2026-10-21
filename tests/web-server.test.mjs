// web-server.test.mjs —— 前端 web 进程 FE-1（只读回溯）：接口功能 + 本机 Web 服务安全（设计 §6.2 / §8）。
// 全离线：knowledge.db 由 0数据格式/schema.sql 现建合成库；每群库只建 identities 一张表；监听 127.0.0.1 随机端口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const { createWebServer } = await import('../web/server.mjs')
const { renderMarkdown, parseInline } = await import('../web/lib/markdown.mjs')
const { writeWebManifest, WEB_MANIFEST_REL } = await import('../lib/web-manifest.js')
const { Store } = await import('../lib/store.js')

const CHAT = '12345678@chatroom'
const OUTSIDE = '1234567890@chatroom' // 库里有数据但不在白名单
const TOKEN = 'synth-token-0001-abcdef'
const SCHEMA = readFileSync(join(import.meta.dirname, '..', '0数据格式', 'schema.sql'), 'utf8')

function buildKnowledgeDb(path) {
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  const ins = db.prepare(`INSERT INTO report (period_type, period_start, period_end, title, content_md, status, chat_id, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`)
  ins.run('daily', '2026-10-13', '2026-10-13', '日报 2026-10-13', '# 日报\n\n- 第一条', 'draft', CHAT)
  ins.run('daily', '2026-10-14', '2026-10-14', '日报 2026-10-14',
    '# 日报\n\n<script>alert(1)</script>\n\n[点我](javascript:alert(1)) 与 [官网](https://example.com)', 'final', CHAT)
  ins.run('weekly', '2026-10-12', '2026-10-18', '周报 2026-W42', '## 本周', 'draft', CHAT)
  ins.run('daily', '2026-10-14', '2026-10-14', '日报 聚合', '汇总', 'draft', 'aggregate')
  ins.run('daily', '2026-10-14', '2026-10-14', '白名单外', '不该看到', 'draft', OUTSIDE)
  db.prepare(`INSERT INTO report_revision (chat_id, period_type, period_start, ts, type, summary, source, source_key, created_at)
              VALUES (?, 'daily', '2026-10-14', 5, 'marking', '任务「#1」→ 已完成', 'web', 'rev:synth-0001', 5)`).run(CHAT)
  db.prepare(`INSERT INTO doc (title, category, content_md, content_hash, created_at, updated_at) VALUES ('示例资料', 'note', '正文', 'h1', 1, 2)`).run()
  db.prepare(`INSERT INTO tag (name) VALUES ('入门')`).run()
  db.prepare('INSERT INTO doc_tag (doc_id, tag_id) VALUES (1, 1)').run()
  db.prepare(`INSERT INTO media (chat_id, media_type, file_name, ext, size, path, path_kind, status, source_key, created_at, updated_at)
              VALUES (?, 'file', 'a.pdf', 'pdf', 2048, '/path/to/a.pdf', 'local', 'available', ?, 1, 1)`).run(CHAT, 'k1')
  db.prepare(`INSERT INTO media (chat_id, media_type, file_name, status, source_key, created_at, updated_at)
              VALUES (?, 'image', 'b.png', 'pending', 'k2', 1, 1)`).run(OUTSIDE)
  db.prepare(`INSERT INTO chat_digest (chat_topic, digest_md, happened_on, created_at) VALUES ('某话题', '- 要点', '2026-10-14', 1)`).run()
  db.close()
}

function buildGroupDb(stateDir, chatId) {
  mkdirSync(join(stateDir, 'groups', chatId), { recursive: true })
  const db = new DatabaseSync(join(stateDir, 'groups', chatId, 'store.db'))
  db.exec(`CREATE TABLE identities (pid TEXT PRIMARY KEY, wxid TEXT NOT NULL UNIQUE, group_nick TEXT NOT NULL DEFAULT '',
           remark TEXT NOT NULL DEFAULT '', watch_level TEXT NOT NULL DEFAULT 'off')`)
  db.prepare(`INSERT INTO identities VALUES ('wx_p1', 'wxid_a', '张三', '', 'group'), ('wx_p2', 'wxid_b', '李四', '', 'off')`).run()
  db.close()
  mkdirSync(join(stateDir, 'digests', chatId, 'wx_p1'), { recursive: true })
  writeFileSync(join(stateDir, 'digests', chatId, 'wx_p1', '2026-10-14.md'), '# 张三 · 2026-10-14\n\n- 合成摘要')
}

async function startEnv({ groups = [CHAT], manifest = true } = {}) {
  const stateDir = resolve(mkdtempSync(join(tmpdir(), 'web-')))
  const dbPath = join(stateDir, 'knowledge.db')
  buildKnowledgeDb(dbPath)
  buildGroupDb(stateDir, CHAT)
  if (manifest) writeWebManifest(new Store(stateDir, { warn() {}, error() {} }), { groups, knowledgeDb: dbPath })
  const app = createWebServer({ stateDir, token: TOKEN })
  const port = await app.start(0)
  return {
    stateDir, port,
    get: (path, headers = {}) => call(port, 'GET', path, { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...headers }),
    raw: (method, path, headers) => call(port, method, path, headers),
    async stop() { await app.close(); rmSync(stateDir, { recursive: true, force: true }) },
  }
}

function call(port, method, path, headers) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body = text
        try { body = JSON.parse(text) } catch { /* 静态资源 */ }
        ok({ status: res.statusCode, headers: res.headers, body, text })
      })
    })
    req.on('error', fail)
    req.end()
  })
}

// —— 插件侧清单 ——

test('writeWebManifest：写入 web/allowed-chats.json（白名单 + 库路径），空白名单照样写', () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'web-manifest-')))
  const store = new Store(dir, { warn() {}, error() {} })
  assert.equal(writeWebManifest(store, { groups: [CHAT], knowledgeDb: '/path/to/knowledge.db', now: () => 7 }), true)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, WEB_MANIFEST_REL), 'utf8')), { version: 1, groups: [CHAT], knowledgeDb: '/path/to/knowledge.db', actionsEnabled: false, operator: null, updatedAt: 7 })
  writeWebManifest(store, { groups: [], knowledgeDb: null })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, WEB_MANIFEST_REL), 'utf8')).groups, [])
  rmSync(dir, { recursive: true, force: true })
})

// —— 功能 ——

test('/api/chats 只列白名单群 + 聚合，带最近报告日期', async () => {
  const env = await startEnv()
  try {
    const r = await env.get('/api/chats')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.chats, [{ chatId: CHAT, latestReport: '2026-10-14' }, { chatId: 'aggregate', latestReport: '2026-10-14' }])
  } finally { await env.stop() }
})

test('/api/reports 列表：按群/周期/日期过滤，带修订数，白名单外群 403', async () => {
  const env = await startEnv()
  try {
    const all = await env.get(`/api/reports?chat=${encodeURIComponent(CHAT)}`)
    assert.equal(all.status, 200)
    assert.deepEqual(all.body.map(r => r.title), ['日报 2026-10-14', '日报 2026-10-13', '周报 2026-W42'])
    assert.equal(all.body[0].revisionCount, 1)
    assert.equal('content_md' in all.body[0] || 'blocks' in all.body[0], false, '列表不含正文')
    const weekly = await env.get(`/api/reports?chat=${encodeURIComponent(CHAT)}&period=weekly`)
    assert.deepEqual(weekly.body.map(r => r.periodType), ['weekly'])
    const ranged = await env.get(`/api/reports?chat=${encodeURIComponent(CHAT)}&from=2026-10-14&to=2026-10-14`)
    assert.deepEqual(ranged.body.map(r => r.periodStart), ['2026-10-14'])
    const noChat = await env.get('/api/reports')
    assert.equal(noChat.body.some(r => r.chatId === OUTSIDE), false, '不指定群时也只返回白名单内')
    assert.equal((await env.get(`/api/reports?chat=${encodeURIComponent(OUTSIDE)}`)).status, 403)
    assert.equal((await env.get('/api/reports?period=yearly')).status, 400)
    assert.equal((await env.get('/api/reports?from=2026/10/01')).status, 400)
  } finally { await env.stop() }
})

test('/api/reports/:id 详情：正文块 + 修订 + 前后期；白名单外 404', async () => {
  const env = await startEnv()
  try {
    const list = (await env.get(`/api/reports?chat=${encodeURIComponent(CHAT)}&period=daily`)).body
    const r = await env.get(`/api/reports/${list[0].id}`)
    assert.equal(r.status, 200)
    assert.equal(r.body.title, '日报 2026-10-14')
    assert.deepEqual(r.body.prev, { id: list[1].id, periodStart: '2026-10-13' })
    assert.equal(r.body.next, null)
    assert.deepEqual(r.body.revisions, [{ ts: 5, type: 'marking', summary: '任务「#1」→ 已完成', source: 'web' }])
    assert.equal(r.body.blocks[0].t, 'h')
    // 前端拿不到白名单外报告的 id——直接枚举全部 id 验证读不到
    let leaked = false
    for (let id = 1; id <= 6; id++) {
      const d = await env.get(`/api/reports/${id}`)
      if (d.status === 200 && d.body.chatId === OUTSIDE) leaked = true
    }
    assert.equal(leaked, false, '白名单外群的报告不可按 id 读取')
    assert.equal((await env.get('/api/reports/abc')).status, 400)
  } finally { await env.stop() }
})

test('/api/calendar：当月每日的周期角标', async () => {
  const env = await startEnv()
  try {
    const r = await env.get(`/api/calendar?chat=${encodeURIComponent(CHAT)}&month=2026-10`)
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body.days).sort(), ['2026-10-12', '2026-10-13', '2026-10-14'])
    assert.equal(r.body.days['2026-10-12'][0].periodType, 'weekly')
    assert.equal((await env.get(`/api/calendar?chat=${encodeURIComponent(CHAT)}&month=2026-1`)).status, 400)
    assert.equal((await env.get(`/api/calendar?chat=${encodeURIComponent(OUTSIDE)}&month=2026-10`)).status, 403)
  } finally { await env.stop() }
})

test('资料/媒体/会话要点：筛选生效，媒体只出白名单群', async () => {
  const env = await startEnv()
  try {
    const docs = await env.get('/api/docs?tag=' + encodeURIComponent('入门'))
    assert.deepEqual(docs.body.docs.map(d => [d.title, d.tags]), [['示例资料', ['入门']]])
    assert.deepEqual(docs.body.tags, ['入门'])
    assert.equal((await env.get('/api/docs?q=' + encodeURIComponent('不存在'))).body.docs.length, 0)
    assert.equal((await env.get('/api/docs/1')).body.blocks[0].t, 'p')
    const media = await env.get('/api/media')
    assert.deepEqual(media.body.map(m => m.fileName), ['a.pdf'])
    const digests = await env.get('/api/digests?day=2026-10-14')
    assert.equal(digests.body.digests[0].chatTopic, '某话题')
  } finally { await env.stop() }
})

test('人员关注：identities（非 off）∪ 摘要目录；读单日摘要；pid 穿越被拒', async () => {
  const env = await startEnv()
  try {
    const r = await env.get(`/api/persons?chat=${encodeURIComponent(CHAT)}`)
    assert.deepEqual(r.body.map(p => [p.pid, p.watchLevel, p.days]), [['wx_p1', 'group', ['2026-10-14']]])
    assert.equal('wxid' in r.body[0], false, '不外露 wxid')
    const d = await env.get(`/api/persons/wx_p1/digests?chat=${encodeURIComponent(CHAT)}&day=2026-10-14`)
    assert.equal(d.status, 200)
    assert.equal(d.body.blocks[0].t, 'h')
    assert.equal((await env.get(`/api/persons/${encodeURIComponent('../x')}/digests?chat=${encodeURIComponent(CHAT)}&day=2026-10-14`)).status, 400)
    assert.equal((await env.get(`/api/persons/wx_p1/digests?chat=${encodeURIComponent(CHAT)}&day=..%2F..`)).status, 400)
    assert.equal((await env.get('/api/persons?chat=aggregate')).status, 403, '聚合不是群')
  } finally { await env.stop() }
})

test('静态页面可取，未知路径 404，不做目录穿越', async () => {
  const env = await startEnv()
  try {
    const host = { host: `127.0.0.1:${env.port}` }
    const page = await env.raw('GET', '/', host)
    assert.equal(page.status, 200)
    assert.match(page.headers['content-type'], /text\/html/)
    assert.equal((await env.raw('GET', '/app.js', host)).status, 200)
    assert.equal((await env.raw('GET', '/../server.mjs', host)).status, 404)
    assert.equal((await env.raw('GET', '/lib/queries.mjs', host)).status, 404)
  } finally { await env.stop() }
})

// —— 安全（设计 §6.2 / §8） ——

test('缺 token / 错 token → 401', async () => {
  const env = await startEnv()
  try {
    assert.equal((await env.raw('GET', '/api/chats', { host: `127.0.0.1:${env.port}` })).status, 401)
    assert.equal((await env.get('/api/chats', { authorization: 'Bearer wrong-token-000000' })).status, 401)
    assert.equal((await env.get('/api/chats', { authorization: TOKEN })).status, 401, '必须是 Bearer 方案')
  } finally { await env.stop() }
})

test('错 Host（DNS rebinding）→ 403，静态资源也拦', async () => {
  const env = await startEnv()
  try {
    assert.equal((await env.get('/api/chats', { host: `evil.example:${env.port}` })).status, 403)
    assert.equal((await env.raw('GET', '/', { host: 'evil.example' })).status, 403)
    assert.equal((await env.get('/api/chats', { host: `localhost:${env.port}` })).status, 200)
  } finally { await env.stop() }
})

test('错 Origin → 403；只读接口与静态资源不接受 POST/PUT（写入只有 /api/actions，见 web-inbox.test）', async () => {
  const env = await startEnv()
  try {
    assert.equal((await env.get('/api/chats', { origin: 'https://evil.example' })).status, 403)
    assert.equal((await env.get('/api/chats', { origin: `http://127.0.0.1:${env.port}` })).status, 200)
    const self = { host: `127.0.0.1:${env.port}`, authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${env.port}` }
    assert.equal((await env.raw('POST', '/api/reports', self)).status, 405)
    assert.equal((await env.raw('POST', '/', self)).status, 405)
    assert.equal((await env.raw('PUT', '/api/actions', self)).status, 405)
  } finally { await env.stop() }
})

test('安全响应头：严格 CSP、禁嵌入、nosniff；不发 CORS 头', async () => {
  const env = await startEnv()
  try {
    for (const r of [await env.get('/api/chats'), await env.raw('GET', '/', { host: `127.0.0.1:${env.port}` })]) {
      assert.match(r.headers['content-security-policy'], /script-src 'self'/)
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/)
      assert.equal(r.headers['x-content-type-options'], 'nosniff')
      assert.equal(r.headers['x-frame-options'], 'DENY')
      assert.equal(Object.keys(r.headers).some(k => k.startsWith('access-control-')), false)
    }
  } finally { await env.stop() }
})

test('白名单清单缺失或为空 → API 503（fail-closed）', async () => {
  const env = await startEnv({ manifest: false })
  try {
    assert.equal((await env.get('/api/chats')).body.error, 'no_allowlist')
  } finally { await env.stop() }
  const empty = await startEnv({ groups: [] })
  try {
    assert.equal((await empty.get('/api/chats')).status, 503)
  } finally { await empty.stop() }
})

test('XSS 载荷：<script> 只作文字，javascript: 链接降级为文字，http(s) 链接放行', async () => {
  const env = await startEnv()
  try {
    const list = (await env.get(`/api/reports?chat=${encodeURIComponent(CHAT)}&from=2026-10-14&to=2026-10-14`)).body
    const r = await env.get(`/api/reports/${list[0].id}`)
    const spans = r.body.blocks.flatMap(b => b.inl ?? [])
    assert.ok(spans.some(s => s.t === 'text' && s.v.includes('<script>')), '<script> 原样保留为文字')
    assert.equal(spans.some(s => s.t === 'link' && /javascript:/i.test(s.href)), false)
    assert.ok(spans.some(s => s.t === 'link' && s.href === 'https://example.com'))
  } finally { await env.stop() }
})

test('markdown 子集：标题/列表/表格/代码；链接协议白名单', () => {
  const blocks = renderMarkdown('# 标题\n\n- a\n  - b\n1. c\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```\n<b>\n```\n\n---')
  assert.deepEqual(blocks.map(b => b.t), ['h', 'li', 'li', 'li', 'table', 'code', 'hr'])
  assert.equal(blocks[2].depth, 1)
  assert.equal(blocks[3].ordered, true)
  assert.equal(blocks[5].v, '<b>')
  assert.deepEqual(parseInline('[x](data:text/html,1)'), [{ t: 'text', v: '[x](data:text/html,1)' }])
  assert.deepEqual(parseInline('**粗** `c`').map(s => s.t), ['strong', 'text', 'code'])
})

test('web 进程零写入：跑完全部只读接口后 stateDir 文件集合不变', async () => {
  const env = await startEnv()
  try {
    const snapshot = () => readdirSync(env.stateDir, { recursive: true }).filter(f => !/-(wal|shm)$/.test(f)).sort()
    const before = snapshot()
    for (const p of ['/api/chats', '/api/reports', '/api/docs', '/api/media', '/api/digests', `/api/persons?chat=${encodeURIComponent(CHAT)}`]) await env.get(p)
    assert.deepEqual(snapshot(), before)
  } finally { await env.stop() }
})
