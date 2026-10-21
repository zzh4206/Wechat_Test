/**
 * report-outbox.ts：「排入发件箱」（FE-3 report.toOutbox）的插件侧入队。
 *
 * 只做一件事：往 outbox.jsonl 追加一条与定时报告**同形**的条目（kind = 报告周期、
 * evidence_ref = 报告 md 路径），之后由既有 sender worker 按原链路处理——四道闸
 * （senderEnabled / sendDryRun / 通道闸 / 交互闸）、每日配额、回读验证一概不变，本模块不碰发送。
 *
 * 防误发（入口侧）：
 * - 总开关 webOutboxEnabled 由 ActionInbox 在调用前检查（默认关，关时零入队）；
 * - 报告 md 必须存在（路径由 chatId/dateKey/kind 推导，不接受外部传入）；
 * - 去重：同一份报告 DEDUPE_MS 内已由前端排入过 → duplicate，不重复入队；
 * - 条目正文只含元数据（周期、日期、修订数），与定时报告「正文不进通知」同口径——
 *   报告内容不经这条通道外发。
 */
import type { Store } from './store.js'
import type { Outbox } from './outbox.js'
import { reportRelPath } from './report.js'

export type ReportKind = 'daily' | 'weekly' | 'monthly'
export type ReportOutboxResult = 'ok' | 'not_found' | 'duplicate'

/** 同一份报告重复排入的去重窗口（10 分钟） */
export const REPORT_OUTBOX_DEDUPE_MS = 10 * 60 * 1000

/** 标题后缀：在 outbox / 审计里区分「前端补推」与定时报告 */
export const WEB_PUSH_MARK = '（前端补推）'

const KIND_NAME: Record<ReportKind, string> = { daily: '日报', weekly: '周报', monthly: '月报' }

export interface ReportOutboxDeps {
  store: Pick<Store, 'readText' | 'listRevisions'>
  outbox: Pick<Outbox, 'appendOutbox' | 'listOutbox'>
  now?: () => number
}

/** 创建入队函数（接线层注入 ActionInbox.reportOutbox） */
export function createReportOutbox(deps: ReportOutboxDeps): (chatId: string, kind: ReportKind, dateKey: string) => ReportOutboxResult {
  const now = deps.now ?? (() => Date.now())
  return (chatId, kind, dateKey) => {
    const rel = reportRelPath(chatId, dateKey, kind)
    if (deps.store.readText(rel) === null) return 'not_found'
    const t = now()
    const recent = deps.outbox.listOutbox().some((e) =>
      e.evidence_ref === rel && e.title.endsWith(WEB_PUSH_MARK) && t - Date.parse(e.ts) < REPORT_OUTBOX_DEDUPE_MS)
    if (recent) return 'duplicate'
    const revisions = deps.store.listRevisions(chatId, kind, dateKey).length
    deps.outbox.appendOutbox({
      kind,
      title: `${KIND_NAME[kind]} ${dateKey}（${chatId}）${WEB_PUSH_MARK}`,
      body: revisions > 0 ? `修订 ${revisions} 处，全文见工作台` : '全文见工作台',
      evidence_ref: rel,
    })
    return 'ok'
  }
}
