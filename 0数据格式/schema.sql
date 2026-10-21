-- ============================================================
-- 微信知识库 · SQLite 模板 DDL（DESIGN.md v0.2 §2 + v0.2.1 评审修订 + v0.4 会话维度/media 表）
-- 表名/字段名与 DESIGN.md 完全一致，修订点见文件尾「修订记录」。
-- 适用：template.db（空模板）与 sample.db（合成假数据）。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 6;   -- schema 版本 6（5→6：entry 增 chat_id 群归属 + v_marking_latest 分组加 chat_id；report_revision/marking 表不动）

-- ------------------------------------------------------------
-- 2.1 资料：一切沉淀的知识单元
-- 修订2：content_hash 语义 = 「仅当 content_md 非空时写 hash，否则 NULL」；
--        归一化（去 BOM、CRLF→LF、strip 首尾空白）后取 SHA-256 hex；
--        唯一性由 CLI/应用层保证，此处只建部分索引（不做硬 UNIQUE）。
-- ------------------------------------------------------------
CREATE TABLE doc (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT,                       -- 大类：paper/tutorial/note/asset/...（二期可升级 category 表）
  source_type  TEXT NOT NULL DEFAULT 'manual'
               CHECK (source_type IN ('manual','chat_digest','web','file_import')),
  source_ref   TEXT,                       -- 来源描述（URL/会话主题/文件说明），不含原文
  file_path    TEXT,                       -- 原文件在 1数据/docs/ 下的相对路径（可空）
  content_md   TEXT,                       -- 正文/摘录 Markdown（可空）
  content_hash TEXT,                       -- 内容指纹 SHA-256；content_md 为空则必须为 NULL
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','archived')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK ((content_md IS NULL AND content_hash IS NULL) OR
         (content_md IS NOT NULL AND content_hash IS NOT NULL))
);
CREATE INDEX idx_doc_cat  ON doc(category);
CREATE INDEX idx_doc_src  ON doc(source_type);
CREATE INDEX idx_doc_hash ON doc(content_hash) WHERE content_hash IS NOT NULL; -- 修订2

-- ------------------------------------------------------------
-- 2.2 标签 + 关联（多对多）
-- ------------------------------------------------------------
CREATE TABLE tag (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE doc_tag (
  doc_id INTEGER NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (doc_id, tag_id)
);
CREATE INDEX idx_doc_tag_tag ON doc_tag(tag_id);   -- 修订5：反查某 tag 下所有 doc

-- ------------------------------------------------------------
-- 2.3 日志：日 / 周 / 月报告
-- v0.4（修订7）：重建加 chat_id（'aggregate'=跨群聚合；冲突键改三元组
-- UNIQUE(period_type, period_start, chat_id)）；周期一致性 CHECK 与
-- 日期格式 GLOB 防线（修订3/修订6）原文保留。
-- ------------------------------------------------------------
CREATE TABLE report (
  id           INTEGER PRIMARY KEY,
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  title        TEXT NOT NULL,              -- 如「周报 2026-W42」；聚合报告不带群后缀
  content_md   TEXT NOT NULL,              -- Markdown 正文
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','final')),
  chat_id      TEXT NOT NULL DEFAULT 'aggregate'
               CHECK (length(chat_id) BETWEEN 1 AND 128),   -- 修订7：'aggregate'=跨群聚合
  doc_ids_hint TEXT,                       -- 引用资料 id 列表（JSON 数组）。仅提示用、可失效（二期以 report_doc 关联表替代）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (period_type, period_start, chat_id),
  CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_end   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_end >= period_start),
  CHECK (period_type <> 'daily'   OR (period_end = period_start)),
  CHECK (period_type <> 'weekly'  OR (strftime('%w', period_start) = '1'
                                      AND period_end = date(period_start, '+6 days'))),
  CHECK (period_type <> 'monthly' OR (strftime('%d', period_start) = '01'
                                      AND period_end = date(period_start, '+1 month', '-1 day')))
);
CREATE INDEX idx_report_period ON report(period_type, period_start);
CREATE INDEX idx_report_status ON report(status);
CREATE INDEX idx_report_chat   ON report(chat_id, period_start);   -- 修订7

-- ------------------------------------------------------------
-- 2.3.1 media 媒体元数据表（v0.4 修订8，新增）
-- 媒体本体永不入库：只存地址与元数据。path_kind 区分本机地址 / 归档地址。
-- ------------------------------------------------------------
CREATE TABLE media (
  id         INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  media_type TEXT NOT NULL CHECK (media_type IN ('image','video','file','voice')),
  file_name  TEXT,
  ext        TEXT CHECK (ext IS NULL OR (ext = lower(ext) AND ext NOT LIKE '%.%' AND length(ext) BETWEEN 1 AND 16)),
  size       INTEGER CHECK (size IS NULL OR size >= 0),
  md5        TEXT CHECK (md5 IS NULL OR length(md5) = 32),
  path       TEXT,
  path_kind  TEXT CHECK (path_kind IN ('local','archive')),          -- 修订8
  status     TEXT NOT NULL DEFAULT 'available'
             CHECK (status IN ('available','pending','missing')),
  source_key TEXT UNIQUE,
  source_ts  INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status <> 'available' OR path IS NOT NULL)   -- available 必须有地址
);
CREATE INDEX idx_media_chat    ON media(chat_id, media_type);
CREATE INDEX idx_media_created ON media(created_at);
CREATE INDEX idx_media_status  ON media(status);

-- ------------------------------------------------------------
-- 2.4 日志条目：面向报告的原子素材
-- 修订1：外键 ON DELETE SET NULL；修订5：部分索引筛未归档/关联条目
-- ------------------------------------------------------------
CREATE TABLE entry (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,             -- 记录时间戳
  kind        TEXT NOT NULL DEFAULT 'note'
              CHECK (kind IN ('note','todo','done','idea','issue')),
  content_md  TEXT NOT NULL,
  report_id   INTEGER REFERENCES report(id) ON DELETE SET NULL,  -- 空=未归档
  doc_id      INTEGER REFERENCES doc(id)    ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  -- 修订11：群归属（chat_id 列加在表尾，与 5→6 迁移 ALTER TABLE ADD COLUMN 后的列序一致；
  -- 既有行经迁移回填 'aggregate'）
  chat_id     TEXT NOT NULL DEFAULT 'aggregate'
              CHECK (length(chat_id) BETWEEN 1 AND 128)
);
CREATE INDEX idx_entry_ts      ON entry(ts);
CREATE INDEX idx_entry_pending ON entry(report_id) WHERE report_id IS NULL; -- 修订5
CREATE INDEX idx_entry_doc     ON entry(doc_id)     WHERE doc_id IS NOT NULL; -- 修订5
CREATE INDEX idx_entry_chat    ON entry(chat_id, ts);                          -- 修订11

-- ------------------------------------------------------------
-- 2.5 会话摘要（二期由「2水群」项目自动写入）：只存要点，绝不存原文。
--     表名/字段名冻结，勿改。
-- 修订1：doc_id 外键 ON DELETE SET NULL；修订4：source_key 幂等键 + created_by；
-- 修订6：happened_on 日期格式 GLOB 防线。
-- 外部写入规约（README/PRIVACY 详述）：PRAGMA foreign_keys=ON;
--   PRAGMA busy_timeout=5000; BEGIN IMMEDIATE 短事务; 单写者原则。
-- ------------------------------------------------------------
CREATE TABLE chat_digest (
  id          INTEGER PRIMARY KEY,
  chat_topic  TEXT NOT NULL,               -- 会话主题描述（非群名亦可）
  digest_md   TEXT NOT NULL,               -- 提炼要点（绝不存原文）
  happened_on TEXT
              CHECK (happened_on IS NULL OR
                     happened_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  doc_id      INTEGER REFERENCES doc(id) ON DELETE SET NULL,
  source_key  TEXT UNIQUE,                 -- 幂等键：外部程序生成，如 'topic:2026-01-05:ab12cd34'
  created_by  TEXT NOT NULL DEFAULT 'cli', -- 写入方：cli / 2水群 项目名等
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_digest_day ON chat_digest(happened_on);

-- ------------------------------------------------------------
-- 2.3.2 report_revision 报告修订历史（v0.6 修订9，TECH-v0.6 §1.1）
-- 修订事件是不可变事实：source_key 幂等键，重放不产生重复行、不做 UPDATE。
-- 不建指向 report 的 FK——修订事件可先于报告行存在（补发场景），查询按
-- (chat_id, period_type, period_start) 关联。
-- ------------------------------------------------------------
CREATE TABLE report_revision (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  ts           INTEGER NOT NULL,              -- 修订发生时刻
  type         TEXT NOT NULL,                 -- 修订类型（自由短词：section/correction/status…）
  target_ref   TEXT,                          -- 段落/条目引用（可空）
  summary      TEXT,                          -- 元数据摘要（红线：不含消息/语句原文）
  source       TEXT NOT NULL CHECK (source IN ('chat','web')),
  source_key   TEXT NOT NULL UNIQUE,          -- 幂等键，插件生成（如 rev:<chatId>:<period>:<ts>:<n>）
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_revision_report ON report_revision(chat_id, period_type, period_start, ts);
CREATE INDEX idx_revision_ts ON report_revision(ts);

-- ------------------------------------------------------------
-- 2.3.3 marking 完成情况标记（v0.6 修订10，TECH-v0.6 §1.2）
-- kind 三态 done/undone/deleted；同一 target_ref 的状态演变 = 追加行（不可变事实）。
-- ------------------------------------------------------------
CREATE TABLE marking (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  kind         TEXT NOT NULL CHECK (kind IN ('done','undone','deleted')),
  target_ref   TEXT NOT NULL,                 -- 任务/事项标识
  ts           INTEGER NOT NULL,              -- 标记时刻
  source       TEXT NOT NULL CHECK (source IN ('chat','web')),
  source_key   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_marking_chat ON marking(chat_id, kind, ts);
CREATE INDEX idx_marking_target ON marking(target_ref);

-- 「未完成事项」聚合 = 每 (chat_id, target_ref) 取最新一条；同 ts 并列时取 id 大者（MAX(id) 兜底）。
-- 修订11：分组加 chat_id——不同群可各自维护同一 target_ref（如同名任务）而互不串态。
CREATE VIEW v_marking_latest AS
SELECT m.* FROM marking m
JOIN (SELECT chat_id, target_ref, MAX(ts) AS mx, MAX(id) AS mi
      FROM marking GROUP BY chat_id, target_ref) t
  ON m.chat_id = t.chat_id AND m.target_ref = t.target_ref
 AND m.ts = t.mx AND m.id = t.mi;

-- ------------------------------------------------------------
-- 2.3.4 v_report_revised 修订视图（v0.6，T1 方案 b：不加 report 列，视图推导）
-- ------------------------------------------------------------
CREATE VIEW v_report_revised AS
SELECT chat_id, period_type, period_start, COUNT(*) AS revision_count, MAX(ts) AS revised_at
FROM report_revision GROUP BY chat_id, period_type, period_start;

-- ------------------------------------------------------------
-- 2.6 视图：周期日志全文 + 条目数（r.* 通配，自动带出 chat_id）
-- ------------------------------------------------------------
CREATE VIEW v_report_full AS
SELECT r.*, (SELECT COUNT(*) FROM entry e WHERE e.report_id = r.id) AS entry_count
FROM report r
ORDER BY r.period_type, r.period_start DESC;

-- ============================================================
-- 修订记录
-- （v0.2.1，设计评审采纳，已回写 DESIGN.md「修订记录」）
-- 1. entry.report_id / entry.doc_id / chat_digest.doc_id 外键 ON DELETE SET NULL。
-- 2. content_hash：仅 content_md 非空时写；归一化后 SHA-256；部分索引 idx_doc_hash；
--    CLI 命中提示「已存在相同内容（id=N）」并拒绝。
-- 3. report 周期一致性 CHECK（daily 同日 / weekly 周一起+6 天 / monthly 首日+月末）。
-- 4. chat_digest 增列 source_key TEXT UNIQUE 与 created_by TEXT NOT NULL DEFAULT 'cli'。
-- 5. 补索引：idx_entry_pending、idx_entry_doc、idx_doc_tag_tag。
-- 6. 日期格式防线 CHECK（GLOB YYYY-MM-DD）：happened_on、report.period_start/period_end。
-- （v0.4，会话维度 + media 表，TECH-v0.4.md 定稿）
-- 7. report 重建：加 chat_id TEXT NOT NULL DEFAULT 'aggregate'（位于 status 之后），
--    冲突键改 UNIQUE(period_type, period_start, chat_id)；新增索引 idx_report_chat；
--    迁移（user_version 3→4）：建 report_new → 按列名回填 chat_id='aggregate' →
--    DROP report → RENAME，单事务。GLOB/周期 CHECK 原文保留。
-- 8. 新增 media 表（媒体元数据，本体永不入库）：path_kind ∈ local/archive、
--    status ∈ available/pending/missing、source_key 幂等键、
--    CHECK(status<>'available' OR path IS NOT NULL)；补索引 idx_media_chat/created/status。
-- （v0.6，审批双通道与报告修订流，TECH-v0.6.md 定稿 + REPLY-v0.6 裁定）
-- 9. 新增 report_revision 表（修订历史，不可变事实）：source_key 幂等、不建 report FK、
--    summary 仅元数据摘要；视图 v_report_revised（COUNT/MAX(ts) 推导，替代 report 轻量列）。
-- 10. 新增 marking 表（完成情况标记，kind 三态 done/undone/deleted）：source_key 幂等、
--    同 target_ref 追加行表达状态演变；视图 v_marking_latest（每 target_ref 最新一条，
--    同 ts 并列取 MAX(id) 兜底）。
-- （v6，会话级 entry 群归属，工单 D-3/D-4，2026-10-20）
-- 11. entry 增列 chat_id TEXT NOT NULL DEFAULT 'aggregate'（列序在表尾，与迁移
--     ALTER TABLE ADD COLUMN 后一致；既有行回填 'aggregate'）；补索引 idx_entry_chat；
--     视图 v_marking_latest 分组改 (chat_id, target_ref)——不同群同名任务各留最新态。
--     迁移（user_version 5→6）：ALTER ADD + 回填 + DROP/重建 v_marking_latest，
--     report_revision/marking 表零改动，单事务幂等。
-- 二期规划（本期不做）：FTS5 全文索引、report_doc 关联表、uuid 业务键、category 表。
-- ============================================================
