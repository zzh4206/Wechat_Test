// 一次性热修脚本：存量秒级 ts 行 ×1000 统一毫秒口径。
//
// 背景：parseCreateTime 旧实现返回秒（CLI create_time 为字符串秒），mapRows 落库 ts 即秒级；
// 而下游全部窗口比较（reportWindow / person-digest 日窗 / reminder 到期 / task-recognition
// deadline）按 Date.now() 毫秒体系 → 秒级 ts 恒小于毫秒窗口起点 → 报告/摘要过滤不到任何消息。
//
// 代码修复（parseCreateTime 返回毫秒）只管新数据；存量行须本脚本 ×1000 回填。
// 覆盖所有毫秒语义的数值列（值域 0 < v < 1e12 才回填，幂等可重跑）：
//   messages.ts、reminder_log.fired_at、tasks.deadline、promises.deadline/fulfilled_ts、
//   files.last_seen_ts、events 及 identities 的时间列（按列名自动识别，防遗漏）。
//
// 用法：node scripts/hotfix-backfill-ts-ms.mjs [--db <store.db 路径>]
//   环境变量：LURKER_STATE_DIR（默认 ~/.dsh/dsh-group-lurker）；--db 则只处理指定库。
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'

const MS = 1e12
const dbArg = process.argv.indexOf('--db')
const dbPaths = []
if (dbArg !== -1) {
  dbPaths.push(process.argv[dbArg + 1])
} else {
  const groupsDir = join(process.env.LURKER_STATE_DIR ?? join(homedir(), '.dsh', 'dsh-group-lurker'), 'groups')
  for (const chatId of readdirSync(groupsDir)) {
    dbPaths.push(join(groupsDir, chatId, 'store.db'))
  }
}

// 列名启发式：时间戳列（毫秒语义）。排除非时间数值列由值域判断兜底。
const isTsColumn = (name) =>
  /^(ts|deadline|fired_at|last_seen_ts|fulfilled_ts|created_at|last_seen_at|last_active_at|first_seen_at)$/.test(name)

let totalFixed = 0
for (const dbPath of dbPaths) {
  const db = new DatabaseSync(dbPath, { readOnly: false })
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  for (const { name: table } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()
    for (const col of cols) {
      if (col.type.toUpperCase() !== 'INTEGER' || !isTsColumn(col.name)) continue
      const q = `SELECT rowid, ${JSON.stringify(col.name)} AS v FROM ${JSON.stringify(table)} WHERE ${JSON.stringify(col.name)} > 0 AND ${JSON.stringify(col.name)} < ${MS}`
      const rows = db.prepare(q).all()
      if (rows.length === 0) continue
      const upd = db.prepare(`UPDATE ${JSON.stringify(table)} SET ${JSON.stringify(col.name)} = ${JSON.stringify(col.name)} * 1000 WHERE rowid = ?`)
      for (const r of rows) upd.run(r.rowid)
      console.log(`[${dbPath}] ${table}.${col.name}: ${rows.length} 行秒级 → 毫秒`)
      totalFixed += rows.length
    }
  }
  db.close()
}
console.log(`回填完成，共 ${totalFixed} 行`)
