/**
 * spikes/bus-probe.mjs — dsh-group-lurker WP0 只读事件探测脚本（SPIKE-bus.md 配套）
 *
 * 它本体是一个 Cordis 插件模块：被宿主加载后，订阅候选事件，只打印
 * 「事件名 + 顶层字段名 + 脱敏后的值类型/前几字符」，绝不打印消息正文，
 * 绝不落盘任何群数据。没有任何 send/deliver 调用。
 *
 * 为什么不是纯 `node bus-probe.mjs`：DSH 的 Cordis 总线活在宿主进程里，
 * 独立 node 进程无法直接 attach（无 IPC）。因此探测方式是把它作为临时
 * 插件 insert 进 profile（见下方"运行说明"），观察完移除即可。
 *
 * ## 运行说明（只读，完成后还原）
 *
 * 1. 把本仓库软链/安装进 profile（示例路径 ~/.dsh/profiles/web）：
 *      cd ~/.dsh/profiles/web
 *      pnpm add file:$HOME/WeChat/2水群
 * 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 顶部临时加一条（注意该文件是
 *    顶层数组，注意逗号）：
 *      - id: group-lurker-probe
 *        name: "@zzh4206/dsh-group-lurker/spike-bus-probe"
 * 3. 重启 DSH（或在 patchReload: live 下热重载）。在宿主日志/控制台观察
 *    [bus-probe] 前缀行。然后在群里 @ 机器人说句话、发条私聊，对比打印。
 * 4. 验证完毕：从 cordis.patch.yml 删除该条目，`pnpm remove` 该链接。
 *
 * 单独 `node spikes/bus-probe.mjs` 只会打印本说明与语法自检结果，不连任何东西。
 *
 * 约定：本脚本打印字段名与脱敏样例（值截断、sessionId 保留结构打码尾部），
 * 用于核对 docs/SPIKE-bus.md §2 的 payload 清单。
 */

const CANDIDATE_EVENTS = [
  'im-connect/message', // WP0.5 补丁新增：im-connect 在 access 过滤前广播的只读入站事件
  'agent/inbox/inserted',
  'agent/inbox/claimed',
  'agent/inbox/discarded',
  'agent/inbox/spliced',
  'session/event',
  'agent/assistant-stream',
  'session/disposed',
]

/** im:<channel>:<kind>:<stamp>:<chatId> → 打码 chatId，保留结构（同 vendor parseImSessionId 规则）。 */
function describeSessionId(id) {
  if (typeof id !== 'string') return id
  if (!id.startsWith('im:')) return id
  const parts = id.split(':')
  if (parts.length >= 5) parts[4] = `<${parts[4].length}ch>`
  return parts.join(':')
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 12 ? `<str ${value.length}>` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return depth > 3 ? '[…]' : value.slice(0, 4).map(item => redact(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = depth > 3 ? '…' : redact(item, depth + 1)
    return out
  }
  return String(value)
}

function shape(payload) {
  if (payload === null || payload === undefined) return String(payload)
  if (Array.isArray(payload)) return { __arrayLen: payload.length, sample: redact(payload[0]) }
  if (typeof payload === 'object') {
    const out = { __keys: Object.keys(payload) }
    if (payload.agent !== undefined) out.agent = redact(payload.agent)
    if (payload.message !== undefined) out.message = redact(payload.message)
    if (payload.session !== undefined) out.session = redact(payload.session)
    if (payload.frame !== undefined) out.frame = { __keys: Object.keys(payload.frame) }
    return out
  }
  return typeof payload
}

function install(ctx, name) {
  const log = line => ctx.logger?.(name)?.info?.(line) ?? console.log(line)
  for (const event of CANDIDATE_EVENTS) {
    ctx.on(event, (...args) => {
      const payload = args[0]
      const sessionId = payload?.agent?.session?.id ?? payload?.session?.id ?? payload?.id
      const lines = [
        `[bus-probe] event=${event} args=${args.length}`,
        `[bus-probe]   shape=${JSON.stringify(shape(payload))}`,
      ]
      if (sessionId !== undefined) lines.push(`[bus-probe]   sessionId=${describeSessionId(sessionId)}`)
      // 第二参数常见为 next() 中间件（approval/request 等），只报告类型。
      if (args.length > 1) lines.push(`[bus-probe]   arg2=${typeof args[1]}`)
      log(lines.join('\n'))
    }, { global: true })
  }
  log(`[bus-probe] 已订阅 ${CANDIDATE_EVENTS.length} 个候选事件（只读，无发送能力）`)
}

// ── Cordis 插件接口（被宿主加载时生效） ───────────────────────────
export const name = 'dsh-group-lurker-spike-bus-probe'
export const inject = []
export function apply(ctx) {
  ctx.effect(() => {
    install(ctx, name)
  }, `${name}.listeners`)
}

// ── 独立运行：自检与说明 ──────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  console.log('bus-probe 是 Cordis 插件模块；独立 node 运行只做自检（见文件头运行说明）。')
  console.log('候选事件:', CANDIDATE_EVENTS.join(', '))
  console.log('self-check:', apply.length === 1 && typeof apply === 'function' ? 'ok' : 'fail')
}
