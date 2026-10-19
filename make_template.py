#!/usr/bin/env python3
"""make_template.py — 生成空模板 template.db 与合成假数据 sample.db。

用法:
    python3 make_template.py            # 在脚本目录生成 template.db / sample.db
    python3 make_template.py -o OUTDIR

仅使用硬编码合成假数据，零真实 wxid / 昵称 / 聊天内容。
可重复运行：每次先删除旧库再重建（幂等）。
"""
import hashlib
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema.sql")


def build_db(path: str) -> sqlite3.Connection:
    if os.path.exists(path):
        os.remove(path)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    with open(SCHEMA, encoding="utf-8") as f:
        sql = f.read()
    conn = sqlite3.connect(path)
    conn.executescript(sql)
    conn.commit()
    return conn


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------
# 合成假数据（全部为虚构示例，不指向任何真实会话/人物）
# ---------------------------------------------------------------
CATS = ["tutorial", "paper", "note"]
TAGS = ["示例-入门", "示例-进阶", "示例-工具", "示例-综述", "示例-待整理"]

LOREM_ZH = (
    "这是一段用于占位的合成文本，仅演示字段格式。"
    "内容为无意义的示例句子，不含任何真实信息。"
)

DOCS = [
    # (title, category, source_type, source_ref, content_md)
    ("示例：同步辐射入门笔记", "note", "manual", "手工整理示例",
     "# 示例：同步辐射入门笔记\n\n" + LOREM_ZH * 3),
    ("示例：示例数据格式说明", "note", "manual", "仓库文档示例",
     "# 示例：示例数据格式说明\n\n" + LOREM_ZH * 2),
    ("示例：某综述阅读摘录", "paper", "web", "示例网址 https://example.org/a",
     "# 示例：某综述阅读摘录\n\n" + LOREM_ZH * 4),
    ("示例：实验方法小结", "note", "manual", "手工整理示例",
     "# 示例：实验方法小结\n\n" + LOREM_ZH * 2),
    ("示例：工具链使用备忘", "tutorial", "manual", "手工整理示例",
     "# 示例：工具链使用备忘\n\n" + LOREM_ZH * 2),
    ("示例：某教程学习记录", "tutorial", "web", "示例网址 https://example.org/b",
     "# 示例：某教程学习记录\n\n" + LOREM_ZH * 3),
    ("示例：待整理碎片合集", "note", "chat_digest", "示例会话主题甲",
     "# 示例：待整理碎片合集\n\n" + LOREM_ZH * 2),
    ("示例：素材图包索引", "asset", "file_import", "示例文件集说明",
     "# 示例：素材图包索引\n\n" + LOREM_ZH * 1),
]
# doc -> tag 名列表（按 tag 在 TAGS 中的下标）
DOC_TAGS = {0: [0, 2], 1: [0], 2: [1, 3], 3: [0, 4], 4: [2], 5: [1], 6: [4], 7: [3]}

NOW = int(time.time())
DAY = 86400


def make_sample(path: str) -> None:
    conn = build_db(path)
    cur = conn.cursor()
    cur.executemany("INSERT INTO tag(name) VALUES (?)", [(t,) for t in TAGS])

    doc_ids = []
    for i, (title, cat, st, ref, md) in enumerate(DOCS):
        cur.execute(
            "INSERT INTO doc(title, category, source_type, source_ref, content_md,"
            " content_hash, status, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (title, cat, st, ref, md, sha(md), "active", NOW - (8 - i) * DAY,
             NOW - (8 - i) * DAY))
        doc_ids.append(cur.lastrowid)
    for di, tids in DOC_TAGS.items():
        cur.executemany(
            "INSERT INTO doc_tag(doc_id, tag_id) VALUES (?,?)",
            [(doc_ids[di], t + 1) for t in tids])

    # 4 份 report（v0.4）：同日双群两份 daily + 1 份聚合 daily + 1 份聚合 weekly
    reports = [
        # (period_type, start, end, title, chat_id)
        ("daily", "2026-01-05", "2026-01-05", "日报 2026-01-05", "aggregate"),
        ("daily", "2026-01-05", "2026-01-05", "日报 2026-01-05 demo-chat-1", "demo-chat-1"),
        ("daily", "2026-01-05", "2026-01-05", "日报 2026-01-05 demo-chat-2", "demo-chat-2"),
        ("weekly", "2026-01-05", "2026-01-11", "周报 2026-W02", "aggregate"),
    ]
    report_ids = {}
    for pt, ps, pe, title, cid in reports:
        body = (f"# {title}\n\n> 合成示例报告，内容为占位文本。\n\n"
                "## 本期要点\n\n- " + LOREM_ZH + "\n")
        cur.execute(
            "INSERT INTO report(period_type, period_start, period_end, title,"
            " content_md, status, chat_id, doc_ids_hint, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (pt, ps, pe, title, body, "draft", cid, "[1,2]", NOW - 2 * DAY, NOW - 2 * DAY))
        report_ids[(pt, cid)] = cur.lastrowid

    # 10 条 entry（部分挂聚合日报，部分未归档）
    kinds = ["note", "todo", "done", "idea", "issue"]
    daily_aggregate_id = report_ids[("daily", "aggregate")]
    for i in range(10):
        rid = daily_aggregate_id if i < 4 else None
        cur.execute(
            "INSERT INTO entry(ts, kind, content_md, report_id, doc_id, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (NOW - (10 - i) * 3600, kinds[i % 5],
             f"（合成示例条目 {i + 1}）" + LOREM_ZH, rid,
             doc_ids[i % len(doc_ids)], NOW - (10 - i) * 3600))

    # media 合成行（v0.4 修订8）：available / pending / missing 三态各若干；本体永不入库
    media_rows = [
        # (chat_id, media_type, file_name, ext, size, md5, path, path_kind, status, source_key, source_ts)
        ("demo-chat-1", "image", "demo-photo-10001", "jpg", 204800,
         "a1b2c3d4e5f60718293a4b5c6d7e8f90", "archive/demo-chat-1/10001.jpg", "archive",
         "available", "demo-chat-1:10001", NOW - 3 * DAY),
        ("demo-chat-1", "file", "demo-doc-10002", "pdf", 1048576,
         "b2c3d4e5f60718293a4b5c6d7e8f90a1", None, None,
         "pending", "demo-chat-1:10002", NOW - 2 * DAY),
        ("demo-chat-1", "video", "demo-clip-10003", "mp4", 8388608,
         "c3d4e5f60718293a4b5c6d7e8f90a1b2", "archive/demo-chat-1/10003.mp4", "archive",
         "available", "demo-chat-1:10003", NOW - DAY),
        ("demo-chat-2", "voice", "demo-voice-20001", "silk", 65536,
         "d4e5f60718293a4b5c6d7e8f90a1b2c3", None, None,
         "missing", "demo-chat-2:20001", NOW - DAY),
        ("demo-chat-2", "image", "demo-photo-20002", "png", 40960,
         "e5f60718293a4b5c6d7e8f90a1b2c3d4", "archive/demo-chat-2/20002.png", "archive",
         "available", "demo-chat-2:20002", NOW - 3600),
    ]
    for m in media_rows:
        cur.execute(
            "INSERT INTO media(chat_id, media_type, file_name, ext, size, md5, path,"
            " path_kind, status, source_key, source_ts, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (*m, NOW - 2 * DAY, NOW - 2 * DAY))

    # 3 条 chat_digest（只存要点，不存原文；带 source_key 验证幂等）
    digests = [
        ("示例会话主题甲", "- 要点一（合成占位）\n- 要点二（合成占位）", "2026-01-05", 1,
         "topic:2026-01-05:a1b2c3d4", "2水群-demo"),
        ("示例会话主题乙", "- 要点A（合成占位）", "2026-01-06", None,
         "topic:2026-01-06:e5f6a7b8", "2水群-demo"),
        ("示例会话主题丙", "- 要点X（合成占位）\n- 要点Y（合成占位）", "2026-01-07", 3,
         "topic:2026-01-07:c9d0e1f2", "2水群-demo"),
    ]
    for topic, dmd, day, did, skey, by in digests:
        cur.execute(
            "INSERT INTO chat_digest(chat_topic, digest_md, happened_on, doc_id,"
            " source_key, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
            (topic, dmd, day, did, skey, by, NOW - DAY))

    conn.commit()
    conn.close()


def main() -> None:
    outdir = sys.argv[sys.argv.index("-o") + 1] if "-o" in sys.argv else HERE
    os.makedirs(outdir, exist_ok=True)
    tpl = os.path.join(outdir, "template.db")
    smp = os.path.join(outdir, "sample.db")
    build_db(tpl).close()
    make_sample(smp)
    for p in (tpl, smp):
        print(f"OK  {p}  ({os.path.getsize(p)} bytes)")


if __name__ == "__main__":
    main()
