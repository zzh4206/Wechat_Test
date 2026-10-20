# 修改文档：v0.6 审批双通道与报告修订流 · 模板侧变更明细

> 版本：schema `user_version` 4 → 5　·　日期：2026-10-20　·　责任：数据负责人
> 实施依据：[TECH-v0.6.md](TECH-v0.6.md)（四项裁定见 [REPLY-v0.6.md](REPLY-v0.6.md)）
> 验收结论：**通过**（终审实测记录见文末）

## 1. schema 变更（纯新增，既有表零改动）

| 对象 | 类型 | 说明 |
|---|---|---|
| `report_revision` | 表 | 修订历史（不可变事实）。`source_key TEXT NOT NULL UNIQUE` 幂等键，冲突跳过不更新；不建指向 report 的外键（补发场景先于报告行存在时不被拒） |
| `marking` | 表 | 完成情况标记。kind 三态 CHECK（done/undone/deleted）、target_ref、`source_key` 幂等 |
| `v_marking_latest` | 视图 | 每 target_ref 最新态（MAX(ts)，同 ts MAX(id) 兜底）——「未完成事项」跨群聚合页直查 |
| `v_report_revised` | 视图 | 修订计数与最近修订时间（推导，**否决了 report 表加列方案**，避免二次重建） |
| 索引 ×4 | 索引 | idx_revision_report / idx_revision_ts / idx_marking_chat / idx_marking_target |

`report` / `entry` / `doc` / `tag` / `doc_tag` / `chat_digest` / `media` 及既有视图：**零改动**。

## 2. 迁移

- `PRAGMA user_version` 4→5：单事务、幂等（第二遍打开零变化）；`0`=全量 v5；`5`=跳过；
  `3`=链式先升 4 再升 5（兼容存量）；其余（1/2/`>5`）报错拒开。
- Python（report_cli 打开时）与 TS（db.ts ensureSchema 链式）两份实现，语义逐字一致。
- 真实库迁移：备份 `~/WeChat/1数据/knowledge.db.bak-v4` 在位；迁移前后行数与行 digest
  完全一致（report 25 / entry 606 / chat_digest 3542 / doc 3 / media 0）；新表 0 行待插件接线。

## 3. 工具链变更

| 文件 | 变更 |
|---|---|
| `report_cli.py` | 增 `revision add` / `marking add` / `revisions list` / `markings latest`（source 缺省 'chat'） |
| `export_md.py` | 报告导出附「修订时间线」「完成情况（最新态）」小节（无记录省略） |
| `make_template.py` | 合成样例：同报告 3 条修订（section/correction/status）、跨报告标记含 undone→done 演变与 deleted、配套示例标签 |

## 4. TypeScript 侧（2水群，commit `230268d` + `be21111`）

- schema.ts / db.ts：内嵌 DDL v5 + 迁移链；
- dao.ts：`insertReportRevision` / `insertMarking`（不可变事实，冲突返回已有 id）、`listRevisions`、`listMarkingsLatest`；
- mirror.ts：`mirrorReportRevision` / `mirrorMarking`（safe 包裹；**事件源接线留插件侧 P3**）；
- **T4 修复（实施中发现的真实 bug）**：原 `upsertReport` 冲突分支 `status=excluded.status`
  会使镜像重放把 final 报告降回 draft——已删除该赋值，final 修订后仍 final、draft 不被自动
  final，测试双分支钉死。

## 5. 验收实测（数据负责人终审）

- schema 语义比对：TS 内嵌 DDL vs schema.sql，30 对象完全一致；
- db-sqlite 23/23 全过（迁移幂等、越界拒开、幂等键、T4 双分支）；全量 423/423；
- 真实库迁移冒烟通过；隐私扫描通过（合成值、无真实标识）；
- 提交：0数据格式 `ce29213`；2水群 `230268d`、`be21111`（均本地，未 push，随统一推送窗口）。
