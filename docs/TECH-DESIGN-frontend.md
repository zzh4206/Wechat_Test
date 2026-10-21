# 技术设计：本地前端工作台（报告回溯 + 待审批收件箱）

- 版本：v0.1（草案，2026-10-21 入库；正文保持 v0.1 原貌，仅分期编号按 [REF-prefixes.md](REF-prefixes.md) 改为 FE-N）
- 状态：§3 方案 B 已采纳；插件侧服务面（FE-2 的 ActionInbox / ApprovalActions）已落地；**FE-1 / FE-2 已落地**（`web/`，启动与开启审批见 RUNBOOK §14）；FE-3 已落地定稿与重新生成，「排入发件箱」待实施（单独 PR，带默认关闭的插件侧开关）
- 数据层依据：[`0数据格式/`](../0数据格式/README.md)（本稿写于 schema v0.4，现行为 v6）、`src/group-store.ts`（每群库）
- 安全依据：[SECURITY-TEST-PLAN.md](SECURITY-TEST-PLAN.md) §0 五条红线

> **实施以后续文档为准**：本稿是讨论起点，下列内容已被后续设计/实现细化或取代——
>
> - 动作通道硬约定（字节偏移水位、回执码、`webActionsToken` 共享 token 与 operator 审计）：[RUNBOOK.md](RUNBOOK.md) §13；本稿 §6.2「启动时生成随机 token」以 RUNBOOK 为准
> - 动作白名单与门面结构（含 `task.mark` / `person.follow` 等新增动作）：[TECH-DESIGN-confirm-loop.md](TECH-DESIGN-confirm-loop.md)；本稿 §5 表仅作背景
> - 审批/标记后的报告修订流、`report_revision` / `marking` 表：[DESIGN-approval-marking.md](DESIGN-approval-marking.md)
> - §11-Q2 已决：`upsertReport` 冲突时保持既有 status（T4 裁定，final 不再被打回 draft）
> - §11-Q3 已决：`regen-queue` 已泛化 `kind`（daily/weekly/monthly）与 `reason`（`manual`）
> - §11-Q5 已决：采用 (b)，插件启动时写 `<stateDir>/web/allowed-chats.json`（`src/web-manifest.ts`，含白名单与 knowledge.db 路径）；白名单为空照写，web 进程据此拒绝启动
>
> **FE-1 实施与本稿的差异**：
>
> - token：环境变量 `LURKER_WEB_TOKEN` 传入（不走命令行参数，免得出现在 `ps` 里）；未设时才随机生成并只打印一次。浏览器经 `#token=` 带入，存 sessionStorage 后从地址栏抹掉
> - 正文渲染：§4.2「安全渲染为 HTML 片段」与 §6.1「前端禁 innerHTML」相互矛盾，实现取后者——服务端把 Markdown 子集解析为 **JSON 块结构**，前端用 createElement + textContent 搭 DOM，整条链路不解析任何 HTML
> - 接口：增 `/api/docs/:id`（资料正文）；`/api/inbox`、`/api/evidence`、`/api/actions*` 归 FE-2；对比视图未做
> - 哨兵：§6.3 各条之外，还限定 web/ 只能 import `node:` 内置与 web/ 内模块、`node:http` 只许取 `createServer`
>
> **FE-2 实施与本稿的差异**：
>
> - 写动作前提：web 进程用共享 token 启动且其指纹与插件 `webActionsToken` 的指纹一致、插件清单 `actionsEnabled=true`（插件把收件箱是否在消费、token 指纹写进 allowed-chats.json）、请求带本服务 Origin 且为 JSON；任一不满足返回 409/403/415，页面只读
> - 审计对齐：动作行带 `operator`（web 进程 token 指纹），插件配置了 token 时不一致即 `operator_mismatch` 不执行——审计 `operator` 因此一定对应浏览器实际使用的 token（RUNBOOK §13.3）
> - 前端只开放插件白名单的子集（见 RUNBOOK §14.2）；`actionId` 由服务端生成，不信任请求体
> - 动作类型沿用插件侧命名（`task.set_deadline`，非本稿 §5 的 `task.setDeadline`）
> - 收件箱除待确认三类外，还列进行中的任务/承诺（完成、兑现、关闭），无时限任务单列「待定时间」
>
> **FE-3（定稿、重新生成）实施与本稿的差异**：
>
> - 定稿走插件收件箱新动作 `report.finalize`（不是 §5 设想的 web 侧直调 `setReportStatus`）：参数为 `{kind, dateKey}`（周期起点），与 `report.regen` 同一校验，不依赖 knowledge.db 行号；定稿记一条 `status` 修订
> - 重新生成只入手动重跑队列、**不进发件箱**（补发队列修正后的语义）；推送到手机只能走「排入发件箱」一个入口
> - 跨群聚合报告暂不提供这两个操作

---

## 0. 背景与目标

现状：报告由 sender 经 filehelper 推到手机端查看。单向推送适合「今天的日报」，但两类交互很别扭：

1. **多日期回溯**：想看上周三某群日报、对比两周周报，只能翻 filehelper 聊天记录；
2. **待审批业务**：任务/承诺/事件识别后入库为 `pending_confirm`，无 deadline 的任务需要「提请审批具体时间」——但 filehelper 是单向通道，没有回执。

盘点代码时发现第 2 点比「生硬」更严重：`TaskRecognitionService.confirmTask / cancelTask / completeTask / confirmEvent`、`PromiseRecognitionService.confirmPromise / cancelPromise / confirmFulfilled / closePromise` 在 `src/` 内**零调用方**。审批闸门有出口无入口，`pending_confirm` 只进不出，模式学习（`learned_pattern` 免确认）也因此永远不会触发。

**目标**：提供一个只在本机访问的 Web 工作台：

- **回溯**：按 日期 × 群 × 周期 浏览全部报告、资料、媒体元数据；
- **审批**：集中处理待确认项，给无 deadline 任务定时间；
- **不扩大攻击面**：五条红线零削弱，监听端口的进程不持有任何发送能力。

## 1. 范围

| 期 | 内容 |
|---|---|
| FE-1 | 只读回溯：报告日历/列表/详情、资料库、媒体清单、人员关注摘要 |
| FE-2 | 审批收件箱：任务/承诺/事件的确认、取消、完成、改 deadline |
| FE-3 | 报告操作：定稿（draft→final）、请求重新生成、把某份报告排入 outbox |
| 不做 | 手机端直连（见 §11-Q4）；在前端内触发 LLM 对话；在前端编辑报告正文；任何发送 |

## 2. 数据源盘点

前端需要的数据分布在**两套库 + 若干文件**，`0数据格式` 只覆盖回溯部分：

| 前端功能 | 数据源 | 访问方式 |
|---|---|---|
| 报告日历/列表/详情 | `knowledge.db` · `report` / `v_report_full`（唯一键 `(period_type, period_start, chat_id)`，索引 `idx_report_chat`） | 只读 SQL |
| 资料库、标签 | `knowledge.db` · `doc` / `tag` / `doc_tag` | 只读 SQL |
| 媒体清单 | `knowledge.db` · `media`（只有地址与元数据） | 只读 SQL |
| 会话要点 | `knowledge.db` · `chat_digest`（按 `happened_on`） | 只读 SQL |
| 待确认任务 | `<stateDir>/groups/<chatId>/store.db` · `tasks`（`status='pending_confirm'`） | 只读 SQL |
| 待确认承诺 / 事件 | 同库 · `promises` / `events` | 只读 SQL |
| 证据上下文 | 同库 · `messages`（`evidence_msg_id` 前后若干条） | 只读 SQL |
| 人员关注摘要 | `<stateDir>/digests/<chatId>/<pid>/<date>.md` | 只读文件 |
| 报告生成元数据 | 同每群库 · `report_meta` | 只读 SQL |

`knowledge.db` 路径取插件配置 `sqlitePath`（留空 = `~/WeChat/1数据/knowledge.db`；`'off'` 时 FE-1 回溯不可用，前端给出提示）。

结论：**回溯以 `0数据格式` 为准设计；审批直接读每群库，不为它扩 schema**（理由见 §11-Q1）。

## 3. 架构选型

### 3.1 方案 A：插件内嵌 HTTP 服务

在 `src/` 新增模块，用 `node:http` 监听本机端口，路由里直接调 `confirmTask` 等方法。

- 优点：实现最短，审批即时生效。
- 缺点：
  - 监听端口的进程同时持有 `sender` 与 `outbox`——任何路由层漏洞都离发送出口只差一次函数调用，与 R1「受控单出口」的精神相悖；
  - HTTP 服务代码天然带 `respond`、`reply`、`send(` 类标识符，与 `tests/no-send.test.mjs` 词表冲突，只能靠豁免或改名绕行，二者都等于削弱哨兵；
  - Web 服务崩溃或阻塞事件循环会拖累采集主流程。

### 3.2 方案 B：独立进程 + 动作收件箱（推荐）

```
浏览器 ──(127.0.0.1 + token)──▶ web 进程（web/，独立 node 进程）
                                 ├─ 只读打开 knowledge.db、groups/*/store.db
                                 ├─ 只读 digests/*.md
                                 └─ 唯一写入：<stateDir>/web/actions.jsonl（追加）
                                                 │
插件进程（src/）◀── 心跳轮询 ───────────────────────┘
   ActionInbox：校验 → 调用既有方法 → 结果经 Store 写 <stateDir>/web/action-results.jsonl
   （confirmTask / updateTaskDeadline / ……；发送仍只在 sender.ts）
```

- **web 进程不持有任何发送能力**：不 import `src/` 任何运行时模块，只共享类型；没有 child_process，没有出网。
- **插件侧只多一个消费者**：读一个 JSONL、调已有方法，写回走 `Store`（R3 围栏不变）。
- 代价：审批生效有轮询延迟（建议 5 s，可配置），前端以「已提交 → 已生效/失败」两态展示。

**推荐 B。** 审批不需要毫秒级响应，用秒级延迟换「监听端口的进程与发送出口物理隔离」是划算的。

## 4. web 进程设计

### 4.1 目录与依赖

```
web/
├── server.mjs        # node:http 服务（零 npm 依赖，Node 24）
├── lib/              # 只读查询、Markdown 安全渲染、动作写入
└── public/           # 静态页面：原生 ES module + CSS，无构建步骤
```

- 与主项目一致：**零 npm 依赖**，SQLite 用 `node:sqlite` 的 `DatabaseSync(path, { readOnly: true })`；
- 启动：`node web/server.mjs --state-dir <dir> [--db <knowledge.db>] [--port 8787]`；
- `host` 固定 `127.0.0.1`，**不提供**改监听地址的参数；
- 群范围：启动时读插件配置中的 `groups` 白名单（与 R2 同一份数据），白名单外的群目录即使存在也不打开、不展示。

### 4.2 只读接口

均为 `GET`，返回 JSON；`chatId` 先过 `CHAT_ID_RE` 与白名单双校验。

| 接口 | 说明 | 数据源 |
|---|---|---|
| `/api/chats` | 白名单群列表 + 各群最近报告日期 | 配置 + `report` |
| `/api/reports?chat=&period=&from=&to=` | 报告列表（不含正文） | `v_report_full` |
| `/api/reports/:id` | 报告详情（正文已安全渲染为 HTML 片段） | `report` |
| `/api/calendar?chat=&month=YYYY-MM` | 当月每日是否有 daily/weekly/monthly | `report` |
| `/api/docs?tag=&category=&q=` | 资料列表（`q` 暂用 `instr`，FTS5 落地后替换） | `doc` / `doc_tag` |
| `/api/media?chat=&type=&status=` | 媒体元数据 | `media` |
| `/api/digests?day=` | 当日会话要点 | `chat_digest` |
| `/api/persons?chat=` · `/api/persons/:pid/digests` | 关注人员与其每日摘要 | `identities` + `digests/` |
| `/api/inbox?chat=` | 待确认任务/承诺/事件汇总 | 每群库 `tasks` / `promises` / `events` |
| `/api/evidence?chat=&msg=&around=5` | 证据消息前后上下文 | 每群库 `messages` |
| `/api/actions/:actionId` | 动作处理结果 | `web/action-results.jsonl` |

### 4.3 写接口（只有一个）

`POST /api/actions`：校验后**追加一行**到 `<stateDir>/web/actions.jsonl`，立即返回 `actionId`，不等待执行。

```jsonc
{
  "actionId": "a-<时间戳>-<随机8位>",   // 幂等键，插件侧按此去重
  "ts": 0,                              // 提交时刻（ms）
  "type": "task.confirm",               // 见 §5 白名单
  "chatId": "12345678@chatroom",
  "targetId": 42,                       // task_id / promise_id / event_id / report.id
  "params": { }                         // 仅 task.setDeadline 等需要
}
```

写入前做路径断言（等价 `assertInsideState`），文件不存在时由 web 进程建 `web/` 子目录。这是 web 进程**唯一**的 fs 写入点。

### 4.4 页面

| 页面 | 要点 |
|---|---|
| 报告日历 | 月视图，格子上标 日/周/月 三种角标；顶部切群（含「聚合」）；点格子进详情 |
| 报告详情 | 左侧正文，右侧同群前后日期快速切换；FE-3 加「定稿」「重新生成」「排入发件箱」 |
| 对比视图 | 同群两期报告并排（周报对周报、月报对月报） |
| 审批收件箱 | 按群分组，卡片显示语句、置信度、识别 deadline、证据片段；操作：确认 / 取消 / 改时间；无 deadline 任务高亮「待定时间」 |
| 人员关注 | 选群 → 选人 → 按日期翻看个人摘要 |
| 资料库 | 标签筛选 + 标题搜索；`file_path` 只展示不提供下载 |

## 5. 插件侧：ActionInbox

新增 `src/action-inbox.ts`，由 `index.ts` 在 `webActionsEnabled=true` 时挂心跳。

**动作白名单**（未列出的 `type` 一律拒绝并写失败结果）：

| type | 调用 | 期 |
|---|---|---|
| `task.confirm` / `task.cancel` / `task.complete` | `taskRecognition.confirmTask / cancelTask / completeTask` | FE-2 |
| `task.setDeadline` | `groupStore.updateTaskDeadline(chatId, id, deadline, 1)`（人工指定 → 置信度 1） | FE-2 |
| `event.confirm` | `taskRecognition.confirmEvent` | FE-2 |
| `promise.confirm` / `promise.cancel` / `promise.fulfilled` / `promise.close` | `promiseRecognition.confirmPromise / cancelPromise / confirmFulfilled / closePromise` | FE-2 |
| `report.finalize` | `KnowledgeDao` 新增 `setReportStatus(id, 'final')` | FE-3 |
| `report.regen` | `regenQueue.enqueue`（需先泛化，见 §11-Q3） | FE-3 |
| `report.toOutbox` | `outbox.appendOutbox`（之后仍经 sender 四道闸，dryRun 默认生效） | FE-3 |

处理规约：

- **水位**：已处理到的字节偏移存 `web/actions.offset`（经 `Store.writeText`），重启后续读；
- **幂等**：`actionId` 已有结果则跳过；目标行状态已变化（如已 `cancelled` 再 `confirm`）返回 `stale`，不强改；
- **校验**：`chatId` 必须在 `config.groups` 内；`targetId` 为正整数；`deadline` 为合理范围内的毫秒时间戳；
- **结果**：`{ actionId, ok, code, ts }` 追加到 `web/action-results.jsonl`，**不回写语句原文**；
- **审计**：同时追加 `audit/web-actions.jsonl`，只记元数据（type、chatId、targetId、结果码）。

## 6. 安全设计

### 6.1 红线对照

| 红线 | 本设计如何守住 |
|---|---|
| R1 受控单出口 | web 进程不 import sender/outbox，无 child_process、无出网；`report.toOutbox` 只入队，发送仍经 sender 四道闸 |
| R2 默认全拒 | web 进程与 ActionInbox 均以 `config.groups` 为准；白名单空则 web 进程拒绝启动 |
| R3 路径围栏 | web 进程唯一写入点 `web/actions.jsonl` 带路径断言；插件侧写回全走 `Store` |
| R4 注入隔离 | 消息原文与 LLM 生成的报告正文一律当数据渲染：先整体 HTML 转义，再做有限 Markdown 子集渲染；前端只用 `textContent`，禁 `innerHTML` 拼接 |
| R5 密钥零接触 | 不涉及 `keys.json`，不打开微信原库，只读本项目自己的库 |

### 6.2 本机 Web 服务的特有威胁

本机端口能被浏览器里**任意网页**访问，这一点必须专门防：

| 威胁 | 对策 |
|---|---|
| CSRF（恶意网页 POST 到 `127.0.0.1:8787`） | 启动时生成随机 token，只打印到终端；所有 `/api/*` 校验 `Authorization` 头；`POST` 额外校验 `Origin` 与本服务一致 |
| DNS rebinding | 校验 `Host` 头必须为 `127.0.0.1:<port>` 或 `localhost:<port>` |
| 跨域读取 | 不发任何 CORS 头 |
| XSS | `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'`，页面无内联脚本 |
| 外链跟随 | 报告中链接渲染为 `rel="noopener noreferrer"`，不自动加载外部图片 |

### 6.3 新增哨兵测试（单独提交）

`tests/web-boundary.test.mjs`，只**加强**、不修改既有哨兵：

- `web/` 内不得出现 `child_process`、对 `src/sender`、`src/outbox` 的 import；
- `web/` 内 `writeFile*` / `appendFile*` 只允许出现在动作写入模块；
- 服务端代码不得出现出网调用；`public/` 中 `fetch(` 只允许相对路径；
- `server.mjs` 的 `listen` 地址字面量必须为 `127.0.0.1`。

## 7. 新增配置

| 位置 | 键 | 默认 | 说明 |
|---|---|---|---|
| 插件 | `webActionsEnabled` | `false` | ActionInbox 总闸；关闭时 actions.jsonl 不被消费 |
| 插件 | `webActionsPollSec` | `5` | 轮询周期 |
| web 进程 | `--state-dir` | 必填 | 与插件 `stateDir` 一致 |
| web 进程 | `--db` | 插件默认路径 | knowledge.db |
| web 进程 | `--port` | `8787` | 只改端口，不能改地址 |

## 8. 测试策略

全离线，遵守 AGENTS.md §5：

- 回溯接口用 `0数据格式/make_template.py` 生成的 `sample.db`；
- 每群库用测试内建的合成 `store.db`（`synth-0001` 类 msgId、`12345678@chatroom` 类群 ID）；
- ActionInbox：注入 mock 的 taskRecognition/promiseRecognition，覆盖白名单外 type、重复 actionId、stale、越权 chatId、损坏行；
- Web 安全：缺 token、错 Host、错 Origin、XSS 载荷（报告正文含 `<script>`、`javascript:` 链接）各一例。

## 9. 分期与工作拆分

| 期 | 交付 | 验收 |
|---|---|---|
| FE-1 | `web/` 只读服务 + 日历/详情/资料/人员页 + web-boundary 哨兵 | sample.db 上全页面可用；安全用例全过 |
| FE-2 | ActionInbox + 收件箱页 | 合成库上 确认→生效 闭环；`learned_pattern` 被登记 |
| FE-3 | 定稿、重新生成、排入发件箱 | 定稿状态不被下次镜像覆盖（§11-Q2）；toOutbox 在 dryRun 下只落 outbox |

## 10. 需同步的文档

- `README.md` 配置表：`webActionsEnabled` / `webActionsPollSec`；
- `docs/RUNBOOK.md`：启动 web 进程、token 获取、停用方法；
- `docs/SECURITY-TEST-PLAN.md`：测试矩阵增「本机 Web 服务」一节；
- `docs/TECH-DESIGN.md`：状态目录结构增 `web/`；
- `CHANGELOG.md` `[Unreleased]`。

## 11. 待决问题

- **Q1 审批数据要不要镜像进 `0数据格式`？** 建议**不镜像**：审批数据的事实源和写入方都在每群库，镜像会多一条同步链与口径漂移风险；前端直接只读每群库即可。若日后要做跨设备查看再议。
- **Q2 定稿状态存哪？** 现 `upsertReport` 在冲突时会用 `excluded.status` 覆盖，报告重新镜像后 `final` 会被打回 `draft`；且 JSONL 才是事实源，重导入也会丢。需二选一：(a) `upsertReport` 冲突时保留已有 `final`；(b) 定稿记在 stateDir 侧并由镜像带入。建议 (a)，改动小。
- **Q3 重新生成怎么接？** 现 `regen-queue` 只支持 `kind='daily'`、`reason='wrong_account'`，需泛化 `kind` 与 `reason`（增 `'manual'`）后才能承接前端请求。
- **Q4 手机端怎么看？** 本设计只绑 127.0.0.1，手机无法直连。短期继续用 filehelper 推送作为通知、工作台在电脑上用；若要手机访问，应另立设计（反向代理 + 认证 + TLS），不在本期放开监听地址。
- **Q5 web 进程如何获得 `groups` 白名单？** 插件配置在 DSH profile 的 `cordis.patch.yml` 中。可选：(a) web 进程解析同一份配置；(b) 插件启动时把白名单写入 `<stateDir>/web/allowed-chats.json` 供 web 进程读。建议 (b)，web 进程不必理解 DSH 配置格式。
