// llm-adapter.test.mjs —— DefaultLlmClient 宿主探测与单轮补全适配 + degraded 原因可见化。
// 全离线：mock 各种宿主形态（有 complete / 只有 stream / 只有注册表+环境变量 / 都没有），
// fetch 全部注入 mock，绝不发真实网络请求；API key 零泄漏断言（日志/落盘/prompt 三处）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { DefaultLlmClient } = await import('../lib/distiller.js')
const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { ReportService } = await import('../lib/report.js')

const KEY = 'zk-TESTKEY-0000000000000000000000000000'
// 本地时区锚点：2026-06-10（周三）；避免 UTC 假设
const BASE = new Date(2026, 5, 10).getTime()
const T = (h, m = 0) => BASE + h * 3600_000 + m * 60_000
const CHAT = 'g@chatroom'
const DAY_KEY = (() => { const d = new Date(BASE); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}` })()

function makeLogger() {
  const lines = []
  return { lines, warn(m) { lines.push(String(m)) }, info(m) { lines.push(String(m)) }, error(m) { lines.push(String(m)) } }
}

/** 模拟 dsh-llm stream(GenerateOptions)：返回 text-delta 块 + finish 的 async iterable */
function streamHost(chunks, captured = []) {
  return {
    listProviders: () => [{ id: 'zai' }],
    stream(options) {
      captured.push(options)
      return (async function* () {
        for (const c of chunks) yield c
      })()
    },
  }
}

function legalOutput() {
  return JSON.stringify({
    title: '排期敲定',
    lead: 'UI 稿今天定稿。',
    judgments: [
      { text: 'UI 稿交付时间已提前到周二。', evidence: [1] },
      { text: '后端接口联调定在周四进行。', evidence: [1] },
      { text: 'Bob 承诺下午给出测试环境。', evidence: [1] },
    ],
    topics: [{ title: '排期', change: '提前一天', status: '', people: '', watch: '', evidence: [1] }],
    quotes: [1],
  })
}

test('探测：宿主方法清单 dump 到 logger（启动可见化）', () => {
  const logger = makeLogger()
  const host = { listProviders: () => [{ id: 'zai' }], stream: () => {}, resolveModelInfo: async () => ({}) }
  new DefaultLlmClient(host, { logger })
  const dump = logger.lines.find((l) => l.startsWith('llm host methods:'))
  assert.ok(dump, '应有方法清单行')
  for (const name of Object.keys(host)) assert.ok(dump.includes(name), `清单应含 ${name}`)
})

test('适配 ①：宿主有 complete → 直接用', async () => {
  const host = { complete: async (p) => `echo:${p.slice(0, 5)}` }
  const client = new DefaultLlmClient(host)
  assert.equal(await client.complete('hello'), 'echo:hello')
})

test('适配 ②：宿主只有 stream（dsh-llm GenerateOptions）→ 拼 text-delta，provider/model 默认 zai/glm-5.3', async () => {
  const captured = []
  const host = streamHost(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"a":' },
      { type: 'text-delta', index: 0, text: '1}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    captured,
  )
  const client = new DefaultLlmClient(host)
  const out = await client.complete('PROMPT')
  assert.equal(out, '{"a":1}')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].provider, 'zai')
  assert.equal(captured[0].model, 'glm-5.3')
  assert.equal(captured[0].messages[0].role, 'user')
  assert.equal(captured[0].messages[0].content, 'PROMPT')
})

test('适配 ②b：stream finish=error → 抛错（不静默）', async () => {
  const host = streamHost([{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota', code: 'X' } } }])
  const client = new DefaultLlmClient(host)
  await assert.rejects(() => client.complete('p'), /stream finished with error/)
})

test('适配 ③：只有注册表 → openai 兼容 fetch（ZAI_API_KEY），key 不进日志/错误', async () => {
  const calls = []
  const fetchMock = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'REGISTRY-OK' } }] }),
    }
  }
  const logger = makeLogger()
  const host = { listProviders: () => [{ id: 'zai' }], listModels: async () => [{ id: 'glm-5.3' }] }
  const client = new DefaultLlmClient(host, { fetch: fetchMock, logger })
  const prev = process.env.ZAI_API_KEY
  process.env.ZAI_API_KEY = KEY
  try {
    const out = await client.complete('PROMPT')
    assert.equal(out, 'REGISTRY-OK')
  } finally {
    if (prev === undefined) delete process.env.ZAI_API_KEY
    else process.env.ZAI_API_KEY = prev
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.z.ai/api/paas/v4/chat/completions')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'glm-5.3')
  assert.equal(body.messages[0].content, 'PROMPT')
  // key 零泄漏：日志不含 key
  assert.ok(!logger.lines.join('\n').includes(KEY), '日志不得含 API key')
})

test('适配 ③b：注册表 + 无环境变量 → 明确抛错（含变量名，不含 key 值），不 fallback 静默', async () => {
  const fetchMock = async () => { throw new Error('network must not be touched') }
  const host = { listProviders: () => [{ id: 'zai' }] }
  const client = new DefaultLlmClient(host, { fetch: fetchMock })
  const prev = process.env.ZAI_API_KEY
  delete process.env.ZAI_API_KEY
  try {
    await assert.rejects(() => client.complete('p'), /ZAI_API_KEY is not set/)
  } finally {
    if (prev !== undefined) process.env.ZAI_API_KEY = prev
  }
})

test('适配 ④：宿主为空/无任何补全面 → 抛错并列出方法清单', async () => {
  const c1 = new DefaultLlmClient(undefined)
  await assert.rejects(() => c1.complete('p'), /no usable completion API/)
  const host = { listProviders: () => [{ id: 'zai' }], listModels: async () => [] }
  const c2 = new DefaultLlmClient(host, { fetch: async () => { throw new Error('http boom') } })
  process.env.ZAI_API_KEY = KEY
  try {
    await assert.rejects(() => c2.complete('p'), /http boom|no usable completion API/)
  } finally {
    delete process.env.ZAI_API_KEY
  }
  const c3 = new DefaultLlmClient({ foo: 1 })
  await assert.rejects(() => c3.complete('p'), /foo/)
})

test('优先级：complete > stream > 注册表 fetch（有 stream 就不发网络请求）', async () => {
  let fetched = false
  const host = {
    ...streamHost([{ type: 'text-delta', index: 0, text: 'S' }, { type: 'finish', reason: { kind: 'stop' } }]),
    listProviders: () => [{ id: 'zai' }],
  }
  const client = new DefaultLlmClient(host, { fetch: async () => { fetched = true; throw new Error('should not fetch') } })
  process.env.ZAI_API_KEY = KEY
  try {
    assert.equal(await client.complete('p'), 'S')
  } finally {
    delete process.env.ZAI_API_KEY
  }
  assert.equal(fetched, false)
})

// —— report degraded 原因可见化 ——

function makeReportEnv(script) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'llmrep-')))
  const logger = makeLogger()
  const gs = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} })
  const calls = []
  const llm = {
    async complete(prompt) {
      calls.push(prompt)
      const next = script.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
  const report = new ReportService({
    groupStore: gs, store, stateDir: dir, llm, logger, enabled: true, groups: [CHAT],
  })
  return { dir, gs, store, llm, report, logger, calls }
}

const MSG = (ts, text) => ({ msgId: `m${ts}`, ts, senderPid: 'p1', senderName: '甲', text, kind: 'text' })

test('degraded 原因①：LLM 调用异常 → 报告行与 report_meta.note 写「LLM 调用异常：…」', async () => {
  const env = makeReportEnv([new Error('boom: host llm exposes nothing')])
  await env.gs.appendMessages(CHAT, [MSG(T(9), '你好'), MSG(T(10), '在忙')])
  const res = await env.report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  const md = readFileSync(join(env.dir, `reports/${CHAT}/${DAY_KEY}.md`), 'utf8')
  assert.ok(md.includes('LLM 调用异常：'), md)
  assert.ok(md.includes('boom'), '应含真实异常文本')
  assert.ok(!md.includes('两次均未通过金字塔断言，本期降级输出骨架') || md.includes('LLM 调用异常'))
  const metas = env.gs.getReportMetas(CHAT, { kind: "daily" })
  assert.equal(metas.length, 1)
  assert.ok(metas[0].note.includes('LLM 调用异常'), metas[0].note)
})

test('degraded 原因②：断言两次失败 → 报告行与 note 写「断言两次失败：…」（与调用异常可区分）', async () => {
  const env = makeReportEnv(['not json', '{"judgments":[]}'])
  await env.gs.appendMessages(CHAT, [MSG(T(9), '你好'), MSG(T(10), '在忙')])
  const res = await env.report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'degraded')
  const md = readFileSync(join(env.dir, `reports/${CHAT}/${DAY_KEY}.md`), 'utf8')
  assert.ok(md.includes('断言两次失败'), md)
  assert.ok(!md.includes('LLM 调用异常'), '断言失败不得误标为调用异常')
  const metas = env.gs.getReportMetas(CHAT, { kind: "daily" })
  assert.ok(metas[0].note.includes('断言两次失败'), metas[0].note)
  assert.ok(!metas[0].note.includes('LLM 调用异常'))
})

test('ok 报告不带 degraded 行，note 为空', async () => {
  const env = makeReportEnv([legalOutput()])
  await env.gs.appendMessages(CHAT, [MSG(T(9), '你好'), MSG(T(10), '在忙')])
  const res = await env.report.generateReport(CHAT, 'daily', T(20, 30))
  assert.equal(res.status, 'ok')
  const md = readFileSync(join(env.dir, `reports/${CHAT}/${DAY_KEY}.md`), 'utf8')
  assert.ok(!md.includes('degraded'))
  assert.equal(env.gs.getReportMetas(CHAT, { kind: "daily" })[0].note, '')
})

test('红线：报告全文（含 degraded 原因）不含 API key；prompt 不含 key', async () => {
  const env = makeReportEnv([new Error(`unauthorized, key=${KEY}`)])
  await env.gs.appendMessages(CHAT, [MSG(T(9), '你好'), MSG(T(10), '在忙')])
  await env.report.generateReport(CHAT, 'daily', T(20, 30))
  const md = readFileSync(join(env.dir, `reports/${CHAT}/${DAY_KEY}.md`), 'utf8')
  assert.ok(!md.includes(KEY), '落盘报告不得含 API key')
  for (const p of env.calls) assert.ok(!p.includes(KEY), 'prompt 不得含 API key')
})
