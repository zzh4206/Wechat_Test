/**
 * schema.ts：知识库 SQLite DDL（冻结接口）。
 *
 * 为什么内嵌字符串而不是运行时读 0数据格式/schema.sql：
 * 1) 构建产物 lib/ 必须自包含——插件安装到 DSH profile 目录后，兄弟目录
 *    「0数据格式」不存在，运行时读相对路径会直接失败；
 * 2) 读绝对路径则要把家目录写进源码，触碰 check-sensitive.sh 红线；
 * 3) schema 已冻结（DESIGN.md v0.2.1），漂移风险低；若上游变更，
 *    以本文件 + user_version 校验兜底。
 *
 * 与 0数据格式/schema.sql 保持逐字一致（v0.2.1，user_version=3）。
 */
export const SCHEMA_VERSION = 3

export const SCHEMA_SQL = `
PRAGMA user_version = 3;

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
  doc_ids_hint TEXT,
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
CREATE INDEX IF NOT EXISTS idx_report_period ON report(period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status);

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
