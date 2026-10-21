/**
 * approval-wiring.ts：审批双通道服务图的唯一组装点（ReportRevisionService + ApprovalActions）。
 *
 * 为什么单独成模块：index.ts 与 tests/wiring.test.mjs 必须共用**同一份**组装代码——
 * 测试里另写一份「同构」组装时，两边会悄悄漂移（ANALYSIS-2026-10-20-approval-wiring-regression
 * 之后又出现过 marks 接线与测试不一致），接线测试就测不到生产接线。
 *
 * 红线：本模块只组装、不持有发送能力；fs 写入全部经 Store（R3 围栏不变）。
 */
import type { Store, StoreLogger } from './store.js'
import type { GroupStoreService } from './group-store.js'
import { ReportRevisionService } from './report-revision.js'
import { ApprovalActions, type ApprovalActionsDeps, type ApprovalNotify } from './approval-actions.js'

export interface ApprovalWiringDeps {
  store: Store
  groupStore: GroupStoreService
  /** 任务/承诺识别服务；任一缺失（未启用）→ approvalActions = null，reportRevision 照常构造 */
  task: ApprovalActionsDeps['task'] | null
  promise: ApprovalActionsDeps['promise'] | null
  notify: ApprovalNotify
  logger: StoreLogger
  enqueueReportRegen?: ApprovalActionsDeps['enqueueReportRegen']
  now?: () => number
}

export interface ApprovalWiring {
  reportRevision: ReportRevisionService
  approvalActions: ApprovalActions | null
  /**
   * 收件箱 stale 细分用的目标解析（ActionInbox.resolveTarget）：只看行是否存在——
   * 不存在 → not_found，存在但状态不符 → status_conflict。未注入时收件箱一律报 not_found，
   * 前端会把「已在别处处理」误显示成「目标不存在」。
   */
  resolveInboxTarget: (chatId: string, kind: 'task' | 'promise' | 'event', id: number) => { createdAt: number } | null
}

/** 组装审批服务图（index.ts 与接线测试共用） */
export function createApprovalWiring(deps: ApprovalWiringDeps): ApprovalWiring {
  const { store, groupStore } = deps
  const reportRevision = new ReportRevisionService({
    store,
    logger: deps.logger,
    now: deps.now,
    resolveTarget: (chatId, kind, id) => {
      // event 行无时间列——出身时刻取其证据消息 ts（事件被识别的那条消息）
      if (kind === 'event') {
        const ev = groupStore.getEvent(chatId, id)
        if (!ev) return null
        const msg = ev.evidenceMsgId ? groupStore.getMessage(chatId, ev.evidenceMsgId) : null
        return msg ? { createdAt: msg.ts } : null
      }
      const row = kind === 'task' ? groupStore.getTask(chatId, id) : groupStore.getPromise(chatId, id)
      return row ? { createdAt: row.createdAt } : null
    },
    mirror: {
      mirrorMarking: (c, k, r, ts, o) => store.mirrorMarking(c, k, r, ts, o),
      mirrorReportRevision: (c, p2, ps, ts, t, o) => store.mirrorReport(c, p2, ps, ts, t, o),
    },
  })
  const approvalActions = deps.task && deps.promise
    ? new ApprovalActions({
        task: deps.task,
        promise: deps.promise,
        store: groupStore,
        notify: deps.notify,
        logger: deps.logger,
        enqueueReportRegen: deps.enqueueReportRegen,
        now: deps.now,
        revision: reportRevision,
        // 完成语义走完整标记链（存在性校验 → 镜像 → 标记当天日报修订段 → 周/月级联），
        // 与 ActionInbox task.mark 同源；直连 store.mirrorMarking 会跳过校验与修订段
        marks: reportRevision,
        reports: {
          finalizeReport: (chatId, kind, periodStart) => store.finalizeReport(chatId, kind, periodStart),
          recordRevision: (chatId, kind, periodStart, ts, summary, source) =>
            store.mirrorReport(chatId, kind, periodStart, ts, 'status', { summary, source }),
        },
      })
    : null
  const resolveInboxTarget: ApprovalWiring['resolveInboxTarget'] = (chatId, kind, id) => {
    const row = kind === 'task' ? groupStore.getTask(chatId, id) : kind === 'promise' ? groupStore.getPromise(chatId, id) : groupStore.getEvent(chatId, id)
    return row ? { createdAt: 'createdAt' in row ? row.createdAt : 0 } : null
  }
  return { reportRevision, approvalActions, resolveInboxTarget }
}
