#!/usr/bin/env node
// synth-profile.mjs —— 合成基准输入侧 L1：把本地群聊数据压成「纯数字代理画像」。
//
// 设计要点（见 docs 中的合成基准方法论）：
// - 真实数据只在本地进程里停留一瞬间，只输出聚合统计：日消息量分位、24 小时曲线、
//   间隔对数分桶、文本长度分位、消息类型占比、参与者数/头部占比、连续同发送者率；
// - 输出的 JSON 里**没有**任何原文、昵称、wxid、群 ID、msgId，也**不保留**任何真实
//   ts（只保留「相对天/小时/间隔」的分布）；
// - 同一种子 + 同一份 jsonl/库 → 输出确定（generatedAt 除外，它是生成时刻）。
//
// 用法：
//   node scripts/synth-profile.mjs --demo [--out profile.json]
//   node scripts/synth-profile.mjs --jsonl <file> [--seed 42] [--out profile.json]
//   node scripts/synth-profile.mjs [--db <store.db>] [--out profile.json]
//
// 离线兜底：本地库不可读（加密/表结构不识别/文件不存在）时用 --demo。
// 代码里不出现任何真实值；默认库路径用 $HOME 计算。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export const PROFILE_VERSION = 1
export const GAP_BUCKETS = [1000, 10_000, 600_000, 1e15]

// 默认画像：字段与量纲即本项目的画像 schema。--demo 原样输出，
// 生成器在离线环境（无本地库）也能重放成本/结构策略。
export const DEMO_PROFILE = Object.freeze({
  version: PROFILE_VERSION,
  seed: 42,
  source: 'local-profile',
  generatedAt: '2026-10-21T00:00:00Z',
  days: 3,
  msgsPerDay: { mean: 181, p50: 170, p95: 320 },
  hourlyCurve: [0, 0, 0, 0, 0, 0, 0, 1, 4, 9, 15, 12, 10, 18, 26, 22, 14, 18, 20, 12, 6, 3, 1, 1],
  gapMsLogBuckets: [
    { max: 1000, p: 0.3 },
    { max: 10_000, p: 0.45 },
    { max: 600_000, p: 0.2 },
    { max: 1e15, p: 0.05 },
  ],
  textLen: { zipfAlpha: 1.4, maxChars: 400, p95: 120 },
  ratios: { image: 0.05, file: 0.01, voice: 0.01, system: 0.01, quote: 0.08 },
  participants: { count: 12, topShare: 0.35 },
  selfReplyRate: 0.18,
})

/** 默认本地库位置：$HOME/.dsh/dsh-group-lurker/store.db（不写死家目录） */
export function defaultDbPath() {
  return join(homedir(), '.dsh', 'dsh-group-lurker', 'store.db')
}

const round = (x, digits = 4) => {
  if (!Number.isFinite(x)) return 0
  const f = 10 ** digits
  return Math.round(x * f) / f
}
const round2 = (x) => round(x, 2)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

/** 最近秩分位（与 numpy 的 'higher' 口径一致；空数组返回 0） */
function quantile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = clamp(Math.ceil(p * sorted.length) - 1, 0, sorted.length - 1)
  return sorted[idx]
}

/** 从现在起算的 ISO 时间戳（去掉毫秒，和画像 schema 的示例同形） */
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const KIND_BY_CODE = new Map([
  [1, 'text'],
  [3, 'image'],
  [34, 'voice'],
  [43, 'voice'],
  [47, 'image'],
  [49, 'file'],
  [10000, 'system'],
  [10002, 'system'],
])

/** 类型归一化：数值（库内 local_type）或字符串（jsonl kind）→ 五类之一 */
function normalizeKind(raw) {
  if (typeof raw === 'number') return KIND_BY_CODE.get(raw) ?? 'text'
  const s = String(raw ?? 'text').toLowerCase()
  if (/image|img|pic|emoji/.test(s)) return 'image'
  if (/voice|audio/.test(s)) return 'voice'
  if (/file|video|link|card/.test(s)) return 'file'
  if (/system|notice|tip/.test(s)) return 'system'
  return 'text'
}

/** 行归一化：只保留用于统计的字段；sender 仅用于计数，绝不进入产物 */
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null
  const rawTs = row.ts ?? row.time ?? row.timestamp ?? row.createTime ?? row.create_time
  let ts = typeof rawTs === 'number' ? rawTs : Number(rawTs)
  if (!Number.isFinite(ts)) return null
  // 秒级时间戳 → 毫秒（真实库常见 10 位）
  if (ts > 0 && ts < 1e12) ts *= 1000
  const sender = row.sender ?? row.from ?? row.user ?? row.talker ?? row.senderId ?? ''
  const text =
    typeof row.text === 'string'
      ? row.text
      : typeof row.content === 'string'
        ? row.content
        : Buffer.isBuffer(row.content)
          ? row.content.toString('utf8')
          : ''
  const kind = normalizeKind(row.kind ?? row.type)
  const quoted =
    (Number.isInteger(row.quoteOf) && row.quoteOf >= 0) ||
    row.quote === true ||
    row.quoted === true
  return { ts, sender: String(sender), text, kind, quoted }
}

/** 从 JSONL 文本解析行（`{ts,sender,text,kind}`，可带 quoteOf） */
export function readRowsFromJsonl(file) {
  const raw = readFileSync(file, 'utf8')
  const rows = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // 只报行号，不回显内容（内容可能敏感）
      throw new Error(`JSONL 第 ${i + 1} 行不是合法 JSON`)
    }
  }
  return rows
}

const TS_COL = /^(create_?time|createtime|timestamp|ts|msg_?time|send_?time|time)$/i
const SENDER_COL = /^(sender|sender_?id|from|from_?user|from_?user_?name|talker|talker_?id|real_?sender_?id|user|user_?name|wxid)$/i
const TEXT_COL = /^(content|text|msg|message|body|str_?content|display_?content|message_?content)$/i
const KIND_COL = /^(type|kind|msg_?type|local_?type|sub_?type)$/i

function pickCol(cols, re) {
  return cols.find((c) => re.test(c)) ?? null
}

/**
 * 从本地 SQLite 读行。表结构自行探测：优先选同时含「时间 + 发送者」列的表，
 * 有 content/type 列则一并取；读不到/加密库时抛错（由 CLI 提示改用 --demo）。
 * 注意：行内容只在内存里参与聚合，不打印、不落盘。
 */
export async function readRowsFromSqlite(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error('本地库文件不存在；可用 --jsonl 或 --demo')
  }
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error('当前 Node 不支持 node:sqlite（需 >= 22.5）；可用 --jsonl 或 --demo')
  }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    throw new Error('本地库无法以只读方式打开；可用 --jsonl 或 --demo')
  }

  try {
    let tables
    try {
      tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    } catch {
      throw new Error('本地库表结构不可读（可能是加密库）；可用 --jsonl 或 --demo')
    }

    const candidates = []
    for (const t of tables) {
      const name = String(t.name)
      let cols
      try {
        cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all()
      } catch {
        continue
      }
      const names = cols.map((c) => String(c.name))
      const tsCol = pickCol(names, TS_COL)
      const senderCol = pickCol(names, SENDER_COL)
      if (!tsCol || !senderCol) continue
      const textCol = pickCol(names, TEXT_COL)
      const kindCol = pickCol(names, KIND_COL)
      candidates.push({ name, tsCol, senderCol, textCol, kindCol, score: 2 + (textCol ? 1 : 0) + (kindCol ? 1 : 0) })
    }
    candidates.sort((a, b) => b.score - a.score)

    for (const c of candidates) {
      const esc = c.name.replace(/"/g, '""')
      const quoteId = (n) => `"${n.replace(/"/g, '""')}"`
      const textSel = c.textCol ? `${quoteId(c.textCol)} AS text` : "'' AS text"
      const kindSel = c.kindCol ? `${quoteId(c.kindCol)} AS kind` : "'text' AS kind"
      const sql = `SELECT ${quoteId(c.tsCol)} AS ts, ${quoteId(c.senderCol)} AS sender, ${textSel}, ${kindSel} FROM "${esc}" LIMIT 500000`
      let rows
      try {
        rows = db.prepare(sql).all()
      } catch {
        continue
      }
      if (rows.length > 0) return rows
    }
    throw new Error('本地库未找到可识别的消息表；可用 --jsonl 或 --demo')
  } finally {
    try {
      db.close()
    } catch {
      /* 关闭失败不影响结果 */
    }
  }
}

/**
 * 核心：从行数组提取代理画像（纯聚合，无原文/ID/真实 ts）。
 * @param {Array<object>} rows  `{ts,sender,text,kind[,quoteOf]}`
 * @param {{seed?: number, source?: string, generatedAt?: string}} [opts]
 */
export function extractProfile(rows, opts = {}) {
  if (!Array.isArray(rows)) throw new Error('rows 必须是数组')
  const norm = rows.map(normalizeRow).filter(Boolean)
  if (norm.length === 0) throw new Error('没有可用的消息行（需要 ts 字段）')

  norm.sort((a, b) => a.ts - b.ts || 0)

  const total = norm.length
  const source = opts.source ?? 'jsonl'
  const seed = Number.isFinite(opts.seed) ? Number(opts.seed) : 42
  const generatedAt = opts.generatedAt ?? nowIso()

  // —— 每日消息量 ——
  const perDay = new Map()
  for (const r of norm) {
    const day = Math.floor(r.ts / 86_400_000)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }
  const dayCounts = [...perDay.values()].sort((a, b) => a - b)
  const days = perDay.size
  const mean = round2(total / days)
  const p50 = quantile(dayCounts, 0.5)
  const p95 = quantile(dayCounts, 0.95)

  // —— 24 小时曲线（UTC，纯计数；不保留具体时间点）——
  const hourlyCurve = new Array(24).fill(0)
  for (const r of norm) hourlyCurve[new Date(r.ts).getUTCHours()]++

  // —— 相邻间隔的对数分桶 ——
  const gapCounts = new Array(GAP_BUCKETS.length).fill(0)
  let gapTotal = 0
  for (let i = 1; i < norm.length; i++) {
    const gap = Math.max(0, norm[i].ts - norm[i - 1].ts)
    gapTotal++
    let hit = GAP_BUCKETS.length - 1
    for (let b = 0; b < GAP_BUCKETS.length; b++) {
      if (gap <= GAP_BUCKETS[b]) {
        hit = b
        break
      }
    }
    gapCounts[hit]++
  }
  const gapMsLogBuckets = GAP_BUCKETS.map((max, i) => ({
    max,
    p: gapTotal > 0 ? round(gapCounts[i] / gapTotal) : DEMO_PROFILE.gapMsLogBuckets[i].p,
  }))
  // 让概率和精确为 1（四舍五入误差塞给最后一桶）
  if (gapTotal > 0) {
    const head = gapMsLogBuckets.slice(0, -1).reduce((s, b) => s + b.p, 0)
    gapMsLogBuckets[gapMsLogBuckets.length - 1].p = round(1 - head)
  }

  // —— 文本长度 ——
  const textLens = norm
    .filter((r) => r.kind === 'text' && r.text.length > 0)
    .map((r) => r.text.length)
  const lens = textLens.length > 0 ? textLens : norm.filter((r) => r.text.length > 0).map((r) => r.text.length)
  let textLen = { ...DEMO_PROFILE.textLen }
  if (lens.length > 0) {
    lens.sort((a, b) => a - b)
    // 对数均值 → Zipf 指数近似（Hill 型估计，钳制到可采样区间）
    const meanLog = lens.reduce((s, l) => s + Math.log(Math.max(1, l)), 0) / lens.length
    const zipfAlpha = clamp(1 + 1 / Math.max(0.1, meanLog), 1.05, 3)
    textLen = {
      zipfAlpha: round2(zipfAlpha),
      maxChars: Math.max(1, lens[lens.length - 1]),
      p95: quantile(lens, 0.95),
    }
  }

  // —— 类型占比 ——
  const kindCounts = { text: 0, image: 0, file: 0, voice: 0, system: 0 }
  let quoted = 0
  for (const r of norm) {
    kindCounts[r.kind] = (kindCounts[r.kind] ?? 0) + 1
    if (r.quoted) quoted++
  }
  const ratios = {
    image: round(kindCounts.image / total),
    file: round(kindCounts.file / total),
    voice: round(kindCounts.voice / total),
    system: round(kindCounts.system / total),
    quote: round(quoted / total),
  }

  // —— 参与者（只数个数与头部占比，不留 ID）——
  const senderCount = new Map()
  for (const r of norm) {
    if (!r.sender) continue
    senderCount.set(r.sender, (senderCount.get(r.sender) ?? 0) + 1)
  }
  const participantCount = senderCount.size
  let topShare = 0
  if (participantCount > 0) {
    let top = 0
    for (const n of senderCount.values()) top = Math.max(top, n)
    topShare = round(top / total)
  }

  // —— 连续同一发送者率 ——
  let pairs = 0
  let same = 0
  for (let i = 1; i < norm.length; i++) {
    pairs++
    if (norm[i].sender === norm[i - 1].sender) same++
  }
  const selfReplyRate = pairs > 0 ? round(same / pairs) : 0

  return {
    version: PROFILE_VERSION,
    seed,
    source,
    generatedAt,
    days,
    msgsPerDay: { mean, p50, p95 },
    hourlyCurve,
    gapMsLogBuckets,
    textLen,
    ratios,
    participants: { count: Math.max(1, participantCount), topShare },
    selfReplyRate,
  }
}

function parseArgs(argv) {
  const args = [...argv]
  const flag = (name) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  return {
    demo: args.includes('--demo'),
    jsonl: flag('jsonl'),
    db: flag('db'),
    out: flag('out'),
    seed: flag('seed'),
  }
}

async function main(argv) {
  const { demo, jsonl, db, out, seed } = parseArgs(argv)
  let profile
  if (demo) {
    profile = DEMO_PROFILE
  } else if (jsonl) {
    let rows
    try {
      rows = readRowsFromJsonl(resolve(jsonl))
    } catch (err) {
      // 不回显路径（可能含家目录）
      throw new Error(err?.code ? '无法读取 --jsonl 文件' : err.message)
    }
    profile = extractProfile(rows, {
      source: 'jsonl',
      seed: seed === undefined ? 42 : Number(seed),
    })
  } else {
    const dbPath = db ? resolve(db) : defaultDbPath()
    const rows = await readRowsFromSqlite(dbPath)
    profile = extractProfile(rows, {
      source: 'sqlite',
      seed: seed === undefined ? 42 : Number(seed),
    })
  }

  const json = `${JSON.stringify(profile, null, 2)}\n`
  if (out) {
    const target = resolve(out)
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, json)
    } catch {
      throw new Error('无法写入 --out 文件')
    }
  } else {
    process.stdout.write(json)
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    // 只回显安全信息（字段名/提示），绝不回显行内容
    console.error(`❌ ${err instanceof Error ? err.message : '画像提取失败'}`)
    process.exitCode = 1
  })
}
