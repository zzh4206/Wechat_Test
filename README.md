# @zzh4206/dsh-group-lurker

**简体中文** ｜ [English](README.en.md)

[![CI](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml/badge.svg)](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)

微信群聊知识库系统：**只读旁听 → LLM 提炼 → 日报 → 本地 SQLite 知识库（查询层）**。

一个 [DSH](https://github.com/deepseek-ai) Cordis 插件 + 一个零数据知识库模板。只支持 **macOS + 微信 4.x**（读取本地 SQLCipher 库）。

**[30 秒速览](#30-秒速览)** ｜ [架构](#架构从聊天到知识库) ｜ [快速开始](#快速开始) ｜ [配置](#配置参考) ｜ [安全模型](#安全模型五条红线) ｜ [知识库模板](#知识库模板与本地数据) ｜ [文档](#文档)

---

## 30 秒速览

| | |
|---|---|
| **做什么** | 读你**自己电脑上已登录**的微信本地库 → 按群提炼 → `insights.jsonl` + 日报 → 镜像进本地 SQLite 知识库 |
| **不做什么** | 不写微信数据、不动微信进程、不逆向通信协议、不读取密钥文件、默认不发消息 |
| **默认状态** | 白名单为空即**拒绝启动**（fail-closed）；发送四道闸默认全关；镜像写失败只 warn 不影响主流程 |
| **你需要** | macOS、微信 4.x、`sqlcipher`、取钥工具、DSH ≥ 0.2.0-rc.2 |
| **数据在哪** | JSONL 事实源在 `$DSH_HOME/dsh-group-lurker/`；知识库在 `~/WeChat/1数据/knowledge.db`（仅本机，永不入库） |

## 仓库组成

| 路径 | 是什么 |
|---|---|
| `src/` | 插件本体：白名单读取、每群缓冲、LLM 提炼、日报、受控单出口发送、SQLite 镜像数据层（`src/db/`） |
| `0数据格式/` | **知识库纯模板**：三层 schema（资料 `doc` + 日志 `report`/`entry` + 会话要点 `chat_digest`）+ 3 个 Python 工具。**不录入任何数据** |
| `scripts/` | `check-sensitive.sh`（敏感信息扫描）、`llm-cost.mjs`（费用汇总）、`import-state-to-sqlite.mjs`（一次性导入器） |
| `tests/` | 50 个测试文件、440 例，全离线 mock，不碰真实库 |

## 架构：从聊天到知识库

```text
微信本地库 (SQLCipher)
   │  只读子进程（密钥经 stdin，不进命令行参数）
   ▼
插件：白名单读取 → 每群独立缓冲 → LLM 提炼
   │
   ├─▶ insights.jsonl + reports/*.md     ← JSONL = 事实源（source of truth）
   │
   └─▶ SQLite 镜像（可选，配置 sqlitePath）← 查询层，写失败只 warn 降级
            默认 ~/WeChat/1数据/knowledge.db

存量迁移：node scripts/import-state-to-sqlite.mjs --state-dir <stateDir> [--db <path>]
          （只读 state，source_key 内容哈希幂等，可重复运行）
查询/导出：0数据格式/report_cli.py · export_md.py
```

- **JSONL 永远是事实源**：SQLite 只是查询层，镜像与导入器使用同一套映射口径
- **schema v0.4**：`report` 带 `chat_id`（冲突键三元组 `(period_type, period_start, chat_id)`，不再跨群聚合分节）、新增 `media` 元数据表（媒体本体永不入库）；`user_version` 迁移幂等，旧库自动升级
- **报告落盘并行提取资料**：报告里的 URL / 文件索引自动入 `doc` 表，与 Python 批量脚本同口径零重复
- **审批闭环与报告修订流（schema v0.6）**：`ApprovalActions` 审批动作单入口 + `ActionInbox` 动作收件箱；报告修订写入 `report_revision`（不可变历史）并级联周报/月报，完成情况以 `marking`（done/undone/deleted 追加式）标记——全部镜像进知识库，形成「单一查询副本」

## 快速开始

**1 · 装依赖**

```bash
brew install sqlcipher
```

**2 · 取本地库密钥**（产物 `.wechat-local/keys.json`，权限 `0600`）

```bash
git clone https://github.com/DaneelOlivaw1/macos-wechat-export.git
cd macos-wechat-export && python3 bootstrap_keys.py
```

**3 · 装插件** —— 在 DSH profile 目录（如 `~/.dsh/profiles/desktop`）：

```bash
pnpm add --config.auto-install-peers=false git+https://github.com/zzh4206/Wechat_Test.git
```

**4 · 写配置，重启 DSH** —— 在 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: group-lurker
  name: "@zzh4206/dsh-group-lurker"
  config:
    groups:
      - "12345678@chatroom"          # 白名单：群 chatId（取钥工具 resolve <群名> 查）
    source: wechat-db
    sourceToolDir: /path/to/macos-wechat-export     # 必填，无默认值
    sourceDbRoot: ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid_hash>/db_storage  # 必填
    sourcePython: /opt/homebrew/bin/python3         # 建议绝对路径
```

**5 · 存量导入（可选）** —— 把既有 state 目录一次性导入知识库：

```bash
node scripts/import-state-to-sqlite.mjs --state-dir ~/.dsh/dsh-group-lurker
```

> `source` 语义：`none`（默认，不读取）｜`wechat-db`（读本地库，三项必填、缺一拒启——刻意无隐式默认值）。

## 配置参考

### 读取与提炼

| 字段 | 默认 | 说明 |
|---|---|---|
| `groups` | `[]` | **白名单**。空 = 拒绝读取（fail-closed） |
| `source` | `none` | `none` ｜ `wechat-db` |
| `sourceToolDir` / `sourceDbRoot` / `sourcePython` | —（必填） | 取钥工具目录 / 微信 `db_storage` 绝对路径 / python 解释器 |
| `pollIntervalSec` / `readLimit` | `10` / `50` | 轮询间隔与单次读取条数 |
| `backfillOnStart` | `0` | 启动回灌条数（默认不回灌历史） |
| `bufferSize` | `60` | 每群环形缓冲 |
| `distillEveryMessages` / `distillIntervalMin` | `25` / `15` | 按条数 / 按时间触发 LLM 提炼 |
| `retentionDays` | `90` | **消息留存天数**：`store.db` 中过期 messages 滚动删除。**数据最小化入口**，不需要留 90 天就调小 |
| `persona` / `groupPersonas` | `default` / `{}` | 默认人格 / 按群覆盖 |

### 知识库镜像与文件索引

| 字段 | 默认 | 说明 |
|---|---|---|
| `sqlitePath` | `''` | SQLite 知识库镜像路径。留空 = `~/WeChat/1数据/knowledge.db`；`'off'` = 关闭。**JSONL 仍是事实源**，镜像写失败只 warn |
| `fileIndexListIntervalMin` | `30`（`0`=关） | 以取钥工具 `files` 子命令清单兜底补全 files 表（微信 4.x 文件消息 XML 不导出，消息流侧拿不到文件名） |

### 发送闸门（默认全关）

| 字段 | 默认 | 说明 |
|---|---|---|
| `senderEnabled` | `false` | 发送总闸 |
| `sendDryRun` | `true` | 演练模式：只落 outbox 不真发 |
| `maxSendsPerDay` | `20` | 每日发送上限（超限标 `skipped_quota` 防风暴） |
| `accountWhitelist` | `[]` | **账号白名单**（fail-closed 同 `groups` 语义）：白名单外账号活跃 → 发送全面挂起 + 取钥硬阻断 |

> 发送定位与 DB 回读闸（`sendTargetChat`、`readbackChatId`、`verifyDelaySec`、`verifyRetries`）属发送链路参数，见 [docs/RUNBOOK.md](docs/RUNBOOK.md)。
| `readbackChatId` | '' | DB 回读验证目标会话 wxid（必填，缺失 fail-closed） |
| `sendSearchViaClipboard` | false | 搜索词剪贴板回退（CJK IME 兜底） |
| `webActionsEnabled` | false | 前端动作收件箱总闸（审批 web 通道） |
| `webActionsPollSec` | 5 | 动作收件箱轮询周期秒 |
| `batchThreshold` | 120 | 大窗口分批归纳阈值 |
| `accountWhitelist` | [] | 账号白名单（账号生命周期自动化） |
| `allowAutoRekey` | false | 小号回归自动取钥 |
| `idleSkipBelowSec` | 10 | 空闲让路阈值秒 |

## 产出

状态目录（默认 `$DSH_HOME/dsh-group-lurker/`）：`groups/<chatId>/{insights.jsonl, llm-calls.jsonl, store.db}`、`reports/<chatId>/YYYY-MM-DD.md`（周报/日报分目录互不覆盖）、`audit.log`（仅元数据）、`cursor.json`、`outbox.jsonl`、`notify/ retention/ scheduler/`。

知识库（`~/WeChat/1数据/knowledge.db`）核心对象：五张事实表 `doc`（资料，`content_hash` 查重）、`entry`（随手记）、`report`（日报/周报/月报，draft → final）、`chat_digest`（**只存要点不存原文**，`source_key` 幂等）、`media`（媒体元数据，本体永不入库）；v0.6 增 `report_revision`（报告修订，不可变历史）与 `marking`（完成情况标记）两表，配 `v_report_revised` / `v_marking_latest` 视图。schema 迁移幂等（`user_version` 逐级升级），旧库自动升级不丢数据。

日报末尾自带成本统计行（模型 / token / 花费）：

```text
> 统计：批 1（失败 0）· 最大批耗时 0.0 s · 缓存命中 0 · LLM 调用 1 次 / 5.6 s · 模型 glm-5.3 · 输入 ~618 / 输出 ~178 tok · ≈¥0.0099
```

- token 拿不到真实 usage 时按 GLM 官方比例估算（**汉字 : token ≈ 1 : 1.6**），带 `~` 前缀与 `tokensEst: true` 标记；费用恒带 `≈`
- 调价不改代码：改 `llmPricing` 配置（见[智谱定价页](https://docs.bigmodel.cn/cn/guide/start/pricing)）
- 汇总：`node scripts/llm-cost.mjs`（`--month` / `--day` / `--chat` / `--state`）；细节见 [docs/RUNBOOK.md](docs/RUNBOOK.md) §7.11

## 安全模型：五条红线

任何一条被测试击穿即为 **P0 事故**，停止发版。完整基线、威胁模型与验收矩阵见 **[docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md)**。

| # | 红线 | 实现锚点 |
|---|---|---|
| **R1** | **受控单出口**：发送仅允许 `src/sender.ts` 一个模块、仅 filehelper 一个通道（代码级硬编码）。四道闸 = 总闸（`senderEnabled` 默认 `false` + `sendDryRun` 默认 `true`）、通道闸、交互闸（前台 + 用户空闲）、合规闸（**DB 回读验证**：发送后回读目标会话核验落库，穷尽重试未命中即判失败）；另有 `maxSendsPerDay` 频控、重试上限防风暴、审计只记元数据。**`sender.ts` 以外任何模块出现发送原语 = P0** | `src/sender.ts` + `no-send` 哨兵 |
| **R2** | **默认全拒**：白名单为空或未列出的群 → 零读取、零子进程调用；账号白名单同语义 | `src/source/wechat-db.ts` 构造闸门 + `gate()` |
| **R3** | **路径围栏**：所有 fs 写入必须落在 `stateDir` 内 | `assertInsideState()` + `src/store.ts` 唯一写入点 |
| **R4** | **注入隔离**：消息原文永远只是数据，不是指令 | `sanitize()` + 指令区/数据区分离 |
| **R5** | **密钥零接触**：不读取、不复制、不打印 `keys.json`，不写微信数据 | 子进程经外部 CLI，密钥自解析；解密经 stdin |

其它边界：不逆向微信通信协议、不修改微信客户端；UI 自动化发送仅走 R1 受控通道（键盘流程定位 + 发送，DB 回读兜底）。

## 知识库模板与本地数据

本仓库同时承载**独立的知识库模板** [`0数据格式/`](0数据格式/README.md)。**模板本身不录入任何数据——数据录入只发生在本机的 `1数据/`。**

| 位置 | 放什么 | git 归属 |
|---|---|---|
| `0数据格式/` | **纯模板**：schema、工具、文档。**不录入任何数据**——`.db` 只是本地生成物，不入库 | 随本仓库公开 ✓ |
| `1数据/`（仅本机） | **唯一的数据录入处**——schema 复用模板，真实数据只存本机 | **永不入库**（已 ignore；也不要对它 `git init`） |

规则（完整红线见 [`0数据格式/PRIVACY.md`](0数据格式/PRIVACY.md)）：真实 wxid、聊天记录、导出文件**只允许**出现在 `1数据/`；`chat_digest` 只存要点不存原文；外部写入遵守字段冻结 + `source_key` 幂等 + 单写者原则。
- **API 密钥零硬编码**：LLM 密钥只经 `apiKeyEnv` 环境变量引用，代码与配置中不允许出现任何字面密钥；CI `sensitive-scan` 同时拦截密钥模式与真实标识符因此**任何人 clone 本仓库都是安全的**——只有 schema、工具与文档，没有任何数据文件。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/README.md](docs/README.md) | **文档索引，从这里进** |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 安装 / 授权 / 白名单 / 审计 / 发送链路 / 排障 |
| [docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md) | 五条红线的总纲与验收矩阵 |
| [0数据格式/README.md](0数据格式/README.md) | 知识库模板：表关系图、工具用法 |
| [0数据格式/PRIVACY.md](0数据格式/PRIVACY.md) | 模板侧隐私红线与外部写入规约 |
| [docs/DESIGN-approval-marking.md](docs/DESIGN-approval-marking.md) / [docs/TECH-DESIGN-confirm-loop.md](docs/TECH-DESIGN-confirm-loop.md) | 审批标记与双通道确认闭环设计 |
| [docs/REF-prefixes.md](docs/REF-prefixes.md) | 编号前缀注册表（PLG-N 等，防多线命名冲突） |
| [SECURITY.md](SECURITY.md) / [CONTRIBUTING.md](CONTRIBUTING.md) / [AGENTS.md](AGENTS.md) | 漏洞上报 / 贡献规范 / agent 硬约束 |
| [CHANGELOG.md](CHANGELOG.md) / [docs/PROGRESS.md](docs/PROGRESS.md) | 版本变更 / 开发日志 |

> 历史：第一代 `im-connect` 路线的 vendor 副本已于 2026-10-13 删除（路线淘汰）；`vendor/` 现仅保留 `macos-wechat-export` 快照。

## 开发

```bash
npm install
npm run build   # tsc → lib/
npm test        # node --test，50 文件 / 440 例，全离线 mock
./scripts/check-sensitive.sh   # 提交前必跑，CI 会拦
```

> 测试导入**编译产物 `lib/`**，改完 `src/` 先 build 再 test。

## 免责声明

- 仅用于**读取你自己有权限访问的本地数据**，供**个人备份与研究**使用
- 请遵守微信用户协议与所在地法律；不得用于监控他人、抓取第三方数据或任何未经授权的场景
- 不包含破解通信协议、绕过鉴权或伪造登录态的能力；读取依赖本机已登录客户端与其本地库密钥
- 使用本工具产生的一切后果由使用者自行承担

## License

[MIT](LICENSE)
