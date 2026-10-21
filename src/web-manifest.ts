/**
 * web-manifest.ts：给前端 web 进程的只读清单（前端设计 §11-Q5 方案 b）。
 *
 * 插件启动时把 `groups` 白名单与 knowledge.db 路径写入 `<stateDir>/web/allowed-chats.json`，
 * web 进程只读这份文件——不必理解 DSH 配置格式，且与 R2 同一份白名单数据。
 * - 白名单为空照样写（`groups: []`）：web 进程据此拒绝启动，与插件 fail-closed 同口径；
 * - 写入经 Store（assertInsideState 围栏，R3）；失败只 warn，不影响插件主流程；
 * - 只含 chatId 与路径，不含昵称/消息等任何内容数据。
 */
import type { Store } from './store.js'

/** 清单相对 stateDir 的路径（web 进程按同一路径读取） */
export const WEB_MANIFEST_REL = 'web/allowed-chats.json'

export interface WebManifest {
  version: 1
  /** 白名单 chatId（与插件 config.groups 一致） */
  groups: string[]
  /** knowledge.db 绝对路径；null = 镜像已关闭（sqlitePath='off'），前端回溯不可用 */
  knowledgeDb: string | null
  /** 插件收件箱是否消费 web/actions.jsonl（= webActionsEnabled 且依赖齐全）；false 时前端禁用审批按钮 */
  actionsEnabled: boolean
  updatedAt: number
}

/** 写入清单；返回是否成功 */
export function writeWebManifest(
  store: Pick<Store, 'ensureDir' | 'writeText'>,
  opts: { groups: readonly string[]; knowledgeDb: string | null; actionsEnabled?: boolean; now?: () => number },
): boolean {
  const manifest: WebManifest = {
    version: 1,
    groups: [...opts.groups],
    knowledgeDb: opts.knowledgeDb,
    actionsEnabled: opts.actionsEnabled ?? false,
    updatedAt: (opts.now ?? Date.now)(),
  }
  if (!store.ensureDir('web')) return false
  return store.writeText(WEB_MANIFEST_REL, `${JSON.stringify(manifest, null, 2)}\n`)
}
