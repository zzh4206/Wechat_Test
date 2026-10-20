#!/usr/bin/env node
/**
 * migrate-summary-to-aggregate.mjs —— P1 口径统一一次性迁移（幂等，由 PM 代跑）。
 *
 * 背景：summary 聚合报告 chat_id 口径分裂——镜像/导入器新通道写 'aggregate'（裁定口径），
 * 旧 v0.4 导入器按目录名写 'summary'（伪会话口径废止）。本脚本把 'summary' 行统一为
 * 'aggregate'，迁移后 'summary' 行数必须为 0。
 *
 * 规则（冲突以文件内容为准 upsert 合并）：
 *   对每行 chat_id='summary'：
 *   ① 无同键 (period_type, period_start) 'aggregate' 行 → UPDATE chat_id='aggregate'；
 *   ② 有同键 'aggregate' 行且 content_md 一致 → DELETE 'summary' 行；
 *   ③ 有同键 'aggregate' 行但内容不同 → 以文件 reports/summary/<period_start>.md 内容为准
 *      upsert 'aggregate' 行（--state-dir 提供文件；缺文件保留库内容），DELETE 'summary' 行。
 *
 * 用法：
 *   node scripts/migrate-summary-to-aggregate.mjs --db <knowledge.db> [--state-dir <stateDir>] [--backup]
 *   --backup  迁移前复制 <db> → <db>.bak-summary（默认开启；--no-backup 关闭）
 *
 * 幂等：重复运行第二遍应报 summary=0、改动 0。
 */
import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { openDb } from '../lib/db/db.js'
import { KnowledgeDao } from '../lib/db/dao.js'
import { defaultDbPath } from '../lib/db/mirror.js'

function parseArgs(argv) {
  const out = { db: defaultDbPath(), stateDir: null, backup: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') out.db = argv[++i]
    else if (argv[i] === '--state-dir') out.stateDir = argv[++i]
    else if (argv[i] === '--no-backup') out.backup = false
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!existsSync(args.db)) {
  console.error(`db 不存在：${args.db}`)
  process.exit(2)
}

if (args.backup) {
  const bak = `${args.db}.bak-summary`
  copyFileSync(args.db, bak)
  console.log(`已备份：${bak}`)
}

const logger = { warn: (m) => console.warn(`[warn] ${m}`), debug: () => {}, error: (m) => console.error(`[error] ${m}`) }
const db = openDb(args.db, { logger })
const dao = new KnowledgeDao(db, logger)

const rows = db
  .prepare(`SELECT id, period_type, period_start, period_end, chat_id, title, content_md FROM report WHERE chat_id = 'summary' ORDER BY period_start`)
  .all()

console.log(`发现 'summary' 行：${rows.length}`)
let migrated = 0
let deduped = 0
let merged = 0

for (const row of rows) {
  const dup = db
    .prepare(`SELECT id, content_md FROM report WHERE chat_id = 'aggregate' AND period_type = ? AND period_start = ?`)
    .get(row.period_type, row.period_start)

  if (!dup) {
    db.prepare(`UPDATE report SET chat_id = 'aggregate' WHERE id = ?`).run(row.id)
    migrated += 1
    continue
  }
  if (dup.content_md === row.content_md) {
    db.prepare(`DELETE FROM report WHERE id = ?`).run(row.id)
    deduped += 1
    continue
  }
  // 冲突：以文件内容为准 upsert（缺文件保留库内 aggregate 内容），删 summary 行
  let fileMd = null
  if (args.stateDir) {
    const f = join(args.stateDir, 'reports', 'summary', `${row.period_start}.md`)
    if (existsSync(f)) fileMd = readFileSync(f, 'utf8')
  }
  const content = fileMd ?? dup.content_md
  dao.upsertReport({
    periodType: row.period_type,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    title: row.title.replace('summary', 'aggregate'),
    contentMd: content,
    status: 'draft',
    chatId: 'aggregate',
    docIdsHint: null,
  })
  db.prepare(`DELETE FROM report WHERE id = ?`).run(row.id)
  merged += 1
}

const after = db.prepare(`SELECT COUNT(*) AS n FROM report WHERE chat_id = 'summary'`).get()
const aggAfter = db.prepare(`SELECT COUNT(*) AS n FROM report WHERE chat_id = 'aggregate'`).get()
console.log(`迁移完成：migrated=${migrated} deduped=${deduped} merged=${merged}`)
console.log(`迁移后：summary=${after.n}（必须为 0） aggregate=${aggAfter.n}`)
if (after.n !== 0) {
  console.error('迁移未达成 summary=0——请人工核查')
  process.exit(1)
}
void dirname
dao.close()
