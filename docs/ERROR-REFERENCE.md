# 报错定位手册（ERROR-REFERENCE）

> 角色：安全经理。本文档的唯一目标：**看到一段报错，60 秒内定位原因、知道谁负责、怎么处置**。
> 配套：[SECURITY-TEST-PLAN.md](./SECURITY-TEST-PLAN.md)（红线）· [RUNBOOK.md](./RUNBOOK.md)（日常运维）
>
> 版本：v1.0（2026-10-14）· 维护人：安全经理。源码报错文本变更时本文必须同步。

---

## 0. 使用方法（三步定位）

1. **拿报错里的特征串**（通常已带模块前缀，如 `wechat-db source:`、`nickname:`、`path escape blocked`）；
2. 到 **§2 反查表** 找到对应错误码（ERR-xxx），或直接到 §3 对应模块小节；
3. 按该条目的「定位 → 处置」执行。拿不准就按 §1 严重度先分级上报。

**诊断素材清单**（定位前先备齐，缺哪样补哪样）：

| 素材 | 位置 | 说明 |
|---|---|---|
| 宿主日志 | DSH profile 控制台 / `DSH_HOME` 日志 | warn/error 全量，报错首发现场 |
| 读取审计 | `<stateDir>/audit.log` | 每次读取一行 `{ts, chatId, count, ok}`，只有元数据 |
| 增量游标 | `<stateDir>/cursor.json` | 损坏/重投问题必看 |
| 状态目录树 | `<stateDir>/` 全目录 `ls -laR` | 路径/锁/落盘异常必看 |
| 子进程 stderr | 报错消息内已截断 200 字符；完整需重跑 CLI | 见 §4 手工重放 |

---

## 1. 严重度分级与响应

| 级别 | 定义 | 响应 |
|---|---|---|
| **P0** | 触碰安全红线（R1~R5）：出现发送类调用、白名单外读取、state 外写入、密钥出现在日志/文件 | **立即停插件**（卸载 patch / 停 DSH），通知安全经理，保留现场（state 目录快照）后再排查 |
| **P1** | 主功能不可用：源启动失败、读取持续失败、单实例锁死 | 当日处理；通常是配置或环境问题，按 §3 逐步走 |
| **P2** | 降级运行：昵称回退、LLM 提炼降级、引用解析降级、人格回退 | 功能仍可用，观察 2~3 个轮询周期再决定 |
| **P3** | 噪声：一次性 warn 后自愈（如单次 parse 失败后下轮恢复） | 登记，不处置 |

> 判级口诀：**碰红线 P0；读不到消息 P1；能读但难看 P2；闪一次 P3。**

---

## 2. 错误码反查表（按报错特征串 → 错误码）

> 排序按"最常见/最危险优先"。定位列 `src/x.ts:行` 为当前版本锚点，行号漂移以特征串为准。

| 报错特征串（grep 用） | 错误码 | 级别 | 模块小节 |
|---|---|---|---|
| `path escape blocked` | **ERR-GUARD-001** | P0 | §3.1 |
| `not in the whitelist` / `read refused` | **ERR-SRC-001** | P2 | §3.2 |
| `whitelist (groups) is empty — fail-closed` | **ERR-SRC-002** | P1 | §3.2 |
| `read failed for` / `catch-up read failed` | **ERR-SRC-003** | P1 | §3.2 |
| `read output missing messages array` / `parse failed for` | **ERR-SRC-004** | P1 | §3.2 |
| `another instance holds` / `wechat-db.lock` | **ERR-SRC-005** | P1 | §3.2 |
| `catch-up` + `宁少读` / `shards` / `before-id` | **ERR-SRC-006** | P3 | §3.2 |
| `catch-up hit the per-round limit` | **ERR-SRC-007** | P2 | §3.2 |
| `keys.json` | **ERR-NICK-001** | P1 | §3.3 |
| `no valid enc_key` | **ERR-NICK-002** | P1 | §3.3 |
| `invalid chatId form (expected "<digits>@chatroom")` | **ERR-NICK-003** | P2 | §3.3 |
| `nickname resolve failed` / `degrade to raw ids` | **ERR-NICK-004** | P2 | §3.3 |
| `nickname miss` | **ERR-NICK-005** | P3 | §3.3 |
| `sqlcipher exited` | **ERR-NICK-006** | P1 | §3.3 |
| `corrupt` + `cursor` / `unexpected shape — starting empty` | **ERR-CUR-001** | P2 | §3.4 |
| `persist failed — will retry` | **ERR-CUR-002** | P2 | §3.4 |
| `quote parse failed` / `degraded to plain text` | **ERR-SRC-008** | P3 | §3.5 |
| `illegal chatId rejected` / `illegal kind` / `illegal date` | **ERR-STORE-001** | P2 | §3.6 |
| `ensureDir failed for` | **ERR-STORE-002** | P1/P0 | §3.6 |
| `invalid capacity` | **ERR-BUF-001** | P2 | §3.7 |
| `expected "HH:MM"` / `invalid digestTime` | **ERR-SCHED-001** | P2 | §3.8 |
| `corrupt state file, starting fresh` | **ERR-SCHED-002** | P2 | §3.8 |
| `missed occurrence` / `beyond catchup window` | **ERR-SCHED-003** | P3 | §3.8 |
| `pyramid` / `断言未通过` / `降级输出` / `invalid LLM output, retrying` | **ERR-LLM-001** | P2 | §3.9 |
| `llm failed` | **ERR-LLM-002** | P2 | §3.9 |
| `宿主无补全 API` / `no completion` | **ERR-LLM-003** | P1 | §3.9 |
| `persona "..." not loaded, fallback to default` | **ERR-PER-001** | P3 | §3.10 |
| `summary degradation` / `摘要降级` | **ERR-FIDX-001** | P3 | §3.11 |
| 密钥形态进日志（warn 回显含 ≥32 连续 hex） | **ERR-SRC-009** | P0/P1 | §3.2 |

---

## 3. 分模块详解（定位 → 处置）

### §3.1 ERR-GUARD-001　路径围栏拦截（P0）

- **报错**：`path escape blocked: <target> resolves outside <base>`
- **含义**：某写入目标解析后不在 stateDir 内，被 `assertInsideState` 拦截（src/guard.ts:44）。
- **定位**：
  1. 这是**防御在正常工作**——先弄清"谁想写、写到哪"：看堆栈里调用方（store / report / person-digest / group-store）；
  2. 检查传入的 `chatId` / `pid` / `date` 形态（report.ts、person-digest.ts 入口各自有 `CHAT_ID_RE` 校验，能到这里说明形态合法但组合异常）；
  3. 确认 `stateDir` 配置是否被人改成了相对路径/软链。
- **处置**：拦截成功 = 红线 R3 生效，无泄漏，属**未遂事件**；但必须查明输入来源（配置被改？上游字段异常？），登记后通报安全经理。若怀疑 symlink 逃逸形态（resolve 不追踪 symlink 的已知限制），立即按 P0 上报。
- **下属 AI 报告义务**：任何一次出现都要在 sec-tests 回归里加一条复现用例。

### §3.2 ERR-SRC-001~007　微信库读取源（wechat-db）

**ERR-SRC-001　白名单外群被拒**（P2）
- `chatId ... is not in the whitelist — read refused`（src/source/wechat-db.ts:410）
- 定位：对照 cordis.patch.yml 的 `groups` 配置与报错里的 chatId。
- 处置：若确实想读该群 → 用户手工把 chatId 加进白名单；若没想读 → 这是闸门正常工作，同时**警惕**为什么会有这个 chatId 出现在读取请求里（谁调的 readOnce），排查调用链。

**ERR-SRC-002　空白名单拒绝启动**（P1）
- `whitelist (groups) is empty — fail-closed`（wechat-db.ts:371）
- 定位：patch 配置里 `groups` 缺失/空数组/格式错（YAML 缩进错误最常见）。
- 处置：这是设计行为（默认全拒）。补全配置；若本意就是不读，把 `source` 设回 `none`。

**ERR-SRC-003　读取子进程失败**（P1）
- `wechat_db read failed for <chatId> (code=<n>)`（wechat-db.ts:521/450）
- 定位（按序）：
  1. 看 audit.log 该群最近几行 `ok` 是否持续 false；
  2. code 含义：`124`=超时（CLI 卡死/库太大）、`1`=CLI 自身报错（密钥/路径）、`-1`=进程都没起来（pythonPath 错）；
  3. 手工重放（§4）拿完整 stderr；
  4. 检查 `sourcePython`/`sourceToolDir`/`sourceDbRoot` 三项配置与实际路径是否一致（微信重登录后 wxid_hash 变化会使 dbRoot 失效——**最常见原因**）。
- 处置：配置错 → 改配置；微信重登录 → 更新 dbRoot；持续失败会自动指数退避（最长 5 分钟/次），修好后自动恢复。

**ERR-SRC-004　CLI 输出解析失败**（P1）
- `read output missing messages array` / `parse failed`（wechat-db.ts:586/447）
- 含义：CLI 退出码 0 但 stdout 不是预期 JSON——通常上游 CLI 版本变了。
- 定位：手工重放保存完整 stdout，`head -c 500` 看输出形态（报错文本混进 stdout？提示语？）。
- 处置：确认 macos-wechat-export 是否被更新/更换分支；契约变更需 spike 重新对齐（tests/wechat-db-source.test.mjs 的 mock 同步改）。

**ERR-SRC-005　单实例锁冲突**（P1）
- `another instance holds <stateDir>/wechat-db.lock — refusing to start`（wechat-db.ts:699）
- 定位：`lsof <stateDir>/wechat-db.lock`——有进程占用 = 真双开（另一个 DSH profile 也装了本插件？）；无占用 = 上次崩溃残留锁。
- 处置：双开 → 停掉一个（同库双读者虽只读无破坏，但游标互相踩会导致重复投递）；确认无进程后 `rm` 锁文件重启。

**ERR-SRC-006　追赶翻页保守停止**（P3）
- `宁少读` / `shards` / `without valid local_id`（wechat-db.ts:557-573）
- 含义：掉线积压追赶时遇到跨分片/缺锚点，主动停（设计取舍：宁少读不错读）。
- 处置：属正常防护。若日志同时显示积压很大，参照 ERR-SRC-007 人工回灌。

**ERR-SRC-007　追赶触顶**（P2）
- `catch-up hit the per-round limit (2000)`（wechat-db.ts:512）
- 处置：积压超过单轮上限。确认消息不重要 → 忽略；需要 → 临时调大 `catchUpLimit` 或用 `backfillOnStart` 定向回灌，注意回灌会重建游标窗口。

### §3.3 ERR-NICK-001~006　昵称解析（nickname）

**ERR-NICK-001　keys.json 读取失败**（P1）
- `nickname: cannot read keys.json at <path> (<code>)`（src/source/nickname.ts:76）
- 定位：code=`ENOENT` → bootstrap_keys.py 没跑/产物被清；`EACCES` → 权限不是 0600 属主。
- 处置：到 macos-wechat-export 目录重跑 `bootstrap_keys.py`。**注意：报错信息只含路径与 errno 码，不含密钥内容——这是红线 R5 的设计，若日志里出现密钥本体立即按 P0 上报。**

**ERR-NICK-002　enc_key 缺失**（P1）：keys.json 存在但没有 contact 库的 key → 微信重登录重新加密了库，重跑 bootstrap。

**ERR-NICK-003　chatId 形态拒绝**（P2）：`expected "<digits>@chatroom"`（nickname.ts:181）——白名单配置里混入了个人聊天 ID 或手误。检查 patch 配置。

**ERR-NICK-004　整群解析失败降级**（P2）：`degrade to raw ids`——显示名回退为 wxid，产物难读但功能无损。持续出现按 ERR-NICK-006 排。

**ERR-NICK-005　单人昵称 miss**（P3）：退群/新成员未同步，自然回退，无需处理。

**ERR-NICK-006　sqlcipher 退出**（P1）：`sqlcipher exited <code>`（nickname.ts:238）——`brew install sqlcipher` 是否还在、版本是否被升级破坏。手工重放（§4）确认。

### §3.4 ERR-CUR-001~002　增量游标（cursor）

**ERR-CUR-001　游标损坏降级**（P2）：`cursor.json has unexpected shape — starting empty`（src/source/cursor.ts:84）
- 含义：JSON 损坏/被改/手编出错 → 空游标重来。**副作用：下一轮会把"当前在库里的最近消息"当新消息重投一次**（去重窗口丢失），下游会多跑一轮提炼，不会重复落库（msg_id 幂等兜底）。
- 处置：接受一次性重投；若频繁损坏，查 state 目录是否被并发写（双开？见 ERR-SRC-005）。

**ERR-CUR-002　游标持久化失败**（P2）：`persist failed — will retry on next poll`——磁盘满/权限。`df` 与 `ls -ld stateDir` 检查。

### §3.5 ERR-SRC-008　引用消息解析降级（P3）

- `quote parse failed ... degraded to plain text`（wechat-db.ts:633）
- 含义：refermsg XML 缺 svrid/结构超出预期 → 原文当普通文本进管线，**不丢消息**。
- 处置：偶发忽略。集中出现（某微信版本更新后）→ 把样本（勿含隐私全文）交给 sec-tests DP-sec-1 补对抗用例。

### §3.6 ERR-STORE-001~002　落盘写入

**ERR-STORE-001　非法字段拒绝**（P2）：`illegal chatId/kind/date rejected`（report.ts:389-390、person-digest.ts:119-123）——上游传参异常，校验在工作。定位：看被拒值来自哪个调用方（scheduler 配置？手工触发？）。

**ERR-STORE-002　ensureDir 失败**（P1，若伴随 ERR-GUARD-001 则 P0）：state 目录磁盘满/权限/被删。`ls -ld <stateDir>` 逐级检查。

### §3.7 ERR-BUF-001　缓冲容量非法（P2）

- `invalid capacity: <n>`（src/buffer.ts:27）——patch 配置 `bufferSize` 给了 0/负数/非整数。改成 ≥1。

### §3.8 ERR-SCHED-001~003　调度器/提醒

**ERR-SCHED-001　时间格式非法**（P2）：`expected "HH:MM"` / `invalid digestTime`——配置手误，改配置。
**ERR-SCHED-002　调度状态损坏**（P2）：`corrupt state file, starting fresh`——调度状态重来，当日定时任务可能重跑一次，幂等产品无碍。
**ERR-SCHED-003　错过窗口放弃**（P3）：停机太久错过定时点，按设计放弃不补——需要补跑用 RUNBOOK 的人工触发。

### §3.9 ERR-LLM-001~003　LLM 提炼/报告

**ERR-LLM-001　输出校验失败降级**（P2）：`金字塔断言未通过/降级输出`、`invalid LLM output, retrying once`——模型输出不合 schema，重试一次后降级占位，**不静默缺天**（report.ts:424-440、person-digest.ts:166-169）。偶发属正常；持续出现记录模型名与频次报给安全经理。

**ERR-LLM-002　LLM 调用失败**（P2）：宿主 llm 服务抖动。下游全部有降级占位，观察即可。

**ERR-LLM-003　宿主无补全 API**（P1）：`宿主无补全 API 时抛明确错误`（distiller.ts:55）——DSH 版本/配置不含 llm 服务。确认宿主版本 ≥ 0.2.0-rc.2 且 patch 里 `inject` 声明未被改动（**这个报错若在正常环境突现，怀疑 patch/index 被改，按红线文件核查**）。

### §3.10 ERR-PER-001　人格回退（P3）

- `persona "<name>" not loaded, fallback to default`（src/persona.ts:88）——`personas/<name>.md` 不存在或为空。改名或补文件。

### §3.11 ERR-FIDX-001　文件摘要降级（P3）

- `摘要降级——LLM 输出两次均非法`（src/file-index.ts:282）——条目保留、摘要占位，无数据丢失。

---

## 4. 手工重放子进程（拿完整 stderr/stdout，诊断 ERR-SRC-003/004、ERR-NICK-006 必用）

```bash
cd <sourceToolDir>   # macos-wechat-export 目录；keys.json 相对路径依赖 cwd
<sourcePython> wechat_db.py --db-root <sourceDbRoot> read \
  --chat-id '<目标群chatId>' --limit 5 ; echo "exit=$?"
```

- `exit=124` → 超时；`exit=1` 且 stderr 提 key/db 路径 → 环境问题；stdout 非纯 JSON → 契约漂移（ERR-SRC-004）。
- **纪律**：重放输出含真实消息内容，只看不存、不入库、不贴进 issue；日志/截图先脱敏。

## 5. 红线核查速查（任何 P0 嫌疑时逐项过）

1. `grep -rniE "send|deliver|osascript" src/ lib/` → 命中即 R1 击穿；
2. audit.log 里出现白名单外 chatId → R2 击穿；
3. state 目录之外出现本项目写入的新文件 → R3 击穿（`find <stateDir> -newer <标记文件>`）；
4. 任何日志/文件出现密钥形态内容（keys.json 的 value）→ R5 击穿；
5. 上述任一成立：**停插件 → 快照 state → 通报安全经理**，顺序不可乱。

## 6. 错误码维护约定（下属 AI 必须遵守）

1. 新增/修改 src 报错文本时，同步更新本表（特征串保持 grep 可命中）；
2. 错误码格式 `ERR-<模块>-<序号>`，模块缩写沿用本表（GUARD/SRC/NICK/CUR/STORE/BUF/SCHED/LLM/PER/FIDX），永不复用已删码；
3. 报错文本里**只放元数据**（路径、errno、code、chatId），绝不放消息原文与密钥；
4. sec-tests 的用例断言失败信息必须引用本表错误码。
