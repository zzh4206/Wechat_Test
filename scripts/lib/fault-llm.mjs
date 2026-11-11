/**
 * fault-llm.mjs —— 故障注入 LLM 客户端（合成基准判定侧的 L3「故障环境代换」）。
 *
 * 目的：零网络、零真实数据地重放 LLM 的失败模式（超时 / 429 / 5xx / 鉴权 / 400 /
 * 非法 JSON / 慢响应），让「分批 / 对半切分 / 退避 / 降级」这些策略的效果可以在
 * 离线基准里被度量。错误文案刻意对齐生产路径：
 * - timeout 用 `Request timed out.`——lib/llm-observe.js 的 errKindOf 按
 *   /timed?\s?out|timeout/i 分类，report/distiller 据此走「对半切分」而非原样重试；
 * - 其余错误带 HTTP 状态码，errKindOf 归为 'other'（与生产同口径）。
 *
 * 能力矩阵（script）：
 * - `'alwaysOk'` / `{ alwaysOk: true, text? }`：永远成功；
 * - 数组：按调用序回放，元素形态
 *     { ok:true, text, delayMs? }            成功返回 text（text 可为函数）
 *     { ok:true, badJson:true }              返回非法 JSON 文本（默认 'not json at all'）
 *     { err:'timeout'|'rate_limit'|'server'|'auth'|'bad_request', delayMs? }  抛对应故障
 *   序列耗尽后回落到 `tail`（缺省 `{ok:true,text:defaultText}`）；
 * - `{ pFail, errWeights?, pTimeout?, pBadJson?, text? }`：按概率注入。
 *   pFail = 失败总概率；pTimeout = 其中 timeout 的绝对概率（≤pFail），其余失败按
 *   errWeights 在非 timeout 类型间加权；pBadJson = 成功调用里返回非法 JSON 的概率。
 *
 * 计数（随调用实时更新，供 bench 读取）：
 *   calls / okCalls / failCalls / promptChars / estimatedInTokens / estimatedOutTokens /
 *   estimatedCostCny / failByKind / badJsonCalls。
 * 费用口径与 lib/llm-observe.js 完全一致：tokens = round(chars/1.6)，价格表默认
 * glm-5.3（输入 ¥8 / 输出 ¥28 每百万 tokens），四舍五入到 1e-6 元。
 *
 * 确定性：概率模式用 seed 驱动的 mulberry32，同 seed 同调用序 → 同结果。
 * 延迟：每次调用 `await sleep(delayMs ?? 全局 delayMs ?? 0)`；缺省 setTimeout(0)，
 * 测试可注入 `sleep` 做零延迟时钟。
 */
import { computeCostCny, DEFAULT_LLM_PRICING, estimateTokens } from '../../lib/llm-observe.js'

/** 可注入的故障类型（bad_request 区别于「非法 JSON」：前者是 HTTP 400，后者是 200 但内容不可解析） */
export const FAULT_KINDS = ['timeout', 'rate_limit', 'server', 'auth', 'bad_request']

/** 各类故障的对齐生产文案与 HTTP 状态码 */
const FAULT_SPEC = {
  timeout: { status: undefined, message: 'llm stream finished with error: Request timed out.' },
  rate_limit: { status: 429, message: 'llm http 429 rate limit exceeded' },
  server: { status: 500, message: 'llm http 500 internal server error' },
  auth: { status: 401, message: 'llm http 401 unauthorized' },
  bad_request: { status: 400, message: 'llm http 400 bad request' },
}

/** 注入故障的错误对象：kind/status 供测试断言，message 供 errKindOf 分类 */
export class FaultLlmError extends Error {
  constructor(kind) {
    const spec = FAULT_SPEC[kind]
    super(spec.message)
    this.name = 'FaultLlmError'
    this.kind = kind
    this.status = spec.status
  }
}

/** mulberry32：32 位种子 PRNG（同 seed 同序列；零依赖） */
export function mulberry32(seed) {
  let a = Number(seed) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function resolveText(value, badJsonText) {
  if (typeof value === 'string') return value
  if (typeof value === 'function') return value
  return badJsonText
}

function validateDelay(v, where) {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new TypeError(`${where}: delayMs 必须是非负有限数`)
  }
  return v
}

function validateEntry(entry, index, badJsonText) {
  const where = `script[${index}]`
  if (!isPlainObject(entry)) throw new TypeError(`${where}: 必须是对象`)
  const delayMs = validateDelay(entry.delayMs, where)
  if (entry.err !== undefined) {
    if (!FAULT_KINDS.includes(entry.err)) {
      throw new TypeError(`${where}: 未知故障 ${JSON.stringify(entry.err)}（可选 ${FAULT_KINDS.join('|')}）`)
    }
    return { err: entry.err, delayMs }
  }
  if (entry.ok !== true) throw new TypeError(`${where}: 必须是 {ok:true,...} 或 {err:'...'}`)
  if (entry.badJson === true) return { ok: true, badJson: true, text: badJsonText, delayMs }
  if (entry.text === undefined) throw new TypeError(`${where}: ok 条目缺少 text`)
  if (typeof entry.text !== 'string' && typeof entry.text !== 'function') {
    throw new TypeError(`${where}: text 必须是字符串或函数`)
  }
  return { ok: true, text: entry.text, delayMs }
}

function normalizeScript(script, badJsonText) {
  if (script === undefined || script === null || script === 'alwaysOk') {
    return { kind: 'ok' }
  }
  if (typeof script === 'string') {
    throw new TypeError(`未知 script: ${JSON.stringify(script)}（可选 'alwaysOk' | 数组 | {pFail,...}）`)
  }
  if (Array.isArray(script)) {
    return { kind: 'sequence', entries: script.map((e, i) => validateEntry(e, i, badJsonText)) }
  }
  if (!isPlainObject(script)) throw new TypeError('script 必须是 alwaysOk | 数组 | 概率对象')
  if (script.alwaysOk === true || script.mode === 'alwaysOk') {
    if (script.text !== undefined && typeof script.text !== 'string' && typeof script.text !== 'function') {
      throw new TypeError('alwaysOk.text 必须是字符串或函数')
    }
    return { kind: 'ok', text: script.text }
  }
  if (typeof script.pFail !== 'number' || !Number.isFinite(script.pFail)) {
    throw new TypeError('概率模式 script 缺少数值 pFail')
  }
  const pFail = clamp01(script.pFail)
  const pTimeout = script.pTimeout === undefined ? 0 : clamp01(script.pTimeout)
  const pBadJson = script.pBadJson === undefined ? 0 : clamp01(script.pBadJson)
  if (pTimeout > pFail) throw new TypeError('pTimeout 不能大于 pFail（timeout 是失败的一种）')
  if (script.text !== undefined && typeof script.text !== 'string' && typeof script.text !== 'function') {
    throw new TypeError('概率模式 text 必须是字符串或函数')
  }
  const errWeights = {}
  if (script.errWeights !== undefined) {
    if (!isPlainObject(script.errWeights)) throw new TypeError('errWeights 必须是对象')
    for (const [k, v] of Object.entries(script.errWeights)) {
      if (!FAULT_KINDS.includes(k)) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new TypeError(`errWeights.${k} 必须是非负有限数`)
      }
      errWeights[k] = v
    }
  }
  return { kind: 'prob', pFail, pTimeout, pBadJson, errWeights, text: script.text }
}

function pickWeighted(weights, rnd) {
  const entries = Object.entries(weights).filter(([k, v]) => FAULT_KINDS.includes(k) && v > 0)
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (total <= 0) return 'server'
  let r = rnd() * total
  for (const [k, v] of entries) {
    r -= v
    if (r <= 0) return k
  }
  return entries[entries.length - 1][0]
}

/**
 * 创建故障注入 LLM 客户端。
 * @param {object} [options]
 * @param {'alwaysOk'|Array|object} [options.script='alwaysOk']
 * @param {number} [options.seed=0]
 * @param {number} [options.delayMs=0] 全局默认延迟（条目/概率可单独覆盖）
 * @param {(ms:number)=>Promise<void>} [options.sleep] 延迟实现（测试注入零延迟时钟）
 * @param {string} [options.badJsonText='not json at all']
 * @param {string} [options.defaultText='[]'] alwaysOk / 序列耗尽 / 概率成功时的缺省文本
 * @param {object} [options.tail] 序列耗尽后的回落条目（缺省 {ok:true,text:defaultText}）
 * @param {string} [options.model='glm-5.3']
 * @param {object} [options.pricing] 价格表（缺省 DEFAULT_LLM_PRICING）
 */
export function createFaultLlm(options = {}) {
  const badJsonText = options.badJsonText ?? 'not json at all'
  const model = options.model ?? 'glm-5.3'
  const pricing = options.pricing ?? DEFAULT_LLM_PRICING
  const defaultText = options.defaultText ?? '[]'
  const globalDelay = validateDelay(options.delayMs, 'options') ?? 0
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const rnd = mulberry32(options.seed ?? 0)
  const mode = normalizeScript(options.script, badJsonText)
  const tail =
    options.tail !== undefined
      ? validateEntry(options.tail, 'tail', badJsonText)
      : { ok: true, text: defaultText }

  const llm = {
    calls: 0,
    okCalls: 0,
    failCalls: 0,
    promptChars: 0,
    estimatedInTokens: 0,
    estimatedOutTokens: 0,
    estimatedCostCny: 0,
    /** 按故障类型计数（仅传输层失败；非法 JSON 记在 badJsonCalls） */
    failByKind: { timeout: 0, rate_limit: 0, server: 0, auth: 0, bad_request: 0 },
    badJsonCalls: 0,
    /** 序列模式已消费的条目数（= 已消费调用数，便于测试断言） */
    seqIndex: 0,
    lastText: '',

    modelId() {
      return model
    },

    /** 当前计数的纯数据快照（per-day 增量统计用） */
    stats() {
      return {
        calls: llm.calls,
        okCalls: llm.okCalls,
        failCalls: llm.failCalls,
        promptChars: llm.promptChars,
        estimatedInTokens: llm.estimatedInTokens,
        estimatedOutTokens: llm.estimatedOutTokens,
        estimatedCostCny: llm.estimatedCostCny,
        failByKind: { ...llm.failByKind },
        badJsonCalls: llm.badJsonCalls,
      }
    },

    async complete(prompt) {
      const text = String(prompt ?? '')
      const callIndex = llm.calls
      llm.calls++
      llm.promptChars += text.length
      llm.estimatedInTokens += estimateTokens(text.length)

      let outcome
      if (mode.kind === 'ok') {
        outcome = { ok: true, text: mode.text }
      } else if (mode.kind === 'sequence') {
        outcome = mode.entries[callIndex] ?? tail
        llm.seqIndex = Math.min(llm.calls, mode.entries.length)
      } else {
        // 概率模式：先掷失败、再掷故障类型、最后掷非法 JSON（顺序固定 → 同 seed 可复现）
        if (rnd() < mode.pFail) {
          let kind
          if (mode.pTimeout > 0 && rnd() < mode.pTimeout / mode.pFail) {
            kind = 'timeout'
          } else {
            const rest = { ...mode.errWeights }
            delete rest.timeout
            kind = pickWeighted(rest, rnd)
          }
          outcome = { err: kind }
        } else if (mode.pBadJson > 0 && rnd() < mode.pBadJson) {
          outcome = { ok: true, badJson: true, text: badJsonText }
        } else {
          outcome = { ok: true, text: mode.text }
        }
      }

      // 延迟契约：每次调用都 await sleep(delayMs ?? 0)；测试注入 sleep 做零延迟时钟
      const delayMs = outcome.delayMs ?? globalDelay
      await sleep(delayMs)

      if (outcome.err !== undefined) {
        llm.failCalls++
        llm.failByKind[outcome.err] = (llm.failByKind[outcome.err] ?? 0) + 1
        llm.estimatedCostCny = computeCostCny(model, llm.estimatedInTokens, llm.estimatedOutTokens, pricing)
        throw new FaultLlmError(outcome.err)
      }

      let out
      if (outcome.badJson === true) {
        out = badJsonText
        llm.badJsonCalls++
      } else {
        const raw = outcome.text === undefined ? defaultText : outcome.text
        out = typeof raw === 'function' ? raw(text, callIndex) : raw
        if (typeof out !== 'string') out = String(out)
      }
      llm.okCalls++
      llm.lastText = out
      llm.estimatedOutTokens += estimateTokens(out.length)
      llm.estimatedCostCny = computeCostCny(model, llm.estimatedInTokens, llm.estimatedOutTokens, pricing)
      return out
    },
  }

  return llm
}
