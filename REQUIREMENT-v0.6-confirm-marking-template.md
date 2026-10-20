# 需求提案 v0.6：审批双通道与报告修订流的模板侧落点

> 提出方：群聊报告系统（TypeScript / 2水群 仓库）
> 提出日期：2026-10-20
> 前置：v0.4 已上线（真实库 v4）；v0.5（账号层级，REQUIREMENT-v0.5-account-hierarchy.md）待排——**本需求建议与 v0.5 合并为一次 schema 迁移窗口**（user_version 4→5）
> 性质：需求提案——schema 变更由模板方定稿
> 关联设计（插件侧）：`2水群/docs/TECH-DESIGN-confirm-loop.md`、`2水群/docs/DESIGN-approval-marking.md`

---

## 0. 为什么这是贯穿性需求

插件侧即将实施**审批双通道**（对话框 + 前端工作台，确认闭环）与**报告修订流**（审批/标记级联更新日/周/月报）。这两项是贯穿性改动：不只插件加模块，**模板（0数据格式）的 schema、工具链、假数据都要同步落点**，否则会出现"插件写了、库里看不到/查不了"的落实缺口。本函列出全部模板侧落点，请数据负责人裁定与排期。

## 1. 裁决请求：报告修订在 knowledge.db 的可见性（T1）

修订流会对报告做**段落级更新**（不动 LLM、不新增行、upsert 同键）。请裁定修订痕迹在库中的形态：

| 方案 | 内容 | 评价 |
|---|---|---|
| (a) 轻量列 | report 表增 `revised_at INTEGER`、`revision_count INTEGER`（迁移 ALTER/重建同 v0.4 惯例） | 查询"哪些报告被修订过"够用；看不到每次改了什么 |
| (b) 镜像表 | 新增 `report_revisions`（chat_id, period_type, period_start, ts, type, target_ref, summary, source），插件镜像侧写入 | 前端「修订时间线」页可直查完整历史；多一张表 |

插件侧建议 **(b)**（前端修订时间线是明确需求），表结构插件侧可代拟初稿供模板方定稿。

## 2. 裁决请求：标记（markings）是否镜像（T2）

「完成情况」段（周报/月报展示任务完成标记：已完成/未完成/删除）有两种查询形态：

| 方案 | 内容 | 评价 |
|---|---|---|
| (a) 烘进正文 | 标记只存在于报告 content_md 的段落里，库不另存 | 零 schema 变更；但跨群/跨期聚合查询（"所有未完成事项"）做不了 |
| (b) 镜像表 | knowledge.db 增 `markings` 视图或镜像表（chat_id, kind, target_ref, status, ts, source） | 前端可做"未完成事项"跨群聚合页 |

插件侧建议 **(b)**（聚合查询是前端的自然需求），且与 v0.5 的每账号目录结构兼容（镜像时带账号维度）。

## 3. 复核请求：Q1（审批数据不镜像）是否维持（T3）

v0.4 评审裁定"审批数据不镜像进 0数据格式"。双通道上线后复核：插件侧维持该裁定（审批事实源与写入方都在每群库，前端只读每群库）。**若无异议请确认维持**；若前端需要跨设备审批视图再另行立项。

## 4. 落地确认：定稿与修订的交互（T4，即 Q2 方案 a）

- `upsertReport` 冲突时**保留已有 `final` 状态**（方案 a）——请确认此落地排期；
- 修订流语义补充：修订**不改变** draft/final（定稿独立）；`final` 报告被修订后仍是 `final` 且 `revised_at` 刷新（若 T1 选方案 a）。

## 5. 工具链（T5/T6）

1. `report_cli.py` / `export_md.py`：支持修订记录与完成情况段的导出（T1/T2 定型后适配）；
2. `make_template.py`：增修订/标记合成样例（同日双群 + weekly/monthly + 修订行 + 标记行），供前端页面开发。

## 6. 迁移与排期（T7）

- **v0.5（账号层级）+ v0.6（本需求）合并为一次 user_version 4→5 迁移**：真实库一次性迁移（备份惯例不变），避免两次迁移窗口；
- 迁移幂等、保留全部既有数据（既有惯例）。

## 7. 红线复核（T8）

标记/修订的 `source` 字段只含通道名（'chat'/'web'），**不含消息原文与语句原文**；审计只记元数据——五条红线（R1–R5）不变。

## 8. 追溯矩阵（防落实缺口）

| # | 落点 | 责任方 | 状态 |
|---|---|---|---|
| T1 | report 修订可见性（方案 a/b 裁决 + schema） | 数据负责人 | 待裁决 |
| T2 | markings 镜像/视图（方案 a/b 裁决 + schema） | 数据负责人 | 待裁决 |
| T3 | Q1 维持确认 | 数据负责人 | 待确认 |
| T4 | upsert 保留 final 落地 | 数据负责人 | 待排期 |
| T5 | report_cli/export_md 适配 | 数据负责人 | 待排期（依赖 T1/T2 定型） |
| T6 | make_template 假数据 | 数据负责人 | 待排期 |
| T7 | v0.5+v0.6 合并迁移窗口 | 双方 | 待排期 |
| T8 | 红线复核 | 双方 | 待确认 |
| PLG-1 | 每群库 markings/report_revisions 表 + 服务方法 | 插件侧（我方） | 设计已备（见关联文档） |
| PLG-2 | ApprovalActions/ActionInbox/ReportRevisionService | 插件侧（我方） | 设计已备 |
| PLG-3 | 镜像接线（mirrorMedia 同款模式） | 插件侧（我方） | 待 T1/T2 定型 |

## 9. 验收（模板侧）

1. 迁移后 user_version=5，全部既有数据保留；
2. 修订一行 → （T1 方案 b）report_revisions 新增一行 + report 行 revised_at 刷新；
3. 标记一条 → （T2 方案 b）markings 镜像可见，跨群聚合查询可用；
4. `final` 报告被修订后 status 仍为 final；
5. make_template 假数据含修订/标记样例，前端页面可在 sample.db 上开发。
