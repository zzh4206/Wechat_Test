/**
 * approval-actions.ts：审批动作单入口（ApprovalActions 门面，confirm-loop 设计 §2.1）。
 *
 * 双通道审批（对话框 + 前端 ActionInbox）汇入同一组方法：
 * - **不搬逻辑**：确认/取消/完成/模式学习原封不动留在 TaskRecognitionService /
 *   PromiseRecognitionService / GroupStoreService（已实测代码不动），门面只做
 *   转发 + 回执组装；
 * - 回执走 notify 注入：对话框通道 = 聊天短句通知；前端通道 = ActionInbox 写
 *   action-results 文件——同一门面，两种回执实现；
 * - 模式学习闭环：确认动作（任一通道）触发 learned_pattern 登记（既有逻辑），
 *   同 assigner + 同句式的下一条识别免确认。
 */
import type { GroupStoreService } from './group-store.js'
import type { TaskRecognitionService } from './task-recognition.js'
import type { PromiseRecognitionService } from './promise-track.js'
import type { StoreLogger } from './store.js'

/** 回执注入（对话框通道 = 聊天短句；前端通道 = 结果文件写入） */
export type ApprovalNotify = (kind: string, title: string, body: string) => Promise<void> | void

export type ReportKind = 'daily' | 'weekly' | 'monthly'

export interface ApprovalActionsDeps {
  task: Pick<TaskRecognitionService, 'confirmTask' | 'cancelTask' | 'completeTask' | 'confirmEvent'>
  promise: Pick<PromiseRecognitionService, 'confirmPromise' | 'cancelPromise' | 'confirmFulfilled' | 'closePromise'>
  store: GroupStoreService
  notify: ApprovalNotify
  logger: StoreLogger
  /** regen 补发队列入队钩子（阶段三泛化后由接线层注入；缺省 = reportRegen 返回 false） */
  enqueueReportRegen?: (chatId: string, dateKey: string, kind: ReportKind) => boolean
  now?: () => number
}

/** 审批动作门面：所有通道的唯一入口（零直改 SQL——全部经既有服务方法） */
export class ApprovalActions {
  private readonly now: () => number

  constructor(private readonly deps: ApprovalActionsDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  private async receipt(ok: boolean, kind: string, title: string, body: string): Promise<boolean> {
    if (ok) await this.deps.notify(kind, title, body)
    return ok
  }

  // —— 任务 ——

  /** 任务确认（pending_confirm → active，登记模式学习） */
  async taskConfirm(chatId: string, taskId: number): Promise<boolean> {
    const ok = await this.deps.task.confirmTask(chatId, taskId)
    return this.receipt(ok, 'approval', '任务已确认', ok ? `任务 #${taskId} 确认为真（${chatId}）` : `任务 #${taskId} 确认失败（不存在或状态非法）`)
  }

  /** 任务取消（误报处置 → cancelled） */
  async taskCancel(chatId: string, taskId: number): Promise<boolean> {
    const ok = await this.deps.task.cancelTask(chatId, taskId)
    return this.receipt(ok, 'approval', '任务已取消', ok ? `任务 #${taskId} 已取消（${chatId}）` : `任务 #${taskId} 取消失败`)
  }

  /** 任务完成（active → done） */
  async taskComplete(chatId: string, taskId: number): Promise<boolean> {
    const ok = await this.deps.task.completeTask(chatId, taskId)
    return this.receipt(ok, 'approval', '任务已完成', ok ? `任务 #${taskId} 标记完成（${chatId}）` : `任务 #${taskId} 完成失败（需为 active 状态）`)
  }

  /** 人工指定任务截止时间（deadline_confidence 置 1） */
  async taskSetDeadline(chatId: string, taskId: number, deadline: number): Promise<boolean> {
    const ok = await this.deps.store.updateTaskDeadline(chatId, taskId, deadline, 1)
    return this.receipt(ok, 'approval', '任务时限已更新', ok ? `任务 #${taskId} 时限人工指定（置信度 1）` : `任务 #${taskId} 时限更新失败`)
  }

  // —— 事件 ——

  /** 事件确认（pending_confirm → active） */
  async eventConfirm(chatId: string, eventId: number): Promise<boolean> {
    const ok = await this.deps.task.confirmEvent(chatId, eventId)
    return this.receipt(ok, 'approval', '事件已确认', ok ? `事件 #${eventId} 确认为真（${chatId}）` : `事件 #${eventId} 确认失败`)
  }

  // —— 承诺 ——

  /** 承诺确认（登记模式学习） */
  async promiseConfirm(chatId: string, promiseId: number): Promise<boolean> {
    const ok = await this.deps.promise.confirmPromise(chatId, promiseId)
    return this.receipt(ok, 'approval', '承诺已确认', ok ? `承诺 #${promiseId} 确认为真（${chatId}）` : `承诺 #${promiseId} 确认失败`)
  }

  /** 承诺取消（误报处置） */
  async promiseCancel(chatId: string, promiseId: number): Promise<boolean> {
    const ok = await this.deps.promise.cancelPromise(chatId, promiseId)
    return this.receipt(ok, 'approval', '承诺已取消', ok ? `承诺 #${promiseId} 已取消（${chatId}）` : `承诺 #${promiseId} 取消失败`)
  }

  /** 承诺手动勾选兑现 */
  async promiseFulfilled(chatId: string, promiseId: number): Promise<boolean> {
    const ok = await this.deps.promise.confirmFulfilled(chatId, promiseId, null)
    return this.receipt(ok, 'approval', '承诺已兑现', ok ? `承诺 #${promiseId} 手动勾选兑现（${chatId}）` : `承诺 #${promiseId} 兑现勾选失败`)
  }

  /** 承诺关闭（跳票不再追踪） */
  async promiseClose(chatId: string, promiseId: number): Promise<boolean> {
    const ok = await this.deps.promise.closePromise(chatId, promiseId)
    return this.receipt(ok, 'approval', '承诺已关闭', ok ? `承诺 #${promiseId} 关闭（不再追踪）` : `承诺 #${promiseId} 关闭失败`)
  }

  // —— 人员关注（person-digest 通道化；watch_level 关注位）——

  /** 关注特定人员（watch_level → group；person-digest 照常出文件） */
  async personFollow(chatId: string, pid: string): Promise<boolean> {
    const ok = await this.deps.store.setIdentityWatchLevel(chatId, pid, 'group')
    return this.receipt(ok, 'approval', '已关注成员', ok ? `已关注 ${pid}（${chatId}）——后续日摘照常产出` : `关注失败：${pid} 不在 ${chatId} 的 identities 中`)
  }

  /** 取消关注（watch_level → off） */
  async personUnfollow(chatId: string, pid: string): Promise<boolean> {
    const ok = await this.deps.store.setIdentityWatchLevel(chatId, pid, 'off')
    return this.receipt(ok, 'approval', '已取消关注', ok ? `已取消关注 ${pid}（${chatId}）` : `取消关注失败：${pid} 不在 ${chatId} 的 identities 中`)
  }

  // —— 报告补生成（经泛化后的 regen 队列，阶段三接线） ——

  /** 请求补生成/重跑某期报告（入 regen 队列，reason='manual'；LLM 参与故走队列不同步） */
  async reportRegen(chatId: string, dateKey: string, kind: ReportKind = 'daily'): Promise<boolean> {
    if (!this.deps.enqueueReportRegen) {
      this.deps.logger.warn('approval-actions: reportRegen 未接 regen 队列——请求被忽略')
      return false
    }
    const ok = this.deps.enqueueReportRegen(chatId, dateKey, kind)
    return this.receipt(ok, 'approval', '补生成已排程', ok ? `${kind} ${dateKey}（${chatId}）已入补生成队列` : `${kind} ${dateKey} 已在队列中（去重）`)
  }
}
