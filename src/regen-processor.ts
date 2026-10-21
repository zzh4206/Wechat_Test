/**
 * regen-processor.ts：补发队列处理器（与 regen-queue.ts 配套）。两种来源分开处理：
 *
 * A. 错号补发（reason='wrong_account'，processRegenHead）——日报调度 tick 内、账号闸放行时调用，
 *    每轮只处理该来源最早的一个元素（多元素逐轮处理，避免一轮长阻塞）：
 * 1. satisfied 检查：该 (chatId, dateKey) 已有非 empty 报告（正确账号在触发时刻前已登录）→
 *    done 出队，审计 regen_satisfied，不重生成；
 * 2. 重新 generateReport（backfill 窗口锚定 dateKey，end=处理时刻，覆盖已同步消息）：
 *    - 有内容 → 报告已落盘 + outbox 条目（进发送链路，takeFocus 照常）→ done 出队，
 *      审计 regen_regenerated + notify；
 *    - 空 → regenAttempts++：≤2 次 → 放回队首（审计 regen_deferred_sync_pending）；
 *      第 3 次全空 → 如实定稿：空报告照常落盘 + outbox 正常创建（按既有链路发送）→
 *      empty_confirmed 出队（审计 regen_empty_confirmed）；
 * 3. 环境类失败（生成入口异常）→ 元素留在原位、不消耗重试次数（审计 regen_env_deferred，
 *    与熄屏 deferred 同语义，attempts 不增）。
 *
 * B. 手动重新生成（reason='manual'，processManualRegen / startManualRegen）——对话框或前端发起：
 *    - 不做 satisfied 检查（重跑的通常正是已有报告）；
 *    - 只重新生成、**不创建 outbox 条目**：推送到手机须另走「排入发件箱」，发送只有一个入口；
 *    - 空产出不重试（重试是为错号切换后等消息同步，手动重跑无此前提），如实结束；
 *    - 独立轮询触发（不依赖日报 tick 与账号闸是否注入）；账号闸注入且当前错号时跳过本轮，
 *      避免用错号的空数据覆盖正常报告。
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
  action: 'satisfied' | 'regenerated' | 'deferred_sync_pending' | 'empty_confirmed' | 'env_deferred' | 'empty' | 'manual_regenerated' | 'manual_skipped_account'
  entry: RegenEntry | null
}

const KIND_NAME: Record<RegenEntry['kind'], string> = { daily: '日报', weekly: '周报', monthly: '月报' }

/** 处理错号补发来源最早的一个元素（每轮一次；手动重跑条目不在此处理，见 processManualRegen） */
export async function processRegenHead(deps: RegenProcessorDeps): Promise<RegenProcessOutcome> {
  const head = deps.queue.firstOf('wrong_account')
  if (!head) return { action: 'empty', entry: null }
  const { chatId, dateKey, kind } = head
  const name = KIND_NAME[kind]

  // satisfied：正确账号在触发时刻前已生成过非 empty 报告 → 不重生成（按条目自身周期查）
  const metas = deps.groupStore.getReportMetas(chatId, { kind, limit: 10 })
  if (metas.some((m) => m.date === dateKey && m.status !== 'empty')) {
    deps.queue.remove(head)
    deps.audit({ result: 'regen_satisfied', chat_id: chatId, date_key: dateKey, kind })
    return { action: 'satisfied', entry: head }
  }

  let rr
  try {
    rr = await deps.report.generateReport(chatId, kind, deps.now(), dateKey)
  } catch (error) {
    // 环境类失败：留在原位，不消耗重试次数（与熄屏 deferred 同语义）
    deps.audit({ result: 'regen_env_deferred', chat_id: chatId, date_key: dateKey, kind })
    deps.logger.warn(`regen-queue: 生成异常（留在原位，attempts 不增） ${chatId}/${dateKey}: ${String(error).slice(0, 120)}`)
    return { action: 'env_deferred', entry: head }
  }

  if (rr.status === 'empty') {
    const attempts = (head.regenAttempts ?? 0) + 1
    deps.queue.setRegenAttempts(chatId, dateKey, attempts, kind)
    if (attempts <= REGEN_EMPTY_MAX_ATTEMPTS) {
      deps.audit({ result: 'regen_deferred_sync_pending', chat_id: chatId, date_key: dateKey, kind, regenAttempts: attempts })
      deps.logger.warn(`regen-queue: 补生成仍为空（第 ${attempts}/${REGEN_EMPTY_MAX_ATTEMPTS + 1} 次尝试）——留在原位重试 ${chatId}/${dateKey}`)
      return { action: 'deferred_sync_pending', entry: deps.queue.firstOf('wrong_account') }
    }
    // 3 次全空 → 如实定稿：空报告已由 generateReport 落盘；outbox 正常创建按既有链路发送
    deps.queue.remove(head)
    deps.outbox.appendOutbox({ kind, title: `补发${name} ${dateKey}`, body: '本期窗口内无消息（补发核实现无内容）', evidence_ref: rr.path ?? '' })
    deps.audit({ result: 'regen_empty_confirmed', chat_id: chatId, date_key: dateKey, kind, regenAttempts: attempts })
    deps.logger.warn(`regen-queue: 连续 ${attempts} 次补生成为空——如实定稿（空${name}正常发送） ${chatId}/${dateKey}`)
    return { action: 'empty_confirmed', entry: head }
  }

  // 有内容 → 报告已落盘；此时才创建 outbox 条目（进发送链路，takeFocus 照常）
  deps.queue.remove(head)
  deps.audit({ result: 'regen_regenerated', chat_id: chatId, date_key: dateKey, kind, status: rr.status, messageCount: rr.messageCount })
  await deps.notify?.(`补发${name}已生成（${chatId} ${dateKey}）`, `关键判断 ${rr.judgmentCount} 条，全文见 outbox 存档`)
  deps.outbox.appendOutbox({ kind, title: `补发${name} ${dateKey}`, body: `补发 ${dateKey} 报告（错号期间空报告已修正）`, evidence_ref: rr.path ?? '' })
  return { action: 'regenerated', entry: head }
}

/** 手动重跑的依赖：不需要 outbox / groupStore（不发送、不做 satisfied 检查） */
export type ManualRegenDeps = Pick<RegenProcessorDeps, 'queue' | 'report' | 'logger' | 'notify' | 'audit' | 'now'> & {
  /** 账号闸：返回 false = 当前错号，跳过本轮（未注入账号闸时恒 true） */
  accountOk?: () => Promise<boolean>
}

/** 处理最早的一条手动重跑（每次一条）。只重新生成报告，不创建 outbox 条目 */
export async function processManualRegen(deps: ManualRegenDeps): Promise<RegenProcessOutcome> {
  const entry = deps.queue.firstOf('manual')
  if (!entry) return { action: 'empty', entry: null }
  const { chatId, dateKey, kind } = entry
  if (deps.accountOk && !(await deps.accountOk())) {
    // 错号在线：重跑只会得到空数据并覆盖正常报告 → 留在原位等正号
    return { action: 'manual_skipped_account', entry }
  }
  let rr
  try {
    rr = await deps.report.generateReport(chatId, kind, deps.now(), dateKey)
  } catch (error) {
    deps.audit({ result: 'regen_env_deferred', chat_id: chatId, date_key: dateKey, kind, reason: 'manual' })
    deps.logger.warn(`regen-queue: 手动重跑生成异常（留在原位） ${chatId}/${dateKey}: ${String(error).slice(0, 120)}`)
    return { action: 'env_deferred', entry }
  }
  deps.queue.remove(entry)
  deps.audit({ result: 'regen_manual_done', chat_id: chatId, date_key: dateKey, kind, status: rr.status, messageCount: rr.messageCount })
  await deps.notify?.(`${KIND_NAME[kind]}已重新生成（${chatId} ${dateKey}）`, rr.status === 'empty' ? '本期窗口内无消息' : `关键判断 ${rr.judgmentCount} 条`)
  return { action: 'manual_regenerated', entry }
}

/**
 * 手动重跑轮询（接线层 ctx.effect 挂 dispose）：每 intervalMs 处理一条；上一轮未结束不重入。
 * 返回清理函数。
 */
export function startManualRegen(deps: ManualRegenDeps & { intervalMs?: number }): () => void {
  let busy = false
  const tick = (): void => {
    if (busy || !deps.queue.firstOf('manual')) return
    busy = true
    processManualRegen(deps)
      .catch((error) => deps.logger.error(`regen-queue: 手动重跑轮询失败: ${String(error).slice(0, 120)}`))
      .finally(() => { busy = false })
  }
  const timer = setInterval(tick, Math.max(1000, deps.intervalMs ?? 30_000))
  tick()
  return () => clearInterval(timer)
}
