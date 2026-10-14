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

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `insert:` 列表加一段。**以下全部路径均为占位，必须替换为本机小号实际路径；仓库内 cordis.patch.yml 是本地运行配置，不入库。**

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

只读旁听**不需要**屏幕录制/辅助功能授权（那是发送/UI 自动化才用的，本插件不发送）。

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

## 12.5 filehelper 发送 worker（发送原语：键盘模拟 + DB 回读验证，2026-10-15 重写）

> 红线（2026-10-14 用户批准，不变）：**仅允许 `filehelper` 一个受控出口**。通道白名单在
> `src/sender.ts` 代码级硬编码（`ALLOWED_CHANNELS = ['filehelper']`），其他 channel 永不发送；
> 绝不发群聊；发送内容 = `【lurker】<标题>` + ≤160 字摘要 + 特征串（单行 ≤200 字符），**绝不发全文**。
>
> 2026-10-15 原语替换：用户否决 wechat-ui UI 校准方案（要求常驻聊天窗口太麻烦），改用
> **wx-chatbot 式键盘模拟**（参考 github.com/sanjiao403/wx-chatbot 的 Windows 键序，移植 macOS 键位），
> 验证从截图/OCR 换成 **wechat_db.py 只读回读**。发送原语抽为可替换接口 `SendPrimitive`：
> `sendMethod: 'keyboard'`（默认）/ `'wechat-ui'`（旧实现保留在 `WechatUiSender`，可随时切回）。

### 发送原语键序（KeyboardSender，13 步）

1. osascript 激活微信（`tell application "WeChat" to activate`）+ 确认前台（非前台直接放弃，防按键落到别的应用）；
2. 保存当前剪贴板内容（发送后恢复——礼貌且防用户数据丢失）；
3. 剪贴板设为 `文件传输助手`；
4. System Events 按键：**Cmd+F**（微信搜索）；
5. System Events 按键：**Cmd+V**（粘贴搜索词——中文走剪贴板，避开输入法）；
6. 延迟 800ms（搜索结果渲染）；
7. System Events 按键：**Return**（选中第一个结果 = 打开文件传输助手会话）；
8. 延迟 500ms；
9. 剪贴板设为消息文本（`【lurker】… + #l<id 前 8 位>` 特征串）；
10. System Events 按键：**Cmd+V**（粘贴消息）；
11. 延迟 300ms；
12. System Events 按键：**Return**（发送）；
13. 恢复剪贴板原内容（失败仅 warn，不阻塞）。

### 验证：DB 回读（替代 OCR/截图——TCC 收益）

真发后延迟 2s，只读调用 `wechat_db.py read --chat-id filehelper --limit 3`，确认文件传输助手
最新消息包含本次文本特征串 `#l<outbox id 前 8 位>`——**验证通过才置 sent**，否则按失败计数
（≥3 次转 failed）。因此 **TCC 只需"辅助功能"**（System Events 按键），**不再需要屏幕录制**——
这是相对 wechat-ui 方案的额外收益。keyboard 模式下 `sourceToolDir` 未配置（无 wechat_db.py
可回读）= **fail-closed 不发送**。

### TCC 前置（首次必做）

系统设置 → 隐私与安全性 → 给 **DSH 宿主应用**（运行本插件的进程）开启：

- **辅助功能**（System Events 按键 + osascript 激活/查询前台）——**唯一必需项**；
- ~~屏幕录制~~（不再需要：验证走 DB 回读，无截图）。

### 真实键位实证（待回填）

微信 mac 4.x 搜索快捷键暂按 **Cmd+F** 设计（wechat-ui 时代参考 + Windows 版 Ctrl+F 的 mac 映射）。
spike 脚本：`scripts/spike-search-shortcut.sh`（会真实敲键，**由 PM/用户在终端代跑**，
agent 不自主执行）——自动依次试 Cmd+F / Ctrl+F / Cmd+Ctrl+F，输出各段 AXFocusedUIElement，
哪段焦点变为搜索框即为真实键位。若全不中，脚本尾附 AX 路径备选（免按键定位，需现场用
Accessibility Inspector 确认元素层级）。**实证结论回填此处：______**

### 首次启用步骤（两段式：dry_run 人工确认定位 → 真发）

1. TCC"辅助功能"授权 + 配置 `sourceToolDir`/`sourceDbRoot`（回读验证必需）；
2. 配置保持 `senderEnabled: true`、`sendDryRun: true`（默认），重启插件；
3. **第一段（干跑）**：触发消费（或调 `groupLurker.sender.sendTestSample()`）——keyboard 模式
   dry_run **执行键序到第 8 步为止**（激活 → 搜索 → 选中第一个结果 → 停），**不粘贴消息不回车**。
   人工确认微信确实定位到"文件传输助手"会话（这是本方案最重要的安全特性：干跑即可验证搜索定位）；
4. **第二段（真发）**：确认定位正确后配置 `sendDryRun: false` 重启，再跑一次——文件传输助手收到
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
- **失败重试**：attempts 落盘，≥3 次转 `failed` 不再重试（防风暴）；
- **状态机**：`pending → sent | dry_run | skipped_quota | skipped_channel | failed`；
- **审计**：`audit/sender.jsonl` 只记元数据（id/kind/结果/attempts/method），绝不记正文；
- **剪贴板**：发送前保存、发送后恢复；恢复失败只 warn；发送失败路径同样尝试恢复；
- **切换回旧实现**：`sendMethod: 'wechat-ui'`（此时 `wechatUiPath`/`composerTop` 生效，TCC 需
  屏幕录制，验证标志回到 `sent_ui_verified`）；
- **测试模式隔离**：`scheduleTestMode` 产生的报告同样进 outbox、同样可发——测试期务必保持
  `sendDryRun: true`，验证完及时关掉 scheduleTestMode。

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
