# Wechat_Test — 微信知识库模板（零真实数据）

SQLite 知识库模板：**资料（doc）+ 日志（report/entry）+ 会话要点（chat_digest）**。
本仓库只含模板、工具与合成假数据；真实数据只在本地 `1数据/`（见 [PRIVACY.md](PRIVACY.md)）。

## 快速开始

```bash
# 1. 生成空模板 template.db 与合成示例 sample.db（可重复运行，幂等重建）
python3 make_template.py

# 2. 记一条未归档条目（--db 默认 ./knowledge.db）
python3 report_cli.py --db sample.db entry add --kind note --text "随手记一条"

# 3. 生成日报/周报/月报（自动归档区间内未归档条目）
python3 report_cli.py --db sample.db report gen --period daily  --date 2026-01-19
python3 report_cli.py --db sample.db report gen --period weekly --date 2026-01-07   # ISO 周，周一起
python3 report_cli.py --db sample.db report gen --period monthly --date 2026-01-15

# 4. 查看 / 列出 / 定稿（draft -> final）
python3 report_cli.py --db sample.db report show --id 3
python3 report_cli.py --db sample.db report list
python3 report_cli.py --db sample.db report finalize --id 3

# 5. 添加资料（自动算 content_hash；重复内容会提示已存在并拒绝）
python3 report_cli.py --db sample.db doc add --title "示例文档" --category note \
    --file ./notes/demo.md --tag "入门,占位"

# 6. 导出 Markdown 文件树（reports/ 与 docs/）
python3 export_md.py --db sample.db --out ./exports
```

## 表关系图（ASCII）

```
                +------------------+       +----------------+
                |      doc         |<--\   |      tag       |
                |------------------|    \  |----------------|
                | id (PK)          |     \ | id (PK)        |
                | title            |      \| name (UNIQUE)  |
                | category         |       +----------------+
                | source_type      |                ^
                | content_md       |                |
                | content_hash     |        +-------+-------+
                | ...              |        |    doc_tag     |
                +------------------+        | (doc_id,tag_id)|
                   ^          ^             +----------------+
                   | (doc_id, SET NULL)      ^
        +----------+----+                    |
        |    entry      |                    |
        |---------------|        +-----------+---------+
        | id (PK)       |        |   chat_digest       |
        | ts, kind      |        |---------------------|
        | content_md    |        | id (PK)             |
        | report_id  --->------- | chat_topic          |
        | doc_id     --->doc     | digest_md  (只存要点)|
        +---------------+        | happened_on         |
               ^                 | source_key (UNIQUE) |
               | (report_id,     | doc_id  --->doc     |
               |  SET NULL)      +---------------------+
        +------------------+
        |     report       |
        |------------------|
        | id (PK)          |
        | period_type      |  daily | weekly | monthly
        | period_start     |  UNIQUE(period_type, period_start)
        | period_end       |  周期一致性 CHECK
        | title, content_md|
        | status           |  draft -> final
        | doc_ids_hint     |  仅提示用、可失效
        +------------------+
        视图 v_report_full = report.* + entry_count
```

三层结构：`entry`（原子素材）→ `report`（日/周/月汇总）→ 沉淀为 `doc`；`chat_digest` 是「聊天 → 要点 → doc」的缓冲。

## 修订记录（v0.2.1，设计评审采纳）

- 外键 SET NULL：entry.report_id / entry.doc_id / chat_digest.doc_id；report 重新生成走 UPDATE 不删建。
- content_hash：仅 content_md 非空时写（去 BOM、CRLF→LF、strip 后 SHA-256），部分索引，CLI 命中提示已存在 id 并拒绝。
- report 周期一致性 CHECK：daily 同日、weekly 周一起+6 天、monthly 首日+月末；日期字段 GLOB 格式防线。
- chat_digest 增 source_key（UNIQUE 幂等键）与 created_by（默认 'cli'）；外部写入规约见 PRIVACY.md。
- 补索引：idx_entry_pending、idx_entry_doc、idx_doc_tag_tag。

## 与 TypeScript 项目的关系（v0.3 定案）

本 schema 是 Wechat_Test 主项目（TypeScript 微信群报告系统）的**正式查询数据层**：
该项目此前只落 JSONL/文本文件（`src/store.ts` 是唯一写入点），不便查看与开发前端，
现约定「**JSONL 仍是事实源 + SQLite 镜像双写**」：

- 驱动：Node 24 内置 `node:sqlite`（零 npm 依赖），短事务 + `busy_timeout` + WAL；
- 写入：`store.ts` 增加可选镜像钩子，SQLite 写失败只记 logger，绝不影响主流程；
- 历史：一次性导入器把既有 state 目录数据迁入 `doc/report/entry/chat_digest`（可重复运行，幂等）；
- 查询：前端/人工一律走本库（视图 `v_report_full`、`idx_entry_pending` 等已就绪）；
- `chat_digest` 从此由 TS 项目写入，`source_key` 幂等键 + 单写者规约（见 [PRIVACY.md](PRIVACY.md)）。

实施进度见下方「路线图」。Python CLI（`report_cli.py` / `export_md.py`）与 TS 镜像**共存通用**：
两边写的是同一个 schema 的同一个库。

## 路线图

- [x] v0.2.1 schema 冻结（含评审修订 6 条）+ Python CLI + Markdown 导出
- [x] TS 数据层：`src/db/`（db / dao / mirror）+ store.ts 双写钩子（2水群 仓库 `2d764f0`，386 测试全过）
- [x] JSONL 历史数据一次性导入器（幂等，实测映射率 ≈100%，重跑行数不变）
- [ ] FTS5 中文全文索引；report_doc 关联表；媒体附件表；category 字典表；前端查询接口
