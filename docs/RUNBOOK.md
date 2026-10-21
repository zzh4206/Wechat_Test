# RUNBOOK：dsh-group-lurker 安装 / 授权 / 白名单 / 审计 / 卸载

> **运行环境（2026-10-14 起 canonical）**：DSH **desktop** 桌面版 + `~/.dsh/profiles/desktop`。web profile 已弃用，仅存档。
> **默认模型**：desktop 宿主 `agent-default-model` = glm-5.3（zai 源），可在 `cordis.patch.yml` 改。
> ⚠️ 已知适配项：desktop 宿主为 Electron 内嵌 Node，`node:sqlite` 可用性待验证（见 PROGRESS 2026-10-14 行）；如加载失败按控制台报错处置。

> 适用：macOS（Apple Silicon 已验证）+ DSH（`~/.dsh`）+ 插件 `@zzh4206/dsh-group-lurker`。
> 本手册只覆盖**小号**路径。**大号只承担一个动作：把小号拉进需要旁听的群**（如 Test 群模式）；除此之外大号不出现：不取钥、不配置、不读取，本手册也不提供任何大号库的配置方法。

## 0. 账号边界（先读，不可越）

- **读取面 = 小号库 + 小号被拉入的群白名单**。`sourceDbRoot` 必须指向**小号**的 `db_storage`；`groups` 白名单只能是**小号已在其中**的群 chatId。
- 小号入群对群友可见（公开旁听，无隐匿预期）；小号不保证常在线，掉线积压由补读机制处理（T1.5）。
- 不读白名单以外任何微信数据；白名单为空即拒绝读取（fail-closed）。

## 1. 前置安装（一次性）

```sh
xcode-select -p          # 缺则 xcode-select --install
brew install python@3.14 sqlcipher
git clone https://github.com/DaneelOlivaw1/macos-wechat-export.git
cd macos-wechat-export
sh build.sh && sh test.sh && python3.14 test_db.py
```

小号取钥（工具的 `bootstrap_keys.py` 流程，详见该仓库 QUICKSTART.md 第 2 节）：**先在微信里登录小号**，菜单退出原版 → 跑 bootstrap → 恢复原版。产物：

- `.wechat-local/keys.json` —— **权限必须 0600，目录 0700（umask 077）**。
- **密钥纪律：keys.json 只留在工具目录 `.wechat-local/` 内；不复制、不移动、不 `cat`/打印、不提交 git、不写进任何配置文件正文。** 配置里只出现它的**路径**（经 `sourceToolDir` 间接指向），不出现内容。

## 2. 查小号的 db_storage 路径与群 chatId

```sh
cd macos-wechat-export
python3.14 disk_inventory.py        # 多账号列表里选【小号】的 db_storage 绝对路径
python3.14 wechat_db.py verify      # 全部 verified 才继续
python3.14 wechat_db.py resolve '群名关键词'   # 用小号库查目标群 → 得到 xxx@chatroom
```

把查到的 `xxx@chatroom` 逐个填进白名单。**resolve 只对小号库执行**——查不到的群即视为小号不在该群，不该进白名单。

## 3. 安装插件到 DSH profile

```sh
# 1) 构建插件（产物 lib/，发布/安装只认 lib）
cd /path/to/2水群
npm run build

# 2) 装进 profile（profile 目录以 ~/.dsh/profiles/desktop 为例，含自己的 package.json）
cd ~/.dsh/profiles/desktop
pnpm add file:/path/to/2水群
```

## 4. 配置（profile 的 cordis.patch.yml）

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 加一段**配置覆盖**（该 profile 里注册由插件包自带的 `insert` 完成，这里只放 `config`）。**以下全部路径与群 ID 均为占位，必须替换为本机实际值。**

> ⚠️ **真实值只写在 profile 的 `cordis.patch.yml`，或仓库内被忽略的 `cordis.local.yml`。**
> **仓库自带的 `cordis.patch.yml` 只有 `insert` 骨架，不放配置**——配置写进仓库会把真实群 ID 与 wxid
> 一起推到公开仓库（本仓库历史上正是这样泄露过一次，历史已被人工清理）。提交前跑 `./scripts/check-sensitive.sh` 自检。

```yaml
- id: group-lurker
  name: '@zzh4206/dsh-group-lurker'
  config:
    groups:                          # 白名单：小号被拉入的群
      - 'xxxxxxxxxx@chatroom'
    source: wechat-db
    sourceToolDir: /替换/为/macos-wechat-export 绝对路径
    sourceDbRoot: /替换/为/【小号】的 db_storage 绝对路径
    sourcePython: /opt/homebrew/bin/python3.14
    # 提炼节奏（正式值；观察期临时调大的参数记得手动调回）
    distillEveryMessages: 25
    distillIntervalMin: 15
    # M1 调度 / 通知（T1.3/T1.4）
    schedulerEnabled: false          # M3 接报告生成后再开
    dailyReportTime: '20:30'
    weeklyReportTime: '20:40'
    monthlyReportTime: '08:00'
    staggerMinutes: 5                # 按白名单顺序每群错峰 5 分钟
    notifyDryRun: true               # true = 只记日志不弹系统通知
```

红线自查：`groups` 为空 → 插件拒读（fail-closed）；任何配置不得包含 keys.json 内容；`sourceDbRoot` 指向小号。

## 5. macOS 完全磁盘访问授权

微信 4.x 数据在 `~/Library/Containers/com.tencent.xinWeChat/...`，宿主进程必须被授予**完全磁盘访问**才能只读打开：

1. 系统设置 → 隐私与安全性 → 完全磁盘访问；
2. 把**运行 DSH 的宿主程序**（终端 / DSH app 实际进程）加入并打开开关；
3. **完全退出并重启宿主**（授权只对新启动的进程生效）。

只读旁听**不需要**任何辅助功能/屏幕录制授权（读取层只读数据库文件）；发送时才需要「辅助功能」（键盘模拟）。

## 6. 启动与审计日志查看

启动 DSH（正常流程），日志出现 `group-lurker ready, stateDir=...` 即装好。状态目录默认 `~/.dsh/dsh-group-lurker/`：

```sh
ls ~/.dsh/dsh-group-lurker
# groups/<chatId>/insights.jsonl   每群提炼产出（引用 ≤50 字，无消息全文）
# groups/<chatId>/cursor.json     读取游标（只记消息 id，不记内容）
# reports/YYYY-MM-DD.md           每日日报
# scheduler/state.json            调度器已触发时点（只记 kind/时间戳，不记内容）
# notify/audit.jsonl              通知审计（只记时间 + kind 元数据，不记标题正文）
```

审计纪律：所有日志只记**元数据**（时间、群号、kind、计数），不记消息正文、不记密钥、不记通知正文。

## 7. D2 全模块使用指南（M3–M6）

### 7.1 报告引擎（reportEnabled 开闸顺序）

自底向上逐层开，每层观察一天再开下一层：

1. 基础管线就绪（§6 验收清单过）后开 `reportEnabled: true`——报告生成可手动触发、调度到点会产出；
2. 再开 `schedulerEnabled: true`——日 20:30 / 周日 20:40 / 月 1 日 08:00 按群错峰自动生成；
3. 最后按需开 `personDigestEnabled` / `taskRecognitionEnabled` / `reminderEnabled` / `promiseRecognitionEnabled` / `fileIndexEnabled` / `followupDraftEnabled`（全部默认关，零 LLM 调用零落库）。

报告正文只落 `reports/` 与 outbox 存档；通知中心只弹短句；零发送。

### 7.2 任务/事件识别与确认

- 识别：白名单群消息落库后自动扫描（`taskRecognitionEnabled: true` + 建议配 `selfWxid` 精确 @匹配）；候选进 `pending_confirm`，**不提醒不发送**，详情落 outbox。
- 确认：经插件 API（DSH 控制台 `ctx.get('groupLurker')`）：

```js
const lurker = ctx.get('groupLurker')
lurker.groupStore.getTasks('xxx@chatroom', { status: 'pending_confirm' })     // 看候选
await lurker.taskRecognition.confirmTask('xxx@chatroom', taskId)             // 确认入清单（→ active）
await lurker.taskRecognition.cancelTask('xxx@chatroom', taskId)              // 误报关闭
```

- 确认过的「派发人+句式」自动学习（`patternLearning` 默认开），同类消息免确认直接 active。
- 阈值（M6 配置化）：`minTaskConfidence`（默认 0=全落库待确认）、`fulfilConfidence`（承诺兑现软关联阈值，默认 0.5）、`activitySpikeMultiplier`（活跃度突变倍数，默认 3）。误报多→上调。

### 7.3 提醒时点表与 reminder_log

`reminderEnabled: true` 后按时点表驱动（全部走通知中心 + outbox，零发送）：

| 时点 | 行为 |
|---|---|
| 识别时 | 任务/承诺候选入 outbox 待确认卡片 |
| 截止前 1 天 | 提醒 |
| 截止前 1 小时 | 默认关（`deadline1hRemind: true` 开） |
| 逾期 | 升级提醒 |
| 每日 07:50 | 待办速览合并推送 |

同一条提醒同一时点只发一次（`reminder_log` 表去重）；重启不重发。

### 7.4 承诺状态机与催办草稿

状态机：`pending_confirm → waiting → fulfilled / broken / cancelled`（跳票不删，进日报"人欠我的"直到手动关闭）。确认/关闭：

```js
await lurker.promiseRecognition.confirmPromise('xxx@chatroom', promiseId)    // 确认入追踪（→ waiting）
await lurker.promiseRecognition.cancelPromise('xxx@chatroom', promiseId)     // 手动关闭
```

对方发出文件/答复且发送者=承诺人、confidence ≥ `fulfilConfidence` → 自动置 fulfilled（只读关联，无发送）。逾期时 `followupDraftEnabled: true` 生成得体催办**草稿**落 outbox 供复制——草稿绝不发送。

### 7.5 文件索引与版本链

`fileIndexEnabled: true` 后文件类消息自动入库：类型归类、同名同哈希合并（多次出现保留 appearances）、上下文一句话摘要、星标（被多人引用或上下文含 deadline 语义）、版本链折叠（"初版→修改稿→最终版"）。M6 起 wx_path 定位接线：工具 `files` 子命令按会话查路径，能定位记实际路径，定位不了（离线期未下载）保持"待下载"占位；每次定位记 `audit/file-locate.jsonl` 元数据。

**files 子命令清单摄取（兜底路径，默认每 30 分钟一轮）**：微信 4.x 的文件消息 `local_type` 低 32 位与链接同为 49 且 XML 不导出，消息流侧只能归 `kind='link'`（占位 `[链接]`，无文件名）→ 消息流扫描拿不到 `kind='file'` 行。`FileIndexService.ingestFromListing` 周期调 `files` 子命令把 `name/path/available` 补进 files 表（失败/超时只 warn，下轮重试）。配置：`fileIndexListIntervalMin`（0=关）、`fileIndexListTimeoutMs`、`fileIndexListLimit`。已知坑：`files` 的 msg_id 与消息 `server_id` 命名空间不总一致——ts/sender 取不到时回退 now/空；两路径按「文件名+大小+发送者」同键合并 appearances，幂等。详见 `docs/ERROR-REFERENCE.md` §3.12（ERR-FIDX-002）。

### 7.6 outbox 查看（tailOutbox）

```sh
tail -n 20 ~/.dsh/dsh-group-lurker/outbox.jsonl   # 最近 20 条待发替身日志
```

或经 API `lurker.outbox.tailOutbox(20)`。outbox 是"本应发往文件传输助手"的全部内容的日志替身——**本插件不发送任何消息**。

### 7.7 保留期与清理

`retentionDays: 90`（默认）：每日一次删除 90 天前的 messages 行；事件/任务/承诺/文件索引等长期保留数据（只含摘要与 ≤50 字引用）不动；被这些长期表引用的旧消息行也不删（引用完整性优先）。清理动作记 `retention/audit.jsonl`（只有时间/群/删除条数，无内容）。

### 7.8 person-digest 与 watchList 配置示例

```yaml
config:
  personDigestEnabled: true
  watchList:                        # 空数组 = 无人被追踪（fail-closed 零活动）
    - wxid: wxid_xxxxxxxx           # 目标人物 wxid（小号库可见者）
      remark: 张三
      scope: global                 # 全部白名单群；或 { groups: ['xxx@chatroom'] } 指定群
  activitySpikeMultiplier: 3        # 活跃度突变倍数（M6 配置化，默认 3）
```

产出：`digests/<chatId>/<pid>/<date>.md` 一页速览（"他最近在忙什么"）。

### 7.9 fused/split A/B 脚手架（决策待运行期定夺）

`distillMode: 'fused' | 'split'`（默认 fused）目前**只是对比脚手架的记录标签**，不切换线上提炼路径。对比方法：

```js
// DSH 控制台：对同一消息窗口 fixture 跑两侧并落盘
const { runAbComparison } = await import('@zzh4206/dsh-group-lurker/lib/ab-harness.js')
await runAbComparison(
  [{ sender: 'P01', text: '周五前把报告发我', ts: Date.now() } /* 代号化窗口 */],
  { llm: ctx.llm 适配 LlmClient, store: lurker.store, distillMode: lurker 配置的 distillMode },
)
```

产物：`<stateDir>/ab/<日期>/`（input-window.json / fused-output.md / split-facts.md / split-output.md / meta.json），人工比对提炼质量。**fused vs split 的最终选择待运行期真实数据对比后定夺**，届时才实装切换逻辑。

### 7.10 快速迭代测试（scheduleTestMode，测完必关）

周报等周日 20:40、月报等每月 1 日 08:00 才触发，平时没法快速验证完整生成链路。临时打开测试模式：

```yaml
# cordis.patch.yml（profile 的 dsh-group-lurker 配置）
scheduleTestMode: true        # 默认 false，不配 = 行为与原版完全一致
testKindIntervalMin: 10       # 启动后每 10 分钟依次强制触发一次 weekly → monthly（交替循环），0 = 不触发
```

行为：调度器照常走日历 tick（不改既有触发逻辑），只是额外每 `testKindIntervalMin` 分钟强制触发一次 weekly、monthly 的 onTick——kind 照常传 `'weekly'` / `'monthly'`，报告引擎按对应周期切窗，真实走完整 LLM 生成链路。与正常日历触发的重复由 report/reminder 幂等机制自然去重（report_meta 同键覆盖），不会出双份报告。

⚠️ **测试完务必把 `scheduleTestMode` 改回 false（或删掉这两行）并重启**——开着它每 N 分钟就跑一轮周报+月报 LLM 调用，烧 token 且重复写 outbox。

### 7.11 成本可观测（T9：模型 / token / 费用透明）

**报告尾统计行**（每次生成都带，含 degraded/empty 路径——empty 零调用时省略成本段）：

```
> 统计：批 2（失败 0）· 最大批耗时 31.4 s · 缓存命中 0 · LLM 调用 3 次 / 45.2 s · 模型 glm-5.3 · 输入 ~12.3k / 输出 ~4.5k tok · ≈¥0.0223
```

- token 带 `~` = 估算值（宿主不回传 usage，按官方口径 **1.6 汉字/token** 即 `chars ÷ 1.6` 估算）；不带 `~` = 宿主回传了真实 usage。费用恒带 `≈`（价格表可能滞后），保留 4 位小数。
- 同口径数据逐调用落 `groups/<chatId>/llm-calls.jsonl`（每次 `llm.complete` 一行）；`report_meta.batch_stats` 也含 `model/inTokens/outTokens/costCny/tokensEst`（随报告元数据入库，可回查历史）。

**`llm-calls.jsonl` 字段表**：

| 字段 | 说明 |
|---|---|
| `ev` | 恒为 `llm_call` |
| `chat` / `kind` / `phase` | 群 / 业务种类（daily/weekly/monthly/distill）/ 阶段（map=分批、merge=合并、distill=提炼） |
| `batch` / `msgs` | 批号（0 = 合并调用）/ 本次调用覆盖消息条数 |
| `promptChars` / `durMs` / `ok` / `errKind` / `ts` | prompt 字符数（不记内容）/ 耗时 / 成败 / 失败分类（timeout/other）/ 时间戳 |
| `model` | 模型名（来自 `LlmClient.modelId()`，即 `llmModel` 配置，空 = `glm-5.3`；缺省 `unknown`） |
| `inTokens` / `outTokens` | 输入 / 输出 tokens（真实 usage 或 chars÷1.6 估算） |
| `costCny` | 费用（元）= inTokens/1M × input 价 + outTokens/1M × output 价；**未知模型 = 0**（日志 warn 一次"未配置价格"） |
| `tokensEst` | `true` = 估算值；`false` = 宿主回传真实 usage |

**价格调整：改配置即可，无需改代码 / 重新构建**（`cordis.patch.yml`）：

```yaml
llmPricing:
  glm-5.3: { input: 8, output: 28 }        # 元/百万 tokens，智谱官方定价页 2026-10 抓取
  glm-5.3-flash: { input: 0.8, output: 2.8 }
```

默认值即上表；**以供应商页面为准**：<https://docs.bigmodel.cn/cn/guide/start/pricing>。换模型（改 `llmModel`）记得同步补价格表条目，否则费用记 0。

**费用汇总（推荐：内置命令）**：

```sh
# 本月每群×每日费用表 + 合计（默认 stateDir 与当前月）
node scripts/llm-cost.mjs
# 指定月 / 单日 / 单群 / 其他 stateDir
node scripts/llm-cost.mjs --month 2026-10 --chat 12345678@chatroom   # 群 ID 用占位符
node scripts/llm-cost.mjs --day 2026-10-16
node scripts/llm-cost.mjs --state /path/to/stateDir
```

（口径：token 为估算+宿主 usage 混合；费用按未命中缓存价计=保守上界，实际命中 prompt cache 时更低；输出末行自动披露未知模型行数与损坏行数。）

**备选：手写 jq**（已验证的两条示例，适合管道组合）：

```sh
# ① 各自然月费用合计（全部群）
jq -s 'group_by(.ts/1000|floor|strftime("%Y-%m")) | map({month: (.[0].ts/1000|floor|strftime("%Y-%m")), cny: (([.[].costCny]|add)*1000|round/1000)})' \
  ~/.dsh/dsh-group-lurker/groups/*/llm-calls.jsonl

# ② 单月费用合计（把 "2026-10" 换成目标月）
jq -s '[.[] | select((.ts/1000|floor|strftime("%Y-%m"))=="2026-10") | .costCny] | add' \
  ~/.dsh/dsh-group-lurker/groups/*/llm-calls.jsonl
```

（`ts` 为毫秒时间戳；`costCny` 逐行累加即总费用，与报告尾 ≈¥ 同口径。）

## 8. 排障

**第一诊断工具：读取层探针 `spikes/db-probe.mjs`**（插件仓库内，只读）——任何"读不到消息/昵称解析失败/库打不开"问题先跑它再查插件：

```sh
cd /path/to/2水群
node spikes/db-probe.mjs /替换/为/【小号】db_storage   # 逐库验证密钥/表结构/可读性
```

常见故障速查：

| 症状 | 排查 |
|---|---|
| `refused (fail-closed)` 日志 | groups 为空或 source 值非法；查 cordis.patch.yml |
| `wechat_db read failed` | 先跑 `python3.14 wechat_db.py verify`（工具目录下）；再跑 db-probe |
| 昵称全是 wxid 原值 | contact.db 密钥/路径问题 → db-probe 看 contact 段 |
| 掉线后老消息丢失 | T1.5 追赶补读上限 2000 条/轮，触顶看 warn 建议 backfill |
| 文件全是"待下载" | 离线期未下载正常；小号在线且已下载后 `wechat_db.py files --chat-id xxx` 应返回 available:true |
| 定时报告没生成 | `scheduler/state.json` 看触发记录；`schedulerEnabled` 与 `reportEnabled` 是否都开 |
| 消息重复投递 | 换机/重取钥后游标自动重对齐的正常现象（幂等消化）；持续重复查 cursor.json |

## 9. v0.2.0 变更摘要（M6）

- **保留期清理**：messages 90 天滚动删除（`retentionDays` 可配），长期表与引用行保留，审计只记条数；
- **wx_path 文件定位**：工具端新增 `wechat_db.py files --chat-id` 子命令；插件端 locatePath 接线，未命中保持"待下载"占位，定位记审计；
- **事件↔文件自动关联**：同群 ±10 分钟时间邻近自动挂 `events.file_ids`（confidence 记审计，不改事件本体）；
- **误报阈值配置化**：`minTaskConfidence` / `fulfilConfidence` / `activitySpikeMultiplier`（默认值=原硬编码行为）；
- **fused/split A/B 脚手架**：`distillMode` 标签 + `runAbComparison` 落盘两侧产出供人工比对（切换逻辑待运行期定夺）；
- RUNBOOK 扩写至 D2 全模块；198+14=212 测试绿，sec-tests 68 绿。

## 10. 验收清单

- [ ] `wechat_db.py verify` 对**小号**库全部 verified；
- [ ] 白名单里每个 chatId 都能用小号库 resolve 到；
- [ ] DSH 日志无 `refused (fail-closed)` / `source start refused`；
- [ ] `groups/<chatId>/insights.jsonl` 有新行；
- [ ] `keys.json` 权限仍为 0600（`stat -f '%Lp' .wechat-local/keys.json`）。

## 11. 卸载

```sh
cd ~/.dsh/profiles/desktop
pnpm remove @zzh4206/dsh-group-lurker   # 移除插件（cordis.patch.yml 对应 insert 段一并删掉）
# 数据删除（不可逆，含全部提炼产出与日报）：
rm -rf ~/.dsh/dsh-group-lurker
# 密钥销毁（不再用时）：
rm -rf /path/to/macos-wechat-export/.wechat-local
```

宿主 dispose 保证无定时器/监听残留；卸载后自动回到"不读取"状态。

## 12. 换机 / 重装微信（不迁移，重取钥）

`.wechat-local/` 整个目录（`keys.json`、`original-signature.txt` 等）是**绑定本机与本次取钥过程的临时产物**，换机、重装微信、微信大版本升级后一律**不迁移、重新取钥**：

1. 新环境按 QUICKSTART 重跑 `bootstrap_keys.py`——它会重新生成签名快照与逐库密钥；
2. **切勿**把旧机器的 `.wechat-local/` 拷过去：旧签名快照会让 `bootstrap_keys.py` 的原版签名对照（第 101 行）误判"原版被改动"而中止；旧 keys.json 对新环境的库也不适用；
3. 取钥成功后插件侧只需核对 `sourceDbRoot`/`sourceToolDir` 指向无误，游标（stateDir/cursor.json）与新库位点不一致时会自动按新库重新对齐（最坏情况：少量近期消息重复投递，下游幂等消化）。

## 12.5 发送 worker（发送原语：⌘⇧W+⌘F 键序 + DB 回读验证；2026-10-20 起不再有定位闸/OCR）

> **历史存档（2026-10-16 定位闸时代，2026-10-20 已随 OCR 闸整体移除——现行流程见本节末与 §12.5 首段）**：键序前置一档
> `wechat-ui open --chat '文件传输助手'`（侧栏 Vision OCR 精确定位 + 合成点击 + 标题核验）——
> **废除"文件传输助手必须常驻当前会话"的 P0 级前提**。定位闸语义：
> - 工具侧流程：主窗解析（多窗口态重试加固）→ 激活并确认**真实前台**（防坐标点击落进别的应用/
>   别的 Space）→ SCStream 截窗 → 侧栏（左 340pt）OCR **唯一精确命中才点击**（缺失/重名/多义
>   绝不点击；可滚动收集虚拟化列表）→ 点击行中心 → 标题核验确认打开；目标已打开时走
>   `already_open` 幂等路径零点击；
> - 插件侧语义：失败 → `deferred` 不发**不计 attempts**（下轮自动重试），审计
>   `result='locate_deferred'` + reason 四分类：`target_missing`（侧栏未唯一命中——绝不模糊点击）/
>   `env_unavailable`（熄屏/锁屏/非前台/多窗口解析失败——环境等待）/ `ui_tool_missing` /
>   `tcc_denied`（部署/权限，确定性不重试）；
> - 顺序保证：交互闸（系统空闲 <10s 跳过）仍在定位闸上游——定位的合成点击只会在用户空闲时发生；
> - 背景：微信 4.1.13（macOS 26）AX 内容树不暴露（Qt a11y 桥缺席，三激活入口全部未实现，
>   详见 `docs/REPORT-sender-autotarget-research.md`），侧栏 OCR 是当前唯一被实证可行的定位通道。

> 红线（2026-10-14 用户批准，不变）：**仅允许 `filehelper` 一个受控出口**。通道白名单在
> `src/sender.ts` 代码级硬编码（`ALLOWED_CHANNELS = ['filehelper']`），其他 channel 永不发送；
> 绝不发群聊；发送内容 = `【lurker】<标题>` + ≤160 字摘要 + 特征串（单行 ≤200 字符），**绝不发全文**。
>
> 2026-10-15 原语替换：用户否决 wechat-ui UI 校准方案（要求常驻聊天窗口太麻烦），改用
> **wx-chatbot 式键盘模拟**（参考 github.com/sanjiao403/wx-chatbot 的 Windows 键序，移植 macOS 键位），
> 验证从截图/OCR 换成 **wechat_db.py 只读回读**。发送原语抽为可替换接口 `SendPrimitive`：
> `sendMethod: 'keyboard'`（默认）/ `'wechat-ui'`（旧实现保留在 `WechatUiSender`，可随时切回）。

### 发送键序（KeyboardSender——2026-10-16 E2E 定论改版：deliver 原语）

1. osascript 激活微信 + 确认前台（非前台放弃——防按键落到别的应用；dry_run 到此为止）；
2. 保存当前剪贴板（发送后恢复）；
3. 剪贴板设为消息文本（`【lurker】… + #l<id 前 8 位>` 特征串）；
4. spawn **`wechat-ui deliver --chat '文件传输助手'`**（工具侧一条龙）：
   定位打开（幂等 already_open）→ OCR 锚定"发送"按钮 → 焦点点击输入区（面板左半安全区，
   避开悬浮窗遮挡）→ 合成 Cmd+V（实证可靠）→ OCR 复核草稿在场（2x 放大 OCR）→ 点击发送按钮
   → 轮询草稿清空 → `delivered_ui`；
5. 恢复剪贴板 → DB 回读验证兜底（不变）。

> **合成 Return 已证死（E2E 五连验证）**：微信 4.x 输入框吞掉一切合成 Enter/Cmd+Return（真人
> Enter 正常）——HID post / postToPid / 真实事件源三种方式全灭。发送动作唯一可靠原语 =
> OCR 定位"发送"按钮 + 合成点击（E2E 2/2 + deliver 子命令全链成功）。附带发现：SCStream 1x
> 窗图的小字条带 OCR 不出，须 2x 上采样；坐标永远当次截图求取（E2E 中窗口 1300→853pt 缩放）。

> **搜索定位废除（三轮实测演进）**：Cmd+F 打开的是"搜一搜"网页面板 → 改点击搜索框 + ↓ 选中
> （时灵时不灵）→ 最终"前台 + 粘贴 + 回车"直发当前会话（2026-10-16 再度废除——回车失效且
> 依赖常驻前提）→ 现为 deliver 定位原语。

**运行前提（P0 级）**：发送前"文件传输助手"必须是微信**当前打开的会话**（开一次微信点开文件
传输助手即记住），发送期间勿切换会话。发送后 DB 回读验证兜底：未命中特征串 = 内容可能落进
了别的会话（P0 异常），该条标 `failed_wrong_target` 终态 + 醒目审计 + 立即 warn，**绝不重试**
（重试可能再次误发），需人工检查微信当前会话与已发内容。

### 验证：DB 回读（替代 OCR/截图——发送后兜底）

真发后延迟 2s，只读调用 `wechat_db.py read --chat-id filehelper --limit 3`，确认文件传输助手
最新消息包含本次文本特征串 `#l<outbox id 前 8 位>`——**验证通过才置 sent**，否则按失败计数
（≥3 次转 failed）。keyboard 模式下 `sourceToolDir` 未配置（无 wechat_db.py
可回读）= **fail-closed 不发送**。

### 发送前合规闸（路线 A，2026-10-15：防误发核心）

在"剪贴板粘贴 + Return"**之前**，spawn `wechat-ui read --chat '文件传输助手'`（**只读**：
截取微信窗口 + OCR 读当前聊天标题 + 与参数核对，工具内置 WeChat 4.x 空白截图修复）——
退出码 0 = 当前会话确为文件传输助手 → 放行键序。原因：微信 4.1.13 AX 树不暴露聊天 UI
（双载体实证，见 docs/REPORT-ax-tree-research.md），OCR 标题核验是唯一成熟可行的发送前检测。
`--chat` 参数与发送目标同源同常量 `FILEHELPER_CHAT`（filehelper 硬编码不变）。

- **dry_run 照常执行合规闸**（只读核验——正好用于上线前验证 TCC 授权与当前会话定位），
  但后续键序照旧跳过；
- OCR 误读抖动防御：失败重试 `chatVerifyRetries` 次（默认 2 = 共 3 次，间隔 1s）；
- 全失败 → **deferred**：审计 `result='wrong_chat_open'` + `reason` 字段，**attempts 不增**
  （用户环境状态不是发送失败），条目保持 pending 下轮自动重试，并 warn 人工介入。

**审计 result 枚举**（排障看 `audit/sender.jsonl` 的 result 区分结局；OCR 时代的 `wrong_chat_open`/`ui_tool_missing`/`tcc_denied` 已随闸移除，不再出现）：

| result | 含义 | 处置 |
|---|---|---|
| `transmitted` → `sent`/`take_focus_sent` | 已发出并回读命中（后者=抢前台模式） | — |
| `failed_wrong_target`（P0） | 已 transmitted 但回读未命中：可能发错会话/目标不对 | 立即核查目标会话与 `sendTargetChat`；终态不重试 |
| `verify_read_deferred` | 回读 CLI 报错（环境问题）：保持 sent_pending_verify，绝不重发 | 查工具/库/密钥；累计 5 轮人工告警 |
| `account_unknown_deferred` | 活跃账号**不可判定**（无写入流且 WAL 时间歧义）→ 挂起 | 正常：登录对应账号后自动恢复 |
| `non_whitelisted_account_suspended` | 白名单外账号活跃 → 全面挂起 | 切回配置账号；审计附活跃 wxid 摘要 |
| `account_key_check_deferred` | 发送前密钥预检失败（keys 失效/库不可读） | 重跑取钥（见文末排障） |
| `unverified_missing_config` | 缺 `sourceToolDir`/`sourceDbRoot`/`sendTargetChat`/`readbackChatId` | 补配置（fail-closed 不发） |
| `screen_locked_deferred` / `not_frontmost` / `user_active` | 环境等待（熄屏/非前台/用户正在操作） | 不计 attempts，下轮自动重试 |
| `skipped_quota` / `skipped_channel` / `dry_run` / `send_failed` | 配额/通道/干跑/真失败 | 见相应小节 |

### TCC 前置（首次必做）

系统设置 → 隐私与安全性 → 给 **DSH 宿主应用**（运行本插件的进程）开启：

- **辅助功能**（System Events 按键 + osascript 激活/查询前台）——**发送唯一必需**的权限；
- **屏幕录制不需要**（2026-10-20 OCR 闸移除后，发送链路只做键盘模拟 + DB 回读，不截屏）。
  仅在使用诊断工具（`wechat-ui doctor` 等截屏类命令）时需要，排障时按需授权。

### 真实键位实证（已回填 2026-10-15）

定位改用**点击搜索框 + ↓ 选中**实证键序（见上节）；早期 Cmd+F 假设已否决（wechat-ui 时代参考 + Windows 版 Ctrl+F 的 mac 映射）。
spike 脚本：`scripts/spike-search-shortcut.sh`（会真实敲键，**由 PM/用户在终端代跑**，
agent 不自主执行）——自动依次试 Cmd+F / Ctrl+F / Cmd+Ctrl+F，输出各段 AXFocusedUIElement，
哪段焦点变为搜索框即为真实键位。若全不中，脚本尾附 AX 路径备选（免按键定位，需现场用
Accessibility Inspector 确认元素层级）。**实证结论回填此处：______**

### 首次启用步骤（两段式：dry_run 人工确认定位 → 真发）

0. **启用前人工检查（键序前提，每次换机 / 改热键 / 改 `sendTargetChat` 后都要重做）**：
   - **快捷键不冲突**：键序依赖 Cmd+Shift+W（调出微信，用户自定义热键）与 Cmd+F（微信搜索框）。
     确认这两个组合没有被系统或其它常驻应用（输入法、截图、窗口管理、剪贴板工具等）占用——
     被抢走时按键会落到别的应用上，微信这边毫无反应或停在错误界面；
   - **搜索第一条结果就是目标会话**：键入搜索词后插件**直接按 Return，进入的是第一个搜索结果**，
     不做二次选择。人工在微信搜索框里输入 `sendTargetChat` 的值，看排在**第一条**的是不是要发的那个会话；
     若第一条是别的联系人 / 群 / 聊天记录 / 搜一搜条目，换一个更独特的搜索词（例如给目标会话设唯一备注），
     直到第一条稳定命中为止。DB 回读只能事后报警，挡不住发错会话。
1. TCC **「辅助功能」** 授权（键盘模拟唯一必需；屏幕录制不需要）+ 配置 `sourceToolDir`/`sourceDbRoot`（回读验证必需）+ `sendTargetChat`/`readbackChatId`（缺失 fail-closed 不发送）；
2. 配置保持 `senderEnabled: true`、`sendDryRun: true`（默认），重启插件；
3. **第一段（干跑）**：触发消费（或调 `groupLurker.sender.sendTestSample()`）——dry_run 执行到
   「Return 进入对话」为止即停（**不粘贴消息不回车发送**）。人工确认微信停在的正是目标会话、
   光标在输入框（这是本方案最重要的安全特性：干跑即可验证搜索定位）；
4. **第二段（真发）**：确认定位正确后配置 `sendDryRun: false` 重启，再跑一次——目标会话收到
   `【lurker】…` 消息，且 `audit/sender.jsonl` 出现 `result:'sent', method:'keyboard'` 行（DB 回读已验证）；
5. 之后真实 pending 报告条目由消费循环（`sendIntervalSec`，默认 300s）自然发送。

### 闸门与行为要点

- **总闸**：`senderEnabled`（默认 false = 零活动）+ `sendDryRun`（默认 true）；
- **通道闸**：白名单硬编码，非 filehelper 的 pending 直接 `skipped_channel`，零按键零回读；
- **交互闸（强化，两道）**：① 微信前台（osascript，非前台跳过，连续 3 轮 warn）；② **用户操作闸**——
  `ioreg -c IOHIDSystem` 读系统空闲秒数，**空闲 <10s 视为用户正在操作 → 跳过本轮**（审计
  `user_active`），防按键串扰（用户正在打字/操作时绝不抢键盘）；
- **两种前台模式（`allowTakeFocus`，默认 false）**：
  - **现模式（false，人在电脑前）**：微信非前台 → 跳过本轮（`not_frontmost`），等你回来看；
  - **抢前台模式（true，全自动无人值守）**：跳过前台检查（键序第 1 步 activate 本就自动把微信
    拉到前台），微信不在前台也照发——代价是**发送瞬间会抢走焦点**；但**用户空闲检测原样保留**：
    空闲 <10s（你正在打字/动鼠标）仍跳过让路并计数——允许抢前台，绝不抢正在打字的手；
  - 审计可区分：抢前台放行的发送记 `result='take_focus_sent'`，普通模式记 `sent`；
- **频控**：`maxSendsPerDay`（默认 20）超限的当日 pending 标 `skipped_quota`（样例同样占配额）；
- **空闲阈值可配（`idleSkipBelowSec`，默认 10 = 现行为零变化）**：发送时点检测系统空闲秒数，
  低于该阈值才跳过本轮让路（`user_active`）；≥阈值或设 0 → 不让路，直接抢前台发送。
  **日常单日报场景可设 0**（每天一次的抢前台可接受）；默认 10 适合频繁发送场景（绝不打断打字）；
- **失败重试**：attempts 落盘，≥3 次转 `failed` 不再重试（防风暴）；
- **OCR 合规闸时代已废弃（10-15 ~ 10-20，2026-10-20 移除）**：原 wechat-ui open/read
  定位+OCR 标题核验闸（locateGate/chatVerifyGate，需屏幕录制 TCC）整体移除——由
  ⌘⇧W+⌘F 定位键序 + DB 回读兜底（readbackChatId）替代；**屏幕录制 TCC 不再被流水线
  需要**（仅辅助功能 TCC）。发送原语只剩键盘流程一条路（WechatUiSender/Config
  sendMethod/composerTop/chatVerifyRetries 同批移除）。
- **发送流程替换（用户指定键序，2026-10-19）**：目标改为**大号对话**（Config
  `sendTargetChat`，默认 '老大'；搜索词）。键序：剪贴板=消息文本 → **Cmd+Shift+W** 调出微信
  → Cmd+F 搜索框 → 键入搜索词（`sendSearchViaClipboard=true` 回退剪贴板方案，防 CJK IME
  拦截）→ Return 进入对话 → 500ms → Cmd+V 粘贴 → Return 发送。dry_run 停在进入对话后
  （光标在输入框，不粘贴不发送）。回读验证目标同步改 `readbackChatId`（必填，缺失
  fail-closed；真实值放 cordis.patch.yml）；合规闸 `--chat sendTargetChat` 同源。
  **遗留**：① Cmd+Shift+W 为用户自定义热键——spike 脚本 `scripts/spike-cmdshiftw.mjs`
  （PM 代跑；agent 终端无辅助功能 TCC 报 -10004 无法验证）；② 中文搜索词 IME 拦截风险 →
  剪贴板回退开关；③ 搜索多命中 → Enter 选第一个，异常由回读兜底。
- **错号空报告两段队列（P0 热修 2026-10-19）**：错号在线时触发的日报 = **未处理**而非
  「真的没消息」——空骨架仅落盘存档 + 压入 `regen-queue.json`（pending_regen，**不 notify
  不进 outbox，绝不发送空报告**）。正号（白名单账号）回归后每轮从队首 pop 一个元素重生成
  （窗口锚定原 dateKey、end=处理时刻）：有内容 → 报告落盘 + outbox 条目进发送链路（done）；
  空 → 放回队首重试 ≤2 次（regenAttempts 跨重启保留）；3 次全空 → **如实定稿**（空日报正常
  创建发送，empty_confirmed）；环境异常 → 放回队首不耗次数。审计
  `regen_queued/regen_deduped/regen_regenerated/regen_deferred_sync_pending/`
  `regen_empty_confirmed/regen_satisfied/regen_env_deferred` 全生命周期可查。
  **事件记录（2026-10-19）**：修复前错号期间两条「本期窗口内无消息」空日报已实发到文件传输
  助手，无法撤回——已由本热修复杜绝（错号期间空报告不再进发送链路）。
- **手动重新生成（reason=`manual`，对话框 `reportRegen` / 前端 `report.regen`）**：与错号补发共用
  `regen-queue.json`，但分开处理——独立轮询（约 30 秒一条，不依赖日报 tick 与账号闸是否配置），
  **只重新生成报告、不进 outbox、不发送**；不做 satisfied 检查（重跑的通常就是已有报告），空产出
  不重试；账号闸配置且错号在线时跳过本轮（防空数据覆盖正常报告）。审计 `regen_manual_done`。
  要推送到手机须另走「排入发件箱」（发送只有一个入口）。错号补发的 satisfied 检查、重试计数与
  outbox 条目均按条目自身周期（日/周/月）处理。
- **账号闸 fail-closed 强化（2026-10-21 误发事故修复）**：旧实现用 2s 写入流采样判活跃账号，
  微信空闲时返回 null 而 sender 把 null 当"不挂起"——登录大号期间照发（事件：2026-10-21 两条日报
  从大号发出，回读判 failed_wrong_target，无法撤回）。现判据三道：①2s 写入流（强信号）→
  ②回退 **DB WAL/db mtime 对比**（活跃账号的 `message_0.db-wal` 持续更新；差距 <60s 视为歧义；
  **`-shm` 会被读取层轮询污染，绝不参与**）→ ③发送前 `verify` 级读取预检（keys 失效→延后）。
  **null 一律 fail-closed**：不可判定 = 不激活微信/不敲键/不耗 attempts，审计
  `account_unknown_deferred`；缺 `sendTargetChat`/`readbackChatId` 等同缺工具，审计
  `unverified_missing_config` 拒发。
- **账号生命周期自动化（白名单制，2026-10-15）**：探针每轮消费周期对
  `xwechat_files/wxid_*` 各目录做**双快照活动对比**（间隔 2s；文件数或最新 mtime 变化 =
  持续写入流 = 活跃；单次快照无判别力）。活跃 ∉ `accountWhitelist` → sender **全面挂起**
  （零微信交互，pending 不耗 attempts），审计 `non_whitelisted_account_suspended` 首轮+每
  10 轮各记一次 + 提醒「读取层读的是缓存数据」；读取层不挂起。白名单空 = 仅允许
  sourceDbRoot 派生的默认账号。**回归恢复三重条件**（同时满足才取钥）：活跃 ∈ 白名单 +
  `wechat_db.py verify` 确认密钥失效 + `allowAutoRekey=true`；白名单外账号活跃时**绝不取钥**
  （代码级硬阻断——防把别的账号登进临时副本污染密钥台账）。取钥（每回归周期 ≤1 次）→
  verify 19/19 → 恢复；用户超时未登录临时副本 → 本轮放弃下轮重试。`allowAutoRekey=false`
  （默认）只通知人工执行 bootstrap_keys.py；**两段式开启条件**：首次开启前必须人工成功
  手跑一次取钥。db-root 代码级锁定配置账号目录（派生自 sourceDbRoot）。
- **media 镜像（v0.4）**：file-index 扫描入库后（同一消息处理周期，无独立定时器），
  groupStore `files` 表全量 upsert 进 knowledge.db `media`：
  `source_key = <chatId>:<file_id>`（幂等）；media_type 图片→image / 视频→video / 其余→file；
  status 有 path→available(local)、无 path/待下载→pending；md5/ext 按 knowledge CHECK 约束
  （32 位 hex / 小写 1–16 位）不合规范置空；失败仅 warn 不影响主流程；
- **日报窗口锚定调度（2026-10-15 决策）**：daily 窗口 = **前一日 20:20 → 触发时刻**（10 分钟
  边界余量）。动机：日报 20:30 定时送达，旧窗口 [当天00:00, 20:30] 会把「昨晚 20:30 之后的消息」
  漏进两份日报的夹缝。新窗口保证 20:30 附近的重要消息必被至少一份日报捕获；20:20–20:30 的重叠
  是刻意的边界保险，两份日报都含它，属预期行为。dateKey 不变（按触发日命名）；
  weekly/monthly 日历语义不变；
- **发送/验证状态机解耦（P0 重发循环根治 2026-10-15）**：键序执行到 Return 即落
  `sent_pending_verify` + `transmittedAt`（先落盘再验证）——该状态**绝不整条重发**，后续周期
  只重试回读验证：命中 → `sent`；穷尽未命中 → `failed_wrong_target`（P0 终态）；CLI 报错 →
  保持 `sent_pending_verify` + `verifyAttempts` 累计（≥5 轮 error 级人工介入告警）。只有
  **发送前**失败（activate 失败/环境不可用等）才保持 pending 重试整条发送。状态机：
  `pending → sent_pending_verify → sent | failed_wrong_target`；`verify_read_deferred` 自环；
  回读验证抗干扰：文件传输助手为**共享通道**（用户自己也会传文件/发消息），验证采用
  「签名 + 时间窗」双重过滤——`--limit 30` 宽窗口 + 必须含 `#l<id8>` 特征串 + `create_time ≥
  transmittedAt-60s`；命中时抓取 `server_id`（微信服务器消息 id）写入条目作送达回执，证据链 =
  签名（自造）+ server_id（官方）+ transmittedAt + sentAt；
- **熄屏/锁屏 = 环境等待（非失败）**：AX 读不到微信窗口（熄屏、锁屏、主窗口关闭）时本轮标记
  `screen_locked_deferred`——**不计 attempts、状态保持 pending**，下轮消费周期自动重试，
  无限等待直到环境恢复（解锁后自动恢复发送，无 attempts 损耗、不熔断）；
  attempts≥3 熔断只针对"环境可读但发送/验证失败"的真实失败（如 DB 回读未命中）；
- **状态机**：`pending → sent | dry_run | skipped_quota | skipped_channel | failed`；
- **审计**：`audit/sender.jsonl` 只记元数据（id/kind/结果/attempts/method），绝不记正文；
- **剪贴板**：发送前保存、发送后恢复；恢复失败只 warn；发送失败路径同样尝试恢复；
- **旧实现已移除**：`wechat-ui` 发送/OCR 闸（2026-10-20）已整体删除——发送原语只剩键盘流程一条路，无需任何回退配置；
- **测试模式隔离**：`scheduleTestMode` 产生的报告同样进 outbox、同样可发——测试期务必保持
  `sendDryRun: true`，验证完及时关掉 scheduleTestMode。

## 13. 前端动作通道对接（web/actions.jsonl，2026-10-20 审查 W-1/W-3/W-4/W-10/W-13 后定稿）

前端工作台（web 进程）与插件之间**只**通过 stateDir 内的 jsonl 文件交换，零 RPC。本节是硬约定：

### 13.1 写通道（前端 → 插件）

- 唯一入口 `POST /api/actions`（web 进程实现，须逐条落实设计 §6.2 token/Origin/Host 三校验）；
  落盘为**追加写** `<stateDir>/web/actions.jsonl`（§4.3 行格式，actionId 全局唯一幂等键）。
- **明令禁止轮转/截断 `web/actions.jsonl`**：插件水位是**字节偏移**（`web/actions.offset`，
  JSON `{byteOffset, lastActionId}`）。文件一旦被截断/轮转（长度 < 水位），插件只能从头 resync
  （error 审计 + 靠 actionId 幂等防重复执行）——这是兜底不是正常路径；历史归档由前端自己负责。
- 每行必须以 `\n` 结尾才算完整一行：半行（写到一半）插件不消费，下轮再读。
- **一切写只走 actions.jsonl**：前端不得直调进程内服务/直接改库；进程内失败对前端永远表现为
  回执非 ok 或 `not_found`。

### 13.2 水位与回执

- 插件每消费一行立即落盘水位（字节偏移 + 最后一条 actionId 锚点）——插件中途崩溃重启只重放
  恰好未处理的部分；锚点对不上（文件被改写）→ 从头 resync + warn。
- 回执：`web/action-results.jsonl` 追加 `{actionId, ok, code, ts}`，前端轮询（默认 5s，
  `webActionsPollSec`）。写失败（磁盘满等）由插件墓碑补写；若长期失败前端会等不到回执——
  排障看 error 日志「回执写失败连续」。
- 失败码：`not_found` / `status_conflict`（stale 细分）、`chat_not_allowed` / `type_not_allowed`、
  `operator_mismatch`（见 §13.3）、`unsupported` / `bad_request`（带 reason）/ `error`。

### 13.3 审计与身份（W-1）

- `audit/web-actions.jsonl` 只记元数据（ts/actionId/type/chatId/code/ok/**operator**），绝无语句原文。
- `operator` = 共享 token 的 sha256 前 8 位（插件配置 `webActionsToken`，与 web 进程同一 token；
  真实值只放 cordis.patch.yml，**任何一侧日志/审计都不落原 token**）。未配置记 `unknown`。
- **对齐保证**：只有两侧 token 一致，审计 `operator` 才能用浏览器实际 token 的哈希核对。因此：
  - 插件把指纹写进 `web/allowed-chats.json` 的 `operator` 字段；web 进程用自己的 `LURKER_WEB_TOKEN` 算同一指纹，
    不一致（`token_mismatch`）或插件未配置 token（`plugin_token_unset`）时写动作禁用；
  - web 进程在每条动作行写 `operator`（本进程 token 的指纹）；插件配置了 token 时，行内 `operator` 缺失或不一致
    → 不执行，回执 `operator_mismatch`，审计行另记 `claimedOperator`（行自称的指纹，便于定位配错的进程）。
    这一层兜住「入队后插件换了 token」与手工写入的行。未配置 token 的插件维持原行为。

### 13.4 读通道（插件 → 前端，outbox）

- `outbox.jsonl` 只有两种行：完整条目（有 `kind`/`ts`）与**状态补丁行**（`{patch:true, id, status, …}`）。
  前端读取必须按 `id` fold 归并（行序优先，后写覆盖先写，补丁是 merge 不是 replace）；
  无 `id` 的旧行按 ts+kind+行号兜底（W-10 兼容规则）。
- 条目 `evidence_ref` 指向报告 md 路径、`outbox/<id>`（详情在 body 的速览类）或消息 msg_id。

## 14. 前端工作台（FE-1 只读回溯 + FE-2 审批收件箱）

本地网页，按 日期 × 群 × 周期 回看报告，另有资料库、媒体清单、会话要点、人员关注摘要（FE-1）；
「审批」页集中处理待确认的任务/承诺/事件、给任务定时间、标记完成，「人员关注」页可关注/取消关注成员（FE-2）。
它是**独立 node 进程**（`web/server.mjs`），不在插件里：不持有任何发送能力，只读本项目自己的库；
唯一的写入是向 `<stateDir>/web/actions.jsonl` 追加动作行，由插件收件箱执行（§13）。

### 14.1 启动

```bash
# 前提：插件至少启动过一次——它会写 <stateDir>/web/allowed-chats.json（白名单 + knowledge.db 路径 + 收件箱是否开启）
LURKER_WEB_TOKEN='<与插件 webActionsToken 相同的值>' \
  node web/server.mjs --state-dir "$HOME/.dsh/dsh-group-lurker" [--db /path/to/knowledge.db] [--port 8787]
```

- 浏览器打开 `http://127.0.0.1:8787/#token=<token>`。页面把 token 存进当前标签页的 sessionStorage 后立即从地址栏抹掉；
  关掉标签页即失效，再开需重新带 `#token=`。
- 不设 `LURKER_WEB_TOKEN` 时进程生成一次性随机 token，**只在启动时打印一次**，且为**只读模式**（审批按钮禁用）——
  适合临时查看。token 不走命令行参数，避免出现在 `ps` 输出里。
- `--db` 缺省取清单里的路径（即插件 `sqlitePath`）；插件 `sqlitePath='off'` 时回溯类页面提示不可用，人员关注照常。
- 只监听 `127.0.0.1`，**没有**改监听地址的参数（手机直连不在本期范围，见前端设计 §11-Q4）。

### 14.2 开启审批（FE-2）

三项都满足，「审批」页的按钮才可用（否则页面顶部提示原因、只读展示）：

1. 插件配置 `webActionsEnabled: true`（并重启插件，清单里 `actionsEnabled` 随之变为 true）；
2. 插件配置 `webActionsToken` 与 web 进程的 `LURKER_WEB_TOKEN` 是**同一个值**（审计 operator 即其 sha256 前 8 位）。
   web 进程会比对两边指纹：不一致或插件没配 token 时页面只读，提示 `token_mismatch` / `plugin_token_unset`（§13.3）；
3. web 进程用 `LURKER_WEB_TOKEN` 启动（随机 token 只读）。

提交后页面显示「已提交，等待插件处理…」，插件按 `webActionsPollSec`（默认 5 秒）消费，回执到达后显示结果：

| 页面提示 | 回执码 | 含义 |
|---|---|---|
| 已生效 | `ok` | 已执行；确认类动作同时登记模式学习、出身日报追加修订段（来源：前端） |
| 状态已变化 | `status_conflict` | 目标已在别处处理（如对话框里已确认），刷新即可 |
| 目标不存在 | `not_found` | 行已被删除或 id 不对 |
| 插件拒绝：token 不一致 | `operator_mismatch` | 提交后插件换了 `webActionsToken`；两边改成同一值后重新提交 |
| 60 秒内插件未处理 | — | 插件没在跑或收件箱没开；动作已入队，插件恢复后仍会执行 |

前端只开放这些动作：`task.confirm/cancel/complete/set_deadline`、`event.confirm`、
`promise.confirm/cancel/fulfilled/close`、`person.follow/unfollow`、`report.finalize`、`report.regen`、
`report.toOutbox`（插件侧白名单的子集；`report.toOutbox` 另受 §14.5 开关约束）。

**报告操作（FE-3，报告详情页）**——两者都**不发送**：

- 「定稿」`report.finalize`：draft → final，单向。定稿后修订、重新生成照常更新正文，状态保持 final；
  修订历史记一条 `status`（来源前端）。已定稿再提交回执 `status_conflict`；`sqlitePath='off'` 时回执
  `unsupported`（定稿状态只存在于 knowledge.db）。
- 「重新生成」`report.regen`：入手动重跑队列（§12.5 附近「手动重新生成」），插件约 30 秒内开始、
  LLM 生成需要一会儿，稍后刷新。**只重写报告、不进发件箱**；同一份已在队列中回执 `duplicate`。
- 参数为 `{kind, dateKey}`，dateKey 必须是周期起点（日报当天、周报周一、月报 1 号）。
- **跨群聚合报告**（`chatId='aggregate'`，只有日报）同样可定稿、重新生成、排入发件箱（后者见 §14.5）。
  聚合不是群、不在白名单里：插件收件箱与 web 侧只对 `report.*` 三个动作放行 `aggregate`，且只认
  `kind: 'daily'`（其它周期回执 `bad_request`，原因 `aggregate_daily_only`），任务/承诺等动作仍回
  `chat_not_allowed`。聚合的「重新生成」**不调 LLM**：按各群当天现有日报重新汇总（窗口与群日报回填
  同口径）；想更新某个群在汇总里的内容，先重新生成那个群的日报、再重新生成汇总。

### 14.3 拒绝启动 / 接口报错

| 现象 | 原因 | 处置 |
|---|---|---|
| 启动即退出：「未找到有效白名单」 | 清单缺失，或插件 `groups` 为空（R2 fail-closed） | 配好 `groups` 后启动一次插件 |
| 页面提示 token 无效（401） | 地址没带 `#token=`，或与进程的 token 不一致 | 用启动时的 token 重开 |
| 403 `bad_host` / `bad_origin` | 用了 127.0.0.1/localhost 以外的主机名访问，或其它网页在跨站请求 | 预期行为（防 DNS rebinding / CSRF），用 `127.0.0.1` 访问 |
| 503 `knowledge_db_unavailable` | knowledge.db 不存在或镜像已关 | 检查 `sqlitePath` / `--db` |
| 409 `actions_disabled` | 写动作未开启（`reason`：`no_shared_token` / `inbox_disabled` / `plugin_token_unset` / `token_mismatch`） | 见 §14.2 |
| 415 / 403 `bad_origin`（提交时） | 写请求必须是本页面发出的 JSON 请求 | 预期行为（防 CSRF），从工作台页面操作 |

白名单每个请求都重读：插件改 `groups` 重启后，web 进程无需重启即生效。

### 14.4 停用

`Ctrl-C`（或 SIGTERM）即可。web 进程没有后台任务，停掉不影响插件；已提交未执行的动作留在 actions.jsonl，
插件照常消费。要彻底关闭审批通道，把插件 `webActionsEnabled` 设回 `false`。


### 14.5 排入发件箱（默认关闭）

报告详情页的「排入发件箱」是工作台里**唯一会走向发送**的操作：往 outbox 追加一条与定时报告同形的条目，
之后由既有 sender worker 处理——四道闸（`senderEnabled` / `sendDryRun` / 通道闸 / 交互闸）、每日配额
`maxSendsPerDay`、DB 回读验证一概照旧，没有新的发送路径。发出去的只是一行提醒
（`【lurker】日报 2026-10-14（群）（前端补推） 修订 N 处，全文见工作台`），**不含报告正文**。

开关：插件配置 `webOutboxEnabled`，默认 `false`。关闭时插件收件箱不注入入队函数，
`report.toOutbox` 一律回执 `unsupported`（手写 actions.jsonl 也绕不过）；web 侧按钮置灰、提交回 409。

**启用步骤（按顺序，前一步确认无误再进行下一步）**：

1. 前置：§14.2 的审批通道已能正常使用（确认/定稿等回执正常）。
2. 保持发送层**干跑**：`sendDryRun: true`（默认）。设 `webOutboxEnabled: true`，重启插件；
   工作台报告详情页的「排入发件箱」按钮应变为可用。
3. 点一次「排入发件箱」，核对：
   - 回执「已排入发件箱」；`outbox.jsonl` 末尾多一条 `kind` 为报告周期、标题以「（前端补推）」结尾、
     `evidence_ref` 为报告 md 路径、`status: pending` 的条目，正文无报告内容；
   - 10 分钟内再点一次 → 回执「10 分钟内已排入过」，outbox 不新增；
   - sender 处理后该条目转 `dry_run`（只激活微信到对话、不粘贴不回车），`audit/sender.jsonl` 只有元数据。
4. 确认无误后，是否真发由发送层自身的开关决定（`senderEnabled` + `sendDryRun: false`，见 §12.5），
   与定时报告完全一致；本开关不提供单独的「真发」选项。**真发前先做完 §12.5「首次启用步骤」第 0 步**
   （快捷键不冲突、微信搜索 `sendTargetChat` 的第一条结果就是目标会话——插件按 Return 直接进入第一条）。
5. 回退：`webOutboxEnabled: false` 并重启即可。已入队未处理的条目仍在 outbox 中，按发送层开关处理；
   需要撤下的话在发送层关闭期间处理，不要手工删改 outbox.jsonl。

## 排障：重新登录/切换微信账号后读取失效（code 15）

**现象**：微信重新登录（或切换账号）后，读取层报 SQLCipher code 15 / audit 出现 ok:false / 报告与摘要停更。

**原因**：数据库密钥与登录态绑定，重新登录后微信轮换库密钥，旧 `keys.json` 失效。

**处置**：重跑取钥刷新（需先退出微信）：
```bash
cd $HOME/WeChat/macos-wechat-export
python3.14 bootstrap_keys.py --acknowledge-debug-copy --db-root "<小号 db_storage 绝对路径>"
python3.14 wechat_db.py --db-root "<同上>" verify   # 预期 19/19 verified
```
然后重开微信（小号）、重启 DSH 即恢复。**切勿**为此切回大号或动其他账号的库。

（实测记录：2026-10-15 重新登录后 message_0.db code 15，重跑取钥 19/19 恢复。
   补充确认【用户目视】：密钥失效窗口期内的发送本身**不受影响**——发送走客户端 UI（粘贴+回车），
   不依赖 keys.json；Test2 验证消息在该窗口内仍成功送达文件传输助手（用户目视+DB 双确认）。
   受影响的只有**读取层与回读验证**（两者依赖 keys.json）——即密钥失效期 = 读停/发不停，
   恢复密钥后回读自动补验。）

## 附录：macos-wechat-export 目录盘点（2026-10-13）

> 结论：除 `__pycache__`（92K 编译缓存，随时再生）外**无废弃物**，整目录 ~400KB，不做瘦身。逐类依据如下。

| 类别 | 文件 | 处置 |
|---|---|---|
| 现役依赖（缺一不可） | `wechat_db.py`（唯一读取 CLI）、`bootstrap_keys.py`（取钥入口，内部调 `capture_keys.py` 做 LLDB 捕获——勿误删）、`disk_inventory.py`（多账号选库）、`.wechat-local/`（keys.json 0600 + 签名快照）、`.git`（**含 T1.5 补丁 `--before-id`，只存在本地**）、`.gitignore`、`LICENSE`+`NOTICE`（MIT 合规义务）、`test_db.py`（29 项验收） | 保留 |
| 将来要用（M5-F7） | `media_pipeline.py`、`test_media.py`、`requirements-media.txt`、`media-config.example.json` | 保留 |
| 二期参考（发送红线暂不用） | `Send.swift`、`WeChatUI.swift`、`Tests.swift`、`wechat-ui`（编译产物）、`UI_GUIDE/OPERATIONS/AGENT_PLAYBOOK`、`check_inbox.py`、`send_verified.py` | 保留（filehelper 通道接入 outbox 时为现成参考） |
| W1 调研残留 | `sqlcipher_probe.py`、`readonly_port_probe.c`、`probe_readonly_port.sh`、`build.sh`、`test.sh` | 保留（W1 报告可复现性注记依赖） |
| 文档 | QUICKSTART / README / KEY_GUIDE / TROUBLESHOOTING / REFERENCE / VALIDATION | 保留（本手册素材出处） |
| 垃圾 | `__pycache__` | 可删（再生） |

仓库状态注记：上游 remote 已移除（原 `DaneelOlivaw1/macos-wechat-export`，无写权限），现为**纯本地私有仓库**（上游 `88ca1be` + 本地补丁 `d5eda50`）。如需异地备份：在 GitHub 新建**自有**私有仓库作 remote，绝不恢复原作者 remote。
