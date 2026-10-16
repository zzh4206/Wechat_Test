#!/usr/bin/env node
// llm-cost.mjs —— LLM 费用汇总（T9 增强：内置聚合视图，替代手写 jq）。
//
// 用法：
//   node scripts/llm-cost.mjs [--state <stateDir>] [--month 2026-10] [--day 2026-10-16] [--chat <chatId>]
//   不带参数 = 默认 stateDir（~/.dsh/dsh-group-lurker）+ 当前自然月。
//
// 数据源：groups/<chatId>/llm-calls.jsonl（T3/T9 观测层产出）。
// 输出：每群 × 每日 的调用数 / 输入输出 token / 费用表 + 合计行。
//
// 口径说明（诚实披露，与 RUNBOOK §7.11 一致）：
// - token 为估算（字符÷1.6）或宿主 usage，逐行带 tokensEst 标记；汇总不区分混合来源；
// - 费用按"未命中缓存输入价"计（宿主不回传统计量）——实际账单在命中 prompt cache 时
//   会低于本表（缓存价约为输入价 1/4），即本表为保守上界，适合预算监控；
// - 未知模型（费用 0）在末尾提示行数。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const stateDir = resolve(flag('state') ?? join(homedir(), '.dsh', 'dsh-group-lurker'))
const now = new Date()
const month = flag('month') ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
const day = flag('day')
const chatFilter = flag('chat')

const groupsDir = join(stateDir, 'groups')
if (!existsSync(groupsDir)) {
  console.error(`未找到 ${groupsDir}（--state 指定 stateDir）`)
  process.exit(1)
}

/** epoch ms → 本地时区 YYYY-MM-DD（与报告窗口的本地时区口径一致） */
const localDay = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const rows = [] // {chat, day, calls, inTok, outTok, cost, unknownModel}
let unknownModelRows = 0
let parseSkipped = 0

for (const chat of readdirSync(groupsDir)) {
  if (chatFilter && chat !== chatFilter) continue
  const rel = join(groupsDir, chat, 'llm-calls.jsonl')
  if (!existsSync(rel)) continue
  const byDay = new Map()
  for (const line of readFileSync(rel, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    let e
    try { e = JSON.parse(t) } catch { parseSkipped++; continue }
    if (e?.ev !== 'llm_call' || typeof e.ts !== 'number') continue
    const d = localDay(e.ts)
    if (day ? d !== day : !d.startsWith(month)) continue
    const cur = byDay.get(d) ?? { calls: 0, inTok: 0, outTok: 0, cost: 0 }
    cur.calls++
    cur.inTok += e.inTokens ?? 0
    cur.outTok += e.outTokens ?? 0
    cur.cost += e.costCny ?? 0
    byDay.set(d, cur)
    if (e.costCny === 0 && (!e.model || e.model === 'unknown')) unknownModelRows++
  }
  for (const [d, v] of [...byDay.entries()].sort()) rows.push({ chat, day: d, ...v })
}

if (rows.length === 0) {
  console.log(`（${stateDir} 在 ${day ?? month} 无 llm_call 记录）`)
  process.exit(0)
}

const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const w = [34, 12, 7, 10, 10, 10]
const pad = (s, i) => String(s).padEnd(w[i])
console.log(`stateDir ${stateDir} · ${day ?? month}${chatFilter ? ` · chat ${chatFilter}` : ''}`)
console.log([pad('chat', 0), pad('day', 1), pad('calls', 2), pad('in tok', 3), pad('out tok', 4), pad('cost ¥', 5)].join(''))
let tc = 0, ti = 0, to = 0, tcost = 0
for (const r of rows) {
  console.log([pad(r.chat, 0), pad(r.day, 1), pad(r.calls, 2), pad(fmtTok(r.inTok), 3), pad(fmtTok(r.outTok), 4), r.cost.toFixed(4)].join(''))
  tc += r.calls; ti += r.inTok; to += r.outTok; tcost += r.cost
}
console.log([pad('合计', 0), pad(day ?? month, 1), pad(tc, 2), pad(fmtTok(ti), 3), pad(fmtTok(to), 4), tcost.toFixed(4)].join(''))
console.log(`（口径：token 估算（÷1.6 汉字）+ 宿主 usage 混合；费用按未命中缓存价计=保守上界，实际命中 prompt cache 时更低${unknownModelRows ? `；${unknownModelRows} 行未知模型费用 0` : ''}${parseSkipped ? `；跳过 ${parseSkipped} 行损坏记录` : ''}）`)
