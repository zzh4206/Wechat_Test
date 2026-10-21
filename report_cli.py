#!/usr/bin/env python3
"""report_cli.py — 微信知识库 CLI（entry / report / doc / revision / marking），schema v0.6。

用法:
    python3 report_cli.py [--db PATH] entry add --kind note --text "..." [--doc-id N]
    python3 report_cli.py [--db PATH] report gen --period daily|weekly|monthly --date YYYY-MM-DD [--chat-id ID]
    python3 report_cli.py [--db PATH] report show --id N
    python3 report_cli.py [--db PATH] report list
    python3 report_cli.py [--db PATH] report finalize --id N
    python3 report_cli.py [--db PATH] doc add --title T [--category C] [--file PATH] [--tag a,b]
    python3 report_cli.py [--db PATH] revision add --chat-id ID --period daily|weekly|monthly
                          --date YYYY-MM-DD --type T [--target R] [--summary S] [--source chat|web] [--ts N]
    python3 report_cli.py [--db PATH] revisions list [--chat-id ID] [--period P] [--date D]
    python3 report_cli.py [--db PATH] marking add --chat-id ID --kind done|undone|deleted
                          --target R [--source chat|web] [--ts N]
    python3 report_cli.py [--db PATH] markings latest [--kind K]

--db 默认 ./knowledge.db。所有写操作都会更新 updated_at（entry 除外，其用 created_at）。
打开库时自动执行 schema 迁移（链式幂等：5→6 entry 增 chat_id 回填 'aggregate' 并重建
v_marking_latest；4 先升 5 再 6；3 先升 4 再 5 再 6；0=全新建 v6；其余拒开）。
全部连接 busy_timeout=5000，写路径统一 BEGIN IMMEDIATE 短事务（D-5）。
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
from contextlib import contextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_SQL_PATH = os.path.join(HERE, "schema.sql")

SCHEMA_VERSION = 6

# v0.4 report 表重建 DDL（与 schema.sql 逐字一致）；迁移按列名显式回填 chat_id='aggregate'
MIGRATE_3_TO_4_SQL = """
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
"""

# v0.6 纯新增 DDL（与 schema.sql 逐字一致；TECH-v0.6 §1）：两表两视图，既有表零改动
MIGRATE_4_TO_5_SQL = """
CREATE TABLE report_revision (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  target_ref   TEXT,
  summary      TEXT,
  source       TEXT NOT NULL CHECK (source IN ('chat','web')),
  source_key   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_revision_report ON report_revision(chat_id, period_type, period_start, ts);
CREATE INDEX idx_revision_ts ON report_revision(ts);
CREATE TABLE marking (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  kind         TEXT NOT NULL CHECK (kind IN ('done','undone','deleted')),
  target_ref   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('chat','web')),
  source_key   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_marking_chat ON marking(chat_id, kind, ts);
CREATE INDEX idx_marking_target ON marking(target_ref);
CREATE VIEW v_marking_latest AS
SELECT m.* FROM marking m
JOIN (SELECT target_ref, MAX(ts) AS mx, MAX(id) AS mi FROM marking GROUP BY target_ref) t
  ON m.target_ref = t.target_ref AND m.ts = t.mx AND m.id = t.mi;
CREATE VIEW v_report_revised AS
SELECT chat_id, period_type, period_start, COUNT(*) AS revision_count, MAX(ts) AS revised_at
FROM report_revision GROUP BY chat_id, period_type, period_start;
"""

# v6 迁移 DDL（与 schema.sql 修订11 一致）：entry ALTER ADD chat_id（既有行经 DEFAULT
# 'aggregate' 回填）+ 补索引 + 重建 v_marking_latest（分组加 chat_id）。
# report_revision / marking 表零改动。ALTER ADD/CREATE INDEX/DROP VIEW 均幂等安全地
# 包在单事务里（重放只在 user_version 仍=5 时发生一次）。
MIGRATE_5_TO_6_SQL = """
ALTER TABLE entry ADD COLUMN chat_id TEXT NOT NULL DEFAULT 'aggregate'
     CHECK (length(chat_id) BETWEEN 1 AND 128);
CREATE INDEX idx_entry_chat ON entry(chat_id, ts);
DROP VIEW v_marking_latest;
CREATE VIEW v_marking_latest AS
SELECT m.* FROM marking m
JOIN (SELECT chat_id, target_ref, MAX(ts) AS mx, MAX(id) AS mi
      FROM marking GROUP BY chat_id, target_ref) t
  ON m.chat_id = t.chat_id AND m.target_ref = t.target_ref
 AND m.ts = t.mx AND m.id = t.mi;
"""


def user_version(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def ensure_schema(conn: sqlite3.Connection) -> None:
    """schema 迁移（幂等、自动，链式）：5→6 单事务（entry ALTER ADD chat_id 回填 +
    重建 v_marking_latest）；4 先升 5 再升 6；3 先升 4 再 5 再 6；0=全新建 v6；
    其余（1/2）或 >6 报错拒开。任何一步失败整体回滚该步，user_version 最后置。"""
    v = user_version(conn)
    if v == SCHEMA_VERSION:
        return
    if v > SCHEMA_VERSION:
        sys.exit(f"[错误] 库 schema 版本 v{v} 高于本工具支持的 v{SCHEMA_VERSION}，拒绝打开")
    if v not in (0, 3, 4, 5):
        sys.exit(f"[错误] 不支持的 schema 版本 v{v}（仅支持 0/3/4/5/{SCHEMA_VERSION}）")
    try:
        if v == 0:
            with open(SCHEMA_SQL_PATH, encoding="utf-8") as f:
                conn.executescript(f.read())  # 全量 DDL（含 PRAGMA user_version=6）
            if user_version(conn) != SCHEMA_VERSION:
                raise RuntimeError("全新建库后 user_version != 6")
            return
        # executescript 会隐式提交挂起事务，故把事务写进脚本文本（单事务、可整体回滚）。
        # DROP report 前须关外键（SQLite 迁移规约），否则 entry 子行引用会阻断 DROP。
        conn.execute("PRAGMA foreign_keys = OFF")
        chain = [(4, MIGRATE_3_TO_4_SQL), (5, MIGRATE_4_TO_5_SQL), (6, MIGRATE_5_TO_6_SQL)]
        for i, (target, sql) in enumerate(chain):
            if v >= target:
                continue
            script = ("BEGIN;\n" + sql
                      + f"\nPRAGMA user_version = {target};\nCOMMIT;\n")
            conn.executescript(script)
    except Exception as e:
        conn.rollback()
        sys.exit(f"[错误] schema 迁移失败（已回滚）: {e}")
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def now() -> int:
    return int(dt.datetime.now().timestamp())


def iso(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def connect(path: str) -> sqlite3.Connection:
    if not os.path.exists(path):
        sys.exit(f"[错误] 数据库不存在: {os.path.abspath(path)}（先运行 make_template.py）")
    conn = sqlite3.connect(path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None            # 显式事务控制（BEGIN IMMEDIATE 短事务）
    conn.execute("PRAGMA busy_timeout = 5000")   # D-5：全部连接统一忙等 5s
    conn.execute("PRAGMA foreign_keys = ON")
    ensure_schema(conn)
    return conn


@contextmanager
def immediate(conn: sqlite3.Connection):
    """D-5：写路径统一 BEGIN IMMEDIATE 短事务（拿写锁再写，避免 SQLITE_BUSY 升级死锁）。
    异常回滚并向上抛；正常结束 COMMIT。"""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.rollback()
        raise
    else:
        conn.commit()


def period_range(period: str, day: str) -> tuple:
    """返回 (period_start, period_end, title)，满足 schema 的周期一致性 CHECK。
    daily: 同日；weekly: ISO 周（周一起，+6 天）；monthly: 当月 1 日至月末。"""
    d = dt.date.fromisoformat(day)
    if period == "daily":
        return d.isoformat(), d.isoformat(), f"日报 {d.isoformat()}"
    if period == "weekly":
        mon = d - dt.timedelta(days=d.isoweekday() - 1)
        end = mon + dt.timedelta(days=6)
        iso_y, iso_w, _ = mon.isocalendar()
        return mon.isoformat(), end.isoformat(), f"周报 {iso_y}-W{iso_w:02d}"
    if period == "monthly":
        start = d.replace(day=1)
        end = (start.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
        return start.isoformat(), end.isoformat(), f"月报 {d.strftime('%Y-%m')}"
    sys.exit(f"[错误] 未知周期类型: {period}")


def content_hash(text: str) -> str:
    """修订2：归一化（去 BOM、CRLF→LF、去首尾空白）后取 SHA-256 hex。"""
    if text.startswith("﻿"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- entry
def entry_add(a) -> None:
    conn = connect(a.db)
    t = now()
    chat_id = a.chat_id or "aggregate"
    if a.doc_id is not None and not conn.execute(
            "SELECT 1 FROM doc WHERE id = ?", (a.doc_id,)).fetchone():
        sys.exit(f"[错误] doc #{a.doc_id} 不存在")
    with immediate(conn):
        cur = conn.execute(
            "INSERT INTO entry (ts, kind, content_md, report_id, doc_id, created_at, chat_id)"
            " VALUES (?, ?, ?, NULL, ?, ?, ?)",
            (t, a.kind, a.text.strip(), a.doc_id, t, chat_id))
    print(f"OK entry #{cur.lastrowid} added (kind={a.kind}, chat_id={chat_id}, 未归档)")
    conn.close()


# ---------------------------------------------------------------- report
def build_content_md(r: sqlite3.Row, entries: list) -> str:
    kind_names = {"note": "笔记", "todo": "待办", "done": "完成", "idea": "想法", "issue": "问题"}
    order = ["todo", "done", "note", "idea", "issue"]
    lines = [
        f"# {r['title']}",
        "",
        f"- 周期：{r['period_start']} ~ {r['period_end']}",
        f"- 条目数：{len(entries)}",
        "",
    ]
    for k in order:
        group = [e for e in entries if e["kind"] == k]
        if group:
            lines.append(f"## {kind_names[k]}")
            lines.append("")
            for e in group:
                d = f"（doc #{e['doc_id']}）" if e["doc_id"] else ""
                lines.append(f"- [#{e['id']}] {e['content_md']}{d}")
            lines.append("")
    lines += ["## 小结", "", "（待补充）", ""]
    return "\n".join(lines)


def report_gen(a) -> None:
    chat_id = a.chat_id or "aggregate"
    start, end, base_title = period_range(a.period, a.date)
    # v0.4：非聚合报告标题带会话段（如「周报 2026-W02 demo-chat-1」）；聚合不加后缀
    title = base_title if chat_id == "aggregate" else f"{base_title} {chat_id}"
    conn = connect(a.db)
    t = now()
    with immediate(conn):
        row = conn.execute(
            "SELECT id, status FROM report WHERE period_type = ? AND period_start = ? AND chat_id = ?",
            (a.period, start, chat_id)).fetchone()
        if row:                                    # 修订1：重新生成走 UPDATE，不删建
            rid = row["id"]
            if row["status"] == "final" and not a.force:   # D-13：final 需显式 --force
                sys.exit(f"[错误] report #{rid} 已定稿（final）；重新生成需加 --force")
            conn.execute(
                "UPDATE report SET period_end = ?, title = ?, status = 'draft',"
                " updated_at = ? WHERE id = ?", (end, title, t, rid))
            # 旧条目先退回未归档，再重新归档
            conn.execute("UPDATE entry SET report_id = NULL WHERE report_id = ?", (rid,))
            action = f"regenerated report #{rid}"
        else:
            cur = conn.execute(
                "INSERT INTO report (period_type, period_start, period_end, title,"
                " content_md, status, chat_id, doc_ids_hint, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, '', 'draft', ?, NULL, ?, ?)",
                (a.period, start, end, title, chat_id, t, t))
            rid = cur.lastrowid
            action = f"created report #{rid}"

        # D-3：只归档本群（chat_id=?) 的未归档 entry——aggregate 不再串吃各群条目
        lo = int(dt.datetime.fromisoformat(start + "T00:00:00").timestamp())
        hi = int(dt.datetime.fromisoformat(end + "T23:59:59").timestamp())
        entries = conn.execute(
            "SELECT * FROM entry WHERE report_id IS NULL AND chat_id = ? AND ts BETWEEN ? AND ?"
            " ORDER BY ts", (chat_id, lo, hi)).fetchall()
        doc_ids = sorted({e["doc_id"] for e in entries if e["doc_id"] is not None})
        conn.executemany("UPDATE entry SET report_id = ? WHERE id = ?",
                         [(rid, e["id"]) for e in entries])
        conn.execute(
            "UPDATE report SET content_md = ?, doc_ids_hint = ?, updated_at = ? WHERE id = ?",
            (build_content_md({"title": title, "period_start": start, "period_end": end},
                              entries),
             json.dumps(doc_ids) if doc_ids else None, t, rid))
    print(f"OK {action} [{a.period} {start}~{end}] 归档 {len(entries)} 条未归档 entry（chat_id={chat_id}）")
    conn.close()


def report_show(a) -> None:
    conn = connect(a.db)
    r = conn.execute("SELECT * FROM v_report_full WHERE id = ?", (a.id,)).fetchone()
    if not r:
        sys.exit(f"[错误] report #{a.id} 不存在")
    keys = ["id", "period_type", "period_start", "period_end", "chat_id", "title",
            "status", "doc_ids_hint", "entry_count"]
    print("=" * 60)
    for k in keys:
        print(f"{k:14}: {r[k]}")
    print(f"{'created/updated':14}: {iso(r['created_at'])} / {iso(r['updated_at'])}")
    print("=" * 60)
    print(r["content_md"] or "(空)")


def report_list(a) -> None:
    conn = connect(a.db)
    rows = conn.execute(
        "SELECT id, period_type, period_start, period_end, chat_id, title, status, entry_count"
        " FROM v_report_full ORDER BY period_start DESC").fetchall()
    if not rows:
        print("(无报告)")
    for r in rows:
        print(f"#{r['id']:<3} {r['period_type']:<7} {r['period_start']}~{r['period_end']}"
              f"  [{r['chat_id']}]  {r['title']}  [{r['status']}]  entries={r['entry_count']}")
    conn.close()


def report_finalize(a) -> None:
    conn = connect(a.db)
    r = conn.execute("SELECT status FROM report WHERE id = ?", (a.id,)).fetchone()
    if not r:
        sys.exit(f"[错误] report #{a.id} 不存在")
    if r["status"] != "draft":
        sys.exit(f"[错误] report #{a.id} 状态为 {r['status']}，仅 draft 可 finalize")
    with immediate(conn):
        conn.execute("UPDATE report SET status = 'final', updated_at = ? WHERE id = ?",
                     (now(), a.id))
    print(f"OK report #{a.id} finalized (draft -> final)")
    conn.close()


# ---------------------------------------------------------------- doc
def sanitize(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip().strip(".")
    return name or "untitled"


def doc_add(a) -> None:
    conn = connect(a.db)
    t = now()
    text = ""
    if a.file:
        if not os.path.exists(a.file):
            sys.exit(f"[错误] 文件不存在: {a.file}")
        with open(a.file, encoding="utf-8") as f:
            text = f.read()
    if not text:
        sys.exit("[错误] doc add 需要 --file 提供正文（否则无法计算 content_hash）")
    h = content_hash(text)
    dup = conn.execute("SELECT id, title FROM doc WHERE content_hash = ?", (h,)).fetchone()
    if dup:                                    # 修订2：提示已存在，不插入
        print(f"[拒绝] 已存在相同内容（id={dup['id']}, title={dup['title']}），"
              f"content_hash={h[:12]}… 未新增 doc")
        conn.close()
        sys.exit(1)
    with immediate(conn):
        cur = conn.execute(
            "INSERT INTO doc (title, category, source_type, source_ref, file_path,"
            " content_md, content_hash, status, created_at, updated_at)"
            " VALUES (?, ?, 'manual', ?, ?, ?, ?, 'active', ?, ?)",
            (a.title, a.category, f"CLI 导入文件 {a.file}" if a.file else None,
             a.file, text, h, t, t))
        did = cur.lastrowid
        for name in [x.strip() for x in (a.tag or "").split(",") if x.strip()]:
            conn.execute("INSERT OR IGNORE INTO tag (name) VALUES (?)", (name,))
            tid = conn.execute("SELECT id FROM tag WHERE name = ?", (name,)).fetchone()["id"]
            conn.execute("INSERT OR IGNORE INTO doc_tag (doc_id, tag_id) VALUES (?, ?)",
                         (did, tid))
    print(f"OK doc #{did} added: {a.title} (category={a.category}, tags={a.tag!r},"
          f" hash={h[:12]}…)")
    conn.close()


# ---------------------------------------------------------------- revision / marking（v0.6）
def revision_add(a) -> None:
    """修订事件是不可变事实：source_key 冲突→提示已有 id，不做 UPDATE。"""
    dt.date.fromisoformat(a.date)  # 日期格式防线
    conn = connect(a.db)
    t = a.ts if a.ts is not None else now()
    skey = a.source_key or f"rev:{a.chat_id}:{a.period}:{a.date}:{t}"
    hit = conn.execute("SELECT id FROM report_revision WHERE source_key = ?", (skey,)).fetchone()
    if hit:
        print(f"[跳过] source_key 已存在（id={hit['id']}），修订事件不可变、不更新")
        conn.close()
        return
    with immediate(conn):
        cur = conn.execute(
            "INSERT INTO report_revision (chat_id, period_type, period_start, ts, type,"
            " target_ref, summary, source, source_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (a.chat_id, a.period, a.date, t, a.type, a.target, a.summary, a.source, skey, now()))
    print(f"OK revision #{cur.lastrowid} added ({a.period} {a.date} type={a.type})")
    conn.close()


def revisions_list(a) -> None:
    conn = connect(a.db)
    sql = ("SELECT * FROM report_revision WHERE 1=1")
    args: list = []
    if a.chat_id:
        sql += " AND chat_id = ?"; args.append(a.chat_id)
    if a.period:
        sql += " AND period_type = ?"; args.append(a.period)
    if a.date:
        sql += " AND period_start = ?"; args.append(a.date)
    sql += " ORDER BY ts"
    rows = conn.execute(sql, args).fetchall()
    if not rows:
        print("(无修订记录)")
    for r in rows:
        print(f"#{r['id']:<4} [{r['chat_id']}] {r['period_type']} {r['period_start']}"
              f"  {iso(r['ts'])}  type={r['type']}  target={r['target_ref'] or '-'}"
              f"  summary={r['summary'] or '-'}  src={r['source']}")
    conn.close()


def marking_add(a) -> None:
    """标记是不可变事实：同一 target_ref 状态演变 = 追加行；source_key 冲突→跳过。"""
    conn = connect(a.db)
    t = a.ts if a.ts is not None else now()
    skey = a.source_key or f"mark:{a.chat_id}:{a.target}:{t}"
    hit = conn.execute("SELECT id FROM marking WHERE source_key = ?", (skey,)).fetchone()
    if hit:
        print(f"[跳过] source_key 已存在（id={hit['id']}），标记事件不可变、不更新")
        conn.close()
        return
    with immediate(conn):
        cur = conn.execute(
            "INSERT INTO marking (chat_id, kind, target_ref, ts, source, source_key, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (a.chat_id, a.kind, a.target, t, a.source, skey, now()))
    print(f"OK marking #{cur.lastrowid} added ({a.kind} {a.target})")
    conn.close()


def markings_latest(a) -> None:
    conn = connect(a.db)
    sql = "SELECT * FROM v_marking_latest"
    args: list = []
    if a.kind:
        sql += " WHERE kind = ?"; args.append(a.kind)
    sql += " ORDER BY ts"
    rows = conn.execute(sql, args).fetchall()
    if not rows:
        print("(无标记记录)")
    for r in rows:
        print(f"#{r['id']:<4} [{r['chat_id']}] {r['kind']:<7} {r['target_ref']}"
              f"  {iso(r['ts'])}  src={r['source']}")
    conn.close()


# ---------------------------------------------------------------- main
def main() -> None:
    p = argparse.ArgumentParser(description="微信知识库 CLI")
    p.add_argument("--db", default="./knowledge.db")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("entry")
    ea = e.add_subparsers(dest="op", required=True).add_parser("add")
    ea.add_argument("--kind", default="note",
                    choices=["note", "todo", "done", "idea", "issue"])
    ea.add_argument("--text", required=True)
    ea.add_argument("--doc-id", type=int, default=None)
    ea.add_argument("--chat-id", default="aggregate",
                    help="群归属 id（缺省 aggregate；report gen --chat-id X 只归档本群 entry）")
    ea.set_defaults(func=entry_add)

    r = sub.add_parser("report")
    rs = r.add_subparsers(dest="op", required=True)
    g = rs.add_parser("gen")
    g.add_argument("--period", required=True, choices=["daily", "weekly", "monthly"])
    g.add_argument("--date", required=True)
    g.add_argument("--chat-id", default="aggregate",
                   help="会话维度 id；缺省 aggregate（跨群聚合，标题不带后缀）")
    g.add_argument("--force", action="store_true",
                   help="重新生成已定稿（final）的报告时必须显式给出（D-13，与 T4 语义对齐）")
    g.set_defaults(func=report_gen)
    s = rs.add_parser("show"); s.add_argument("--id", type=int, required=True)
    s.set_defaults(func=report_show)
    l = rs.add_parser("list"); l.set_defaults(func=report_list)
    f = rs.add_parser("finalize"); f.add_argument("--id", type=int, required=True)
    f.set_defaults(func=report_finalize)

    d = sub.add_parser("doc")
    da = d.add_subparsers(dest="op", required=True).add_parser("add")
    da.add_argument("--title", required=True)
    da.add_argument("--category", default=None)
    da.add_argument("--file", default=None)
    da.add_argument("--tag", default="", help="逗号分隔 tag 名")
    da.set_defaults(func=doc_add)

    rv = sub.add_parser("revision")
    ra = rv.add_subparsers(dest="op", required=True).add_parser("add")
    ra.add_argument("--chat-id", required=True)
    ra.add_argument("--period", required=True, choices=["daily", "weekly", "monthly"])
    ra.add_argument("--date", required=True, help="period_start YYYY-MM-DD")
    ra.add_argument("--type", required=True, help="修订类型（自由短词，如 section/correction/status）")
    ra.add_argument("--target", default=None, help="段落/条目引用（可空）")
    ra.add_argument("--summary", default=None, help="元数据摘要（红线：不含原文）")
    ra.add_argument("--source", default="chat", choices=["chat", "web"])
    ra.add_argument("--ts", type=int, default=None, help="修订发生时刻（缺省当前时间）")
    ra.add_argument("--source-key", default=None, help="幂等键（缺省按插件惯例生成）")
    ra.set_defaults(func=revision_add)

    rvs = sub.add_parser("revisions")
    rl = rvs.add_subparsers(dest="op", required=True).add_parser("list")
    rl.add_argument("--chat-id", default=None)
    rl.add_argument("--period", default=None, choices=["daily", "weekly", "monthly"])
    rl.add_argument("--date", default=None)
    rl.set_defaults(func=revisions_list)

    mk = sub.add_parser("marking")
    ma = mk.add_subparsers(dest="op", required=True).add_parser("add")
    ma.add_argument("--chat-id", required=True)
    ma.add_argument("--kind", required=True, choices=["done", "undone", "deleted"])
    ma.add_argument("--target", required=True, help="任务/事项标识")
    ma.add_argument("--source", default="chat", choices=["chat", "web"])
    ma.add_argument("--ts", type=int, default=None)
    ma.add_argument("--source-key", default=None)
    ma.set_defaults(func=marking_add)

    mks = sub.add_parser("markings")
    ml = mks.add_subparsers(dest="op", required=True).add_parser("latest")
    ml.add_argument("--kind", default=None, choices=["done", "undone", "deleted"])
    ml.set_defaults(func=markings_latest)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
