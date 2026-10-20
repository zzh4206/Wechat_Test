#!/usr/bin/env node
/**
 * migrate-v4-to-v5.mjs —— knowledge.db v4→v5 迁移 + 幂等自检（由 PM 代跑；备份惯例）。
 * openDb 自带幂等迁移（4→5 建报表/视图置 5；5 跳过；0 全新建；<4 / >5 拒开）。
 * 本脚本职责：① 备份 <db> → <db>.bak-v4；② 打开触发迁移；③ 自检 user_version=5、
 *   report_revision/marking 表与两视图存在、既有数据零变化（report/entry 行数迁移前后一致）。
 * 用法：node scripts/migrate-v4-to-v5.mjs --db <knowledge.db> [--no-backup]
 */
import { copyFileSync, existsSync } from 'node:fs'
import { openDb } from '../lib/db/db.js'
import { KnowledgeDao } from '../lib/db/dao.js'
import { defaultDbPath } from '../lib/db/mirror.js'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--db') args.db = process.argv[++i]
  else if (process.argv[i] === '--no-backup') args.noBackup = true
}
args.db = args.db ?? defaultDbPath()
if (!existsSync(args.db)) {
  console.error(`db 不存在：${args.db}`)
  process.exit(2)
}
if (!args.noBackup) {
  const bak = `${args.db}.bak-v4`
  copyFileSync(args.db, bak)
  console.log(`已备份：${bak}`)
}
const before = (() => {
  const dao0 = new KnowledgeDao(openDb(args.db, { logger: { warn() {}, error() {} } }), { warn() {}, error() {} })
  const counts = { report: dao0.count('report'), entry: dao0.count('entry'), media: dao0.count('media') }
  dao0.close()
  return counts
})()
const logger = { warn: (m) => console.warn(`[warn] ${m}`), error: (m) => console.error(`[error] ${m}`), debug: () => {} }
const db = openDb(args.db, { logger })
if (!db) {
  console.error('打开失败（迁移被拒：user_version <4 或 >5）')
  process.exit(1)
}
const uv = Number(db.prepare('PRAGMA user_version').get().user_version)
const dao = new KnowledgeDao(db, logger)
const has = (name, type = 'table') => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' AND name = ?`).get(name)
const ok =
  uv === 5 &&
  has('report_revision') && has('marking') &&
  has('v_marking_latest', 'view') && has('v_report_revised', 'view')
const after = { report: dao.count('report'), entry: dao.count('entry'), media: dao.count('media') }
console.log(`user_version=${uv}（期望 5）`)
console.log(`report_revision=${has('report_revision')} marking=${has('marking')} v_marking_latest=${has('v_marking_latest', 'view')} v_report_revised=${has('v_report_revised', 'view')}`)
console.log(`既有数据零变化：report ${before.report}→${after.report} entry ${before.entry}→${after.entry} media ${before.media}→${after.media}`)
dao.close()
if (!ok || JSON.stringify(before) !== JSON.stringify(after)) {
  console.error('自检未通过')
  process.exit(1)
}
console.log('自检通过（幂等：可重复运行，第二遍应全部一致）')
