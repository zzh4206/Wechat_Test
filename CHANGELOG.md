# 更新日志

本文件记录本项目的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 前端工作台 FE-2（审批收件箱）：「审批」页列出各白名单群待确认的任务/承诺/事件、无时限任务与进行中事项，带证据预览与前后文；可确认、取消、完成、定时间、兑现、关闭，「人员关注」页可关注/取消关注成员。提交经 `POST /api/actions` 追加到 `web/actions.jsonl`（web 进程唯一写入点 `web/lib/actions.mjs`，拒绝符号链接），插件收件箱执行后页面轮询回执显示结果。写动作要求共享 token（`LURKER_WEB_TOKEN` = `webActionsToken`）、插件收件箱开启（清单新增 `actionsEnabled`）、本服务 Origin 与 JSON 请求体；web-boundary 哨兵加钉动作模块只许追加写。启动与开启方法见 RUNBOOK §14
- 前端工作台 FE-1（只读回溯，前端设计方案 B）：新增独立 web 进程 `web/server.mjs`（零 npm 依赖、只监听 127.0.0.1、只读打开 knowledge.db / 每群库 / digests，FE-1 零写入），页面含报告月历与详情（修订历史、前后期切换）、资料库、媒体清单、会话要点、人员关注摘要；`/api/*` 校验 token（`LURKER_WEB_TOKEN`）、Host、Origin，严格 CSP、不发 CORS 头；正文经服务端解析为 JSON 块结构、前端只用 textContent 渲染。插件启动时写 `<stateDir>/web/allowed-chats.json`（`src/web-manifest.ts`，白名单 + knowledge.db 路径，设计 §11-Q5 方案 b），web 进程据此做白名单校验、清单缺失或为空拒绝启动。新增哨兵 `tests/web-boundary.test.mjs`（web/ 只 import node: 内置与自身模块、无子进程/出网、零写原语、listen 只认 127.0.0.1、页面禁 innerHTML 类原语）与功能/安全用例 `tests/web-server.test.mjs`；启动与排障见 RUNBOOK §14
- 前端动作通道加固一批（2026-10-20 前端准备审查 W-1/W-2/W-3/W-9）：收件箱水位改**字节偏移**（`web/actions.offset` 存 `{byteOffset, lastActionId}`，每行处理后立即落盘；截断/轮转 → 从头 resync + error 审计、actionId 连续性锚点不符 → resync + warn、尾部半行不消费）——修回设计「水位=字节偏移」口径；审计行增 `operator`（共享 token 的 sha256 前 8 位，新配置 `webActionsToken`，绝不落原 token）；`webActionsEnabled` 开但 task/promise 识别缺失时启动 error 指明缺失依赖与「收件箱不消费」后果；回执写失败入有界内存墓碑下轮补写 + 连续失败 error 告警；RUNBOOK 新增 §13 前端对接硬约定（禁轮转/截断 actions.jsonl、outbox 补丁行读侧归并等）
- reminder 每日速览 `evidence_ref` 改指 outbox 条目自身（`outbox/<id>`，`appendOutbox` 支持调用方预生成 id）——不再指向从未写入的 `reminder/digest/<day>.txt`（W-11）

- schema v0.6（审批双通道与报告修订流，TECH-v0.6 定稿）：纯新增 `report_revision`（修订历史，`source_key` 幂等、不可变事实、不建 report 外键）与 `marking`（完成情况标记，kind 三态 done/undone/deleted，同 `target_ref` 状态演变=追加行）两表及 `v_report_revised` / `v_marking_latest` 两视图，既有表零改动；`KnowledgeDao` 增 `insertReportRevision` / `insertMarking`（source_key 冲突→返回已有 id 不更新）/ `listRevisions` / `listMarkingsLatest`，`SqliteMirror` 增 `mirrorReportRevision` / `mirrorMarking`（safe 包裹，事件源接线由插件侧后续完成）；自动迁移升 user_version 4→5 单事务幂等（v3 先升 4 再升 5，0=全新建 v5，其余 <4 或 >5 拒开），与 Python 侧（0数据格式）逻辑一致

- schema v6（工单 D-3/D-4/D-5/D-7，2026-10-20）：`entry` 增列 `chat_id`（迁移回填 `'aggregate'`）+ 索引 `idx_entry_chat`，`v_marking_latest` 分组改 `(chat_id, target_ref)`（不同群同名任务各留最新态）；`KnowledgeDao.insertEntry` / 镜像 `opportunity→entry` 带群 `chatId`；自动迁移升 user_version 5→6 链式幂等（v4 先升 5 再 6、v3 先升 4 再 5 再 6，0=全新建 v6，>6 拒开），与 Python 侧逻辑一致
- group-store：store.db 连接补 `busy_timeout=5000`（D-7），写竞争时忙等而非即刻 SQLITE_BUSY

### Fixed

- 前端收件箱回执：前端动作调审批门面时没传 `source`，落到缺省 `'chat'`，前端审批在修订段被记成「来源：对话框」——改为显式传 `'web'`；生产接线没给 `ActionInbox` 注入 `resolveTarget`，已处理过的目标一律回 `not_found`（且 `event.*` 被当任务 id 查）——`createApprovalWiring` 新增 `resolveInboxTarget` 并注入，按 task/promise/event 区分，已处理过的回 `status_conflict`
- 前端工作台页面：可选内容为空时出现文字「null」（原生 `replaceChildren` 不跳过 null）——改用过滤空值的 `fill()`
- 审批接线：`taskComplete` 的 `marks` 依赖改走 `reportRevision.markTarget`（原直连 `store.mirrorMarking`）——不存在的任务不再"完成成功"，完成时出身日报照常追加修订段并级联周/月报，与收件箱 `task.mark` 同源同效。组装抽成 `src/approval-wiring.ts` 的 `createApprovalWiring`，`index.ts` 与 `tests/wiring.test.mjs` 共用，接线测试从此测的是生产接线
- outbox `updateSendState` 由整文件读-改-写改**追加状态补丁行**（`{patch:true, id, …patch}`），读取侧（`tailOutbox`/`listOutbox` 及测试 helper）按 id fold 归并——与 `appendOutbox` 并发不再丢追加（审查 W-4）；regen 整文件覆写与修订段追加的并发安全以并发断言测试钉死（渲染 span 与追加 span 内零 await，单线程原子，W-5）
- T4 语义：`upsertReport` 冲突分支不再用 `excluded.status` 覆盖既有 status——`final` 报告被修订后仍 `final`（修订不降级），`draft` 也不会被自动 final（draft→final 单向定稿由 finalize 通道承载），测试钉死

### Fixed

- 文件消息归档缺口（「local_type 49 ≠ 一定是链接」诊断落地）：`FileIndexService` 新增 `ingestFromListing`——以工具 `files` 子命令清单（`msg_id/name/path/available`）为兜底数据源补全 files 表。背景：微信 4.x 的 appmsg 文件消息 `local_type` 低 32 位与链接同为 49 且 XML 不导出，消息流侧只能归 `kind='link'`、占位无文件名，消息流扫描拿不到 `kind='file'` 行 → files 表恒 0。新增配置 `fileIndexListIntervalMin`（默认 30，0=关）/ `fileIndexListTimeoutMs` / `fileIndexListLimit`；摄取失败/超时只 warn 不阻塞；幂等（同名同大小同发送者键合并 appearances；孤儿 `msg_id` 因外键置 NULL，来源保留在 `file_id`）。证据链见 `docs/REPORT-文件消息归档缺口诊断.md`，条目入 `docs/ERROR-REFERENCE.md` §3.12（ERR-FIDX-002）

### Added

- 报告落盘并行提取非对话资料入 doc 表（`mirrorDocsFromReport`，`mirrorReport` 内部紧随调用）：提取全部唯一 URL（截断/尾部标点剥离口径与 `0数据格式/extract_docs_from_reports.py` 一致）逐条 `upsertDoc`（category='web'，title=「资源：<引用行可读描述或域名>」，source_ref=`报告 <dateKey> · <chatId>`）并挂「来自报告」标签（github.com 另挂「github」）；「### 本期文件索引」非占位行建 file doc（source_type='file_import'）。查重与 Python 同口径：全库 `content_md` 已含该 URL 即跳过（`findDocIdByUrl`，instr 精确子串）+ 行指纹 hash——与 Python 批量脚本先后跑零重复，命中保持首建 `source_ref` 不覆盖。逐条 safe 包裹，单条失败只 warn 不影响主流程。`KnowledgeDao` 增 `ensureTag` / `findDocIdByUrl` / `findDocByHash`
- schema v0.4（会话维度 + media 表）：`report` 增列 `chat_id`（`'aggregate'`=跨群聚合），冲突键改三元组 `(period_type, period_start, chat_id)`；新增 `media` 元数据表（媒体本体永不入库，`path_kind`、status 三态、`source_key` 幂等键）；`KnowledgeDao` 增 `upsertMedia` / `listMediaByChat`，`upsertReport` 带 `chatId`
- schema 自动迁移（`db.ts openDb`）：`user_version` 3→4 单事务幂等（report 重建回填 `chat_id='aggregate'`、建 media 表），0=全新建 v4，>4 报错拒开，与 Python 侧逻辑一致
- 双写镜像接入主入口（`index.ts apply`）：新增配置 `sqlitePath`（留空 = 默认 `~/WeChat/1数据/knowledge.db`；`'off'` 关闭）。SQLite 为查询层、JSONL 仍为事实源，镜像写失败只 warn 不影响主流程

### Changed

- 镜像与导入器按群落 report 行：`reports/<chatId>/YYYY-MM-DD.md` → `chat_id=<群 ID>`（不再跨群聚合分节）；既有 aggregate 行不删不改

### Added

- SQLite 知识库数据层（`src/db/`，node:sqlite `DatabaseSync`，零 npm 依赖）：冻结 schema v0.2.1 内嵌 DDL、`KnowledgeDao`（doc/entry/report/chat_digest，`source_key` 与 `(period_type, period_start)` 幂等 upsert）、`BEGIN IMMEDIATE` 短事务、写失败只 warn 不致命
- 可选 SQLite 镜像：`Store` 构造函数新增 `sqlitePath?`——传入即把 `groups/<chatId>/insights.jsonl`（→ `chat_digest`/`entry`）与 `reports/<chatId>/YYYY-MM-DD.md`（→ `report`）镜像进知识库；JSONL 仍是事实源，镜像失败静默降级
- 一次性导入器 `scripts/import-state-to-sqlite.mjs`：`--state-dir`（只读）+ `--db`（默认 `<home>/WeChat/1数据/knowledge.db`），可重复运行（`source_key` 内容哈希幂等）
- `sender` 发送前**定位闸**：keyboard 模式先 `wechat-ui open --chat` 精确锁定目标会话（侧栏 OCR 唯一命中才点击），免除"文件传输助手须常驻前台"这一使用前提；失败按 `target_missing` / `env_unavailable` / `ui_tool_missing` / `tcc_denied` 分类延迟处理并落审计（`result='locate_deferred'`），**不计入失败重试次数**
- 发送段改用 `wechat-ui deliver --chat`：定位打开 → 点焦点 → 合成 Cmd+V → OCR 复核草稿 → OCR 锚定"发送"按钮 → 轮询草稿清空（替代对微信 4.x 输入框无效的合成 Return）
- 仓库防线：`scripts/check-sensitive.sh` 与 CI `sensitive-scan` job，阻止真实 `wxid` / 群 ID / 家目录路径 / 密钥再次进入仓库
- 治理文件：`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`.github/` 工作流与模板、`.gitattributes`、`.editorconfig`、`docs/README.md` 文档索引
- `AGENTS.md`：给并行工作的 AI agent 的硬性约束（提交前必跑命令、敏感数据红线表、R1–R5 安全边界、并行提交注意）

### Changed

- 文档与测试中的真实标识符一律替换为占位符（`wxid_xxx`、`12345678@chatroom`）
- golden 夹具改名并匿名化：`tests/fixtures/seg-golden/12345678@chatroom-2026-10-15.json`（保留 `ts` 与 `boundaries`，`msgId` 替换为合成值）
- `.gitignore` 补入本地运行配置（`cordis.local.yml`、`*.local.*`）、`.env` 与编辑器目录

### Security

- **清理已推送的公开历史**：历史提交中的真实 `wxid`（主号与小号）与群 ID 已用 `git filter-repo` 抹除，并强推覆盖。**注意：`v0.2.0` 之前历史的提交 SHA 已全部改变**，旧的 commit URL 不再可用

## [0.2.0] - 2026-10-16

### Added

- 每群独立人格与独立消息缓冲；按群覆盖人格（`groupPersonas`）
- 昵称解析：群消息自动映射 `wxid` → 群内显示名（备注名优先）
- 增量游标与去重窗口：重启不重投、不漏新；默认不回灌历史（`backfillOnStart`）
- 单实例锁（含 PID 已死时安全接管）
- 日报系统：金字塔 schema 归纳 + 证据溯源 + 降级链路
- 成本可观测：`groups/<chatId>/llm-calls.jsonl` 记录 `model / inTokens / outTokens / costCny / tokensEst`，报告尾输出统计行
- 两段式生成实验开关 `schemaTwoStage`（默认关闭）
- T1.5 积压追赶：单轮持续向前翻页直至读空，超上限时告警并建议人工 backfill
- 审计日志：仅记录元数据（时间、群、条数、成败），绝无消息内容

### Security

- 受监管读取三原则：白名单为空即 fail-closed；白名单外群在适配器层零子进程调用；读取行为全程审计
- `no-send` 静态哨兵测试：钉死读取路径不持有消息发送通道
- 解密密钥经 stdin 传入，不进入命令行参数

[Unreleased]: https://github.com/zzh4206/Wechat_Test/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zzh4206/Wechat_Test/releases/tag/v0.2.0
