// actions.mjs —— 前端动作通道的 web 侧（前端设计 §4.3，RUNBOOK §13）。web 进程**唯一**的 fs 写入点。
//
// - 只做一件写：向 <stateDir>/web/actions.jsonl **追加**完整一行（以 \n 结尾）。
//   禁止截断/轮转/改写该文件（插件水位是字节偏移，RUNBOOK §13.1）——web-boundary 哨兵钉死；
// - 写前三道路径闸（R3）：目标必须落在 stateDir 内；web/ 与 actions.jsonl 都不能是符号链接；
// - 动作白名单只开 FE-2 用到的子集（插件侧 ACTION_TYPES 的子集），参数逐类型校验；
//   插件侧还会再校验一遍（白名单、chatId、targetId、stale），这里是第一道；
// - actionId 由服务端生成（幂等键），不信任前端传入；
// - 回执只读：扫 web/action-results.jsonl 找同 actionId 的最后一行。
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, sep } from 'node:path'
import { ID_RE } from './manifest.mjs'

export const ACTIONS_FILE = join('web', 'actions.jsonl')
export const RESULTS_FILE = join('web', 'action-results.jsonl')
export const ACTION_ID_RE = /^a-\d{13}-[0-9a-f]{8}$/

// 2020-01-01 ~ 2100-01-01（毫秒）：人工指定时限的合理范围
const DEADLINE_MIN = Date.UTC(2020, 0, 1)
const DEADLINE_MAX = Date.UTC(2100, 0, 1)

const byTarget = () => null
const byDeadline = (p) => (Number.isInteger(p?.deadline) && p.deadline >= DEADLINE_MIN && p.deadline < DEADLINE_MAX ? { deadline: p.deadline } : 'deadline_invalid')
const byPid = (p) => (typeof p?.pid === 'string' && ID_RE.test(p.pid) ? { pid: p.pid } : 'pid_invalid')

/** FE-2 动作白名单：type → [是否需要 targetId, 参数校验（返回 params / null=无参数 / string=错误原因）] */
export const WEB_ACTIONS = Object.freeze({
  'task.confirm': [true, byTarget],
  'task.cancel': [true, byTarget],
  'task.complete': [true, byTarget],
  'task.set_deadline': [true, byDeadline],
  'event.confirm': [true, byTarget],
  'promise.confirm': [true, byTarget],
  'promise.cancel': [true, byTarget],
  'promise.fulfilled': [true, byTarget],
  'promise.close': [true, byTarget],
  'person.follow': [false, byPid],
  'person.unfollow': [false, byPid],
})

/**
 * 校验前端提交并组装动作行。
 * @returns {{ line: object } | { error: string, reason?: string }}
 */
export function buildAction(body, allowedGroups, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad_request', reason: 'body' }
  const spec = Object.hasOwn(WEB_ACTIONS, body.type) ? WEB_ACTIONS[body.type] : null
  if (!spec) return { error: 'type_not_allowed' }
  if (typeof body.chatId !== 'string' || !allowedGroups.has(body.chatId)) return { error: 'chat_not_allowed' }
  const [needsTarget, check] = spec
  const line = { actionId: `a-${now}-${randomBytes(4).toString('hex')}`, ts: now, type: body.type, chatId: body.chatId }
  if (needsTarget) {
    if (!Number.isSafeInteger(body.targetId) || body.targetId <= 0) return { error: 'bad_request', reason: 'targetId' }
    line.targetId = body.targetId
  }
  const params = check(body.params)
  if (typeof params === 'string') return { error: 'bad_request', reason: params }
  if (params) line.params = params
  return { line }
}

/** R3：目标路径在 stateDir 内，且 web/ 与 actions.jsonl 都不是符号链接 */
function assertSafeTarget(stateDir) {
  const root = realpathSync(stateDir)
  const webDir = join(stateDir, 'web')
  mkdirSync(webDir, { recursive: true })
  if (lstatSync(webDir).isSymbolicLink()) throw new Error('web/ 是符号链接')
  if (!realpathSync(webDir).startsWith(root + sep)) throw new Error('web/ 越出 stateDir')
  const file = join(stateDir, ACTIONS_FILE)
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error('actions.jsonl 是符号链接')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return file
}

/** 追加一行动作（单次 append 写入完整一行，插件只消费以 \n 结尾的行） */
export function appendAction(stateDir, line) {
  const file = assertSafeTarget(stateDir)
  appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** 查回执：{ status: 'pending' } 或 { status: 'done', ok, code } */
export function readResult(stateDir, actionId) {
  let text = ''
  try {
    text = readFileSync(join(stateDir, RESULTS_FILE), 'utf8')
  } catch {
    return { status: 'pending' }
  }
  let found = null
  for (const raw of text.split('\n')) {
    if (!raw.includes(actionId)) continue
    try {
      const v = JSON.parse(raw)
      if (v.actionId === actionId) found = v
    } catch { /* 损坏行跳过 */ }
  }
  return found ? { status: 'done', ok: found.ok === true, code: String(found.code ?? 'error') } : { status: 'pending' }
}
