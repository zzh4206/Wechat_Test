#!/usr/bin/env python3
"""bootstrap.py — 新机器一键构建规范 1数据 目录（空库 + 目录骨架）。

用法:
    python3 bootstrap.py [--target DIR] [--account WXID]

行为（TECH-bootstrap §2）:
    1. knowledge.db 不存在 → 用 schema.sql 全量 DDL 创建（user_version=6 空库）；
    2. 已存在 → 不重建不修改：校验 user_version，=6 打印 OK；<6 提示走 report_cli
       自动迁移并退出 0；>6 报错退出非 0；
    3. docs/ exports/ media/ 三个子目录不存在则创建，存在则跳过（幂等，可重复运行）；
    4. 全程零网络、零真实数据；创建物只有空库与空目录。

路径约定（TECH-bootstrap §1）:
    --target   缺省 ./1数据（相对调用目录；绝不硬编码用户家目录——D-1 教训）。
    --account  为 v0.5 预留的可选账号参数：提供时 target 即账号根，布局不变；
               多账号/目录重排在 v0.5 窗口另行迁移，本脚本不预设。

产出布局:
    <DIR>/knowledge.db   真实库（v6 全量 DDL，user_version=6，零行）
    <DIR>/docs/          doc.file_path 的相对根
    <DIR>/exports/       export_md 默认输出根
    <DIR>/media/         媒体地址登记的相对根

仅用 Python3 标准库；退出码 0=成功/幂等重跑，非 0=参数或版本错误。
TS 镜像路径（运行配置）不在本脚本职责内；历史回填走 2水群 导入器与
extract_docs_from_reports.py，也不在本脚本范围。
"""
import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_SQL_PATH = os.path.join(HERE, "schema.sql")

SCHEMA_VERSION = 6
SUBDIRS = ("docs", "exports", "media")


def user_version(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def create_empty_db(db_path: str) -> None:
    """用 schema.sql 全量 DDL 创建 v6 空库（与 report_cli 全新建库路径一致）。"""
    with open(SCHEMA_SQL_PATH, "r", encoding="utf-8") as f:
        ddl = f.read()
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(ddl)  # 含 PRAGMA user_version = 6
        if user_version(conn) != SCHEMA_VERSION:
            raise RuntimeError("全新建库后 user_version != 6")
        conn.commit()
    finally:
        conn.close()


def ensure_dirs(root: str) -> None:
    for name in SUBDIRS:
        path = os.path.join(root, name)
        if os.path.isdir(path):
            print(f"  跳过（已存在）: {path}")
        else:
            os.makedirs(path)
            print(f"  已创建目录:  {path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="新机器一键构建规范数据目录（空库 + docs/exports/media 骨架）")
    parser.add_argument("--target", default=os.path.join(".", "1数据"),
                        help="目标目录（缺省 ./1数据，相对调用目录）")
    parser.add_argument("--account", default=None,
                        help="可选账号标识（v0.5 预留）：提供时 target 即账号根，布局不变")
    args = parser.parse_args()

    target = args.target
    if not target:
        parser.error("--target 不能为空")
    if args.account is not None and not args.account.strip():
        parser.error("--account 不能为空字符串")
    os.makedirs(target, exist_ok=True)

    label = f"{target}（账号 {args.account} 的根目录，v0.5 预留布局）" \
        if args.account else target
    print(f"[bootstrap] 目标目录: {label}")

    # 1. knowledge.db：不存在则建 v6 空库；已存在则只校验版本，绝不重建不修改
    db_path = os.path.join(target, "knowledge.db")
    if not os.path.exists(db_path):
        create_empty_db(db_path)
        print(f"  已创建空库:  {db_path}（schema v{SCHEMA_VERSION}，零行）")
    else:
        conn = sqlite3.connect(db_path)
        try:
            v = user_version(conn)
        finally:
            conn.close()
        if v == SCHEMA_VERSION:
            print(f"  库已存在且版本正确（user_version={v}），OK，不改动")
        elif v < SCHEMA_VERSION:
            print(f"  库已存在且 user_version={v}（低于 v{SCHEMA_VERSION}）："
                  f"本脚本不改动；请运行 python3 report_cli.py --db {db_path} <命令>，"
                  f"打开库时会自动链式迁移到 v{SCHEMA_VERSION}。")
            return 0
        else:
            print(f"[错误] 库 user_version={v} 高于本工具支持的 v{SCHEMA_VERSION}，拒绝处理",
                  file=sys.stderr)
            return 2

    # 2. 三个子目录：不存在则创建，存在则跳过（幂等）
    ensure_dirs(target)

    print("[bootstrap] 完成。产出为空库与目录骨架，零网络、零真实数据。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
