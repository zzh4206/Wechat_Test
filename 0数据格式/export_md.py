#!/usr/bin/env python3
"""export_md.py — 把 report 与 doc 导出为 Markdown 文件树（仅供 1数据/exports/ 或仓库预览）。

v0.6：报告导出附「修订时间线」与「完成情况（最新态）」小节（来自 report_revision /
v_marking_latest，无记录则省略小节）。

用法:
    python3 export_md.py --db PATH --out DIR
        out/reports/YYYY/YYYY-MM-DD.md | YYYY-Www.md | YYYY-MM.md   （aggregate 聚合报告，按周期类型）
        out/reports/<chatId>/YYYY-MM-DD.md | ...                    （v0.4 非聚合报告，带会话段目录）
        out/docs/<category>/<id>-<标题>.md                           （D-6：文件名带 id 前缀，杜绝覆盖）
文件名经消毒（替换路径非法字符）。资料文件名带 doc id 前缀（D-6），同名标题不再互覆。
frontmatter 的 tags 输出为 YAML 数组（D-15 顺手）；「完成情况」按报告周期过滤（D-4）。
"""
import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import sys


def sanitize(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip().strip(".")
    return name[:120] or "untitled"


def frontmatter(meta: dict) -> str:
    lines = ["---"]
    for k, v in meta.items():
        if v is None:
            continue
        if isinstance(v, list):
            v = json.dumps(v, ensure_ascii=False)   # D-15：数组（如 tags）输出 YAML 数组
        elif isinstance(v, str) and (":" in v or v.startswith("[")):
            v = json.dumps(v, ensure_ascii=False)
        lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines)


def period_bounds(period_start: str, period_end: str) -> tuple:
    """报告周期 → (lo, hi) Unix 秒区间（本地时区，与 report_cli 归档口径一致）。"""
    lo = int(dt.datetime.fromisoformat(period_start + "T00:00:00").timestamp())
    hi = int(dt.datetime.fromisoformat(period_end + "T23:59:59").timestamp())
    return lo, hi


def revision_section(conn, r) -> str:
    """「修订时间线」小节（v0.6）：该报告全部修订事件，按 ts 升序。"""
    rows = conn.execute(
        "SELECT * FROM report_revision"
        " WHERE chat_id = ? AND period_type = ? AND period_start = ? ORDER BY ts",
        (r["chat_id"], r["period_type"], r["period_start"])).fetchall()
    if not rows:
        return ""
    lines = ["## 修订时间线", ""]
    for v in rows:
        ref = f"（{v['target_ref']}）" if v["target_ref"] else ""
        summary = f"：{v['summary']}" if v["summary"] else ""
        lines.append(f"- {dt.datetime.fromtimestamp(v['ts']).strftime('%Y-%m-%d %H:%M')}"
                     f" [{v['type']}]{ref}{summary}（src={v['source']}）")
    lines.append("")
    return "\n".join(lines)


def marking_section(conn, r) -> str:
    """「完成情况（最新态）」小节（v0.6）：该会话标记的最新态（v_marking_latest）。
    D-4：只取落在该报告周期内的标记（跨群同 target_ref 的行已由视图按 chat_id 分组）。"""
    lo, hi = period_bounds(r["period_start"], r["period_end"])
    rows = conn.execute(
        "SELECT * FROM v_marking_latest WHERE chat_id = ? AND ts BETWEEN ? AND ? ORDER BY ts",
        (r["chat_id"], lo, hi)).fetchall()
    if not rows:
        return ""
    lines = ["## 完成情况（最新态）", ""]
    kind_names = {"done": "已完成", "undone": "未完成", "deleted": "已删除"}
    for m in rows:
        lines.append(f"- [{kind_names.get(m['kind'], m['kind'])}] {m['target_ref']}"
                     f"（{dt.datetime.fromtimestamp(m['ts']).strftime('%Y-%m-%d %H:%M')}"
                     f"，src={m['source']}）")
    lines.append("")
    return "\n".join(lines)


def report_path(r) -> str:
    start = dt.date.fromisoformat(r["period_start"])
    y, w, _ = start.isocalendar()
    if r["chat_id"] != "aggregate":
        # v0.4 非聚合报告：reports/<chatId>/ 平铺（与导入器读取路径 reports/<chatId>/YYYY-MM-DD.md 对齐）
        cid = sanitize(r["chat_id"])
        if r["period_type"] == "daily":
            return os.path.join("reports", cid, f"{start.isoformat()}.md")
        if r["period_type"] == "weekly":
            return os.path.join("reports", cid, f"{y:04d}-W{w:02d}.md")
        return os.path.join("reports", cid, f"{start.strftime('%Y-%m')}.md")
    if r["period_type"] == "daily":
        return os.path.join("reports", f"{y:04d}", f"{start.isoformat()}.md")
    if r["period_type"] == "weekly":
        return os.path.join("reports", f"{y:04d}", f"{y:04d}-W{w:02d}.md")
    return os.path.join("reports", f"{y:04d}", f"{start.strftime('%Y-%m')}.md")


def main() -> None:
    ap = argparse.ArgumentParser(description="导出 report / doc 为 Markdown 文件树")
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if not os.path.exists(a.db):
        sys.exit(f"[错误] 数据库不存在: {a.db}")
    conn = sqlite3.connect(a.db)
    conn.row_factory = sqlite3.Row
    n_rep = n_doc = 0

    for r in conn.execute("SELECT * FROM v_report_full"):
        path = os.path.join(a.out, report_path(r))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        body = frontmatter({
            "type": "report", "id": r["id"], "period_type": r["period_type"],
            "period_start": r["period_start"], "period_end": r["period_end"],
            "chat_id": r["chat_id"] if "chat_id" in r.keys() else "aggregate",
            "title": r["title"], "status": r["status"],
            "doc_ids_hint": r["doc_ids_hint"], "entry_count": r["entry_count"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        }) + "\n\n" + (r["content_md"] or "") + "\n" \
            + revision_section(conn, r) + marking_section(conn, r)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        n_rep += 1

    for d in conn.execute("SELECT * FROM doc WHERE content_md IS NOT NULL"):
        cat = sanitize(d["category"] or "未分类")
        # D-6：文件名带 id 前缀（<id>-<title>.md），同名标题不再互相覆盖
        path = os.path.join(a.out, "docs", cat, f"{d['id']}-{sanitize(d['title'])}.md")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tags = [row[0] for row in conn.execute(
            "SELECT t.name FROM doc_tag dt JOIN tag t ON t.id = dt.tag_id"
            " WHERE dt.doc_id = ? ORDER BY t.name", (d["id"],))]
        body = frontmatter({
            "type": "doc", "id": d["id"], "title": d["title"], "category": d["category"],
            "source_type": d["source_type"], "source_ref": d["source_ref"],
            "file_path": d["file_path"], "tags": tags,   # D-15：tags 数组化
            "status": d["status"], "content_hash": d["content_hash"],
            "created_at": d["created_at"], "updated_at": d["updated_at"],
        }) + "\n\n" + (d["content_md"] or "") + "\n"
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        n_doc += 1

    conn.close()
    print(f"OK 导出完成: {n_rep} 份报告, {n_doc} 份资料 -> {os.path.abspath(a.out)}")


if __name__ == "__main__":
    main()
