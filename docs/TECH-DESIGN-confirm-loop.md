# 技术设计：审批双通道与确认闭环（代码结构改动）

- 版本：v0.1（草案）
- 状态：待评审
- 关联：[TECH-DESIGN-frontend.md](TECH-DESIGN-frontend.md)（前端工作台设计草案 v0.1：方案 B 动作收件箱）、[DESIGN-approval-marking.md](DESIGN-approval-marking.md)（审批与标记的报告修正流）
- 数据层依据：`src/group-store.ts`（tasks / promises / events 表）、`src/task-recognition.ts`、`src/promise-track.ts`

---

## 0. 现状问题（已取证）

审批的**出口**存在但**入口**缺失——确认闭环断在半途：

| 已确认事实 | 位置 |
|---|---|
| `confirmTask / cancelTask / completeTask / confirmEvent` 已实现 | `src/task-recognition.ts:602/616/623/630` |
| `confirmPromise / cancelPromise / confirmFulfilled / closePromise` 已实现 | `src/promise-track.ts:441` 起 |
| `updateTaskDeadline`（人工指定 → 置信度 1）已实现 | `src/group-store.ts:1860`（每群包装）/`:1187`（核心） |
| 模式学习已实现：确认时登记 `learned_pattern = ${assigner_pid}:${句式指纹}`，同类免确认 | `src/group-store.ts:1179/1372` |
| **以上全部方法在 src/ 内零调用方**（仅模块自身） | 全仓 grep 实证 |

后果：

1. `pending_confirm` 只进不出——待确认项无限堆积；
2. `learned_pattern` 免确认的模式学习**永远不会触发**（学习的前提是"确认发生过"）;
3. 无 deadline 任务的「提请审批具体时间」无处可批；
4. 前端工作台（TECH-DESIGN-frontend）的审批收件箱没有可对接的服务面。

## 1. 目标

**双通道审批**：同一个动作，既能在对话框里完成（现有聊天交互），也能在前端工作台完成——**双线并存，不是改线**。两通道汇入同一组服务方法，产生完全相同的库状态与模式学习效果。

## 2. 代码结构改动

### 2.1 新增 `ApprovalActions` 门面（src/approval-actions.ts）

把分散在两个识别服务里的审批方法提炼成**单一门面**，作为所有通道的唯一入口：

```ts
export class ApprovalActions {
  constructor(task: TaskRecognitionService, promise: PromiseRecognitionService,
              store: GroupStore, notify: ChatNotifier)
  // 每个动作：调既有方法 → 成功后经 notify 回执一句话（对话框通道可见，前端通道经结果文件可见）
  taskConfirm(chatId, taskId) / taskCancel / taskComplete / taskSetDeadline(chatId, taskId, deadline)
  eventConfirm(chatId, eventId)
  promiseConfirm / promiseCancel / promiseFulfilled / promiseClose (chatId, promiseId)
  personFollow / personUnfollow (chatId, pid)          // 关注特定人员（§4）
  reportRegen(chatId, dateKey, kind)                    // 补生成/重跑（§4，经泛化后的 regen 队列）
}
```

要点：

- **不搬逻辑**：门面只做转发 + 回执组装；确认/学习/状态机逻辑原封不动留在识别服务（已实测的代码不动）；
- 回执走 `notify` 接口注入：对话框通道注入聊天短句通知，前端通道注入「结果文件」（见 2.2）——**同一门面，两种回执实现**。

### 2.2 新增 `ActionInbox`（src/action-inbox.ts）

消费前端写下的动作文件（前端设计 §4.3/§5）：

- 数据源：`<stateDir>/web/actions.jsonl`（前端进程唯一写入点，插件只读）；
- 水位：`web/actions.offset`（经 Store.writeText，重启续读）；
- 每行校验：`chatId ∈ config.groups`（R2）、`type` 在白名单（未列出 → 拒绝并写失败结果）、`targetId` 正整数、幂等（`actionId` 已有结果则跳过）、stale（目标行状态已变化不强改，返回 `stale`）；
- 执行：调 `ApprovalActions` 对应方法；
- 结果：`web/action-results.jsonl`（`{actionId, ok, code, ts}`，不回写语句原文）+ `audit/web-actions.jsonl`（只记元数据）；
- 总闸：`webActionsEnabled`（默认 false，关闭时不消费）；轮询 `webActionsPollSec`（默认 5s）。

### 2.3 对话框通道对齐

现有聊天内的审批交互改为调 `ApprovalActions`（行为不变，只是改走门面），保证两通道**代码路径同源**——这是"双通道等价"的结构保证：任何一处修 bug，两边同时生效。

### 2.4 regen-queue 泛化（承接「补生成/重跑某天报告」）

现状：`src/regen-queue.ts` 仅 `kind='daily'`、`reason='wrong_account'`。泛化：

- `kind: 'daily' | 'weekly' | 'monthly'`；
- `reason: 'wrong_account' | 'manual'`（`manual` = 前端/对话框请求）；
- `enqueue` / `has` / pop 处理按 kind 分别去重（同键 = (kind, dateKey, chatId)）；
- 消费端（regen-processor）按 kind 调 `generateReport`（weekly/monthly 的窗口推导复用 `reportPeriodOf`——单一实现，与镜像同口径）；
- **月报 dateKey 锚定当月 1 号**（既有裁定，backfill 参数同样适用）。

### 2.5 关注特定人员（person-digest 的通道化）

`src/person-digest.ts` 产出的 `digests/<chatId>/<pid>/<date>.md` 保持不变（文件形态，前端只读展示）。新增：

- `personFollow / personUnfollow`（ApprovalActions 门面方法，落 `identities` 表的关注位）；
- 前端动作类型 `person.follow / person.unfollow`。

### 2.6 新增配置

| 键 | 默认 | 说明 |
|---|---|---|
| `webActionsEnabled` | false | ActionInbox 总闸 |
| `webActionsPollSec` | 5 | 轮询周期 |

## 3. 数据落点澄清（不扩 0数据格式）

| 数据 | 存放 | 是否进 knowledge.db |
|---|---|---|
| 待确认任务/承诺/事件（`status='pending_confirm'`） | 每群库 tasks/promises/events 表 | **否**（事实源与写入方都在每群库，镜像徒增口径漂移——前端直接只读每群库） |
| deadline 与 `deadline_confidence` | tasks 表既有列 | 否（同上） |
| 人员关注摘要 | `digests/<chatId>/<pid>/<date>.md` 文件 | 否（文件形态，前端只读） |
| 补生成队列 | `regen-queue.json` | 否（运行时队列） |
| 审批动作审计 | `audit/web-actions.jsonl` | 否（只记元数据） |

## 4. 模式学习的闭环意义

确认动作经任一通道发生后，`learned_pattern` 登记随之生效（既有逻辑，无需改）：

- 同一 `assigner_pid` + 同一句式指纹的下一条识别 → 免确认直接 `active`；
- 学习率成为前端可展示的运营指标（待确认堆积下降 = 学习生效）。

## 5. 测试

- 双通道等价：同一动作分别经对话框通知路径与 ActionInbox 路径 → 库状态、learned_pattern、审计完全一致；
- ActionInbox：白名单外 type 拒绝、重复 actionId 幂等、stale 不强改、越权 chatId 拒绝、损坏行跳过、水位跨重启；
- regen 泛化：weekly/monthly kind 的补生成（period 推导正确、月报锚定 1 号）；
- 全离线（mock 服务与文件），全量绿 + build 干净。

## 6. 分期

| 期 | 内容 |
|---|---|
| C1 | ApprovalActions 门面 + 对话框通道改走门面（行为不变的结构收敛） |
| C2 | ActionInbox + 白名单 + 审计（对接前端 P1 收件箱） |
| C3 | regen 泛化 + person 关注动作（对接前端 P2 与人员页） |
---

## 7. 贯穿性追溯：模板侧（0数据格式）协同项

本设计是**贯穿性改动**——插件侧模块只是其中一环，以下模板侧落点必须同步落实，防止"插件做了、模板没跟上"。
完整需求已出函：`0数据格式/REQUIREMENT-v0.6-confirm-marking-template.md`（数据负责人评审）。

| # | 改动 | 模板侧落点（0数据格式） | 责任方 |
|---|---|---|---|
| T1 | 报告修订（修订流） | report 表修订可见性：(a) 轻量列 `revised_at`/`revision_count`；(b) 新增 `report_revisions` 镜像表（前端修订时间线直查）——二选一 | 数据负责人决策 |
| T2 | 标记（完成情况） | knowledge.db 是否需要 markings 镜像/视图（跨群聚合查询直查 vs 只读烘进 content_md 的段落） | 数据负责人决策 |
| T3 | 审批数据镜像（Q1 复核） | v0.4 裁定"审批数据不镜像"——双通道上线后复核是否维持（建议维持） | 数据负责人复核 |
| T4 | 定稿与修订交互（Q2） | `upsertReport` 冲突保留 `final`（方案 a）落地；修订不改 final、final 不被镜像打回 | 数据负责人落地 |
| T5 | 工具链 | report_cli / export_md 支持 修订记录与完成情况段 的导出 | 数据负责人 |
| T6 | 假数据 | make_template 增 修订/标记 合成样例（前端页面开发依赖） | 数据负责人 |
| T7 | 版本与迁移 | 与 v0.5（账号层级）合并为一次 schema 迁移窗口；user_version 4→5 | 双方 |
| T8 | 红线复核 | 标记/修订的 source 字段只含通道名（chat/web）无正文；五条红线不变 | 双方确认 |

插件侧对应职责（本两份文档 §2/§3/§4）：每群库 markings/report_revisions 表、ApprovalActions/ReportRevisionService/ActionInbox、镜像接线（待 T1/T2 裁定后实施）。

