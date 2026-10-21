// distiller-cost-guard.test.mjs —— 成本治理 C1（失败退避 + 熔断 + 错误可见）
// 与 C2（增量水位）验收。背景与根因见 docs/COST-ANALYSIS-2026-10-21.md §3：
//   ① 失败后 nextAttemptAt 生效（退避窗口内 0 次新 LLM 调用）；
//   ② 连续失败退避递增（1→2→4→8→…，30min 封顶）+ 熔断 1h 优先；
//   ③ 连续 5 次失败 → 熔断 + notifier 恰好 1 次（同窗口不重复）；
//   ④ 成功清零 failStreak/nextAttemptAt 并推进水位；
//   ⑤ 增量水位：先 25 条、再来 5 条 → 只送 5 条；无新消息不触发；
//   ⑥ 重启（新 Distiller 实例读 json）后退避仍生效、水位仍有效、心跳不重触发；
//   ⑦ errKind 六分类 + 失败行 errMsg 已脱敏且 ≤160 字符。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BufferPool } from '../lib/buffer.js'
import { PersonaService } from '../lib/persona.js'
import { Store } from '../lib/store.js'
import {
  Distiller,
  distillStateRelPath,
  distillBackoffMs,
  nextAttemptDelayMs,
  filterAfterWatermark,
  emptyDistillState,
  DISTILL_BACKOFF_BASE_MS,
  DISTILL_BACKOFF_MAX_MS,
  DISTILL_CIRCUIT_OPEN_MS,
  DISTILL_CIRCUIT_THRESHOLD,
} from '../lib/distiller.js'
import { LlmCallRecorder, errKindOf, summarizeErrMsg, ERR_MSG_MAX_CHARS, llmCallRelPath } from '../lib/llm-observe.js'

/** 固定起点时钟（所有断言都用相对偏移，避免依赖真实时间） */
const T0 = 1_700_000_000_000
const MIN = 60_000

function makeLogger() {
  const warnings = []
  return { warnings, warn(m) { warnings.push(m) }, info() {}, error() {} }
}

/** 合法 LLM 输出（四类之一即可，避免 schema 校验失败干扰退避断言） */
const OK_OUT = JSON.stringify([{ type: 'quote', text: '卷不动了', reason: '梗' }])

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'lurker-cost-'))
}

/** 往 buffer 里塞 n 条 ts 递增的消息（messageId 有序，便于水位兜底断言） */
function seed(buffer, chatId, n, { startTs = 1000, from = 0 } = {}) {
  const out = []
  for (let i = 0; i < n; i++) {
    const seq = from + i
    const msg = {
      ts: startTs + seq,
      sender: `u${seq % 5}`,
      text: JSON.stringify(`消息${seq}`),
      messageId: `m${String(seq).padStart(4, '0')}`,
    }
    buffer.push(chatId, msg)
    out.push(msg)
  }
  return out
}

/** 从 prompt 数据区取回送进 LLM 的消息数组（数据区是最后一行 JSON） */
function messagesIn(prompt) {
  return JSON.parse(prompt.trimEnd().split('\n').pop())
}

/** 读该群状态文件（不存在返回 null） */
function readState(dir, chatId) {
  const p = join(dir, distillStateRelPath(chatId))
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

/** 读该群 llm_call JSONL */
function readCalls(dir, chatId) {
  const p = join(dir, llmCallRelPath(chatId))
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/**
 * 搭一套带真实 Store（落盘）+ 可注入时钟/notifier 的提炼器。
 * 同一个 dir/buffer 可反复调用本函数创建"重启后的新实例"（⑥ 用）。
 */
function makeEnv({ dir = makeDir(), everyMessages = 25, intervalMin = 15, batchThreshold, messages = 0 } = {}) {
  const logger = makeLogger()
  const store = new Store(dir, logger)
  const buffer = new BufferPool({ bufferSize: 200 })
  if (messages > 0) seed(buffer, 'g1', messages)
  const clock = { t: T0 }
  const calls = []
  const produced = []
  /** 可在用例中途翻转：true = 每次调用都抛错 */
  const llm = {
    failing: false,
    error: new Error('connection reset by peer'),
    async complete(prompt) {
      calls.push(prompt)
      if (llm.failing) throw llm.error
      return OK_OUT
    },
  }
  const notifyCalls = []
  const notifier = {
    async notify(kind, title, body) {
      notifyCalls.push({ kind, title, body })
      return { shown: false, dryRun: true }
    },
  }
  return { dir, logger, store, buffer, clock, calls, produced, llm, notifier, notifyCalls, everyMessages, intervalMin, batchThreshold }
}

/** 在既有 env 上创建（或重建）一个 Distiller 实例——同 dir/buffer 即模拟"重启" */
function makeDistiller(env, overrides = {}) {
  const timerRef = { fn: null, cleared: null }
  const d = new Distiller({
    buffer: env.buffer,
    llm: overrides.llm ?? env.llm,
    personas: new PersonaService({ stateDir: env.dir, logger: env.logger }),
    groupPersonas: {},
    logger: env.logger,
    distillEveryMessages: env.everyMessages,
    distillIntervalMin: env.intervalMin,
    onInsights: (chatId, insights) => env.produced.push([chatId, insights]),
    now: () => env.clock.t,
    setInterval: (fn) => {
      timerRef.fn = fn
      return { unref() {} }
    },
    clearInterval: (t) => {
      timerRef.cleared = t
    },
    store: env.store,
    // notifier: null → 显式不注入（验证可选依赖缺省静默）
    notifier: overrides.notifier === null ? undefined : (overrides.notifier ?? env.notifier),
    llmCallRecorder: overrides.llmCallRecorder,
    batchThreshold: env.batchThreshold,
  })
  return { distiller: d, timerRef }
}

// —————————————— ① 退避闸门：窗口内 0 次新调用 ——————————————

test('① 失败 1 次 → nextAttemptAt 生效（立即再触发 0 次新调用），时间前进 1 分钟后可再试', async () => {
  const env = makeEnv({ messages: 3, everyMessages: 25 })
  const { distiller } = makeDistiller(env)
  env.llm.failing = true

  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  // 非 timeout 类错误 → 单批 + 重试一次 = 2 次调用（旧语义不变）
  assert.equal(env.calls.length, 2, '首次失败：调用 + 重试各一次')

  const st = readState(env.dir, 'g1')
  assert.equal(st.failStreak, 1)
  assert.equal(st.nextAttemptAt, T0 + DISTILL_BACKOFF_BASE_MS, '1 次失败 → 退避 1 分钟')

  // 立刻再触发（消息阈值路径）：被闸门拦下，零新调用、零状态变化
  assert.equal(await distiller.tryDistill('g1', 'message-threshold'), false)
  assert.equal(env.calls.length, 2, '退避窗口内 0 次新 LLM 调用（止血关键）')
  // 再触发一次 manual 也是如此
  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  assert.equal(env.calls.length, 2)

  // 差 1ms 到点：仍拒绝
  env.clock.t = T0 + DISTILL_BACKOFF_BASE_MS - 1
  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  assert.equal(env.calls.length, 2)

  // 到点（now === nextAttemptAt）：放行 → 再失败一次（又 2 次调用）
  env.clock.t = T0 + DISTILL_BACKOFF_BASE_MS
  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  assert.equal(env.calls.length, 4, '退避到点后允许重试')
  assert.equal(readState(env.dir, 'g1').failStreak, 2)

  rmSync(env.dir, { recursive: true, force: true })
})

test('①b 失败不消费消息计数（counters 不清零）——风暴根源的反面约定', async () => {
  const env = makeEnv({ messages: 3, everyMessages: 2 })
  const { distiller } = makeDistiller(env)
  env.llm.failing = true
  distiller.onNewMessage('g1')
  distiller.onNewMessage('g1') // 达阈值 → 首次尝试（失败）
  await new Promise((r) => setImmediate(r))
  assert.ok(env.calls.length >= 2, '首次触发确实调了 LLM')
  const pending = distiller.status('g1').pending
  assert.equal(pending, 2, '失败不清 counters（消息不丢；阻止风暴的是 nextAttemptAt 而非计数）')
  // 后续每条新消息都会再"试"，但退避窗口内一律 0 调用
  const before = env.calls.length
  distiller.onNewMessage('g1')
  await new Promise((r) => setImmediate(r))
  assert.equal(env.calls.length, before, '退避窗口内每条新消息都不再触发 LLM')
  rmSync(env.dir, { recursive: true, force: true })
})

// —————————————— ② 退避递增与封顶 ——————————————

test('② 退避递增：1→2→4→8→16 分钟，30 分钟封顶；≥5 次走熔断 1 小时', async () => {
  // 纯函数口径（可直接断言序列）
  assert.equal(distillBackoffMs(1), 1 * MIN)
  assert.equal(distillBackoffMs(2), 2 * MIN)
  assert.equal(distillBackoffMs(3), 4 * MIN)
  assert.equal(distillBackoffMs(4), 8 * MIN)
  assert.equal(distillBackoffMs(5), 16 * MIN)
  assert.equal(distillBackoffMs(6), DISTILL_BACKOFF_MAX_MS, '32min → 封顶 30min')
  assert.equal(distillBackoffMs(12), DISTILL_BACKOFF_MAX_MS)
  assert.equal(distillBackoffMs(1), DISTILL_BACKOFF_BASE_MS)
  // 合成口径：熔断窗口优先于 30 分钟封顶
  assert.equal(nextAttemptDelayMs(4), 8 * MIN)
  assert.equal(nextAttemptDelayMs(DISTILL_CIRCUIT_THRESHOLD), DISTILL_CIRCUIT_OPEN_MS)
  assert.equal(nextAttemptDelayMs(9), DISTILL_CIRCUIT_OPEN_MS)

  // 端到端：连续失败 4 次，每次都按序列退避
  const env = makeEnv({ messages: 3 })
  const { distiller } = makeDistiller(env)
  env.llm.failing = true
  const expected = [1, 2, 4, 8]
  for (let k = 1; k <= expected.length; k++) {
    assert.equal(await distiller.tryDistill('g1', 'manual'), false)
    const st = readState(env.dir, 'g1')
    assert.equal(st.failStreak, k)
    assert.equal(st.nextAttemptAt, env.clock.t + expected[k - 1] * MIN, `第 ${k} 次失败 → 退避 ${expected[k - 1]} 分钟`)
    env.clock.t = st.nextAttemptAt // 到点再试
  }
  // 第 5 次 → 熔断 1 小时
  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  const st5 = readState(env.dir, 'g1')
  assert.equal(st5.failStreak, DISTILL_CIRCUIT_THRESHOLD)
  assert.equal(st5.nextAttemptAt, env.clock.t + DISTILL_CIRCUIT_OPEN_MS, '第 5 次失败 → 熔断 1 小时')
  rmSync(env.dir, { recursive: true, force: true })
})

// —————————————— ③ 熔断 + notifier 恰好 1 次 ——————————————

test('③ 连续 5 次失败 → 熔断 1h + notifier 恰好 1 次（同窗口不再告警）', async () => {
  const env = makeEnv({ messages: 3 })
  const { distiller } = makeDistiller(env)
  env.llm.failing = true

  for (let k = 1; k < DISTILL_CIRCUIT_THRESHOLD; k++) {
    assert.equal(await distiller.tryDistill('g1', 'manual'), false)
    assert.equal(env.notifyCalls.length, 0, `第 ${k} 次失败尚未熔断 → 不告警`)
    env.clock.t = readState(env.dir, 'g1').nextAttemptAt
  }
  // 第 5 次 → 熔断 + 告警一次
  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  assert.equal(env.notifyCalls.length, 1, '熔断恰好告警一次')
  assert.equal(env.notifyCalls[0].kind, 'distill-circuit-open')
  assert.equal(readState(env.dir, 'g1').circuitNotified, true)
  // 告警正文只含群 id / 次数 / 时长，不含消息内容或错误全文
  assert.match(env.notifyCalls[0].body, /g1/)
  assert.match(env.notifyCalls[0].body, /5 次/)
  assert.equal(env.notifyCalls[0].body.includes('connection reset'), false)

  // 熔断窗口内：任何触发都 0 调用、0 告警
  const before = env.calls.length
  assert.equal(await distiller.tryDistill('g1', 'message-threshold'), false)
  assert.equal(env.calls.length, before)
  assert.equal(env.notifyCalls.length, 1)

  // 1 小时后再失败（第 6 次）：重新熔断但不重复告警
  env.clock.t = readState(env.dir, 'g1').nextAttemptAt
  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  const st6 = readState(env.dir, 'g1')
  assert.equal(st6.failStreak, 6)
  assert.equal(st6.nextAttemptAt, env.clock.t + DISTILL_CIRCUIT_OPEN_MS)
  assert.equal(env.notifyCalls.length, 1, '同一熔断窗口只告警一次')

  rmSync(env.dir, { recursive: true, force: true })
})

test('③b 未注入 notifier → 熔断静默（可选依赖，缺省不抛错）', async () => {
  const env = makeEnv({ messages: 3 })
  const { distiller } = makeDistiller(env, { notifier: null })
  env.llm.failing = true
  for (let k = 1; k <= DISTILL_CIRCUIT_THRESHOLD; k++) {
    await distiller.tryDistill('g1', 'manual')
    env.clock.t = readState(env.dir, 'g1').nextAttemptAt
  }
  assert.equal(readState(env.dir, 'g1').failStreak, DISTILL_CIRCUIT_THRESHOLD)
  assert.equal(env.notifyCalls.length, 0)
  rmSync(env.dir, { recursive: true, force: true })
})

// —————————————— ④ 成功清零 + 水位推进 ——————————————

test('④ 成功后 failStreak/nextAttemptAt 清零、lastSuccessAt 更新、水位推进', async () => {
  const env = makeEnv({ messages: 3 }) // ts 1000/1001/1002
  const { distiller } = makeDistiller(env)
  env.llm.failing = true
  await distiller.tryDistill('g1', 'manual')
  assert.equal(readState(env.dir, 'g1').failStreak, 1)

  env.clock.t = readState(env.dir, 'g1').nextAttemptAt
  env.llm.failing = false
  assert.equal(await distiller.tryDistill('g1', 'manual'), true)

  const st = readState(env.dir, 'g1')
  assert.equal(st.failStreak, 0, '成功清零 failStreak')
  assert.equal(st.nextAttemptAt, 0, '成功清退避')
  assert.equal(st.lastSuccessAt, env.clock.t, 'lastSuccessAt = now')
  assert.equal(st.lastDistilledMsgTs, 1002, '水位推进到本批最后一条 ts')
  assert.equal(st.lastDistilledMsgId, 'm0002', '水位同时记 msgId 兜底')
  assert.equal(distiller.status('g1').lastDistillAt, env.clock.t)
  assert.equal(distiller.status('g1').failStreak, 0)
  rmSync(env.dir, { recursive: true, force: true })
})

// —————————————— ⑤ 增量水位 ——————————————

test('⑤ 增量水位：先 25 条、再来 5 条 → 第二次只送 5 条；无新消息不触发', async () => {
  const env = makeEnv({ everyMessages: 25, messages: 25 }) // ts 1000..1024
  const { distiller } = makeDistiller(env)

  assert.equal(await distiller.tryDistill('g1', 'interval'), true)
  assert.equal(env.calls.length, 1)
  const first = messagesIn(env.calls[0])
  assert.equal(first.length, 25, '首轮全量（无水位历史群不特殊处理）')
  assert.equal(JSON.parse(first[0].text), '消息0')

  // 再来 5 条新消息（ts 1025..1029）
  seed(env.buffer, 'g1', 5, { startTs: 1000, from: 25 })
  assert.equal(await distiller.tryDistill('g1', 'message-threshold'), true)
  assert.equal(env.calls.length, 2)
  const second = messagesIn(env.calls[1])
  assert.equal(second.length, 5, 'C2：只送水位之后的新消息（旧 25 条不重送）')
  assert.deepEqual(
    second.map((m) => JSON.parse(m.text)),
    ['消息25', '消息26', '消息27', '消息28', '消息29'],
    '送的正是新 5 条，序号连续且无重复',
  )
  assert.equal(readState(env.dir, 'g1').lastDistilledMsgTs, 1029)

  // 无新消息：不触发（0 次新调用）
  assert.equal(await distiller.tryDistill('g1', 'interval'), false)
  assert.equal(env.calls.length, 2, '水位过滤后为空 → 不调 LLM')

  rmSync(env.dir, { recursive: true, force: true })
})

test('⑤b 水位过滤纯函数：ts 严格更大才算新；同 ts 按 msgId 序兜底', () => {
  const st = { ...emptyDistillState(), lastDistilledMsgTs: 200, lastDistilledMsgId: 'm0100' }
  const msgs = [
    { ts: 199, messageId: 'm0099' }, // 旧
    { ts: 200, messageId: 'm0100' }, // 水位本身 → 已提炼
    { ts: 200, messageId: 'm0101' }, // 同 ts 但 msgId 更大 → 新
    { ts: 201, messageId: 'm0001' }, // ts 更大 → 新（不看 msgId）
  ]
  assert.deepEqual(
    filterAfterWatermark(msgs, st).map((m) => `${m.ts}/${m.messageId}`),
    ['200/m0101', '201/m0001'],
  )
  // 无水位：全量
  assert.equal(filterAfterWatermark(msgs, emptyDistillState()).length, 4)
  // 同 ts 但缺 msgId：视为已提炼（宁可少送不重送）
  assert.deepEqual(filterAfterWatermark([{ ts: 200 }], st), [])
})

// —————————————— ⑥ 重启恢复 ——————————————

test('⑥ 重启：新实例从 json 恢复退避与水位（心跳也不再重触发）', async () => {
  const env = makeEnv({ messages: 3 })
  // 实例 A：失败 1 次 → 落盘 failStreak=1 / nextAttemptAt=T0+1min
  const a = makeDistiller(env)
  env.llm.failing = true
  assert.equal(await a.distiller.tryDistill('g1', 'manual'), false)
  const callsAfterFail = env.calls.length
  assert.equal(callsAfterFail, 2)

  // 实例 B = "进程重启"：同 dir/同 store/新对象、内存 Map 全空
  const b = makeDistiller(env)
  assert.equal(await b.distiller.tryDistill('g1', 'manual'), false, '重启后退避仍生效')
  assert.equal(env.calls.length, callsAfterFail, '重启不退避 → 0 次新调用（旧实现每 30s 重触发就是这里漏的）')

  // 心跳路径同样被拦：新实例收到一条新消息 → tick 也不得调 LLM
  b.distiller.start()
  b.distiller.onNewMessage('g1')
  await b.timerRef.fn()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(env.calls.length, callsAfterFail, '重启 + 新消息 + 心跳仍在退避窗口内 → 0 调用')

  // 到点后成功一次 → 水位落盘
  env.clock.t = T0 + DISTILL_BACKOFF_BASE_MS
  env.llm.failing = false
  assert.equal(await b.distiller.tryDistill('g1', 'manual'), true)
  assert.equal(readState(env.dir, 'g1').lastDistilledMsgTs, 1002)

  // 实例 C：只喂重启后到达的新消息（水位跨重启有效）
  seed(env.buffer, 'g1', 2, { startTs: 1000, from: 3 }) // ts 1003/1004
  const c = makeDistiller(env)
  assert.equal(await c.distiller.tryDistill('g1', 'interval'), true)
  const fed = messagesIn(env.calls[env.calls.length - 1])
  assert.equal(fed.length, 2, '重启后水位仍有效：只送 2 条新消息')
  assert.deepEqual(fed.map((m) => JSON.parse(m.text)), ['消息3', '消息4'])

  rmSync(env.dir, { recursive: true, force: true })
})

test('⑥b 状态文件损坏 → 作废重来（不抛错、按无状态继续）', async () => {
  const env = makeEnv({ messages: 2 })
  // 先写一份坏 json
  env.store.ensureDir('groups/g1')
  env.store.writeText(distillStateRelPath('g1'), '{ 这不是 JSON')
  const { distiller } = makeDistiller(env)
  assert.equal(await distiller.tryDistill('g1', 'manual'), true, '损坏状态不阻断提炼')
  assert.ok(env.logger.warnings.some((w) => /distill-state\.json 损坏/.test(w)), '损坏必须 warn 一次')
  assert.equal(readState(env.dir, 'g1').lastDistilledMsgTs, 1001, '作废后按无水位全量提炼并写下新状态')
  rmSync(env.dir, { recursive: true, force: true })
})

// —————————————— ⑦ 错误分类 + errMsg ——————————————

test('⑦-1 errKindOf 六分类：429/401/403/5xx/400/timeout/other', () => {
  // timeout 优先且向后兼容（report/distiller 的对半切分判据只看它）
  assert.equal(errKindOf(new Error('llm stream finished with error: Request timed out.')), 'timeout')
  assert.equal(errKindOf(new Error('Request timeout')), 'timeout')
  assert.equal(errKindOf('timeout'), 'timeout')
  // 限流
  assert.equal(errKindOf(new Error('llm http 429 from https://api.example/v4/chat/completions')), 'rate_limit')
  assert.equal(errKindOf(new Error('429 Too Many Requests')), 'rate_limit')
  assert.equal(errKindOf(new Error('rate limit exceeded')), 'rate_limit')
  // 鉴权（须先于 bad_request，否则 "invalid api key" 会被 /invalid/ 抢走）
  assert.equal(errKindOf(new Error('llm http 401 unauthorized')), 'auth')
  assert.equal(errKindOf(new Error('403 Forbidden')), 'auth')
  assert.equal(errKindOf(new Error('invalid api key')), 'auth')
  // 服务端
  assert.equal(errKindOf(new Error('llm http 503 from upstream')), 'server')
  assert.equal(errKindOf(new Error('500 Internal Server Error')), 'server')
  assert.equal(errKindOf(new Error('502 Bad Gateway')), 'server')
  // 请求非法
  assert.equal(errKindOf(new Error('llm http 400 bad request')), 'bad_request')
  assert.equal(errKindOf(new Error('422 Unprocessable Entity')), 'bad_request')
  assert.equal(errKindOf(new Error('invalid JSON schema')), 'bad_request')
  // 其余（既有测试语义不变）
  assert.equal(errKindOf(new Error('connection reset by peer')), 'other')
  assert.equal(errKindOf(new Error('boom')), 'other')
  assert.equal(errKindOf(null), 'other')
})

test('⑦-2 失败行含脱敏 errMsg（≤160 字符）；成功行无 errMsg；distill 相位同样落 errMsg', async () => {
  const dir = makeDir()
  const logger = makeLogger()
  const store = new Store(dir, logger)
  const rec = new LlmCallRecorder(store, () => T0, { model: 'glm-5.3' })
  const secret = `sk-${'a'.repeat(40)}`
  const prompt = 'P'.repeat(120)

  // 失败：鉴权错误 + 内嵌疑似 key → 必须脱敏、截断 160
  await assert.rejects(
    () =>
      rec.call('g1', 'distill', 'distill', 1, 25, prompt, async () => {
        throw new Error(`llm http 401 unauthorized: key ${secret}`)
      }),
    /401/,
  )
  // 成功：不写 errMsg
  await rec.call('g1', 'distill', 'distill', 1, 25, prompt, async () => '[]')

  const rows = readCalls(dir, 'g1')
  assert.equal(rows.length, 2)
  const fail = rows[0]
  assert.equal(fail.ok, false)
  assert.equal(fail.errKind, 'auth')
  assert.equal(typeof fail.errMsg, 'string', '失败行必须有 errMsg')
  assert.ok(fail.errMsg.length <= ERR_MSG_MAX_CHARS, `errMsg 必须 ≤${ERR_MSG_MAX_CHARS} 字符`)
  assert.equal(fail.errMsg.includes(secret), false, '疑似 key 不得原样落盘')
  assert.match(fail.errMsg, /redacted-token:\d+/, '脱敏标记必须出现')
  assert.match(fail.errMsg, /401/)
  // 成功行无 errMsg（向后兼容：旧字段集不变）
  assert.equal(rows[1].ok, true)
  assert.equal('errMsg' in rows[1], false)

  // 长错误消息截断到 160 字符（用空格打断密钥形态串，避免整段被脱敏掉）
  assert.equal(summarizeErrMsg(new Error('boom '.repeat(80))).length, ERR_MSG_MAX_CHARS)
  // 非法 JSON 类错误摘要原样保留（可读、可归因）
  assert.equal(summarizeErrMsg(new Error('Unexpected token } in JSON at position 3')), 'Unexpected token } in JSON at position 3')

  rmSync(dir, { recursive: true, force: true })
})

test('⑦-3 提炼失败经 LlmCallRecorder → JSONL 失败行带 errKind + errMsg（端到端）', async () => {
  const env = makeEnv({ messages: 3 })
  const recorder = new LlmCallRecorder(env.store, () => env.clock.t, { model: 'glm-5.3' })
  // 正常由 index.ts 注入；这里直接经构造注入，模拟真实接线
  const { distiller } = makeDistiller(env, { llmCallRecorder: recorder })
  env.llm.failing = true
  env.llm.error = new Error('llm http 503 from https://api.example/v4/chat/completions')

  assert.equal(await distiller.tryDistill('g1', 'manual'), false)
  const rows = readCalls(env.dir, 'g1')
  assert.equal(rows.length, 2, '失败 + 重试各落一行')
  for (const r of rows) {
    assert.equal(r.phase, 'distill')
    assert.equal(r.ok, false)
    assert.equal(r.errKind, 'server')
    assert.match(r.errMsg, /503/)
  }
  rmSync(env.dir, { recursive: true, force: true })
})
