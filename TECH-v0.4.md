# TECH：v0.4 会话维度 + media 表 · 技术方案（定稿）

> 依据：REQUIREMENT-v0.4-media-and-chat.md（需求）+ REPLY-v0.4.md（评审答复）
> schema 版本：`user_version` 3 → **4**。实施 agent 以本文为唯一实施依据。

## 1. schema 变更总览

### 1.1 report 表重建（R1/R2）

```sql
CREATE TABLE report_new (
  id           INTEGER PRIMARY KEY,
  period_type  TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  title        TEXT NOT NULL,
  content_md   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  chat_id      TEXT NOT NULL DEFAULT 'aggregate'
               CHECK (length(chat_id) BETWEEN 1 AND 128),   -- R2
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
-- 迁移：INSERT INTO report_new SELECT id, period_type, period_start, period_end, title,
--          content_md, status, 'aggregate', doc_ids_hint, created_at, updated_at FROM report;
-- 然后DROP report; ALTER TABLE report_new RENAME TO report;
```
chat_id 插列位置在 status 之后（新表按上述列序），迁移 INSERT 按列名显式写。
索引：保留 `idx_report_period(period_type, period_start)`、`idx_report_status`；新增
`idx_report_chat(chat_id, period_start)`；UNIQUE 三元组自动建隐式索引。

### 1.2 media 表（新增，R3/R4）

```sql
CREATE TABLE media (
  id         INTEGER PRIMARY KEY,
  chat_id    TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 128),
  media_type TEXT NOT NULL CHECK (media_type IN ('image','video','file','voice')),
  file_name  TEXT,
  ext        TEXT CHECK (ext IS NULL OR (ext = lower(ext) AND ext NOT LIKE '%.%' AND length(ext) BETWEEN 1 AND 16)),
  size       INTEGER CHECK (size IS NULL OR size >= 0),
  md5        TEXT CHECK (md5 IS NULL OR length(md5) = 32),
  path       TEXT,
  path_kind  TEXT CHECK (path_kind IN ('local','archive')),          -- R3
  status     TEXT NOT NULL DEFAULT 'available'
             CHECK (status IN ('available','pending','missing')),
  source_key TEXT UNIQUE,
  source_ts  INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (status <> 'available' OR path IS NOT NULL)   -- available 必须有地址
);
CREATE INDEX idx_media_chat    ON media(chat_id, media_type);
CREATE INDEX idx_media_created ON media(created_at);
CREATE INDEX idx_media_status  ON media(status);
```

### 1.3 不变的表

doc / tag / doc_tag / entry / chat_digest / v_report_full 不动。
v_report_full 保持 `report.*` 通配（自动带出新列）。

## 2. 迁移机制（幂等、自动）

- 判据：`PRAGMA user_version`。`=3` → 执行 §1.1 重建 + §1.2 建表 + `PRAGMA user_version=4`，单事务；`=4` → 跳过；`0`（全新库）→ 直接执行 v0.4 全量 DDL 并置 4；`>4` → 报错拒开。
- 实现两份：Python（report_cli.py 打开库时执行）与 TS（db.ts openDb 内）；两边逻辑一致，迁移必须可重入（任何一步失败回滚，user_version 最后置）。
- 真实库 `~/WeChat/1数据/knowledge.db` 现为 v3：迁移后 report 5 行全保留、chat_id='aggregate'。

## 3. 各写入方适配

### 3.1 Python（0数据格式/）
- `report_cli.py`：`report gen` 增 `--chat-id`（默认 aggregate，进 title 如「周报 2026-W43 <chatId>」聚合时不加后缀）；`report list/show` 输出 chat_id；upsert 冲突键改三元组。
- `export_md.py`：非 aggregate 行导出路径加会话段：`reports/<chatId>/YYYY-MM-DD.md`；aggregate 维持原路径；frontmatter 加 chat_id。
- `make_template.py`：假数据升级——同日双群两份 daily（两个 chat_id）+ 1 份 aggregate + 若干 media 合成行（含 available/pending/missing 各态、source_key 形如 `demo-chat-1:10001`）。
- media 无 Python CLI（REPLY 答复 §分工）。

### 3.2 TypeScript（2水群 仓库）
- `src/db/schema.ts`：DDL 更新为 v0.4（内嵌，保持与 0数据格式/schema.sql 语义逐字一致）；版本判据改 user_version 3/4 分支。
- `src/db/dao.ts`：upsertReport 增加 chatId 参数（冲突键三元组）；新增 `upsertMedia(m: MediaInput)`（source_key 冲突走 UPDATE，updated_at 刷新）；新增 `listMediaByChat(chatId, filter?)`。
- `src/db/mirror.ts`：report 镜像带真实 chat_id（store 侧 rel 路径已含群 ID，解析传入；解析不出→'aggregate'）。
- `scripts/import-state-to-sqlite.mjs`：reports/<chatId>/YYYY-MM-DD.md 改为**按群各落一行**（chat_id=目录名群 ID），不再跨群聚合分节；已存在的 5 行 aggregate 报告不删不改（迁移回填）；重跑幂等。
- 类型 `MediaInput`：全部字段可选除 chat_id/media_type/source_key/status。

## 4. 测试要求（新增用例）

1. 迁移：v3 样例库（含 2 行同周期 report）→ 迁移后共存、chat_id='aggregate'、行数不变；对 v4 库重跑迁移无变化（幂等）。
2. 双群日报：同 (daily, 2026-01-05) 两个 chat_id 各插一行成功；第三个同 chat_id 走 upsert 更新不新增。
3. media：三种 status 合法插入；status='available' 无 path 被 CHECK 拒；source_key 重写行数不变且 path 被更新；ext 大写/带点被拒。
4. Python CLI：--chat-id gen 双群 + aggregate 三行共存；export_md 目录结构正确。
5. TS 回归：既有 386 测试全过（upsertReport 签名变更处同步修）+ 新用例全过；导入器对真实 state 重跑：非 aggregate 行新增且两遍行数稳定，aggregate 5 行不变。

## 5. 隐私与红线（不变）

- 模板仓库（0数据格式 → GitHub）：合成假数据（`demo-chat-1` 等），零真实 chatroomId；`grep -rniE "[0-9]{6,}@chatroom|zzh4206"` 排除红线声明后零命中。
- 真实数据只进 `1数据/knowledge.db`；媒体本体永不入库，media 只存地址与元数据。

## 6. 验收清单（双方共用）

- [ ] user_version=4；v3→v4 迁移幂等、数据零丢失
- [ ] 同周期多群报告共存；aggregate 语义保留
- [ ] media 幂等重扫、CHECK 防线生效、按会话/类型可查
- [ ] Python + TS + 导入器三方回归通过
- [ ] 隐私扫描通过；模板与真实库分离未破坏

## 7. 实施顺序

1. schema.sql + make_template.py + 迁移逻辑（Python 侧）→ 自测
2. report_cli.py / export_md.py 适配 → 自测
3. TS 侧 schema.ts / dao.ts / mirror.ts / 导入器 + 测试 → 全量回归
4. 真实库迁移冒烟（迁移前自动备份 knowledge.db → knowledge.db.bak-v3）
5. 提交：2水群 本地 commit（不 push）；0数据格式 更新（schema.sql/DESIGN/README/REPLY/TECH 入库）
