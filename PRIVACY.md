# PRIVACY.md — 隐私红线（发布前必读）

本仓库（Wechat_Test）**只包含模板、工具代码与硬编码合成假数据**。任何真实个人数据一律禁止入库。

## 红线（不可逾越）

1. **零真实数据**：真实 wxid、昵称、群名、头像、聊天原文/截图/语音转写，一律不得出现在本仓库任何文件（含代码注释、测试数据、示例输出、提交历史）。
2. **`1数据/` 永不上传**：真实数据库、原始媒体、导出文件只存在于本地 `1数据/` 目录（已在 `.gitignore`）。不得复制进仓库、不得改路径指到仓库内。
3. **`chat_digest` 只存要点不存原文**：`digest_md` 只允许写提炼后的结论/要点；聊天原文、逐句记录、可识别个人的原始片段一律不写。`source_key` 由程序生成的幂等键，不含原始会话标识。
4. **示例数据必须合成**：所有 `sample.db` / 示例输出使用无意义占位文本（如「合成占位…」、Lorem 中文句），标题用「示例：…」前缀。
5. **发布前自查**：`grep -rni "wxid" .`、`grep -rniE "昵称|群名" .` 无真实命中；`git log` 里也不得有历史泄露。

## 外部程序写入规约（针对 2水群 等自动写入 chat_digest 的项目）

- 表名/字段名冻结：`chat_digest(chat_topic, digest_md, happened_on, doc_id, source_key, created_by, created_at)`，禁止改名。
- 幂等键 `source_key`：外部程序生成，格式建议 `topic:YYYY-MM-DD:hash8`；靠 UNIQUE 约束实现重复写入自动去重（INSERT OR IGNORE 或先查后插）。
- 连接规约：`PRAGMA foreign_keys = ON;`、`PRAGMA busy_timeout = 5000;`、写操作用 `BEGIN IMMEDIATE` 短事务，**单写者原则**（同一时刻只允许一个写进程）。
- 只写 `digest_md` 要点；写入前自行过滤任何原文/个人标识。

## 修订记录（v0.2.1 同步）

- content_hash 仅在 content_md 非空时写；CLI 命中相同 hash 时提示「已存在相同内容（id=N）」并拒绝。
- entry.report_id / entry.doc_id / chat_digest.doc_id 外键为 ON DELETE SET NULL。
- report 周期一致性 CHECK；日期字段 GLOB 格式防线；report 重新生成走 UPDATE 不删建。
