#!/usr/bin/env node
/**
 * import-state-to-sqlite.mjs：把既有 state 目录一次性导入知识库 SQLite（可重复运行）。
 *
 * 用法：
 *   node scripts/import-state-to-sqlite.mjs --state-dir <stateDir> [--db <path>]
 *   --state-dir  插件状态目录（$DSH_HOME/dsh-group-lurker），只读，绝不回写
 *   --db         目标 SQLite 路径；缺省 <home>/WeChat/1数据/knowledge.db（gitignore 目录）
 *
 * 映射规则（与 src/db/mirror.ts 一致）：
 *   groups/<chatId>/insights.jsonl → chat_digest（topic/viewpoint/quote，source_key 内容 hash8 幂等）
 *                                    + entry（opportunity → kind='idea'）
 *   reports/<chatId>/YYYY-MM-DD.md → report(daily)；同一天多个群合并为一份（schema 唯一键
 *                                    (period_type, period_start) 冻结，正文按群分节拼接）
 *   其余文件（audit/cursor/outbox/llm-calls/...）不映射，计入「未映射」统计。
 * 报告/摘要幂等：先聚合再 upsert；doc 表本次 state 中没有对应资料来源，不硬造。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { openDb, normalizeText } from '../lib/db/db.js'
import { KnowledgeDao, contentHash, hash8 } from '../lib/db/dao.js'
import { defaultDbPath } from '../lib/db/mirror.js'

// ---- 参数解析（无外部依赖） ----
function parseArgs(argv) {
  const out = { stateDir: null, db: defaultDbPath() }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir') out.stateDir = argv[++i]
    else if (argv[i] === '--db') out.db = argv[++i]
  }
  if (!out.stateDir) {
    console.error('用法：node scripts/import-state-to-sqlite.mjs --state-dir <stateDir> [--db <path>]')
    process.exit(2)
  }
  return out
}

const logger = {
  warn: (m) => console.warn(`[warn] ${m}`),
  debug: () => {},
}

// ---- insight → digest/entry（与 mirror.ts 同一映射，幂等键同源） ----
function dayKeyOf(ts) {
  const ms = typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : NaN
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function importInsightLine(dao, line, stats) {
  stats.insightLines++
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    stats.unmappedInsight++
    return
  }
  const type = typeof entry.type === 'string' ? entry.type : ''
  const text =
    entry.summary ?? entry.text ?? entry.quote ?? entry.angle ?? // opportunity 正文在 angle
    (typeof entry.title === 'string' ? entry.title : '')
  if (!type || typeof text !== 'string' || !text) {
    stats.unmappedInsight++
    return
  }
  const title = typeof entry.title === 'string' ? entry.title : ''
  const topic = entry.topic || title
  const day = dayKeyOf(entry.ts)
  if (type === 'opportunity') {
    const ms = typeof entry.ts === 'number' ? entry.ts : typeof entry.ts === 'string' ? Date.parse(entry.ts) : Date.now()
    const ts = Number.isFinite(ms) ? ms : Date.now()
    // entry 无唯一键：按 (ts, kind, content_md) 查重保证重复运行幂等
    if (dao.findEntry(ts, 'idea', text) !== null) {
      stats.mappedInsight++
      return
    }
    if (dao.insertEntry({ ts, kind: 'idea', contentMd: text }) !== null) {
      stats.entries++
      stats.mappedInsight++
    } else stats.failedInsight++
    return
  }
  const sourceKey = `insight:${type}:${hash8(line)}`
  const id = dao.insertChatDigest({
    chatTopic: topic ? `${type}:${topic}` : type,
    digestMd: text,
    happenedOn: day,
    sourceKey,
    createdBy: '2水群-import',
  })
  if (id !== null) {
    stats.digests++
    stats.mappedInsight++
  } else stats.failedInsight++
}

// ---- 主流程 ----
const args = parseArgs(process.argv.slice(2))
const db = openDb(args.db, { logger })
if (!db) {
  console.error('打开 SQLite 失败，中止（不写任何数据）。')
  process.exit(1)
}
const dao = new KnowledgeDao(db, logger)

const stats = {
  insightLines: 0,
  mappedInsight: 0,
  unmappedInsight: 0,
  failedInsight: 0,
  digests: 0,
  entries: 0,
  reportFiles: 0,
  reportsMapped: 0,
  otherFiles: 0,
}

// reports/<x>/YYYY-MM-DD.md 聚合（同一天多群合并，正文分节）
const reportsByDay = new Map() // day -> Array<[chatId, md]>

for (const name of readdirSync(args.stateDir)) {
  const p = join(args.stateDir, name)
  if (!statSync(p).isDirectory()) continue

  if (name === 'groups') {
    for (const chatId of readdirSync(p)) {
      const gp = join(p, chatId)
      if (!statSync(gp).isDirectory()) continue
      const insights = join(gp, 'insights.jsonl')
      try {
        const text = readFileSync(insights, 'utf8')
        for (const line of normalizeText(text).split('\n')) {
          if (line) importInsightLine(dao, line, stats)
        }
      } catch {
        /* 无 insights.jsonl 的群目录，跳过 */
      }
    }
    continue
  }

  if (name === 'reports') {
    for (const sub of readdirSync(p)) {
      const rp = join(p, sub)
      if (!statSync(rp).isDirectory()) continue
      for (const f of readdirSync(rp)) {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue
        const day = basename(f, '.md')
        const md = readFileSync(join(rp, f), 'utf8')
        if (!reportsByDay.has(day)) reportsByDay.set(day, [])
        reportsByDay.get(day).push([sub, md])
        stats.reportFiles++
      }
    }
    continue
  }

  stats.otherFiles++
}

// 聚合后的报告统一 upsert（先聚合再写 → 重复运行天然幂等）
for (const [day, parts] of [...reportsByDay.entries()].sort()) {
  const merged = parts
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([chatId, md]) => `## ${chatId}\n\n${normalizeText(md)}`)
    .join('\n\n')
  const id = dao.upsertReport({
    periodType: 'daily',
    periodStart: day,
    periodEnd: day,
    title: `日报聚合 ${day}`,
    contentMd: merged,
    status: 'draft',
    docIdsHint: null,
  })
  if (id !== null) stats.reportsMapped++
}

const before = dao.count('report')
console.log('导入完成：')
console.log(`  db=${args.db}`)
console.log(`  insights 行 ${stats.insightLines}：映射 ${stats.mappedInsight}（digest ${stats.digests} + entry ${stats.entries}），未映射 ${stats.unmappedInsight}，写失败 ${stats.failedInsight}`)
console.log(`  日报文件 ${stats.reportFiles}：聚合为 report 行 ${stats.reportsMapped}`)
console.log(`  未映射的 state 子目录：${stats.otherFiles}`)
console.log(`  库内计数：doc=${dao.count('doc')} report=${before} entry=${dao.count('entry')} chat_digest=${dao.count('chat_digest')}`)
console.log(`  内容指纹示例（首条 digest 源键即 insight:<type>:<hash8>；doc.content_hash 归一化=去 BOM/CRLF→LF/strip 后 sha256）`)
dao.close()
// contentHash 导出仅供调用方核对归一化口径（本脚本不写 doc）
void contentHash
