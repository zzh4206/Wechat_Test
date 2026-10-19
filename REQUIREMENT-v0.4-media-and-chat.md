# 需求提案 v0.4：会话维度 + 媒体附件地址表

> 提出方：群聊报告系统（TypeScript 微信群报告系统 / 2水群 仓库）
> 提出日期：2026-10-16
> 背景：该系统已实测双群并行运行（每群每天一份日报 + 每群有文件/图片/视频需要登记地址），现行 v0.3 schema 存在两个缺口，提请模板方评审并纳入 v0.4。
> 性质：需求提案——schema 变更由模板方定稿；本文只描述需求与建议 DDL，不代替模板方决策。

---

## 需求一：报告表增加会话维度（修复双群同日互斥）

### 现状问题

`report` 表 `UNIQUE (period_type, period_start)` 在"多群并行"场景下互斥：插件每天为**每个群**各生成一份日报（cs101 群与 Test 群各一份），第二份必然撞 UNIQUE 约束无法入库。周报/月报同理。

### 需求

1. `report` 表新增 `chat_id TEXT NOT NULL DEFAULT 'aggregate'` 列：
   - `'aggregate'` = 跨群汇总（现有聚合报告的归宿）；
   - `'<chatroomId>'` = 单群日报（如 `'12345678@chatroom'`）；
2. `UNIQUE` 约束改为 `(period_type, period_start, chat_id)`；
3. 新增索引 `idx_report_chat ON report(chat_id, period_start)`；
4. （可选，供前端按群筛选）新增 `chat` 维度表或 `chat_id` 字典说明，模板方定。

### 建议 DDL（v0.4 迁移，模板方定稿）

```sql
-- 旧数据（聚合行）chat_id 回填 'aggregate'
ALTER TABLE report ADD COLUMN chat_id TEXT NOT NULL DEFAULT 'aggregate';
-- SQLite 不能改 UNIQUE，需重建表（保留全部既有数据）
```

### 验收

- 同一 `(period_type, period_start)` 下两个不同 chat_id 的日报可共存；
- 旧聚合行保留且 chat_id='aggregate'；
- 现有写入方（report_cli.py / TypeScript 镜像）按新约束 upsert 幂等。

---

## 需求二：新增媒体附件地址表（群聊文件/图片/视频的地址登记）

### 需求描述

群聊中出现的**文件、图片、视频**需要登记其**存储地址与元数据**——只存地址与元数据，**绝不存媒体文件本体**（隐私红线，与 PRIVACY.md 一致）。

数据来源：上游插件已具备按会话查询文件存储路径的能力（`files --chat-id` 子命令），每条媒体可提供：所属会话、来源消息标识、类型、文件名、大小、本机路径（可得时）、状态（可用/待下载）。

### 建议 DDL（模板方定稿）

```sql
CREATE TABLE media (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL,              -- 所属会话（chatroomId）
  media_type   TEXT NOT NULL
               CHECK (media_type IN ('image','video','file','voice')),
  file_name    TEXT,                       -- 原始文件名（可空，微信可能匿名）
  ext          TEXT,                       -- 扩展名（小写，无点）
  size         INTEGER,                    -- 字节（可得时）
  md5          TEXT,                       -- 内容指纹（可得时）
  path         TEXT,                       -- 存储地址：本机路径 / 1数据 相对路径
  status       TEXT NOT NULL DEFAULT 'available'
               CHECK (status IN ('available','pending','missing')),
  source_key   TEXT UNIQUE,                -- 幂等键：外部写入方生成（如 '<chatId>:<server_id>'）
  source_ts    INTEGER,                    -- 来源消息时间戳
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_media_chat ON media(chat_id, media_type);
CREATE INDEX idx_media_created ON media(created_at);
CREATE INDEX idx_media_status ON media(status);
```

要点：
- `source_key` UNIQUE：外部系统（TypeScript 插件）幂等写入，重扫不重复入库；
- `status='pending'`：路径未定位（如媒体未下载），后续可补；
- `path` 支持两种形态：本机绝对路径（微信原始存储）或 `1数据/` 归档路径（用户归档后）；
- 只存地址与元数据；**媒体本体永不入库**（隐私红线）。

### 验收

- 按会话查询：`SELECT * FROM media WHERE chat_id=?`；
- 按类型统计：`media_type` 分组计数；
- 幂等重扫：同一 `source_key` 重复写入不产生重复行；
- 隐私：表中任何字段不含聊天原文与媒体本体。

---

## 迁移与兼容

1. v0.3 → v0.4 迁移须幂等、保留全部既有数据（当前真实库已有 report 5 行 / entry 434 / chat_digest 2514）；
2. TypeScript 镜像侧（src/db/schema.ts / dao.ts / mirror.ts）同步 v0.4；
3. Python CLI（report_cli.py / export_md.py）适配新约束。

## 优先级建议

| 项 | 优先级 | 理由 |
|---|---|---|
| 需求一（chat 维度） | **高** | 双群日报每晚都在生成，镜像侧已存在互斥隐患 |
| 需求二（media 表） | 高 | 文件/图片/视频地址是用户明确要求的存储内容，且插件侧数据源已就绪 |
