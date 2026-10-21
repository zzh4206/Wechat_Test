// manifest.mjs —— 读取插件写的 <stateDir>/web/allowed-chats.json（前端设计 §11-Q5 方案 b）。
//
// 白名单是 R2 的唯一事实源：web 进程不解析 DSH 配置，只信这份文件。
// 每次请求都重读（文件很小），插件改白名单后重启即生效，web 进程无需重启。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MANIFEST_REL = join('web', 'allowed-chats.json')

/** chatId / pid 路径安全字符（与插件 CHAT_ID_RE 同口径，防 `..`/`/` 伪装） */
export const ID_RE = /^[A-Za-z0-9_@=-]{1,128}$/

/** 跨群聚合报告的 chat_id（knowledge.db 约定） */
export const AGGREGATE = 'aggregate'

/**
 * 读清单；文件缺失/损坏/白名单为空一律返回 null（调用方 fail-closed）。
 * 非法 chatId 直接丢弃，不进入白名单。
 */
export function loadManifest(stateDir) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(stateDir, MANIFEST_REL), 'utf8'))
  } catch {
    return null
  }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.groups)) return null
  const groups = raw.groups.filter(g => typeof g === 'string' && ID_RE.test(g) && g !== AGGREGATE)
  if (groups.length === 0) return null
  const knowledgeDb = typeof raw.knowledgeDb === 'string' && raw.knowledgeDb ? raw.knowledgeDb : null
  // 插件收件箱是否在消费 actions.jsonl（旧清单无此字段 = 否）
  const actionsEnabled = raw.actionsEnabled === true
  return { groups, knowledgeDb, actionsEnabled }
}
