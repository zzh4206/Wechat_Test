/**
 * regen-processor.ts：错号空报告补发队列的 FIFO 处理器（与 regen-queue.ts 配套）。
 *
 * 每轮消费周期只处理队首一个元素（多元素逐轮处理，避免一轮长阻塞）：
 * 1. satisfied 检查：该 (chatId, dateKey) 已有非 empty 报告（正确账号在触发时刻前已登录）→
 *    done 出队，审计 regen_satisfied，不重生成；
 * 2. 重新 generateReport（backfill 窗口锚定 dateKey，end=处理时刻，覆盖已同步消息）：
 *    - 有内容 → 报告已落盘 + outbox 条目（进发送链路，takeFocus 照常）→ done 出队，
 *      审计 regen_regenerated + notify；
 *    - 空 → regenAttempts++：≤2 次 → 放回队首（审计 regen_deferred_sync_pending）；
 *      第 3 次全空 → 如实定稿：空报告照常落盘 + outbox 正常创建（按既有链路发送）→
 *      empty_confirmed 出队（审计 regen_empty_confirmed）；
 * 3. 环境类失败（生成入口异常）→ 元素放回队首、不消耗重试次数（审计 regen_env_deferred，
 *    与熄屏 deferred 同语义，attempts 不增）。
 */
import type { Outbox } from './outbox.js'
import type { Store } from './store.js'
import type { StoreLogger } from './store.js'
import type { RegenEntry, RegenQueue } from './regen-queue.js'

export const REGEN_EMPTY_MAX_ATTEMPTS = 2 // 空产出重试上限（共 1+2=3 次生成尝试）

export interface RegenProcessorDeps {
  queue: RegenQueue
  report: { generateReport: (chatId: string, kind: 'daily' | 'weekly' | 'monthly', asOf?: number, backfillDateKey?: string) => Promise<{ status: string; path: string | null; judgmentCount: number; topicCount: number; messageCount: number }> }
  groupStore: { getReportMetas: (chatId: string, opts: { kind?: 'daily' | 'weekly' | 'monthly'; limit?: number }) => Array<{ date: string; status: string }> }
  outbox: Outbox
  store: Store
  logger: StoreLogger
  notify?: (title: string, body: string) => Promise<void> | void
  /** 审计出口（零正文：只记元数据） */
  audit: (entry: Record<string, unknown>) => void
  now: () => number
}

export interface RegenProcessOutcome {
  /** handled = 已处理（出队或定稿）；deferred = 放回队首；empty = 队列空 */
  action: 'satisfied' | 'regenerated' | 'deferred_sync_pending' | 'empty_confirmed' | 'env_deferred' | 'empty'
  entry: RegenEntry | null
}

/** 处理队首一个元素（每轮一次）。返回处理结局供审计/日志 */
export async function processRegenHead(deps: RegenProcessorDeps): Promise<RegenProcessOutcome> {
  const head = deps.queue.peek()
  if (!head) return { action: 'empty', entry: null }
  const { chatId, dateKey } = head

  // satisfied：正确账号在触发时刻前已生成过非 empty 报告 → 不重生成
  const metas = deps.groupStore.getReportMetas(chatId, { kind: 'daily', limit: 10 })
  if (metas.some((m) => m.date === dateKey && m.status !== 'empty')) {
    deps.queue.pop()
    deps.audit({ result: 'regen_satisfied', chat_id: chatId, date_key: dateKey })
    return { action: 'satisfied', entry: head }
  }

  let rr
  try {
    rr = await deps.report.generateReport(chatId, head.kind, deps.now(), dateKey)
  } catch (error) {
    // 环境类失败：放回队首，不消耗重试次数（与熄屏 deferred 同语义）
    deps.queue.pop()
    deps.queue.unshift(head)
    deps.audit({ result: 'regen_env_deferred', chat_id: chatId, date_key: dateKey })
    deps.logger.warn(`regen-queue: 生成异常（放回队首，attempts 不增） ${chatId}/${dateKey}: ${String(error).slice(0, 120)}`)
    return { action: 'env_deferred', entry: head }
  }

  if (rr.status === 'empty') {
    const attempts = (head.regenAttempts ?? 0) + 1
    deps.queue.setRegenAttempts(chatId, dateKey, attempts)
    if (attempts <= REGEN_EMPTY_MAX_ATTEMPTS) {
      deps.audit({ result: 'regen_deferred_sync_pending', chat_id: chatId, date_key: dateKey, regenAttempts: attempts })
      deps.logger.warn(`regen-queue: 补生成仍为空（第 ${attempts}/${REGEN_EMPTY_MAX_ATTEMPTS + 1} 次尝试）——放回队首重试 ${chatId}/${dateKey}`)
      return { action: 'deferred_sync_pending', entry: deps.queue.peek() }
    }
    // 3 次全空 → 如实定稿：空报告已由 generateReport 落盘；outbox 正常创建按既有链路发送
    deps.queue.pop()
    deps.outbox.appendOutbox({ kind: 'daily', title: `补发日报 ${dateKey}`, body: '本期窗口内无消息（补发核实现无内容）', evidence_ref: rr.path ?? '' })
    deps.audit({ result: 'regen_empty_confirmed', chat_id: chatId, date_key: dateKey, regenAttempts: attempts })
    deps.logger.warn(`regen-queue: 连续 ${attempts} 次补生成为空——如实定稿（空日报正常发送） ${chatId}/${dateKey}`)
    return { action: 'empty_confirmed', entry: head }
  }

  // 有内容 → 报告已落盘；此时才创建 outbox 条目（进发送链路，takeFocus 照常）
  deps.queue.pop()
  deps.audit({ result: 'regen_regenerated', chat_id: chatId, date_key: dateKey, status: rr.status, messageCount: rr.messageCount })
  await deps.notify?.(`补发日报已生成（${chatId} ${dateKey}）`, `关键判断 ${rr.judgmentCount} 条，全文见 outbox 存档`)
  deps.outbox.appendOutbox({ kind: 'daily', title: `补发${head.kind === 'weekly' ? '周报' : head.kind === 'monthly' ? '月报' : '日报'} ${dateKey}`, body: `补发 ${dateKey} 报告（错号期间空报告已修正）`, evidence_ref: rr.path ?? '' })
  return { action: 'regenerated', entry: head }
}
