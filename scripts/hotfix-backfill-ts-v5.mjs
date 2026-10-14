// 一次性热修脚本：存量 ts=0 行回填真实时间 + 类型码占位文本修正。
//
// 背景：源适配器旧实现对字符串 create_time 解析失败落 ts=0（CLI 实测返回字符串秒），
// 库里积了 5 条 ts=0 行（3 条还带着生类型码占位 '[type:25769803825]'）。
// 代码修复（mapRows parseCreateTime + mapRawType + store v5 迁移）只管新数据，
// 存量行须按 server_id 到源 CLI 回查 create_time 回填。
//
// 选择说明：用一次性脚本而非 v5 迁移做回填——迁移在库打开路径上运行，不应依赖
// 外部 CLI 子进程（失败会阻塞插件启动，违背 fail-closed 精神）；脚本跑完即删，可审计。
//
// 用法：node scripts/hotfix-backfill-ts-v5.mjs
//   环境变量：LURKER_STATE_DIR（默认 ~/.dsh/dsh-group-lurker）、
//             WECHAT_DB_ROOT（db_storage 路径）、TOOL_DIR（macos-wechat-export 目录）
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { GroupStore } from '../lib/group-store.js'
import { mapRawType } from '../lib/source/wechat-db.js'

const stateDir = process.env.LURKER_STATE_DIR ?? join(homedir(), '.dsh', 'dsh-group-lurker')
const dbRoot = process.env.WECHAT_DB_ROOT
const toolDir = process.env.TOOL_DIR ?? join(homedir(), 'WeChat', 'macos-wechat-export')
if (!dbRoot) {
  console.error('需要 WECHAT_DB_ROOT 环境变量（微信 db_storage 路径）')
  process.exit(1)
}

const noopLogger = { info() {}, warn() {}, error() {} }
const groupsDir = join(stateDir, 'groups')

for (const chatId of readdirSync(groupsDir)) {
  const dbPath = join(groupsDir, chatId, 'store.db')
  // 先经 GroupStore 打开：自动跑迁移链到 v5（messages kind CHECK 扩展），link/other 才可写
  const store = new GroupStore(chatId, dbPath, noopLogger)
  const db = new DatabaseSync(dbPath, { readOnly: false })
  const stale = db.prepare('SELECT msg_id, text FROM messages WHERE ts = 0').all()
  if (stale.length === 0) {
    console.log(`[${chatId}] 无 ts=0 存量行，跳过`)
    store.close()
    db.close()
    continue
  }
  // 源 CLI 全量读该群（--limit 上限 200，按 --before-id 向前翻页），建 server_id → 行 索引
  const byId = new Map()
  let beforeId
  for (let page = 0; page < 100; page++) {
    const args = ['--db-root', dbRoot, 'read', '--chat-id', chatId, '--limit', '200']
    if (beforeId !== undefined) args.push('--before-id', String(beforeId))
    const out = execFileSync('python3', [join(toolDir, 'wechat_db.py'), ...args], {
      cwd: toolDir, // CLI 相对路径找 .wechat-local/keys.json，须在工具目录下运行
    }).toString()
    const msgs = JSON.parse(out).messages ?? []
    if (msgs.length === 0) break
    for (const m of msgs) byId.set(String(m.server_id), m)
    if (msgs.length < 200) break
    beforeId = msgs[msgs.length - 1].local_id
  }

  let fixed = 0
  let missed = 0
  for (const row of stale) {
    const src = byId.get(row.msg_id)
    let ts = null
    if (src) {
      const n = Number(src.create_time)
      if (Number.isFinite(n) && n > 0) ts = n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n)
    }
    if (ts === null) {
      // 回查不到真实时间：用当前时间兜底（与运行时兜底策略一致），并计数
      ts = Math.floor(Date.now() / 1000)
      missed++
    }
    // 占位文本同步修正：'[type:N]' → 映射表友好占位
    const m = row.text.match(/^\[type:(\d+)\]$/)
    let text = row.text
    let kind = null
    if (m) {
      const mapped = mapRawType(Number(m[1]))
      text = mapped.label
      kind = mapped.kind
    }
    db.prepare('UPDATE messages SET ts = ?, text = ?, kind = COALESCE(?, kind) WHERE msg_id = ?').run(
      ts,
      text,
      kind,
      row.msg_id,
    )
    fixed++
    console.log(`[${chatId}] ${row.msg_id} ts=0 → ${ts}（${new Date(ts * 1000).toISOString()}）text=${JSON.stringify(text)}${kind ? ` kind=${kind}` : ''}${src ? '' : '（CLI 未回查到，用当前时间兜底）'}`)
  }
  console.log(`[${chatId}] 回填完成：${fixed} 条，其中兜底 ${missed} 条`)
  store.close()
  db.close()
}
