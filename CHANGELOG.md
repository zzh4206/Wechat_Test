# 更新日志

本文件记录本项目的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0] - 2026-11-11

### Added

- 前端工作台 FE-1：独立只读 web 进程 `web/server.mjs`，零 npm 依赖、只监听 127.0.0.1、只读打开知识库
  - 页面：报告月历与详情（修订历史、前后期切换）、资料库、媒体清单、会话要点、人员关注摘要
  - `/api/*` 校验 token、Host、Origin，严格 CSP、不发 CORS；正文由服务端解析为 JSON 块，前端只用 `textContent` 渲染
  - 插件启动时写 `<stateDir>/web/allowed-chats.json`，web 进程据此做白名单校验，清单缺失或为空则拒绝启动
- 前端工作台 FE-2：审批收件箱，可确认 / 取消 / 完成 / 定时间 / 兑现 / 关闭，人员关注页可关注或取消关注成员
  - 提交经 `POST /api/actions` 追加到 `web/actions.jsonl`（web 进程唯一写入点，拒绝符号链接），插件执行后页面轮询回执
  - 写动作要求共享 token、`actionsEnabled`、本服务 Origin 与 JSON 请求体；`operator` 不一致即回执 `operator_mismatch`
- 前端工作台 FE-3：报告详情页可「定稿」「重新生成」「排入发件箱」，三条路都不直接发送
  - `report.finalize` 为 draft → final 单向并记一条 `status` 修订；已定稿回执 `status_conflict`，未启用知识库镜像回执 `unsupported`
  - 重新生成只入手动重跑队列；排入发件箱受 `webOutboxEnabled`（默认 false）控制，同一报告 10 分钟内重复排入回执 `duplicate`
- 跨群汇总报告（`chatId='aggregate'`）纳入报告操作：插件收件箱与 web 侧只放行 `report.*` 且只认日报
  - 非报告动作仍 `chat_not_allowed`，非日报周期回执 `aggregate_daily_only`；重跑按该日原定生成时刻重新汇总、不调 LLM
- 成本治理 C1/C2：提炼失败退避与熔断、增量水位去重复提炼
  - C1 状态存 `groups/<chatId>/distill-state.json`，连续失败按 `min(30min, 1min×2^(k-1))` 退避，5 连败熔断 1 小时并告警一次
  - C2 只送 `lastDistilledMsgTs/Id` 之后的新消息，过滤后为空不调用；部分批失败时水位冻结在连续成功前缀末尾
- 成本治理 C3/C4：输入瘦身与缓存价估算
  - C3 新增共享 `toWireMessages()`：`text` 只编码一层、`ts` 转秒、非文本折叠为占位保留行、长文截断；181 条样本实测数据区 −30.1%
  - C4 增 `ModelPricing.cacheInput` 与 `estimateCostWithCache()`，指令前缀逐字节稳定，报告尾给出「命中缓存可再省 ≈X%」
- 合成基准工具链：不依赖真实群聊即可验证 LLM 成本与鲁棒性策略
  - 画像只输出统计量（无文本 / ID / 时间戳）；固定种子生成会话并植入真值
  - 故障注入可编排 timeout / 429 / 5xx / auth / 坏 JSON / 延迟；重放复刻生产语义并输出 I1–I5 不变量判定
  - 文档见 `docs/SYNTHETIC-BENCH.md`，方法论见 `docs/SYNTHETIC-BENCH-METHODOLOGY.md`
- 基准新增 `--storm`：同一 fixture 先跑零失败基线，再注入失败，按 1.5x 判 I3
  - 单次重放时 I3 如实给 `pass: null`（N/A）并提示判法，不再假装有结论
  - `retryAmplification` 更名为 `callFanout`（观测量而非判据），新增 `distill.intervalRounds` / `distill.expectedRounds`
- SQLite 知识库数据层与 schema 演进（v0.4 → v0.6 → v6，链式幂等迁移）
  - 数据层 `src/db/`：冻结 DDL、`KnowledgeDao`（`source_key` 与三元组幂等 upsert）、`BEGIN IMMEDIATE` 短事务，写失败只 warn
  - v0.4 会话维度 + `media` 表；v0.6 `report_revision` 与 `marking`；v6 `entry.chat_id` 与按群落分组的最新标记视图
  - 一次性导入器 `scripts/import-state-to-sqlite.mjs` 可重复运行；`>6` 的库拒绝打开
- 报告落盘时并行提取资料入 `doc` 表：唯一 URL 逐条 `upsertDoc`，「文件索引」非占位行建 file doc
  - 与 `0数据格式/extract_docs_from_reports.py` 同口径：全库 `content_md` 已含该 URL 即跳过，与 Python 脚本先后跑零重复
- 文件消息归档兜底：`FileIndexService.ingestFromListing` 以 `files` 清单补全 files 表
  - 背景：微信 4.x 文件消息的 `local_type` 低 32 位与链接同为 49 且 XML 不导出，消息流侧只能归为 link，files 表恒为 0
  - 新增 `fileIndexListIntervalMin`（默认 30，0=关）/ `fileIndexListTimeoutMs` / `fileIndexListLimit`，失败只 warn 不阻塞
  - 证据链见 `docs/REPORT-文件消息归档缺口诊断.md`
- 仓库防线与治理文件：`check-sensitive.sh` 与 CI `sensitive-scan`、`SECURITY.md`、`CONTRIBUTING.md`、`AGENTS.md`、文档索引
- 补记 sender 发送链路：受监管读取 → 键盘原语 → 发送 worker，四道闸、配额与回读验证
  - 键盘流程：`⌘⇧W` 切会话、`⌘F` 搜索定位，合成粘贴后轮询草稿清空
  - 10-20 之前的 `wechat-ui open`/`deliver` + OCR 实现已移除且从未发布，原文见 `docs/CHANGELOG-DETAILS.md`
- 补记 日报系统 T1–T9：金字塔 schema 归纳、证据溯源、降级链路、积压追赶
- 补记 `scripts/llm-cost.mjs`：按群 / 按日查询 LLM 花费
- 补记 两段式生成实验开关 `schemaTwoStage`（默认关闭）与 `groups/<chatId>/llm-calls.jsonl` 成本可观测

### Changed

- CI 的 `pull_request` 触发不再限定 base 分支：所有 PR 都跑 `build-test` 与 `sensitive-scan`，并新增 `workflow_dispatch`
  - 起因：#17/#18 的目标分支为 `llm/revert-last-two`，PR 上整条 CI 未触发，两条失败的测试合入半个多月后才被发现
- 报告修订落位规则：标记写「操作当天」的日报，审批写「出身日」的日报，修订行时间戳一律为操作时刻
  - 标记是工作流的演化，应体现在当天；审批是对该条目的确认，归属它所在的那份报告
- 镜像与导入器按群落 report 行：`reports/<chatId>/YYYY-MM-DD.md` 映射为 `chat_id=<群 ID>`，不再跨群聚合分节
- 双写镜像接入主入口：新增 `sqlitePath`（留空 = 默认 `~/WeChat/1数据/knowledge.db`，`'off'` 关闭），JSONL 仍是事实源
- 文档与测试中的真实标识符一律替换为占位符；golden 夹具改名并匿名化；`.gitignore` 补入本地配置与编辑器目录
- 补记 依赖升级：TypeScript 5.9.3 → 7.0.2、`@types/node` 26.x、`actions/checkout` 与 `actions/setup-node` 大版本

### Fixed

- 提炼器重试风暴（2026-10-20 单群 ¥34.87 的元凶）：失败路径不更新水位也不清计数，`tick()` 又对从未成功的群每 30s 必触发
  - 实测单群一天 1948 次调用、93% 失败；两路叠加成「每条新消息跑一轮全量提炼」
  - 改为失败只记账并退避（失败不消费消息计数），是否真调 LLM 只由 `nextAttemptAt` 决定，状态跨重启持久化
- 基准两条判据的口径错误（`--fail 0` 下也必红，红了半个多月无人认领）
  - I1 上界原假设「阈值触发主导」，而 fixture 上 tick 先到、每轮只喂 3 条新消息（实测 51 轮 vs 上界 6）；改为（阈值轮 + 定时轮）× 失败余量，本 fixture 上界 57
  - I3 原「提炼调用 / 理论最少批数 ≤ 3.0」量到的是定时小批扇出而非重试；改为 A/B 口径 1.5x 且只在 `--storm` 下判定
- 基准 fixture 注释与实际默认值不符（写「每 5 条触发 + 30 分钟 tick」，代码是每 25 条 + 15 分钟）
- 标记的修订归属改为标记发生当天的日报，并级联当天所在周 / 月（此前误与审批同口径写出身日报）
- 收件箱加固（W-1/W-2/W-3/W-9）：水位改字节偏移，审计记 `operator`，回执墓碑补写，RUNBOOK 增对接硬约定
  - 水位存 `web/actions.offset` 的 `{byteOffset, lastActionId}`，每行处理后立即落盘；截断 / 轮转 / 半行 / 连续性不符分别 resync 并告警
  - 审计行增 `operator`（共享 token 的 sha256 前 8 位，绝不落原 token）；回执写失败入有界内存墓碑，下轮补写
  - RUNBOOK 新增 §13：禁轮转 / 截断 `actions.jsonl`、outbox 补丁行读侧归并等硬约定
- 重跑链路：`report.regen` 去重回执由 `not_found` 改为 `duplicate`；手动重跑独立轮询；错号补发按条目周期处理
  - 手动重跑原被 satisfied 检查直接出队、只在日报 tick 且配了账号闸时才处理、生成后还会进 outbox 发送；改为独立轮询 `startManualRegen`
  - 错号补发原固定查日报 meta、按 daily 落盘重试、outbox 标题固定为日报；`regen-queue.json` 载入的运算优先级错误一并修正
- 前端收件箱回执：调审批门面未传 `source` 被记成「来源：对话框」，改为显式 `'web'`
  - 生产接线未注入 `resolveTarget`，已处理过的目标一律回 `not_found`；新增 `resolveInboxTarget` 按 task / promise / event 区分，已处理的回 `status_conflict`
- 审批接线：`taskComplete` 的 `marks` 改走 `reportRevision.markTarget`，不存在的任务不再「完成成功」
  - 组装抽成 `src/approval-wiring.ts` 的 `createApprovalWiring`，`index.ts` 与测试共用，接线测试从此测的是生产接线
- outbox `updateSendState` 由整文件读-改-写改为追加状态补丁行，读取侧按 id 归并，与 `appendOutbox` 并发不再丢追加
- `upsertReport` 冲突分支不再用 `excluded.status` 覆盖既有状态：`final` 报告被修订后仍 `final`，`draft` 也不会被自动定稿
- 回填窗口终点由「现在」改为该日 `dailyReportTime`：汇总重跑、错号补发与手动重跑，之后几天的消息不再计入统计或喂给 LLM
- 前端页面可选内容为空时显示文字「null」（原生 `replaceChildren` 不跳过 null）→ 改用过滤空值的 `fill()`
- 报告操作与审批解耦：任务 / 承诺识别未开启时，报告操作（定稿 / 重新生成 / 排入发件箱）照常可用
  - 审批类动作回执 `unsupported`；启动日志由 error 降为 warn 并如实说明哪些能力仍可用
- reminder 每日速览的 `evidence_ref` 改指自身 outbox 条目（`outbox/<id>`），不再指向从未写入的 `reminder/digest/<day>.txt`
- `store.db` 连接补 `busy_timeout=5000`，写竞争时忙等而非立刻 `SQLITE_BUSY`
- 补记 账号闸 fail-closed：修复「大号在线时误发」的生产事故（P0）
- 补记 错号空报告补发队列：错号恢复后补发，不再被排在前面的人工条目阻塞

### Security

- 清理已推送的公开历史：`git filter-repo` 抹除历史提交中的真实 `wxid` 与群 ID 后强推
  - **`v0.2.0` 之前历史的提交 SHA 已全部改变**，旧的 commit URL 不再可用

## [0.2.0] - 2026-10-14

> 本段成文于 2026-10-17（发布后补记，提交 `1bcbf1f`，比 `v0.2.0` tag 对象早两分钟）。整理时修正两处：
> 版本日期原写 `10-16`，而 tag 指向 `392d5e5`（2026-10-14 09:47）；`llm-calls.jsonl` 与 `schemaTwoStage`
> 由 10-16 的提交引入、**不在该 tag 树里**，已移入 0.3.0。

### Added

- 每群独立人格与独立消息缓冲；按群覆盖人格（`groupPersonas`）
- 昵称解析：群消息自动映射 `wxid` → 群内显示名（备注名优先）
- 增量游标与去重窗口：重启不重投、不漏新；默认不回灌历史（`backfillOnStart`）
- 单实例锁（含 PID 已死时安全接管）
- 日报系统：金字塔 schema 归纳 + 证据溯源 + 降级链路
- T1.5 积压追赶：单轮持续向前翻页直至读空，超上限时告警并建议人工 backfill
- 审计日志：仅记录元数据（时间、群、条数、成败），绝无消息内容

### Security

- 受监管读取三原则：白名单为空即 fail-closed；白名单外群在适配器层零子进程调用；读取行为全程审计
- `no-send` 静态哨兵测试：钉死读取路径不持有消息发送通道
- 解密密钥经 stdin 传入，不进入命令行参数

[Unreleased]: https://github.com/zzh4206/Wechat_Test/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/zzh4206/Wechat_Test/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zzh4206/Wechat_Test/releases/tag/v0.2.0
