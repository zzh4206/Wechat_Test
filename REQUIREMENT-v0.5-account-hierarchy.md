# 需求提案 v0.5：账号 → 群聊 → 报告/媒体 三级数据隔离

> 提出方：群聊报告系统（TypeScript / 2水群 仓库）
> 提出日期：2026-10-16（深夜）
> 前置：v0.4（会话维度 + media 表）实施中——本需求为其**目录布局扩展**，建议 v0.4 合入后作为 v0.5 排期
> 性质：需求提案——目录布局与库拆分由模板方定稿

---

## 需求描述（用户原话归纳）

数据不仅要**文件夹独立**（群聊独立），还要**不同账号独立**：

```
1数据/
└── <账号 wxid>/                        ← 账号隔离（如 wxid_bqlher…= 小号）
    ├── knowledge.db                    ← 该账号的知识库（schema 同 v0.4）
    ├── exports/                        ← Markdown 导出
    └── <群聊 chatId>/                  ← 群聊隔离
        ├── reports/
        │   ├── daily/  2026-10-16.md …  ← 日报（按日命名）
        │   ├── weekly/ 2026-W43.md …    ← 周报
        │   └── monthly/ 2026-10.md …    ← 月报
        └── media/
            └── addresses.jsonl          ← 该群文件/图片/视频的地址登记
                                          （路径/类型/大小/状态——本体永不入库）
```

要点：
1. **账号维度**：每个微信账号一个独立目录（含独立 knowledge.db）——不同账号的数据物理隔离，互不可见；
2. **群聊维度**：账号下每个群聊一个独立文件夹；
3. **报告文件**：群聊文件夹下按 报告类型/日期 组织（daily/weekly/monthly 子目录，文件按日期命名）；
4. **媒体地址**：群聊文件夹下媒体地址登记文件（addresses.jsonl，即 v0.4 media 表的文件化导出/或直写）。

## 动机

1. **账号切换的数据正确性**：账号白名单制下未来可能多账号使用本机——各账号数据物理分目录，杜绝镜像/导出时的串号可能；
2. **迁移与备份粒度**：单账号可整目录备份/迁移/删除；
3. **与调度对齐**：日报窗口已锚定"前日 20:20 → 触发时刻"（20:30 调度），报告文件按 (账号, 群, 类型, 日期) 归位后，检索路径与数据语义一致。

## 需求细则（模板方定稿）

### 1. 目录布局规范（template README/DESIGN 更新）

- `1数据/<account_wxid>/knowledge.db`：每账号一库（不再有全局单库）；
- `1数据/<account_wxid>/<chatId>/reports/{daily,weekly,monthly}/`：report_cli / export_md 的输出位；
- `1数据/<account_wxid>/<chatId>/media/addresses.jsonl`：媒体地址登记（与 v0.4 media 表同构的文件化形态）；
- 既有 `1数据/knowledge.db` 迁移：一次性移入对应账号目录。

### 2. schema 是否需要 v0.5 变更

- 方案甲（推荐）：**schema 不变**——v0.4 已含 chat_id；账号维度由"每账号一库"承载（库路径即账号），report/media 表内不需要 account 列；
- 方案乙：单库 + account 列——不推荐（违背账号物理隔离的初衷）。

### 3. 工具适配

- `report_cli.py` / `export_md.py`：增 `--account <wxid>`（推导库与输出路径）；
- `make_template.py`：生成 `<account>/<chatId>/` 层级的假数据样例；
- TypeScript 镜像侧：mirror 输出路径与 knowledge.db 路径同步适配（2水群 仓库）。

### 4. 迁移

- 现有 `1数据/knowledge.db`（v4，report 5 / entry 434 / chat_digest 2514）一次性迁入对应账号目录，幂等；
- 既有 `reports/<chatId>/` 导出到新目录结构的映射。

## 优先级与排序

- v0.4（会话维度 + media 表）**先行合入**（实施中）；
- v0.5（本需求）紧随其后——涉及 knowledge.db 路径变更，**一次性迁移窗口**宜与 v0.4 部署重启合并，避免两次迁移。

## 验收

1. `1数据/<wxid>/knowledge.db` 存在且为 v4，含全部既有数据；
2. `1数据/<wxid>/<chatId>/reports/{daily,weekly,monthly}/` 报告文件按规范归位；
3. `media/addresses.jsonl` 与 media 表内容一致；
4. TypeScript 镜像写入新路径；Python CLI `--account` 生效；幂等重跑不重复。
