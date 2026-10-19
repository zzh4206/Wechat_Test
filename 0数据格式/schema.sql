-- ============================================================
-- 微信知识库 · SQLite 模板 DDL（DESIGN.md v0.2 §2 + 设计评审修订 v0.2.1，接口冻结）
-- 表名/字段名与 DESIGN.md 完全一致，修订点见文件尾「修订记录」。
-- 适用：template.db（空模板）与 sample.db（合成假数据）。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 3;   -- schema 版本 v0.2.1

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
-- 修订3：周期一致性 CHECK；修订6：日期格式 GLOB 防线
-- ------------------------------------------------------------
CREATE TABLE report (
  id           INTEGER PRIMARY KEY,
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  title        TEXT NOT NULL,              -- 如「周报 2026-W42」
  content_md   TEXT NOT NULL,              -- Markdown 正文
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','final')),
  doc_ids_hint TEXT,                       -- 引用资料 id 列表（JSON 数组）。仅提示用、可失效（二期以 report_doc 关联表替代）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (period_type, period_start),
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
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_entry_ts      ON entry(ts);
CREATE INDEX idx_entry_pending ON entry(report_id) WHERE report_id IS NULL; -- 修订5
CREATE INDEX idx_entry_doc     ON entry(doc_id)     WHERE doc_id IS NOT NULL; -- 修订5

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
-- 2.6 视图：周期日志全文 + 条目数
-- ------------------------------------------------------------
CREATE VIEW v_report_full AS
SELECT r.*, (SELECT COUNT(*) FROM entry e WHERE e.report_id = r.id) AS entry_count
FROM report r
ORDER BY r.period_type, r.period_start DESC;

-- ============================================================
-- 修订记录（v0.2.1，设计评审采纳，已回写 DESIGN.md「修订记录」）
-- 1. entry.report_id / entry.doc_id / chat_digest.doc_id 外键 ON DELETE SET NULL。
-- 2. content_hash：仅 content_md 非空时写；归一化后 SHA-256；部分索引 idx_doc_hash；
--    CLI 命中提示「已存在相同内容（id=N）」并拒绝。
-- 3. report 周期一致性 CHECK（daily 同日 / weekly 周一起+6 天 / monthly 首日+月末）。
-- 4. chat_digest 增列 source_key TEXT UNIQUE 与 created_by TEXT NOT NULL DEFAULT 'cli'。
-- 5. 补索引：idx_entry_pending、idx_entry_doc、idx_doc_tag_tag。
-- 6. 日期格式防线 CHECK（GLOB YYYY-MM-DD）：happened_on、report.period_start/period_end。
-- 二期规划（本期不做）：FTS5 全文索引、report_doc 关联表、uuid 业务键、媒体附件表、category 表。
-- ============================================================
