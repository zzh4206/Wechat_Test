# @zzh4206/dsh-group-lurker

**简体中文** ｜ [English](README.en.md)

[![CI](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml/badge.svg)](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)

只读旁听微信群聊的 [DSH](https://github.com/deepseek-ai) Cordis 插件：**按群维护独立人格，提炼话题 / 人物 / 金句，产出结构化日志与 Markdown 日报。**

只支持 **macOS + 微信 4.x**（读取本地 SQLCipher 库）。

**[30 秒速览](#30-秒速览)** ｜ [快速开始](#快速开始) ｜ [配置](#配置参考) ｜ [产出](#你会得到什么) ｜ [安全模型](#安全模型五条红线) ｜ [知识库模板](#知识库模板与本地数据) ｜ [文档](#文档)

---

## 30 秒速览

| | |
|---|---|
| **做什么** | 读你**自己电脑上已登录**的微信本地库 → 按群提炼 → `insights.jsonl` + 每日 Markdown 日报 |
| **不做什么** | 不写微信数据、不动微信进程、不逆向通信协议、不读取密钥文件、默认不发消息 |
| **默认状态** | 白名单为空即**拒绝启动**（fail-closed）；发送四道闸默认全关 |
| **你需要** | macOS、微信 4.x、`sqlcipher`、取钥工具、DSH ≥ 0.2.0-rc.2 |
| **产出在哪** | `$DSH_HOME/dsh-group-lurker/`（见[产出](#你会得到什么)） |

## 设计原则

1. **默认全拒** —— `groups` 白名单为空即拒绝启动；白名单外的群在适配器层**零子进程调用**（有测试断言钉死）
2. **只读** —— 经只读子进程读取，永不写微信数据、永不动微信进程
3. **每群独立** —— 独立消息缓冲 + 独立人格（`personas/<name>.md`，可按群覆盖）
4. **全程可审计** —— `audit.log` 只记元数据（时间、群、条数、成败），**绝无消息内容**

## 前提条件

| 依赖 | 说明 |
|---|---|
| DSH ≥ `0.2.0-rc.2` | 宿主 |
| macOS 微信 4.x | 桌面客户端保持目标账号登录（读的是它的本地库） |
| `sqlcipher` | `brew install sqlcipher` |
| 取钥工具 | [macos-wechat-export](https://github.com/DaneelOlivaw1/macos-wechat-export)：只读复用其取钥与读取 CLI。克隆后先跑 `bootstrap_keys.py` 完成取钥，产物 `.wechat-local/keys.json`（`0600`） |

## 快速开始

**1 · 装依赖**

```bash
brew install sqlcipher
```

**2 · 取本地库密钥**（产物 `.wechat-local/keys.json`，权限应为 `0600`）

```bash
git clone https://github.com/DaneelOlivaw1/macos-wechat-export.git
cd macos-wechat-export && python3 bootstrap_keys.py
```

**3 · 装插件** —— 在 DSH profile 目录（如 `~/.dsh/profiles/desktop`）：

```bash
pnpm add --config.auto-install-peers=false file:/path/to/dsh-group-lurker
# 或直接从 git：
pnpm add --config.auto-install-peers=false git+https://github.com/zzh4206/Wechat_Test.git
```

**4 · 写配置，重启 DSH** —— 在 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: group-lurker
  name: "@zzh4206/dsh-group-lurker"
  config:
    groups:
      - "12345678@chatroom"          # 白名单：群 chatId（用取钥工具的 resolve <群名> 查）
    source: wechat-db
    sourceToolDir: /path/to/macos-wechat-export                        # 必填，无默认值
    sourceDbRoot: ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid_hash>/db_storage  # 必填，无默认值
    sourcePython: /opt/homebrew/bin/python3               # 建议绝对路径
```

重启 DSH（或等 patch 热加载）即生效。

> **`source` 的语义**：`none`（默认，不读取任何东西）／`wechat-db`（读本地库）。选后者必须显式配置 `sourceToolDir`、`sourceDbRoot`、`sourcePython` 三项——**没有隐式默认值，缺一项就启动失败**，这是刻意的。

## 配置参考

| 字段 | 默认 | 说明 |
|---|---|---|
| `groups` | `[]` | **白名单**。空 = 拒绝读取（fail-closed） |
| `source` | `none` | `none`（不读取）｜`wechat-db`（本地库读取） |
| `sourceToolDir` | —（必填） | 取钥工具目录 |
| `sourceDbRoot` | —（必填） | 微信 `db_storage` 绝对路径 |
| `sourcePython` | `python3` | python 解释器 |
| `pollIntervalSec` | `10` | 轮询间隔（秒） |
| `readLimit` | `50` | 每次读取条数 |
| `backfillOnStart` | `0` | 启动回灌条数（受监管原则：默认不回灌历史） |
| `bufferSize` | `60` | 每群环形缓冲 |
| `distillEveryMessages` | `25` | 每攒 N 条触发一次 LLM 提炼 |
| `distillIntervalMin` | `15` | 定时提炼间隔（分钟） |
| `retentionDays` | `90` | **消息留存天数**：`store.db` 中 `ts` 早于该天数的 messages 行滚动删除（`events`/`tasks`/`promises`/`files` 不受影响）。**数据最小化入口**——本地存的是真实聊天记录，不需要留 90 天就调小 |
| `persona` | `default` | 默认人格名 |
| `groupPersonas` | `{}` | 按群人格覆盖：`chatId → 人格名` |
| `stateDir` | `DSH_HOME/dsh-group-lurker` | 状态目录 |

## 你会得到什么

状态目录（默认 `$DSH_HOME/dsh-group-lurker/`）：

```text
├── audit.log                      读取审计：时间 / 群 / 条数 / 成败（无消息内容）
├── cursor.json                    增量游标：重启不重投、不漏新
├── groups/<chatId>/
│   ├── insights.jsonl             提炼结果（话题 / 人物 / 金句）
│   ├── llm-calls.jsonl            每次 LLM 调用的成本记录
│   └── store.db                   消息库（受 retentionDays 滚动清理）
├── reports/<chatId>/YYYY-MM-DD.md 每日日报（含尾部成本统计行）
├── outbox.jsonl                   出站队列：草稿与通知落这里，发送闸门默认全关 → 只入队不发出
├── notify/ retention/ scheduler/  通知审计 / 留存审计 / 调度状态
└── wechat-db.lock                 读取互斥锁
```

日报末尾自带成本统计行，模型、token、花费一目了然：

```text
> 统计：窗口 2026-10-16 至 2026-10-16，消息 2 条，话题 0 个，引用 2 条。
> 统计：批 1（失败 0）· 最大批耗时 0.0 s · 缓存命中 0 · LLM 调用 1 次 / 5.6 s · 模型 glm-5.3 · 输入 ~618 / 输出 ~178 tok · ≈¥0.0099
```

- **token 口径**：宿主回传 usage 时用真实值；拿不到 usage 时按 GLM 官方换算估算（**汉字 : token ≈ 1 : 1.6**），估算值带 `~` 前缀与 `tokensEst: true` 标记，可与真实值区分
- **费用口径**：`costCny = 输入/1M × input 价 + 输出/1M × output 价`，恒带 `≈`（价格表可能滞后于供应商调价）
- **调价不改代码**：改 `llmPricing` 配置即可（键 = 模型名，值 = 元/百万 token），默认值取自[智谱官方定价页](https://docs.bigmodel.cn/cn/guide/start/pricing)
- **费用汇总**：`node scripts/llm-cost.mjs`（默认本月；`--month` / `--day` / `--chat` / `--state` 过滤）
- 计费细节与两段式生成实验开关（`schemaTwoStage`）：[docs/RUNBOOK.md](docs/RUNBOOK.md) §7.11、[docs/TECH-DESIGN-llm-overload-mitigation.md](docs/TECH-DESIGN-llm-overload-mitigation.md)

## 安全模型：五条红线

任何一条被测试击穿即为 **P0 事故**，必须停止发版。完整基线、威胁模型与验收矩阵见 **[docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md)**。

| # | 红线 | 实现锚点 |
|---|---|---|
| **R1** | **受控单出口**：发送仅允许 `src/sender.ts` 一个模块、仅 filehelper 一个通道（代码级硬编码）。四道闸 = 总闸（`senderEnabled` 默认 `false` + `sendDryRun` 默认 `true`）、通道闸、交互闸（前台 + 用户空闲）、合规闸（OCR 核验当前会话）；另有频控与重试上限防风暴，审计只记元数据。**`sender.ts` 以外任何模块出现发送原语 = P0** | `src/sender.ts` + `no-send` 哨兵 |
| **R2** | **默认全拒**：白名单为空或未列出的群 → 零读取、零子进程调用 | `src/source/wechat-db.ts` 构造闸门 + `gate()` |
| **R3** | **路径围栏**：所有 fs 写入必须落在 `stateDir` 内 | `assertInsideState()` + `src/store.ts` 唯一写入点 |
| **R4** | **注入隔离**：消息原文永远只是数据，不是指令 | `sanitize()` + 指令区/数据区分离 |
| **R5** | **密钥零接触**：不读取、不复制、不打印 `keys.json`，不写微信数据 | 子进程经外部 CLI，密钥由工具自解析；解密经 stdin（不进命令行参数） |

其它边界：不逆向微信通信协议、不修改微信客户端；UI 自动化发送仅走 R1 的受控通道。

## 知识库模板与本地数据

本仓库同时承载一个**独立的知识库模板** [`0数据格式/`](0数据格式/README.md)：SQLite 三层结构（资料 `doc` + 日志 `report`/`entry` + 会话要点 `chat_digest`），配套三个工具——`make_template.py`（幂等生成模板）、`report_cli.py`（记录条目 / 生成日报周报月报 / 资料管理）、`export_md.py`（导出 Markdown 树）。**模板本身不录入任何数据**——数据录入只发生在本机的 `1数据/`。

**它存在的目的就是防泄漏**——模板与数据被物理隔离，录入行为只发生在 `1数据/`：

| 位置 | 放什么 | git 归属 |
|---|---|---|
| `0数据格式/` | **纯模板**：schema、工具、文档。**不录入任何数据**——`.db` 文件只是本地生成物，不入库 | 随本仓库公开 ✓ |
| `1数据/`（仅本机） | **唯一的数据录入处**——schema 复用模板，真实数据只存本机 | **永不入库**（已 ignore；也不要对它 `git init`） |

规则（完整红线见 [`0数据格式/PRIVACY.md`](0数据格式/PRIVACY.md)）：

- 真实 wxid、聊天记录、导出文件**只允许**出现在 `1数据/`，不得复制进仓库任何位置
- `chat_digest` 只存提炼后的**要点**，不存聊天原文；`source_key` 幂等去重
- 外部程序写入规约：字段名冻结、`PRAGMA foreign_keys = ON`、短事务、**单写者原则**
- 因此**任何人 clone 本仓库都是安全的**——仓库里只有 schema、工具与文档，没有任何数据文件

## 文档

| 文档 | 内容 |
|---|---|
| [docs/README.md](docs/README.md) | **文档索引，从这里进** |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 安装 / 授权 / 白名单 / 审计 / 卸载 / 排障 |
| [docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md) | 五条红线的总纲与验收矩阵 |
| [SECURITY.md](SECURITY.md) | 安全政策与漏洞上报 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献方式与提交规范 |
| [AGENTS.md](AGENTS.md) | 给本仓库 AI agent 的硬性约束（提交前必跑什么、不能碰什么） |
| [CHANGELOG.md](CHANGELOG.md) / [docs/PROGRESS.md](docs/PROGRESS.md) | 版本变更 / 开发进度日志 |

> 历史：第一代 `im-connect` 路线的 vendor 副本已于 2026-10-13 删除（路线淘汰）；`vendor/` 现仅保留 `macos-wechat-export` 的已提交快照（见 `vendor/VENDOR-NOTE.md`）。

## 开发

```bash
npm install
npm run build   # tsc → lib/
npm test        # node --test，379 例，全离线 mock，不碰真实库
```

> 测试导入的是**编译产物 `lib/`**，所以改完 `src/` 必须先 `npm run build` 再 `npm test`。

提交前**必须**先跑敏感信息扫描，否则 CI 会拦：

```bash
./scripts/check-sensitive.sh
```

## 免责声明

- 本工具仅用于**读取你自己有权限访问的本地数据**，供**个人备份与研究**使用
- 请遵守微信用户协议与所在地法律；不得用于监控他人、抓取第三方数据或任何未经授权的场景
- 本工具**不包含**破解通信协议、绕过鉴权或伪造登录态的能力；读取依赖你本机已登录的客户端与本地库密钥
- 使用本工具产生的一切后果由使用者自行承担

## License

[MIT](LICENSE)
