# REPLY：v0.4 需求评审答复（模板方 → 群聊报告系统）

> 答复日期：2026-10-19 · 评审人：数据负责人
> 结论：**两项需求全部采纳，按《TECH-v0.4》定稿实施**。提出方建议的 DDL 方向正确，模板方做了 4 处修订（见下）。

## 评审意见

| # | 需求 | 结论 | 修订 |
|---|---|---|---|
| 1 | report 增加会话维度 | ✅ 采纳，优先级高 | R1：表重建而非 ALTER；R2：chat_id 加非空/长度防线 |
| 2 | 新增 media 表 | ✅ 采纳，优先级高 | R3：path 增加 path_kind 区分本机/归档；R4：md5/size/ext 加轻量 CHECK |

## 对需求一的答复

- `chat_id TEXT NOT NULL DEFAULT 'aggregate'`、`UNIQUE(period_type, period_start, chat_id)`、`idx_report_chat`：**照单采纳**。
- 修订 R1：SQLite 无法修改 UNIQUE，走「建新表→拷数据→改名」重建（真实库现仅 5 行 report，秒级）；`user_version` 3→4，openDb 时自动迁移且幂等（见技术文档 §4）。
- 修订 R2：chat_id 加 `CHECK (length(chat_id) BETWEEN 1 AND 128)`，防外部写入空串/超长。**不建 chat 维度表**——本库不存会话元数据（隐私口径），前端按群筛选直接 GROUP BY chat_id 即可；display name 留在 TS 侧。
- 兼容承诺：`'aggregate'` 语义保留；report_cli.py `report gen` 新增 `--chat-id`（默认 aggregate）；导入器改为**按群落行**（reports/<chatId>/YYYY-MM-DD.md → chat_id=该群），已入库的 5 行聚合报告保留不动，重跑导入器不产生重复。

## 对需求二的答复

- `media` 表结构与三个索引、`source_key` UNIQUE 幂等、`status` 三态、**本体永不入库**：**照单采纳**。
- 修订 R3：新增 `path_kind TEXT CHECK (path_kind IN ('local','archive'))`——path 的两种形态（微信原始路径 / 1数据 归档路径）由显式列区分，前端和归档流程不用猜路径语义；可空（status='pending' 时两者皆空）。
- 修订 R4：`ext` 统一小写无点（写入方归一，库里加 CHECK `ext = lower(ext) AND ext NOT LIKE '%.%'`）；`md5` 加 `CHECK (md5 IS NULL OR length(md5)=32)`；`size` 加 `CHECK (size IS NULL OR size>=0)`。均为写入防线，成本低。
- 隐私确认：file_name/path/chat_id 属于本机数据（只进 `1数据/knowledge.db`），不进 GitHub；模板与假数据中一律合成值。

## 写入方分工（自 v0.4 起）

| 写入方 | 职责 |
|---|---|
| TS 插件（mirror） | media 表**唯一写入方**（来自 `files --chat-id` 扫描）；report/entry/chat_digest 镜像带 chat_id |
| Python CLI | report gen 支持 --chat-id；media 不做 CLI（避免双写方竞争） |
| 单写者规约 | 不变：BEGIN IMMEDIATE 短事务、busy_timeout=5000（PRIVACY.md §规约） |

验收以《TECH-v0.4》§6 为准，实施完成后双方各自回归。
