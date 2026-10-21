#!/usr/bin/env python3
"""extract_docs_from_reports.py — 从 report 表正文提取非对话资料（URL / 文件索引条目）入 doc 库。

约定（DESIGN.md v0.2 §2 + schema v0.4）：
- content_hash = 去 BOM、CRLF→LF、strip 后的 SHA-256 hex（仅 content_md 非空时写）；
- doc.content_hash 只是部分索引，去重由本脚本应用层保证：
  1) 同 content_hash 已存在 → 跳过；
  2) 全库任一 doc.content_md 已含该 URL → 跳过（不重复建）。
- 全离线：不联网抓取页面，只落 URL + 报告内行内语境。
- 幂等：可对新报告增量重跑；写入用事务；时间戳为 Unix 秒。

用法： python3 extract_docs_from_reports.py [--db PATH]
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sqlite3
import sys

DEFAULT_DB = "./knowledge.db"   # D-1：相对工作目录，不写机器绝对路径（--db 可覆盖）

# URL 截断：中文引号 / 空白 / 右括号 / 常见中文标点
URL_RE = re.compile(r"https?://[^\s\)）」』】\"'，。；、！？：]+")
URL_TRAIL_RE = re.compile(r"[.,;:!?）)」』\]〉»]+$")

TAG_REPORT = "来自报告"
TAG_GITHUB = "github"


def content_hash(md: str) -> str:
    s = md.replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(s.strip().encode("utf-8")).hexdigest()


def host_of(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url)
    return m.group(1) if m else url


def extract_urls(text: str) -> list[str]:
    out, seen = [], set()
    for m in URL_RE.finditer(text):
        u = URL_TRAIL_RE.sub("", m.group(0))
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def line_context(md: str, url: str) -> str:
    """URL 所在行的原文（保留 L3 行内引用格式，含发言人与时间）。"""
    for line in md.splitlines():
        if url in line:
            return line.strip()
    return ""


def descriptive_title(md: str, url: str, host: str) -> str | None:
    """从 URL 所在引用行取可读描述（仓库名/站点名），否则 None（用域名）。"""
    ctx = line_context(md, url)
    if not ctx:
        return None
    if "github.com" in url:
        m = re.search(r"github\.com/([A-Za-z0-9_.\-]+)/([A-Za-z0-9_.\-]+)", url)
        if m:
            owner, name = m.group(1), m.group(2)
            if name in ctx:
                return name
            return f"{owner}/{name}"
    # 非 GitHub：取引用行里 URL 之外的可读文字（如「clab活了。」）
    q = re.search(r"「([^」]+)」", ctx)
    if q:
        text = q.group(1).replace(url, "").strip(" 。,，.:：")
        if text:
            return text[:30]
    return None


def file_index_entries(md: str) -> list[str]:
    """「### 本期文件索引」区段下的非空行（跳过占位行）。"""
    if "### 本期文件索引" not in md:
        return []
    sec = md.split("### 本期文件索引", 1)[1].split("\n### ", 1)[0]
    out = []
    for raw in sec.splitlines():
        line = raw.strip()
        if not line or "本期无新文件" in line:
            continue
        out.append(line)
    return out


def get_or_create_tag(cur: sqlite3.Cursor, name: str) -> int:
    row = cur.execute("SELECT id FROM tag WHERE name = ?", (name,)).fetchone()
    if row:
        return row[0]
    cur.execute("INSERT INTO tag(name) VALUES (?)", (name,))
    return cur.lastrowid


def link_tag(cur: sqlite3.Cursor, doc_id: int, tag_id: int) -> bool:
    """返回是否新建了关联。"""
    ex = cur.execute(
        "SELECT 1 FROM doc_tag WHERE doc_id=? AND tag_id=?", (doc_id, tag_id)
    ).fetchone()
    if ex:
        return False
    cur.execute("INSERT INTO doc_tag(doc_id, tag_id) VALUES (?,?)", (doc_id, tag_id))
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB, help="knowledge.db 路径（默认真实库）")
    ap.add_argument("--dry-run", action="store_true", help="只统计不写入")
    args = ap.parse_args()

    con = sqlite3.connect(args.db, isolation_level=None)  # 显式事务控制
    cur = con.cursor()
    cur.execute("PRAGMA busy_timeout = 5000")   # D-5：写路径统一忙等 5s
    now = int(__import__("time").time())

    stats = {
        "reports_scanned": 0,
        "urls_found_unique": 0,
        "url_docs_created": 0,
        "url_docs_skipped_existing": 0,
        "file_index_entries": 0,
        "file_docs_created": 0,
        "file_docs_skipped_existing": 0,
        "tags_linked": 0,
    }

    # 预载：全库已入 doc 的 content_md（URL 查重用）+ 全部 content_hash
    existing_mds = [
        r[0] for r in cur.execute("SELECT content_md FROM doc WHERE content_md IS NOT NULL")
    ]
    existing_hashes = {
        r[0] for r in cur.execute("SELECT content_hash FROM doc WHERE content_hash IS NOT NULL")
    }
    # D-16：文件索引「行级 key」查重——已有 file_import doc 的首行（= 建库时的索引行原文）
    # 指纹入集合；新扫描到的索引行按行指纹与之比对，跨报告/跨批次重复行不再依赖子串兜底
    existing_file_keys = {
        content_hash(r[0].splitlines()[0])
        for r in cur.execute(
            "SELECT content_md FROM doc WHERE source_type = 'file_import'"
            " AND content_md IS NOT NULL")
        if r[0].splitlines()
    }

    # 报告 id -> 提及记录（跨报告同一 URL 并列 source_ref）
    # 先收集，再统一写，保证 source_ref 可并列
    url_hits: dict[str, list[dict]] = {}
    file_hits: dict[str, list[dict]] = {}

    for rid, ptype, pstart, chat_id, md in cur.execute(
        "SELECT id, period_type, period_start, chat_id, content_md FROM report ORDER BY id"
    ):
        stats["reports_scanned"] += 1
        date = pstart  # 报告日期（周期起始日）
        for u in extract_urls(md):
            url_hits.setdefault(u, []).append(
                {
                    "report_id": rid,
                    "date": date,
                    "chat_id": chat_id,
                    "context": line_context(md, u),
                    "title_desc": descriptive_title(md, u, host_of(u)),
                }
            )
        for entry in file_index_entries(md):
            key = content_hash(entry)  # 以行原文指纹做键，天然幂等
            file_hits.setdefault(key, []).append(
                {"report_id": rid, "date": date, "chat_id": chat_id, "line": entry}
            )

    stats["urls_found_unique"] = len(url_hits)
    stats["file_index_entries"] = sum(len(v) for v in file_hits.values())

    tag_report_id = get_or_create_tag(cur, TAG_REPORT)
    tag_github_id = get_or_create_tag(cur, TAG_GITHUB)

    created_samples: list[tuple] = []

    if not args.dry_run:
        cur.execute("BEGIN IMMEDIATE")
    try:
        # ---- URL docs ----
        for u, hits in sorted(url_hits.items()):
            # 语境行去重（同一引用被多份报告复用时原文相同）
            seen_ctx: list[str] = []
            for h in hits:
                if h["context"] and h["context"] not in seen_ctx:
                    seen_ctx.append(h["context"])
            md_body = (
                f"- URL：{u}\n"
                + "".join(f"- 语境：{c}\n" for c in seen_ctx)
                + "- 提及："
                + "；".join(f"报告 {h['date']} · {h['chat_id']}" for h in hits)
                + "\n"
            )
            ch = content_hash(md_body)
            # 查重 1：同 hash 已存在（含已含同 URL 的旧 doc，hash 会不同 → 用查重 2 兜底）
            # 查重 2：全库 content_md 已含该 URL → 跳过
            dup = any(u in m for m in existing_mds) or ch in existing_hashes
            if dup:
                stats["url_docs_skipped_existing"] += 1
                continue
            first = hits[0]
            desc = next((h["title_desc"] for h in hits if h["title_desc"]), None) or host_of(u)
            title = f"资源：{desc}"
            source_ref = "；".join(f"报告 {h['date']} · {h['chat_id']}" for h in hits)
            cur.execute(
                "INSERT INTO doc(title, category, source_type, source_ref, file_path,"
                " content_md, content_hash, status, created_at, updated_at)"
                " VALUES (?,?,?,?,NULL,?,?, 'active', ?, ?)",
                (title, "web", "web", source_ref, md_body, ch, now, now),
            )
            doc_id = cur.lastrowid
            link_tag(cur, doc_id, tag_report_id)
            stats["tags_linked"] += 1
            if "github.com" in u:
                link_tag(cur, doc_id, tag_github_id)
                stats["tags_linked"] += 1
            existing_mds.append(md_body)
            existing_hashes.add(ch)
            stats["url_docs_created"] += 1
            created_samples.append((doc_id, title, source_ref, md_body))

        # ---- 文件索引 docs ----
        for key, hits in sorted(file_hits.items()):
            # D-16：行级 key（索引行原文指纹）已存在 → 直接跳过（不再依赖 md_body 整体
            # hash 或子串兜底——多报告合并提及会使 md_body 变化，整体 hash 天然失稳）
            dup = key in existing_file_keys
            if not dup:
                line = hits[0]["line"]
                # 同一行原文多报告提及：合并写
                md_body = line + "\n" + "\n".join(
                    f"（{h['date']} · {h['chat_id']}）" for h in hits
                ) + "\n"
                ch = content_hash(md_body)
                if ch in existing_hashes or any(
                    line in m for m in existing_mds
                ):
                    dup = True
            if dup:
                stats["file_docs_skipped_existing"] += 1
                continue
            name = hits[0]["line"].lstrip("-* ").strip()
            title = name[:80]
            source_ref = "；".join(f"报告 {h['date']} · {h['chat_id']}" for h in hits)
            cur.execute(
                "INSERT INTO doc(title, category, source_type, source_ref, file_path,"
                " content_md, content_hash, status, created_at, updated_at)"
                " VALUES (?,?,?,?,NULL,?,?, 'active', ?, ?)",
                (title, "file", "file_import", source_ref, md_body, ch, now, now),
            )
            doc_id = cur.lastrowid
            link_tag(cur, doc_id, tag_report_id)
            stats["tags_linked"] += 1
            existing_hashes.add(ch)
            existing_mds.append(md_body)
            existing_file_keys.add(key)   # D-16：行级 key 同步登记
            stats["file_docs_created"] += 1
            created_samples.append((doc_id, title, source_ref, md_body))

        if args.dry_run:
            con.rollback()
        else:
            con.commit()
    except Exception:
        con.rollback()
        raise

    print(
        f"扫描报告: {stats['reports_scanned']}\n"
        f"URL 提取(全文唯一): {stats['urls_found_unique']}\n"
        f"  新建 URL doc: {stats['url_docs_created']}\n"
        f"  跳过(已存在/已含URL): {stats['url_docs_skipped_existing']}\n"
        f"文件索引条目: {stats['file_index_entries']}\n"
        f"  新建 file doc: {stats['file_docs_created']}\n"
        f"  跳过: {stats['file_docs_skipped_existing']}\n"
        f"tag 关联新增: {stats['tags_linked']}\n"
        f"总新建 doc: {stats['url_docs_created'] + stats['file_docs_created']}"
    )
    if created_samples:
        print("--- 新建样例 ---")
        for doc_id, title, sref, body in created_samples[:10]:
            print(f"[{doc_id}] {title} | {sref}\n{body}")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
