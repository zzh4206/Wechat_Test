#!/usr/bin/env python3
"""report_cli.py — 微信知识库 CLI（entry / report / doc），schema v0.2.1。

用法:
    python3 report_cli.py [--db PATH] entry add --kind note --text "..." [--doc-id N]
    python3 report_cli.py [--db PATH] report gen --period daily|weekly|monthly --date YYYY-MM-DD
    python3 report_cli.py [--db PATH] report show --id N
    python3 report_cli.py [--db PATH] report list
    python3 report_cli.py [--db PATH] report finalize --id N
    python3 report_cli.py [--db PATH] doc add --title T [--category C] [--file PATH] [--tag a,b]

--db 默认 ./knowledge.db。所有写操作都会更新 updated_at（entry 除外，其用 created_at）。
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys


def now() -> int:
    return int(dt.datetime.now().timestamp())


def iso(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def connect(path: str) -> sqlite3.Connection:
    if not os.path.exists(path):
        sys.exit(f"[错误] 数据库不存在: {os.path.abspath(path)}（先运行 make_template.py）")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


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
    if a.doc_id is not None and not conn.execute(
            "SELECT 1 FROM doc WHERE id = ?", (a.doc_id,)).fetchone():
        sys.exit(f"[错误] doc #{a.doc_id} 不存在")
    cur = conn.execute(
        "INSERT INTO entry (ts, kind, content_md, report_id, doc_id, created_at)"
        " VALUES (?, ?, ?, NULL, ?, ?)",
        (t, a.kind, a.text.strip(), a.doc_id, t))
    conn.commit()
    print(f"OK entry #{cur.lastrowid} added (kind={a.kind}, 未归档)")
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
    start, end, title = period_range(a.period, a.date)
    conn = connect(a.db)
    t = now()
    row = conn.execute(
        "SELECT id FROM report WHERE period_type = ? AND period_start = ?",
        (a.period, start)).fetchone()
    if row:                                    # 修订1：重新生成走 UPDATE，不删建
        rid = row["id"]
        conn.execute(
            "UPDATE report SET period_end = ?, title = ?, status = 'draft',"
            " updated_at = ? WHERE id = ?", (end, title, t, rid))
        # 旧条目先退回未归档，再重新归档
        conn.execute("UPDATE entry SET report_id = NULL WHERE report_id = ?", (rid,))
        action = f"regenerated report #{rid}"
    else:
        cur = conn.execute(
            "INSERT INTO report (period_type, period_start, period_end, title,"
            " content_md, status, doc_ids_hint, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, '', 'draft', NULL, ?, ?)",
            (a.period, start, end, title, t, t))
        rid = cur.lastrowid
        action = f"created report #{rid}"

    lo = int(dt.datetime.fromisoformat(start + "T00:00:00").timestamp())
    hi = int(dt.datetime.fromisoformat(end + "T23:59:59").timestamp())
    entries = conn.execute(
        "SELECT * FROM entry WHERE report_id IS NULL AND ts BETWEEN ? AND ?"
        " ORDER BY ts", (lo, hi)).fetchall()
    doc_ids = sorted({e["doc_id"] for e in entries if e["doc_id"] is not None})
    conn.executemany("UPDATE entry SET report_id = ? WHERE id = ?",
                     [(rid, e["id"]) for e in entries])
    conn.execute(
        "UPDATE report SET content_md = ?, doc_ids_hint = ?, updated_at = ? WHERE id = ?",
        (build_content_md({"title": title, "period_start": start, "period_end": end},
                          entries),
         json.dumps(doc_ids) if doc_ids else None, t, rid))
    conn.commit()
    print(f"OK {action} [{a.period} {start}~{end}] 归档 {len(entries)} 条未归档 entry")
    conn.close()


def report_show(a) -> None:
    conn = connect(a.db)
    r = conn.execute("SELECT * FROM v_report_full WHERE id = ?", (a.id,)).fetchone()
    if not r:
        sys.exit(f"[错误] report #{a.id} 不存在")
    keys = ["id", "period_type", "period_start", "period_end", "title", "status",
            "doc_ids_hint", "entry_count"]
    print("=" * 60)
    for k in keys:
        print(f"{k:14}: {r[k]}")
    print(f"{'created/updated':14}: {iso(r['created_at'])} / {iso(r['updated_at'])}")
    print("=" * 60)
    print(r["content_md"] or "(空)")


def report_list(a) -> None:
    conn = connect(a.db)
    rows = conn.execute(
        "SELECT id, period_type, period_start, period_end, title, status, entry_count"
        " FROM v_report_full ORDER BY period_start DESC").fetchall()
    if not rows:
        print("(无报告)")
    for r in rows:
        print(f"#{r['id']:<3} {r['period_type']:<7} {r['period_start']}~{r['period_end']}"
              f"  {r['title']}  [{r['status']}]  entries={r['entry_count']}")
    conn.close()


def report_finalize(a) -> None:
    conn = connect(a.db)
    r = conn.execute("SELECT status FROM report WHERE id = ?", (a.id,)).fetchone()
    if not r:
        sys.exit(f"[错误] report #{a.id} 不存在")
    if r["status"] != "draft":
        sys.exit(f"[错误] report #{a.id} 状态为 {r['status']}，仅 draft 可 finalize")
    conn.execute("UPDATE report SET status = 'final', updated_at = ? WHERE id = ?",
                 (now(), a.id))
    conn.commit()
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
    conn.commit()
    print(f"OK doc #{did} added: {a.title} (category={a.category}, tags={a.tag!r},"
          f" hash={h[:12]}…)")
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
    ea.set_defaults(func=entry_add)

    r = sub.add_parser("report")
    rs = r.add_subparsers(dest="op", required=True)
    g = rs.add_parser("gen")
    g.add_argument("--period", required=True, choices=["daily", "weekly", "monthly"])
    g.add_argument("--date", required=True)
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

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
