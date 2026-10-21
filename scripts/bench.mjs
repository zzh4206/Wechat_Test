#!/usr/bin/env node
/**
 * bench.mjs —— 合成基准「重放」器：零网络、零真实数据地重放提炼器与报告管线，
 * 注入故障并输出机器可读判定（方法论 §2「L2 输出判据代换」）。
 *
 * 设计要点：
 * - **真实服务类**重放：GroupStoreService / Store / BufferPool / Distiller /
 *   ReportService / PersonaService / LlmCallRecorder 全部用仓库实现，只在临时
 *   state 目录里跑（mkdtemp + finally 删除），绝不写 ~/.dsh、绝不联网；
 * - **故障注入**：LLM 客户端换成 scripts/lib/fault-llm.mjs（超时/429/5xx/鉴权/
 *   400/非法 JSON），提炼与报告共用同一注入参数、各自独立计数；
 * - **重放约定**（诚实披露）：一次*成功*提炼消费其待处理窗口（等价于 C2 增量
 *   水位的效果），失败不消费（真实计数器语义）——于是「失败后每条新消息重触发」
 *   的 legacy 行为被如实还原，同时 alwaysOk 下 calls 恒等于理论最少批数；
 *   串行 await 每次 tryDistill（不复现并发丢触发，故触发数是保守上界）；
 * - **变体感知**：先探测 lib/distiller.js（或 src/distiller.ts）是否导出
 *   nextAttemptDelayMs / distillStateRelPath / DISTILL_CIRCUIT_THRESHOLD、是否
 *   含 distill-state.json 标记，再在重放后检查状态文件是否真的被写出；
 *   `--variant guard|legacy` 可强制标签（代码不支持 guard 时在 warnings 里明说）。
 *
 * 用法：
 *   node scripts/bench.mjs --stream <stream.jsonl> --manifest <manifest.json> \
 *        --seed 42 [--fail 0.3] [--days N] [--variant guard|legacy] [--json]
 *   node scripts/bench.mjs --synth --seed 42 [--days 3] [--json]   # 内置最小合成器
 *
 * 不变量（输出 PASS/FAIL）：
 *   I1 提炼调用数 ≤ ceil(msgs/batch) × (1 + 2×失败率×4)
 *   I2 单日总成本 ≤ ¥0.5（585 规模 300 条/日画像下的预算线）
 *   I3 失败注入 30% 时重试放大系数 ≤ 3.0（无风暴）
 *   I4 报告必需产出：每天 ok 或 degraded，不抛、不丢文件
 *   I5 evidence/quotes 序号映射合法（全部落在当天报告窗口内）
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BufferPool } from '../lib/buffer.js'
import * as distillerModule from '../lib/distiller.js'
import { Distiller } from '../lib/distiller.js'
import { GroupStoreService, MESSAGE_KINDS } from '../lib/group-store.js'
import { DEFAULT_LLM_PRICING, LlmCallRecorder } from '../lib/llm-observe.js'
import { PersonaService } from '../lib/persona.js'
import { ReportService, reportWindow } from '../lib/report.js'
import { Store } from '../lib/store.js'
import { createFaultLlm } from './lib/fault-llm.mjs'
import { parseReportMd } from './bench-quality.mjs'

const DAY_MS = 86_400_000
const BENCH_CHAT = '12345678@chatroom'
const COST_BUDGET_CNY = 0.5
const RETRY_AMPLIFICATION_MAX = 3.0

class BenchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BenchError'
    this.exitCode = 2
  }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function round(v, digits) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function localDayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function localDayStart(key) {
  const [y, m, d] = String(key).split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

function quietLogger() {
  const warnings = []
  return {
    warnings,
    warn(m) {
      warnings.push(String(m))
    },
    error(m) {
      warnings.push(String(m))
    },
  }
}

// —————————————————— 参数 ——————————————————

const HELP = `用法:
  node scripts/bench.mjs --stream <stream.jsonl> --manifest <manifest.json> \\
       --seed 42 [--fail 0.3] [--days N] [--variant guard|legacy] [--json] [--strict]
  node scripts/bench.mjs --synth --seed 42 [--days 3] [--json]

参数:
  --stream <f>            合成消息流（每行 {ts,sender,kind,text,quoteOf}）
  --manifest <f>          合成清单（topics/tasks/quotes；缺失报清晰错误）
  --seed <n>              随机种子（默认 42；同种子同输出）
  --fail <0..1>           LLM 传输层失败注入概率（默认 0）
  --bad-json <0..1>       成功调用里返回非法 JSON 的概率（默认 0）
  --days <n>              只重放前 n 个自然日（默认全部；--synth 时默认 3）
  --variant <v>           强制变体标签 guard|legacy（默认自动探测）
  --every <n>             每 n 条消息触发提炼（默认 5）
  --interval-min <n>      定时间隔分钟（默认 30）
  --batch-threshold <n>   报告分批阈值（默认 120，50 条/日 → 单批）
  --buffer-size <n>       重放缓冲容量（默认 10000，避免淘汰干扰度量）
  --chat <id>             合成 chatId（默认 12345678@chatroom）
  --synth                 使用内置最小合成器（3 天 × 50 条 + 植入真值）
  --json                  只输出机器可读 JSON
  --strict                任一不变量 FAIL 时退出码 1（默认 0）
  --help                  显示本帮助

示例:
  node scripts/bench.mjs --stream /path/to/stream.jsonl --manifest /path/to/manifest.json --seed 42 --fail 0.3
  node scripts/bench.mjs --synth --seed 42 --variant legacy --json`

function parseArgs(argv) {
  const opts = {
    stream: null,
    manifest: null,
    seed: 42,
    fail: 0,
    badJson: 0,
    days: null,
    variant: null,
    every: 25,
    intervalMin: 15,
    batchThreshold: 120,
    bufferSize: 60,
    chat: BENCH_CHAT,
    synth: false,
    json: false,
    strict: false,
    help: false,
  }
  const numberFlag = (name, value, { min = -Infinity, max = Infinity, integer = false } = {}) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw new BenchError(`参数 --${name} 取值非法: ${JSON.stringify(value)}（期望 ${integer ? '整数' : '数值'}${min !== -Infinity ? ` ≥${min}` : ''}${max !== Infinity ? ` ≤${max}` : ''}）`)
    }
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new BenchError(`参数 ${arg} 需要一个值`)
      return v
    }
    switch (arg) {
      case '--stream':
        opts.stream = next()
        break
      case '--manifest':
        opts.manifest = next()
        break
      case '--seed':
        opts.seed = numberFlag('seed', next(), { min: 0, integer: true })
        break
      case '--fail':
        opts.fail = numberFlag('fail', next(), { min: 0, max: 1 })
        break
      case '--bad-json':
        opts.badJson = numberFlag('bad-json', next(), { min: 0, max: 1 })
        break
      case '--days':
        opts.days = numberFlag('days', next(), { min: 1, integer: true })
        break
      case '--variant': {
        const v = next()
        if (v !== 'guard' && v !== 'legacy') throw new BenchError(`--variant 只接受 guard|legacy（收到 ${JSON.stringify(v)}）`)
        opts.variant = v
        break
      }
      case '--every':
        opts.every = numberFlag('every', next(), { min: 1, integer: true })
        break
      case '--interval-min':
        opts.intervalMin = numberFlag('interval-min', next(), { min: 1, integer: true })
        break
      case '--batch-threshold':
        opts.batchThreshold = numberFlag('batch-threshold', next(), { min: 10, integer: true })
        break
      case '--buffer-size':
        opts.bufferSize = numberFlag('buffer-size', next(), { min: 1, integer: true })
        break
      case '--chat':
        opts.chat = next()
        break
      case '--synth':
        opts.synth = true
        break
      case '--json':
        opts.json = true
        break
      case '--strict':
        opts.strict = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new BenchError(`未知参数: ${arg}`)
    }
  }
  if (!/^[A-Za-z0-9_@=-]{1,128}$/.test(opts.chat)) {
    throw new BenchError(`--chat 含非法字符（只允许字母数字 _ @ = -）: ${JSON.stringify(opts.chat)}`)
  }
  return opts
}

// —————————————————— 输入加载 ——————————————————

function loadStream(path) {
  const abs = resolve(path)
  let raw
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (error) {
    throw new BenchError(`stream 文件读取失败：${abs}\n  ${error.message}\n  请用 --stream 指定合成流（每行 {ts,sender,kind,text,quoteOf}）`)
  }
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) throw new BenchError(`stream 文件为空：${abs}`)
  const messages = lines.map((line, i) => {
    let rec
    try {
      rec = JSON.parse(line)
    } catch (error) {
      throw new BenchError(`stream 第 ${i + 1} 行不是合法 JSON：${error.message}`)
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new BenchError(`stream 第 ${i + 1} 行不是对象`)
    // ts 契约是毫秒时间戳；同时容忍数值字符串与 ISO 字符串（G1 产物接入更顺滑）
    let ts = rec.ts
    if (typeof ts === 'string') ts = /^\d+$/.test(ts.trim()) ? Number(ts) : Date.parse(ts)
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new BenchError(`stream 第 ${i + 1} 行缺少数值 ts（毫秒时间戳或 ISO 字符串）`)
    }
    if (rec.text !== undefined && typeof rec.text !== 'string') {
      throw new BenchError(`stream 第 ${i + 1} 行 text 必须是字符串`)
    }
    return {
      ts,
      sender: typeof rec.sender === 'string' && rec.sender !== '' ? rec.sender : '合成成员',
      kind: typeof rec.kind === 'string' ? rec.kind : 'text',
      text: typeof rec.text === 'string' ? rec.text : '',
      quoteOf: rec.quoteOf ?? null,
    }
  })
  messages.sort((a, b) => a.ts - b.ts)
  return messages
}

function loadManifest(path) {
  const abs = resolve(path)
  let raw
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (error) {
    throw new BenchError(`manifest 文件读取失败：${abs}\n  ${error.message}\n  请用 --manifest 指定合成清单（topics/tasks/quotes）`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new BenchError(`manifest 不是合法 JSON：${abs}\n  ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BenchError(`manifest 顶层必须是对象：${abs}`)
  }
  return {
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    raw: parsed,
  }
}

function selectDays(messages, days) {
  const keys = []
  for (const m of messages) {
    const k = localDayKey(m.ts)
    if (!keys.includes(k)) keys.push(k)
  }
  keys.sort()
  const selected = days === null ? keys : keys.slice(0, days)
  const set = new Set(selected)
  return {
    dayKeys: selected,
    requestedDays: days,
    messages: messages.filter((m) => set.has(localDayKey(m.ts))),
  }
}

// —————————————————— 内置最小合成器（--synth） ——————————————————

const SYNTH_TOPICS = [
  '接口联调排期',
  '版本发布窗口',
  '测试环境交付',
  '预算评审',
  '线上告警复盘',
  '下周迭代范围',
]

const SYNTH_TEXTS = [
  '{topic}这个周五能给个结论吗',
  '我先说下{topic}：目前还没卡点',
  '收到，{topic}我下午跟进',
  '关于{topic}，接口文档还差一版',
  '{topic}要不要放到下周一再定',
  '联调环境今天下午可以给',
  '版本分支先别合新需求',
  '这个问题的根因在缓存过期',
  '我整理一下{topic}的结论发群里',
  '辛苦大家，{topic}按刚才说的推进',
]

/**
 * 内置最小合成器：固定基准日 2026-10-20 起，每天 50 条（08:00 起 5 分钟一条，
 * 即 08:00–12:05 的活跃段），文案只含合成占位词；植入 6 个话题 / 3 个任务 / 3 条引用。
 * 5 分钟间隔让「每 5 条触发」形成 25 分钟节拍，短于 30 分钟 tick——于是 tick 只在
 * 失败后的空闲段补触发（阈值主导形态），与 I1 上界公式的前提一致。
 * 用途仅是本仓库离线演示与测试，不替代 G1 的 synth-gen 产物。
 */
export function buildSynthFixture({ days = 3, seed = 42 } = {}) {
  const messages = []
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < 50; i++) {
      const start = new Date(2026, 9, 20 + d, 8, 0, 0, 0).getTime()
      const ts = start + i * 5 * 60_000
      const title = SYNTH_TOPICS[(d * 2 + (i % 3 === 0 ? 0 : i % 2)) % SYNTH_TOPICS.length]
      const text = SYNTH_TEXTS[(i + d * 7 + seed) % SYNTH_TEXTS.length].replace('{topic}', title)
      messages.push({
        ts,
        sender: `合成成员${(i % 7) + 1}`,
        kind: 'text',
        text: `${text}（${d + 1}-${i + 1}）`,
        quoteOf: i > 0 && i % 11 === 0 ? i - 1 : null,
      })
    }
  }
  const manifest = {
    version: 1,
    note: 'bench --synth 内置最小合成器产物（零真实数据）',
    topics: SYNTH_TOPICS.map((title, i) => ({ id: `T${i + 1}`, title, msgIdx: (i * 17) % messages.length })),
    tasks: [
      { id: 'K1', statement: '周五前给出接口联调环境', evidenceIdx: [5] },
      { id: 'K2', statement: '下周一冻结版本发布分支', evidenceIdx: [27] },
      { id: 'K3', statement: '整理预算评审结论并发群', evidenceIdx: [61] },
    ],
    quotes: [
      { pair: [5, 6], text: messages[5].text },
      { pair: [27, 28], text: messages[27].text },
      { pair: [61, 62], text: messages[61].text },
    ],
  }
  return { messages, manifest, source: { synth: true, days } }
}

// —————————————————— 变体探测 ——————————————————

const GUARD_MARKERS = ['nextAttemptDelayMs', 'distillStateRelPath', 'distill-state.json', 'DISTILL_CIRCUIT_THRESHOLD']
const GUARD_SYMBOLS = [
  'nextAttemptDelayMs',
  'distillBackoffMs',
  'distillStateRelPath',
  'DISTILL_CIRCUIT_THRESHOLD',
  'DISTILL_CIRCUIT_OPEN_MS',
]

export function probeVariant() {
  const evidence = { sourceFile: null, markers: [], exports: [] }
  for (const [rel, label] of [
    ['../lib/distiller.js', 'lib/distiller.js'],
    ['../src/distiller.ts', 'src/distiller.ts'],
  ]) {
    try {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
      const markers = GUARD_MARKERS.filter((m) => src.includes(m))
      if (markers.length > 0) {
        evidence.sourceFile = label
        evidence.markers = markers
        break
      }
    } catch {
      /* 文件不存在：换下一个来源 */
    }
  }
  evidence.exports = GUARD_SYMBOLS.filter((name) => distillerModule[name] !== undefined)
  const detected = evidence.exports.length > 0 || evidence.markers.length > 0 ? 'guard' : 'legacy'
  return { detected, evidence }
}

function staleBuildWarning() {
  try {
    const src = statSync(new URL('../src/distiller.ts', import.meta.url)).mtimeMs
    const lib = statSync(new URL('../lib/distiller.js', import.meta.url)).mtimeMs
    if (src > lib) return 'src/distiller.ts 比 lib/distiller.js 新：基准跑的是编译产物，请先 npm run build'
  } catch {
    /* 缺文件时静默（lib 缺失会在 import 阶段报错） */
  }
  return null
}

// —————————————————— LLM 合成回复 ——————————————————

const INSIGHT_TEXT = JSON.stringify([
  {
    type: 'topic',
    title: '合成话题归纳',
    summary: '合成消息窗口的主题归纳（故障注入基准）',
    actors: ['合成成员'],
    mood: 'neutral',
  },
])

/** 从报告 prompt 的数据区取出该次调用的最大序号，构造合法报告稿 */
function reportDraftFor(prompt) {
  const last = prompt.trimEnd().split('\n').pop() ?? ''
  let n = 1
  let ns = []
  try {
    const wire = JSON.parse(last)
    if (Array.isArray(wire?.messages)) {
      n = wire.messages.length
      // 分批路径的 n 是全局序号（start+i+1），必须原样沿用，不能取批内 1..batchSize
      ns = wire.messages.map((m) => Number(m?.n)).filter((v) => Number.isInteger(v) && v >= 1)
    } else if (typeof wire?.message_count === 'number') {
      n = wire.message_count
    } else if (Array.isArray(wire)) {
      n = wire.length
      ns = wire.map((m) => Number(m?.n)).filter((v) => Number.isInteger(v) && v >= 1)
    }
  } catch {
    /* 非 JSON 末尾（异常 prompt）→ 单条兜底 */
  }
  n = Math.max(1, Math.floor(n))
  const a = ns.length > 0 ? ns[0] : 1
  const b = ns.length > 0 ? ns[Math.floor(ns.length / 2)] : Math.max(1, Math.floor(n / 2))
  const c = ns.length > 0 ? ns[ns.length - 1] : n
  const quoteIdx = [...new Set([a, b, c])]
  return JSON.stringify({
    title: '合成窗口归纳',
    lead: `本窗口共 ${n} 条合成消息，归纳稿由基准固定合成。`,
    judgments: [
      { text: '合成判断一：窗口内讨论集中在接口联调与排期。', evidence: [a] },
      { text: '合成判断二：有一条待办承诺需要跟进。', evidence: [b] },
      { text: '合成判断三：窗口尾部出现新的进展。', evidence: [c] },
    ],
    topics: [
      { title: '接口联调', change: '合成素材推进一档', status: '进行中', people: '合成成员', watch: '联调是否按期', evidence: [a] },
    ],
    quotes: quoteIdx,
  })
}

/** 成功回复：提炼器要 insights 数组，报告要合法 JSON 稿 */
function successText(prompt) {
  if (prompt.includes('群聊旁听分析引擎')) return INSIGHT_TEXT
  return reportDraftFor(prompt)
}

function buildFaultScript({ fail, badJson, text }) {
  if (fail === 0 && badJson === 0) return { alwaysOk: true, text }
  return {
    pFail: fail,
    pTimeout: fail * 0.34,
    pBadJson: badJson,
    errWeights: { timeout: 3, rate_limit: 2, server: 2, auth: 1, bad_request: 1 },
    text,
  }
}

// —————————————————— 重放主体 ——————————————————

function delta(before, after) {
  return {
    calls: after.calls - before.calls,
    okCalls: after.okCalls - before.okCalls,
    failCalls: after.failCalls - before.failCalls,
    promptChars: after.promptChars - before.promptChars,
    estimatedInTokens: after.estimatedInTokens - before.estimatedInTokens,
    estimatedOutTokens: after.estimatedOutTokens - before.estimatedOutTokens,
    estimatedCostCny: after.estimatedCostCny - before.estimatedCostCny,
    badJsonCalls: after.badJsonCalls - before.badJsonCalls,
  }
}

function mergeFailByKind(target, source) {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v
  return target
}

/**
 * 在临时 state 目录里重放一次基准。
 * @param {object} params
 * @param {Array<{ts:number,sender:string,kind?:string,text:string,quoteOf?:unknown}>} params.messages
 * @param {object} params.manifest
 * @param {object} params.source
 * @returns {Promise<object>} 机器可读结果（同时供 CLI 两种输出使用）
 */
export async function runBench(params) {
  const opts = {
    seed: 42,
    fail: 0,
    badJson: 0,
    days: null,
    variant: null,
    every: 25,
    intervalMin: 15,
    batchThreshold: 120,
    bufferSize: 60,
    chat: BENCH_CHAT,
    ...params,
  }
  const { messages: allMessages, manifest, source } = params
  if (!Array.isArray(allMessages) || allMessages.length === 0) throw new BenchError('msgs 为空，无法重放')
  if (!manifest || typeof manifest !== 'object') throw new BenchError('manifest 缺失')

  const selected = selectDays(allMessages, opts.days)
  if (selected.messages.length === 0) throw new BenchError('选中的自然日内没有消息')
  const chatId = opts.chat
  const intervalMs = opts.intervalMin * 60_000
  const batchLimit = Math.max(1, Math.min(opts.every, opts.batchThreshold))
  const logger = quietLogger()
  const variantInfo = probeVariant()
  const requestedVariant = opts.variant
  const effectiveVariant = requestedVariant ?? variantInfo.detected
  const guardSupported = variantInfo.detected === 'guard'
  const warnings = []
  const stale = staleBuildWarning()
  if (stale !== null) warnings.push(stale)
  if (requestedVariant !== null && requestedVariant !== variantInfo.detected) {
    warnings.push(
      `强制 variant=${requestedVariant}，但探测结果为 ${variantInfo.detected}` +
        (requestedVariant === 'guard' && !guardSupported
          ? '（代码未导出 nextAttemptDelayMs / 无 distill-state.json，实际行为与 legacy 相同）'
          : requestedVariant === 'legacy' && guardSupported
            ? '（代码已带退避保护，无法在本进程关闭；输出标签仅用于对比）'
            : ''),
    )
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
  const groupStore = new GroupStoreService(tempDir, logger)
  const store = new Store(tempDir, logger)
  let distiller = null
  let reportService = null
  try {
    // ① 灌库：合成流 → 真实 GroupStore（临时目录）
    const storable = selected.messages.map((m, i) => {
      const kind = MESSAGE_KINDS.includes(m.kind) ? m.kind : 'text'
      let quoteOfMsgId = null
      if (typeof m.quoteOf === 'string') quoteOfMsgId = m.quoteOf
      else if (typeof m.quoteOf === 'number' && Number.isInteger(m.quoteOf)) {
        const idx = m.quoteOf >= 0 && m.quoteOf < selected.messages.length ? m.quoteOf : m.quoteOf - 1
        if (idx >= 0 && idx < selected.messages.length) quoteOfMsgId = `synth-${String(idx + 1).padStart(4, '0')}`
      }
      return {
        msgId: `synth-${String(i + 1).padStart(4, '0')}`,
        ts: m.ts,
        senderPid: `synth-user-${(i % 7) + 1}`,
        senderName: m.sender,
        kind,
        text: m.text,
        quoteOfMsgId,
      }
    })
    const inserted = await groupStore.appendMessages(chatId, storable)
    if (inserted !== storable.length) {
      warnings.push(`入库条数 ${inserted} ≠ 合成流条数 ${storable.length}（可能有重复 msgId/ts）`)
    }

    // ② 提炼器重放
    let clock = selected.messages[0].ts
    const buffer = new BufferPool({ bufferSize: opts.bufferSize })
    const personas = new PersonaService({ stateDir: tempDir, logger })
    const distillLlm = createFaultLlm({
      script: buildFaultScript({ fail: opts.fail, badJson: opts.badJson, text: successText }),
      seed: opts.seed,
    })
    const distillRecorder = new LlmCallRecorder(store, () => clock, {
      model: distillLlm.modelId(),
      pricing: DEFAULT_LLM_PRICING,
      logger,
    })
    distiller = new Distiller({
      buffer,
      llm: distillLlm,
      personas,
      groupPersonas: {},
      logger,
      distillEveryMessages: opts.every,
      distillIntervalMin: opts.intervalMin,
      batchThreshold: opts.batchThreshold,
      readSafeBatch: () => null,
      llmCallRecorder: distillRecorder,
      // 供 guard 变体持久化 distill-state.json（legacy 忽略该选项）
      store,
      onInsights: () => {},
      now: () => clock,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    })

    const msgIdOf = new Map()
    selected.messages.forEach((m, i) => msgIdOf.set(m, `synth-${String(i + 1).padStart(4, '0')}`))
    // 保真要点（对齐生产语义）：buffer 是最近 N 条的环，只随消息流入更新、提炼不清空——
    // 因此每轮快照 = 整个 buffer，切批数 = ceil(buffer/batchLimit)。这正是风暴的量级来源。
    const ring = []
    let counter = 0 // 镜像 Distiller 内部计数器：仅提炼成功时清零（失败保留 → 后续每条消息再触发）
    let lastSuccessAt = 0
    let attempts = 0
    let attemptsOk = 0
    let attemptsFailed = 0
    let batchAttempts = 0

    const attempt = async (reason) => {
      if (ring.length === 0) return false
      attempts++
      batchAttempts += Math.ceil(ring.length / batchLimit)
      const ok = await distiller.tryDistill(chatId, reason)
      if (ok) {
        attemptsOk++
        counter = 0
        lastSuccessAt = clock
      } else {
        attemptsFailed++
      }
      return ok
    }

    const feed = (snap) => {
      ring.push(snap)
      if (ring.length > opts.bufferSize) ring.shift()
      buffer.push(chatId, snap)
      counter++
    }

    let tickCursor = selected.messages[0].ts
    const advanceTicks = async (toTs) => {
      while (tickCursor + intervalMs <= toTs) {
        tickCursor += intervalMs
        clock = tickCursor
        // 复刻真实 tick 的时间闸门：距上次成功不足 interval 不触发
        if (clock - lastSuccessAt >= intervalMs) await attempt('interval')
      }
    }

    // ③ 报告重放（reportEnabled mock store：真实 ReportService + 临时 Store）
    const reportLlm = createFaultLlm({
      script: buildFaultScript({ fail: opts.fail, badJson: opts.badJson, text: successText }),
      seed: (opts.seed ^ 0x5bd1e995) >>> 0,
    })
    reportService = new ReportService({
      groupStore,
      store,
      stateDir: tempDir,
      llm: reportLlm,
      logger,
      enabled: true,
      batchThreshold: opts.batchThreshold,
      adaptiveBatch: false,
      reportPipeline: 'map-reduce',
      schemaTwoStage: false,
      llmPricing: DEFAULT_LLM_PRICING,
      groups: [chatId],
      sleep: async () => {},
      now: () => clock,
    })

    const perDay = []
    const i5Problems = []
    const i4Problems = []
    const reportStatuses = []
    let i5Checked = 0
    let reportBatches = 0

    for (const dayKey of selected.dayKeys) {
      const dayStart = localDayStart(dayKey)
      const dayEnd = dayStart + DAY_MS - 1
      const dayMessages = selected.messages.filter((m) => localDayKey(m.ts) === dayKey)
      const beforeDistill = distillLlm.stats()
      const beforeAttempts = attempts
      const beforeAttemptsFailed = attemptsFailed

      for (const m of dayMessages) {
        await advanceTicks(m.ts)
        clock = m.ts
        feed({ ts: m.ts, sender: m.sender, text: JSON.stringify(m.text), messageId: msgIdOf.get(m) })
        if (counter >= opts.every) await attempt('message-threshold')
      }
      await advanceTicks(dayEnd)
      const afterDistill = distillLlm.stats()

      // —— 当日日报（窗口 = 前日 20:20 → 当日 23:59:59.999，与调度口径一致）——
      clock = dayEnd
      const beforeReport = reportLlm.stats()
      let result = null
      let thrown = null
      try {
        result = await reportService.generateReport(chatId, 'daily', dayEnd)
      } catch (error) {
        thrown = String(error)
      }
      const afterReport = reportLlm.stats()
      const status = result?.status ?? (thrown !== null ? 'threw' : 'missing')
      reportStatuses.push({ day: dayKey, status, messageCount: result?.messageCount ?? null, path: result?.path ?? null })
      if (thrown !== null) i4Problems.push(`${dayKey}: 抛错 ${thrown}`)
      else if (!['ok', 'degraded'].includes(status) && !(status === 'empty' && (result?.messageCount ?? 0) === 0)) {
        i4Problems.push(`${dayKey}: 状态 ${status}（期望 ok|degraded）`)
      }
      if (result !== null && result.path === null) i4Problems.push(`${dayKey}: 报告未落盘（path=null）`)

      // 报告批数（meta.batch_stats）
      let dayBatches = 0
      try {
        const meta = groupStore.getReportMetas(chatId, { kind: 'daily', limit: 1000 }).find((m) => m.date === dayKey)
        dayBatches = meta?.batchStats?.batches ?? 0
      } catch {
        dayBatches = 0
      }
      reportBatches += dayBatches

      // I5：evidence/quotes 序号 → msg_id 必须落在当天报告窗口
      const win = reportWindow('daily', dayEnd)
      const windowIds = new Set(
        groupStore.getMessages(chatId, { afterTs: win.start - 1, beforeTs: win.end, limit: 5000 }).map((m) => m.msgId),
      )
      const md = result?.path ? store.readText(result.path) : null
      if (md === null) {
        i5Problems.push(`${dayKey}: 报告文件不可读`)
      } else {
        const parsed = parseReportMd(md)
        const ids = [...new Set([...parsed.judgments.flatMap((j) => j.evidence), ...parsed.quotes.map((q) => q.msgId)])]
        i5Checked += ids.length
        const outside = ids.filter((id) => !windowIds.has(id))
        for (const id of outside) i5Problems.push(`${dayKey}: 序号映射越出窗口 ${id}`)
      }

      const dDistill = delta(beforeDistill, afterDistill)
      const dReport = delta(beforeReport, afterReport)
      perDay.push({
        date: dayKey,
        messages: dayMessages.length,
        distillCalls: dDistill.calls,
        distillCostCny: round(dDistill.estimatedCostCny, 6),
        distillAttempts: attempts - beforeAttempts,
        distillAttemptsFailed: attemptsFailed - beforeAttemptsFailed,
        reportCalls: dReport.calls,
        reportCostCny: round(dReport.estimatedCostCny, 6),
        costCny: round(dDistill.estimatedCostCny + dReport.estimatedCostCny, 6),
        reportStatus: status,
        reportBatches: dayBatches,
        failures: dDistill.failCalls + dReport.failCalls,
        badJson: dDistill.badJsonCalls + dReport.badJsonCalls,
      })
    }

    // ④ 汇总
    const distillStats = distillLlm.stats()
    const reportStats = reportLlm.stats()
    const calls = distillStats.calls + reportStats.calls
    const failCalls = distillStats.failCalls + reportStats.failCalls
    const badJsonCalls = distillStats.badJsonCalls + reportStats.badJsonCalls
    const costCny = round(distillStats.estimatedCostCny + reportStats.estimatedCostCny, 6)
    const failRate = calls === 0 ? 0 : failCalls / calls
    const failByKind = {}
    mergeFailByKind(failByKind, distillStats.failByKind)
    mergeFailByKind(failByKind, reportStats.failByKind)
    const theoreticalMinCalls = Math.ceil(selected.messages.length / batchLimit)
    const retryAmplification = theoreticalMinCalls === 0 ? null : round(distillStats.calls / theoreticalMinCalls, 3)
    const maxDayCost = perDay.reduce((max, d) => Math.max(max, d.costCny), 0)
    const maxDayKey = perDay.find((d) => d.costCny === maxDayCost)?.date ?? '-'

    // I1（失败率按提炼阶段口径——报告调用不改变提炼批数的上界）
    const distillFailRate = distillStats.calls === 0 ? 0 : distillStats.failCalls / distillStats.calls
    const i1Bound = theoreticalMinCalls * (1 + 2 * distillFailRate * 4)
    const I1 = {
      pass: distillStats.calls <= i1Bound + 1e-9,
      detail: `提炼调用 ${distillStats.calls} ≤ 上界 ${round(i1Bound, 2)}（理论最少 ${theoreticalMinCalls}，提炼失败率 ${(distillFailRate * 100).toFixed(1)}%，批上限 ${batchLimit}）`,
    }
    // I2
    const I2 = {
      pass: maxDayCost <= COST_BUDGET_CNY + 1e-9,
      detail: `单日最高成本 ¥${maxDayCost.toFixed(4)} ≤ ¥${COST_BUDGET_CNY}（${maxDayKey}）`,
    }
    // I3
    const I3 = {
      pass: retryAmplification !== null && retryAmplification <= RETRY_AMPLIFICATION_MAX + 1e-9,
      detail: `重试放大 ${retryAmplification === null ? 'n/a' : `${retryAmplification.toFixed(2)}x`} ≤ ${RETRY_AMPLIFICATION_MAX.toFixed(1)}x（提炼 ${distillStats.calls} / 理论最少 ${theoreticalMinCalls}，注入失败率 ${(opts.fail * 100).toFixed(0)}%）`,
    }
    // I4
    const I4 = {
      pass: i4Problems.length === 0,
      detail: i4Problems.length === 0
        ? `${perDay.length} 天报告均产出（${reportStatuses.map((s) => `${s.day}=${s.status}`).join(', ')}）`
        : i4Problems.join('；'),
    }
    // I5
    const I5 = {
      pass: i5Problems.length === 0,
      detail: i5Problems.length === 0
        ? `校验 ${i5Checked} 个序号，全部落在报告窗口内`
        : i5Problems.join('；'),
    }
    const invariants = { I1, I2, I3, I4, I5 }

    // 观测层交叉校验：llm-calls.jsonl 的条数/费用应等于重放计数
    let observed = null
    try {
      const jsonl = readFileSync(join(tempDir, 'groups', chatId, 'llm-calls.jsonl'), 'utf8')
      let obsCalls = 0
      let obsCost = 0
      let obsIn = 0
      let obsOut = 0
      for (const line of jsonl.split('\n')) {
        if (line.trim() === '') continue
        const entry = JSON.parse(line)
        if (entry?.ev !== 'llm_call') continue
        obsCalls++
        obsCost += Number(entry.costCny) || 0
        obsIn += Number(entry.inTokens) || 0
        obsOut += Number(entry.outTokens) || 0
      }
      observed = {
        calls: obsCalls,
        costCny: round(obsCost, 6),
        inTokens: obsIn,
        outTokens: obsOut,
        callsMatch: obsCalls === calls,
        costDelta: round(obsCost - costCny, 6),
      }
    } catch {
      observed = null
    }

    const stateFileWritten = existsSync(join(tempDir, 'groups', chatId, 'distill-state.json'))
    const allPass = Object.values(invariants).every((inv) => inv.pass)

    return {
      days: selected.dayKeys.length,
      messages: selected.messages.length,
      calls,
      costCny,
      failRate: round(failRate, 4),
      retryAmplification,
      invariants,
      allPass,
      meta: {
        seed: opts.seed,
        failInjected: opts.fail,
        badJsonInjected: opts.badJson,
        requestedDays: selected.requestedDays,
        every: opts.every,
        intervalMin: opts.intervalMin,
        batchThreshold: opts.batchThreshold,
        batchLimit,
        bufferSize: opts.bufferSize,
        chat: chatId,
        source,
        targetScale: '585 规模画像：约 300 条消息/日',
      },
      variant: {
        requested: requestedVariant,
        detected: variantInfo.detected,
        effective: effectiveVariant,
        guardSupported,
        stateFileWritten,
        evidence: variantInfo.evidence,
        warnings,
      },
      distill: {
        calls: distillStats.calls,
        okCalls: distillStats.okCalls,
        failCalls: distillStats.failCalls,
        costCny: round(distillStats.estimatedCostCny, 6),
        inTokens: distillStats.estimatedInTokens,
        outTokens: distillStats.estimatedOutTokens,
        attempts,
        attemptsOk,
        attemptsFailed,
        theoreticalMinCalls,
        batchAttempts,
        batches: batchAttempts,
        failByKind: distillStats.failByKind,
        badJsonCalls: distillStats.badJsonCalls,
      },
      report: {
        calls: reportStats.calls,
        failCalls: reportStats.failCalls,
        costCny: round(reportStats.estimatedCostCny, 6),
        batches: reportBatches,
        statuses: reportStatuses.map((s) => s.status),
        degraded: reportStatuses.filter((s) => s.status === 'degraded').map((s) => s.day),
        byDay: reportStatuses,
      },
      failByKind,
      badJsonCalls,
      perDay,
      maxDayCostCny: round(maxDayCost, 6),
      observed,
      warnings: logger.warnings.slice(0, 50),
      warningCount: logger.warnings.length,
    }
  } finally {
    try {
      distiller?.dispose()
    } catch {
      /* 清理失败不掩盖主结果 */
    }
    try {
      reportService?.dispose()
    } catch {
      /* 同上 */
    }
    try {
      groupStore.dispose()
    } catch {
      /* 同上 */
    }
    rmSync(tempDir, { recursive: true, force: true })
  }
}

// —————————————————— 输出 ——————————————————

function verdict(pass) {
  return pass ? 'PASS' : 'FAIL'
}

/** 终端显示宽度（CJK 宽字符按 2 列计） */
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  }
  return width
}

function padCell(text, width, align = 'left') {
  const pad = ' '.repeat(Math.max(0, width - displayWidth(text)))
  return align === 'left' ? text + pad : pad + text
}

function printHuman(result) {
  const m = result.meta
  console.log('合成基准重放（零网络 / 零真实数据）')
  console.log(
    `规模: ${result.days} 天 · ${result.messages} 条（每 ${m.every} 条触发 + 每 ${m.intervalMin} 分钟 tick）` +
      ` · seed=${m.seed} · 注入失败 ${(m.failInjected * 100).toFixed(0)}%` +
      (m.badJsonInjected > 0 ? ` / 非法 JSON ${(m.badJsonInjected * 100).toFixed(0)}%` : ''),
  )
  console.log(
    `变体: requested=${result.variant.requested ?? 'auto'} detected=${result.variant.detected} effective=${result.variant.effective}` +
      ` · guard 状态文件=${result.variant.stateFileWritten ? '已写' : '未写'}`,
  )
  for (const w of result.variant.warnings) console.log(`  ⚠ ${w}`)
  console.log('')
  const header = ['日期', '消息', '提炼调用', '提炼费用', '报告调用', '报告状态', '报告批数']
  const rows = result.perDay.map((d) => [
    d.date,
    String(d.messages),
    String(d.distillCalls),
    `¥${d.distillCostCny.toFixed(4)}`,
    String(d.reportCalls),
    d.reportStatus,
    String(d.reportBatches),
  ])
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i]))))
  const fmt = (row) => row.map((c, i) => padCell(c, widths[i], i === 0 ? 'left' : 'right')).join('  ')
  console.log(fmt(header))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const row of rows) console.log(fmt(row))
  console.log(
    fmt([
      '合计',
      String(result.messages),
      String(result.distill.calls),
      `¥${result.distill.costCny.toFixed(4)}`,
      String(result.report.calls),
      result.report.degraded.length > 0 ? `degraded ${result.report.degraded.length}` : 'ok',
      String(result.report.batches),
    ]),
  )
  console.log('')
  console.log(
    `汇总: 调用 ${result.calls} 次（失败 ${result.distill.failCalls + result.report.failCalls}，失败率 ${(result.failRate * 100).toFixed(1)}%）` +
      ` · 总费用 ¥${result.costCny.toFixed(4)} · 单日最高 ¥${result.maxDayCostCny.toFixed(4)}` +
      ` · 重试放大 ${result.retryAmplification === null ? 'n/a' : `${result.retryAmplification.toFixed(2)}x`}`,
  )
  console.log(
    `故障分布: ${Object.entries(result.failByKind).map(([k, v]) => `${k} ${v}`).join(' · ')}` +
      (result.badJsonCalls > 0 ? ` · 非法 JSON ${result.badJsonCalls}` : ''),
  )
  console.log(
    `提炼: 尝试 ${result.distill.attempts} 次（成功 ${result.distill.attemptsOk} / 失败 ${result.distill.attemptsFailed}）` +
      ` · 理论最少调用 ${result.distill.theoreticalMinCalls}（批上限 ${m.batchLimit}）`,
  )
  if (result.observed !== null) {
    console.log(
      `观测层交叉校验: llm-calls.jsonl ${result.observed.calls} 次 / ¥${result.observed.costCny.toFixed(6)}` +
        `（与重放计数 ${result.observed.callsMatch ? '一致' : '不一致'}，费用差 ${result.observed.costDelta}）`,
    )
  }
  console.log('')
  console.log('不变量判定')
  for (const [id, inv] of Object.entries(result.invariants)) {
    console.log(`  ${id} ${verdict(inv.pass)}  ${inv.detail}`)
  }
  console.log('')
  console.log(`总判定: ${result.allPass ? 'PASS（全部不变量通过）' : 'FAIL（见上表）'}`)
}

// —————————————————— 入口 ——————————————————

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    console.error(String(error.message))
    console.error(HELP)
    return 2
  }
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  let fixture
  try {
    if (opts.synth) {
      if (opts.stream !== null || opts.manifest !== null) {
        throw new BenchError('--synth 与 --stream/--manifest 不能同时使用（选一个数据来源）')
      }
      fixture = buildSynthFixture({ days: opts.days ?? 3, seed: opts.seed })
    } else {
      if (opts.stream === null || opts.manifest === null) {
        throw new BenchError('缺少 --stream 或 --manifest（也可用 --synth 使用内置最小合成器）\n  ' + HELP.split('\n')[1])
      }
      fixture = {
        messages: loadStream(opts.stream),
        manifest: loadManifest(opts.manifest),
        source: { stream: opts.stream, manifest: opts.manifest, synth: false },
      }
    }
    const result = await runBench({ ...opts, ...fixture })
    if (opts.json) console.log(JSON.stringify(result, null, 2))
    else printHuman(result)
    const allPass = Object.values(result.invariants).every((inv) => inv.pass)
    return opts.strict && !allPass ? 1 : 0
  } catch (error) {
    if (error instanceof BenchError) {
      console.error(`基准输入错误: ${error.message}`)
      return error.exitCode
    }
    console.error(`基准执行失败: ${error?.stack ?? error}`)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entry !== null && import.meta.url === entry) {
  process.exitCode = await main(process.argv.slice(2))
}
