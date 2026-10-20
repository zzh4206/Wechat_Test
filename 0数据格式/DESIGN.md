# 微信知识库数据库模板 · 设计文档（v0.2）

> 状态：**待确认**（v0.1 消息原档方案已按需求转向废弃：不存对话原文，聚焦**资料 + 日志**）。
> 模板仓库：本仓库（只放格式/工具/假数据，零真实信息）
> 真实数据落盘：本地 `1数据/` 目录（gitignore，永不上传）

## 1. 需求重述

| 项 | 决策 |
|---|---|
| 核心对象 | ① **资料**（文档、笔记、素材，来源可为聊天提炼/手工/网页）② **日志**（日报/周报/月报） |
| 不做什么 | 不存聊天原文原档（电脑手机天然有）；媒体文件二期 |
| 载体 | SQLite 主库（已确认）；报告正文以 **Markdown 文本存库** + 可选外链文件 |
| 隐私 | 同 v0.1：真实 wxid/内容只在 1数据 |

## 2. Schema v0.2（5 核心表 + 1 可选表）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 2.1 资料：一切沉淀的知识单元
CREATE TABLE doc (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT,                       -- 大类：paper/tutorial/note/asset/...
  source_type  TEXT NOT NULL DEFAULT 'manual'
               CHECK (source_type IN ('manual','chat_digest','web','file_import')),
  source_ref   TEXT,                       -- 来源描述（URL/会话主题/文件说明），不含原文
  file_path    TEXT,                       -- 原文件在 1数据/docs/ 下的相对路径（可空）
  content_md   TEXT,                       -- 正文/摘录 Markdown（可空）
  content_hash TEXT UNIQUE,                -- 内容指纹，去重
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_doc_cat ON doc(category);
CREATE INDEX idx_doc_src ON doc(source_type);

-- 2.2 标签 + 关联（多对多）
CREATE TABLE tag (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE doc_tag (
  doc_id INTEGER NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (doc_id, tag_id)
);

-- 2.3 日志：日 / 周 / 月报告
CREATE TABLE report (
  id           INTEGER PRIMARY KEY,
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,              -- ISO 日期 'YYYY-MM-DD'
  period_end   TEXT NOT NULL,
  title        TEXT NOT NULL,              -- 如「周报 2026-W42」
  content_md   TEXT NOT NULL,              -- Markdown 正文
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','final')),
  doc_ids_hint TEXT,                       -- 引用的资料 id 列表（JSON 数组，轻量冗余）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (period_type, period_start)
);
CREATE INDEX idx_report_period ON report(period_type, period_start);

-- 2.4 日志条目：面向报告的原子素材（当天随手记，日/周报由条目汇总而成）
CREATE TABLE entry (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,             -- 记录时间戳
  kind        TEXT NOT NULL DEFAULT 'note'
              CHECK (kind IN ('note','todo','done','idea','issue')),
  content_md  TEXT NOT NULL,
  report_id   INTEGER REFERENCES report(id),-- 汇入哪份日志（可空=未归档）
  doc_id      INTEGER REFERENCES doc(id),   -- 关联资料（可空）
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_entry_ts ON entry(ts);

-- 2.5 会话摘要（可选，二期启用）：从聊天提炼的结论/要点，绝不存原文
CREATE TABLE chat_digest (
  id          INTEGER PRIMARY KEY,
  chat_topic  TEXT NOT NULL,               -- 会话主题描述（非群名亦可）
  digest_md   TEXT NOT NULL,               -- 提炼要点
  happened_on TEXT,                        -- ISO 日期
  doc_id      INTEGER REFERENCES doc(id),  -- 提炼为资料后回链
  created_at  INTEGER NOT NULL
);

-- 2.6 视图：周期日志全文 + 条目数
CREATE VIEW v_report_full AS
SELECT r.*, (SELECT COUNT(*) FROM entry e WHERE e.report_id = r.id) AS entry_count
FROM report r ORDER BY r.period_type, r.period_start DESC;
```

设计要点：
- **三层结构**：`entry`（原子素材）→ `report`（日/周/月汇总）→ 长期沉淀为 `doc`（资料）；`chat_digest` 是「聊天→资料」的转化缓冲。
- **资料去重**靠 `content_hash`（SHA-256）；报告唯一性靠 `(period_type, period_start)`。
- **报告正文存 Markdown 文本**：单库自包含、可全文检索（二期可挂 FTS5）。
- 对话原文零存储；`source_ref` 只写「来源描述」。

## 3. 仓库布局（Wechat_Test）

```
├── DESIGN.md               # 本文档
├── schema.sql              # 唯一真源 DDL
├── make_template.py        # 生成空 template.db + 合成假数据 sample.db
├── report_cli.py           # 日报/周报/月报与条目的增查 CLI（entry add / report gen）
├── export_md.py            # 日志/资料导出为 Markdown 文件树（1数据/exports/）
├── PRIVACY.md / README.md
```

`1数据/`（本地）：`knowledge.db` + `docs/`（原始文件）+ `exports/`（Markdown 导出）。

## 4. 分工（确认后派工）

| Agent | 任务 |
|---|---|
| A · schema 工程师 | schema.sql / make_template.py / 假数据 / README / PRIVACY.md / 验证 |
| B · 工具工程师 | report_cli.py + export_md.py（基于 A 的 schema，可与 A 串行或并行约定 schema 冻结点） |
| C · 发布工程师 | 推 Wechat_Test + 隐私扫描（A/B 验收后） |

## 5. 修订记录（v0.2.1，设计评审采纳，schema.sql 已同步）

1. **外键删除行为**：`entry.report_id`、`entry.doc_id`、`chat_digest.doc_id` 一律 `ON DELETE SET NULL`；report_cli 的 report 重新生成走 UPDATE 而非删建。
2. **content_hash 语义固化**：仅当 `content_md` 非空时写 hash（否则 NULL）；归一化（去 BOM、CRLF→LF、strip 首尾空白）后取 SHA-256 hex；列为部分索引 `idx_doc_hash … WHERE content_hash IS NOT NULL`，不做硬 UNIQUE；doc add 命中同 hash 时提示「已存在相同内容（id=N）」并拒绝。
3. **report 周期 CHECK**：daily→`period_end=period_start`；weekly→`strftime('%w',period_start)='1'` 且 `period_end=date(period_start,'+6 days')`；monthly→`strftime('%d',period_start)='01'` 且 `period_end=date(period_start,'+1 month','-1 day')`。
4. **chat_digest 增列**：`source_key TEXT UNIQUE`（幂等键，外部程序生成，如 `'topic:YYYY-MM-DD:hash8'`）、`created_by TEXT NOT NULL DEFAULT 'cli'`；外部写入规约（foreign_keys=ON、busy_timeout=5000、BEGIN IMMEDIATE 短事务、单写者）写入 README/PRIVACY。
5. **索引补齐**：`idx_entry_pending`（WHERE report_id IS NULL）、`idx_entry_doc`（WHERE doc_id IS NOT NULL）、`idx_doc_tag_tag`。
6. **日期格式防线**：`happened_on`、`report.period_start/period_end` 加 `CHECK (x IS NULL OR x GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`。

**二期规划（本期不做）**：FTS5 全文索引、report_doc 关联表（暂保留 doc_ids_hint，仅提示、可失效）、uuid 业务键、媒体附件表、category 表。

## 6. v0.3 增补（TypeScript 数据层整合，2026-10-19 定案）

- 定位变更：本 schema 为主项目（TS 微信群报告系统）的正式查询数据层，非独立知识库。
- 同步模式：**JSONL 仍为事实源 + SQLite 镜像双写**（store.ts 可选钩子；SQLite 写失败只记 logger）。
- 驱动：Node 24 内置 `node:sqlite`（DatabaseSync），零 npm 依赖。
- 历史：一次性导入器，JSONL→doc/report/entry/chat_digest，按 content_hash / (period_type,period_start) / source_key 幂等。
- 真实库路径：本地 1数据/knowledge.db（gitignore）。

## 7. v0.4 增补（会话维度 + media 表，2026-10 定案，TECH-v0.4.md 为实施依据）

- report 表重建：增列 `chat_id TEXT NOT NULL DEFAULT 'aggregate'`（status 之后），冲突键改三元组
  `UNIQUE(period_type, period_start, chat_id)`；新增索引 `idx_report_chat(chat_id, period_start)`；
  周期一致性 CHECK 与日期 GLOB 防线原文保留。
- 新增 media 表：媒体本体永不入库，只存地址与元数据；`path_kind ∈ local/archive`、
  `status ∈ available/pending/missing`、`source_key` 幂等键、`CHECK(status<>'available' OR path IS NOT NULL)`。
- 迁移机制：`PRAGMA user_version` 3→4 单事务幂等（Python report_cli 与 TS db.ts openDb 双实现，逻辑一致）；
  全新库（0）直接建 v4；>4 拒开。
- 写入方适配：report_cli `report gen --chat-id`（缺省 aggregate，标题不带群后缀）、export_md 非 aggregate
  行导出至 `reports/<chatId>/`；TS dao upsertReport 带 chatId、upsertMedia/listMediaByChat、
  mirror 与导入器按群落 report 行（`reports/<chatId>/YYYY-MM-DD.md` → chat_id=目录名群 ID）。
- 二期规划更新：媒体附件表本期已落（media）；FTS5 / report_doc / uuid / category 仍不做。

## 8. v0.4 增补（会话维度 + media 表，2026-10-19 定稿）

- `report` 重建：新增 `chat_id`（默认 'aggregate'），UNIQUE 改 `(period_type, period_start, chat_id)`，双群同日日报可共存；`user_version` 3→4，两端（Python/TS）openDb 自动幂等迁移。
- 新增 `media` 表：媒体**地址与元数据**登记（本体永不入库），`source_key` 幂等、`path_kind` 区分本机/归档、`available` 必有 path；TS 插件为唯一写入方。
- 导入器口径：`reports/<chatId>/YYYY-MM-DD.md` 按群落行；非 @chatroom 目录（如 summary）以目录名为伪会话维度落行，属**确认行为**；既有 aggregate 行永不删除。
- 依据：REQUIREMENT-v0.4 / REPLY-v0.4 / TECH-v0.4（同目录）。

## 9. v0.4.1 增补（报告类型显式通道，2026-10-19，由报告系统侧代为回填；数据负责人复验合并入主分支）

- 背景：报告文件布局 `reports/<chatId>/<dateKey>.md` 不含类型信息，路径侧镜像/导入器只能
  猜测类型——周报（dateKey=周一）与月报（dateKey=1 号）能通过 daily 的 CHECK 校验，
  被**静默错标为 daily**（缺口 G1/G2）。
- 约定：报告引擎落盘改走显式通道 `store.writeReport(kind, chatId, dateKey, md)`（kind 由
  代码给出；文件布局零破坏）；镜像按 `kind→period` 推导入库：
  daily=(d,d)、weekly=(该周周一, 周一+6 天)、monthly=(当月 1 号, 当月月末)；
  dateKey 非法（月报非 1 号 / 非日期）→ 跳过并 warn，**绝不猜测错标**。
- 导入器同口径：文件系统侧按报告标题行（`# 日报 / 周报 / 月报`）识别；
  识别不出回退 daily 并在导入汇总中计数上报；period 推导与镜像共用同一实现（单一事实源）。
- 路径侧镜像不再从 `reports/…` 路径写入 report 行（避免与显式通道双重写入/口径漂移）。
- 口径裁定（数据负责人）：聚合报告 chat_id 统一为 `'aggregate'`（`'summary'` 伪会话废止）；
  media `source_key` 采用 `<chatId>:<file_id>` 文件粒度（首见 msgId 溯源留二期可选列）。
- 模板独立快照分支：`0数据格式-template`（本节同文），主分支以本子目录为准。
