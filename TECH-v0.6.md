# TECH：v0.6 审批双通道与报告修订流 · 模板侧技术方案（定稿）

> 依据：REQUIREMENT-v0.6 + REPLY-v0.6。schema `user_version` 4 → **5**。
> 实施工程师以本文为唯一依据；与 v0.5 目录改造解耦（见 REPLY 边界声明）。

## 1. schema 变更（只增不改，report/entry/doc 等既有表零改动）

### 1.1 report_revisions（修订历史）

```sql
CREATE TABLE report_revision (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  ts           INTEGER NOT NULL,              -- 修订发生时刻
  type         TEXT NOT NULL,                 -- 修订类型（自由短词：section/correction/status…）
  target_ref   TEXT,                          -- 段落/条目引用（可空）
  summary      TEXT,                          -- 元数据摘要（红线：不含消息/语句原文）
  source       TEXT NOT NULL CHECK (source IN ('chat','web')),
  source_key   TEXT NOT NULL UNIQUE,          -- 幂等键，插件生成（如 rev:<chatId>:<period>:<ts>:<n>）
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_revision_report ON report_revision(chat_id, period_type, period_start, ts);
CREATE INDEX idx_revision_ts ON report_revision(ts);
```

外键约定：**不建指向 report 的 FK**——修订事件先于报告行存在（补发场景）时不得被拒；
查询用 `(chat_id, period_type, period_start)` 关联。

### 1.2 marking（完成情况标记）

```sql
CREATE TABLE marking (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  kind         TEXT NOT NULL CHECK (kind IN ('done','undone','deleted')),
  target_ref   TEXT NOT NULL,                 -- 任务/事项标识
  ts           INTEGER NOT NULL,              -- 标记时刻
  source       TEXT NOT NULL CHECK (source IN ('chat','web')),
  source_key   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_marking_chat ON marking(chat_id, kind, ts);
CREATE INDEX idx_marking_target ON marking(target_ref);
```

「未完成事项」聚合语义 = 每 target_ref 取最新一条（视图）：

```sql
CREATE VIEW v_marking_latest AS
SELECT m.* FROM marking m
JOIN (SELECT target_ref, MAX(ts) AS mx FROM marking GROUP BY target_ref) t
  ON m.target_ref = t.target_ref AND m.ts = t.mx;
```

（前端「未完成页」= `WHERE kind='undone'`；同 ts 并列时取 id 大者——`MAX(id)` 兜底，实现时处理。）

### 1.3 v_report_revised（修订视图，替代「轻量列」）

```sql
CREATE VIEW v_report_revised AS
SELECT chat_id, period_type, period_start, COUNT(*) AS revision_count, MAX(ts) AS revised_at
FROM report_revision GROUP BY chat_id, period_type, period_start;
```

### 1.4 不变的表

report / entry / doc / tag / doc_tag / chat_digest / media 及既有视图零改动。

## 2. 迁移（4→5，幂等自动）

- 判据 `PRAGMA user_version`：`4` → 建 §1 三对象 + 置 5（单事务，user_version 最后置）；
  `5` → 跳过；`0` → 全量 v5 DDL；`<4` 或 `>5` → 报错拒开。
- Python（report_cli 打开时执行）与 TS（db.ts openDb）两份实现逻辑一致，与 v0.4 惯例同；
- 真实库迁移前备份 `knowledge.db.bak-v4`；迁移后既有数据零变化（本窗口纯新增表）。

## 3. 写入方适配

### 3.1 TypeScript（2水群）

- `types.ts`：ReportRevisionInput / MarkingInput；
- `dao.ts`：`insertReportRevision`（source_key 冲突→跳过返回已有 id，**不是 UPDATE**——修订事件是不可变事实）、
  `insertMarking`（同上不可变）、`listRevisions(chatId?, period?)`、`listMarkingsLatest(kind?)`、
  `upsertReport` 冲突分支修改：**若既有行 status='final'，更新内容但 status 保持 'final'**
  （现实现若直接覆盖 status 则违反 T4，测试钉死）；
- `mirror.ts`：`mirrorReportRevision(...)` / `mirrorMarking(...)`（safe 包裹，与 mirrorMedia 同模式）；
  镜像接线由插件侧 P3 完成（本窗口交付 DAO+mirror 方法即可，事件源接线属插件侧）。

### 3.2 Python（0数据格式）

- `report_cli.py`：`revision add`（--chat-id --period --date --type --summary --source）、
  `marking add`（--chat-id --kind --target --source）、`revisions list`、`markings latest`；
- `export_md.py`：报告导出时附「修订时间线」与「完成情况（最新态）」小节（来自两张表）；
- `make_template.py`：合成样例——同报告 3 条修订（不同 type）+ 跨报告标记
  （done/undone/deleted 混合，含同一 target_ref 的状态演变 undone→done）+ 对应 tag；
- `schema.sql` 升 v5（与 TS 内嵌 DDL 语义逐字一致）。

## 4. 测试要求

1. 迁移：v4 样例库→uv=5、既有数据零变化；重跑幂等；<4/>5 拒开；
2. 修订：insert 同 source_key 两遍→1 行；不同 source_key→多行；v_report_revised 计数正确；
3. 标记：同 target undone→done 两行；v_marking_latest 只见 done；跨群聚合可查；
4. T4 语义：final 报告 upsert 修订内容后仍 final；draft 报告 upsert 后仍 draft（不自动 final）；
5. 红线：summary/source 不含原文（CHECK 层面只限枚举，内容审计靠测试样例与 review）；
6. 全量回归：既有全部测试不破坏；真实库迁移冒烟（备份→迁移→行数对照）。

## 5. 验收清单

- [ ] uv=5；v4→5 幂等；既有数据零丢失
- [ ] 修订/标记表 + 两视图 + 索引齐备；source_key 幂等生效
- [ ] final 保留语义被测试钉死
- [ ] Python CLI / export_md / make_template 假数据适配完成
- [ ] 真实库迁移完成（bak-v4 备份在位）；隐私扫描通过

## 6. 排期

1. schema.sql + 迁移 + make_template → 2. report_cli/export_md → 3. TS dao/mirror + 测试 → 4. 真实库迁移冒烟 → 5. 提交（2水群 本地 commit；0数据格式 更新随下一次推送窗口）。
