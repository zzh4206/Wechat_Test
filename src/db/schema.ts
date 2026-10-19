/**
 * schema.ts：知识库 SQLite DDL（冻结接口）。
 *
 * 为什么内嵌字符串而不是运行时读 0数据格式/schema.sql：
 * 1) 构建产物 lib/ 必须自包含——插件安装到 DSH profile 目录后，兄弟目录
 *    「0数据格式」不存在，运行时读相对路径会直接失败；
 * 2) 读绝对路径则要把家目录写进源码，触碰 check-sensitive.sh 红线；
 * 3) schema 漂移风险低；若上游变更，以本文件 + user_version 校验兜底。
 *
 * 与 0数据格式/schema.sql 保持语义逐字一致（v0.4，user_version=4）：
 * report 重建含 chat_id（冲突键三元组），新增 media 表；周期 GLOB/CHECK 原文保留。
 */
export const SCHEMA_VERSION = 4

/** v0.4 全量 DDL（全新库直接执行；含 user_version=4） */
export const SCHEMA_SQL = `
PRAGMA user_version = 4;

CREATE TABLE IF NOT EXISTS doc (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT,
  source_type  TEXT NOT NULL DEFAULT 'manual'
               CHECK (source_type IN ('manual','chat_digest','web','file_import')),
  source_ref   TEXT,
  file_path    TEXT,
  content_md   TEXT,
  content_hash TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','archived')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK ((content_md IS NULL AND content_hash IS NULL) OR
         (content_md IS NOT NULL AND content_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_doc_cat  ON doc(category);
CREATE INDEX IF NOT EXISTS idx_doc_src  ON doc(source_type);
CREATE INDEX IF NOT EXISTS idx_doc_hash ON doc(content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS tag (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS doc_tag (
  doc_id INTEGER NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (doc_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_tag_tag ON doc_tag(tag_id);

CREATE TABLE IF NOT EXISTS report (
  id           INTEGER PRIMARY KEY,
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  title        TEXT NOT NULL,
  content_md   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','final')),
  chat_id      TEXT NOT NULL DEFAULT 'aggregate'
               CHECK (length(chat_id) BETWEEN 1 AND 128),
  doc_ids_hint TEXT,
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
CREATE INDEX IF NOT EXISTS idx_report_period ON report(period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status);
CREATE INDEX IF NOT EXISTS idx_report_chat   ON report(chat_id, period_start);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  media_type TEXT NOT NULL CHECK (media_type IN ('image','video','file','voice')),
  file_name  TEXT,
  ext        TEXT CHECK (ext IS NULL OR (ext = lower(ext) AND ext NOT LIKE '%.%' AND length(ext) BETWEEN 1 AND 16)),
  size       INTEGER CHECK (size IS NULL OR size >= 0),
  md5        TEXT CHECK (md5 IS NULL OR length(md5) = 32),
  path       TEXT,
  path_kind  TEXT CHECK (path_kind IN ('local','archive')),
  status     TEXT NOT NULL DEFAULT 'available'
             CHECK (status IN ('available','pending','missing')),
  source_key TEXT UNIQUE,
  source_ts  INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status <> 'available' OR path IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_media_chat    ON media(chat_id, media_type);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at);
CREATE INDEX IF NOT EXISTS idx_media_status  ON media(status);

CREATE TABLE IF NOT EXISTS entry (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note'
              CHECK (kind IN ('note','todo','done','idea','issue')),
  content_md  TEXT NOT NULL,
  report_id   INTEGER REFERENCES report(id) ON DELETE SET NULL,
  doc_id      INTEGER REFERENCES doc(id)    ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entry_ts      ON entry(ts);
CREATE INDEX IF NOT EXISTS idx_entry_pending ON entry(report_id) WHERE report_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_entry_doc     ON entry(doc_id)     WHERE doc_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_digest (
  id          INTEGER PRIMARY KEY,
  chat_topic  TEXT NOT NULL,
  digest_md   TEXT NOT NULL,
  happened_on TEXT
              CHECK (happened_on IS NULL OR
                     happened_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  doc_id      INTEGER REFERENCES doc(id) ON DELETE SET NULL,
  source_key  TEXT UNIQUE,
  created_by  TEXT NOT NULL DEFAULT 'cli',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_day ON chat_digest(happened_on);

CREATE VIEW IF NOT EXISTS v_report_full AS
SELECT r.*, (SELECT COUNT(*) FROM entry e WHERE e.report_id = r.id) AS entry_count
FROM report r
ORDER BY r.period_type, r.period_start DESC;
`

/**
 * v3 → v4 迁移 DDL（与 0数据格式 TECH-v0.4.md §1.1 逐字一致）：
 * 重建 report（chat_id 插在 status 之后），按列名显式回填 chat_id='aggregate'，
 * 再建 media 表。执行须包裹在单事务内、先 PRAGMA foreign_keys=OFF（见 db.ts）。
 */
export const MIGRATE_V3_TO_V4_SQL = `
DROP VIEW IF EXISTS v_report_full;   -- report 重建期间视图悬空，末尾重建
CREATE TABLE report_new (
  id           INTEGER PRIMARY KEY,
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  title        TEXT NOT NULL,
  content_md   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  chat_id      TEXT NOT NULL DEFAULT 'aggregate'
               CHECK (length(chat_id) BETWEEN 1 AND 128),
  doc_ids_hint TEXT,
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
INSERT INTO report_new (id, period_type, period_start, period_end, title,
                        content_md, status, chat_id, doc_ids_hint, created_at, updated_at)
  SELECT id, period_type, period_start, period_end, title,
         content_md, status, 'aggregate', doc_ids_hint, created_at, updated_at FROM report;
DROP TABLE report;
ALTER TABLE report_new RENAME TO report;
CREATE INDEX idx_report_period ON report(period_type, period_start);
CREATE INDEX idx_report_status ON report(status);
CREATE INDEX idx_report_chat   ON report(chat_id, period_start);
CREATE TABLE media (
  id         INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  media_type TEXT NOT NULL CHECK (media_type IN ('image','video','file','voice')),
  file_name  TEXT,
  ext        TEXT CHECK (ext IS NULL OR (ext = lower(ext) AND ext NOT LIKE '%.%' AND length(ext) BETWEEN 1 AND 16)),
  size       INTEGER CHECK (size IS NULL OR size >= 0),
  md5        TEXT CHECK (md5 IS NULL OR length(md5) = 32),
  path       TEXT,
  path_kind  TEXT CHECK (path_kind IN ('local','archive')),
  status     TEXT NOT NULL DEFAULT 'available'
             CHECK (status IN ('available','pending','missing')),
  source_key TEXT UNIQUE,
  source_ts  INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status <> 'available' OR path IS NOT NULL)
);
CREATE INDEX idx_media_chat    ON media(chat_id, media_type);
CREATE INDEX idx_media_created ON media(created_at);
CREATE INDEX idx_media_status  ON media(status);
CREATE VIEW v_report_full AS
SELECT r.*, (SELECT COUNT(*) FROM entry e WHERE e.report_id = r.id) AS entry_count
FROM report r
ORDER BY r.period_type, r.period_start DESC;
`
