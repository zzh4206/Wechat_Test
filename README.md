# @zzh4206/dsh-group-lurker

一个独立可复用的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) Cordis 插件：**只读旁听微信群聊，按群维护独立上下文与人格，提炼关键信息并生成日志。**

> 仅支持 macOS 微信 4.x（本地 SQLCipher 库读取路线）。
> **默认零读取、零发送**：白名单为空即拒绝启动；发送能力为「受控单出口」，默认关闭（详见[安全模型](#安全模型红线)）。

## 特性

- **只读为默认**：经只读子进程读取微信本地库，永不写微信数据、永不动微信进程；`no-send` 静态哨兵扫描源码与编译产物，钉死"发送原语只允许出现在 `src/sender.ts`"
- **受监管读取（管控三原则）**：
  1. 默认全拒——`groups` 白名单为空即拒绝启动读取（fail-closed）
  2. 白名单外的群在适配器层零子进程调用（测试断言）
  3. 读取行为全程审计（`audit.log` 仅记元数据：时间、群、条数、成败，绝无消息内容）
- **每群独立**：独立消息缓冲、独立人格（`personas/<name>.md`，可按群覆盖）
- **昵称解析**：群消息自动映射 wxid → 群内显示名（备注名优先）
- **增量游标**：持久化去重窗口，重启不重投、不漏新；默认不回灌历史
- **日志产出**：`insights.jsonl`（话题摘要/人物/金句）+ 每日 Markdown 日报

## 前提条件

| 依赖 | 说明 |
|---|---|
| DSH ≥ 0.2.0-rc.2 | 宿主 |
| macOS 微信 4.x | 桌面客户端保持目标账号登录（读取其本地库） |
| sqlcipher | `brew install sqlcipher` |
| [macos-wechat-export](https://github.com/DaneelOlivaw1/macos-wechat-export) | 只读复用其取钥与读取 CLI；克隆后先跑 `bootstrap_keys.py` 完成取钥（产物 `.wechat-local/keys.json`，0600） |

## 安装

在 DSH profile 目录（如 `~/.dsh/profiles/desktop`）：

```bash
pnpm add --config.auto-install-peers=false file:/path/to/dsh-group-lurker
# 或从 git：
pnpm add --config.auto-install-peers=false git+https://github.com/zzh4206/Wechat_Test.git
```

然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: group-lurker
  name: "@zzh4206/dsh-group-lurker"
  config:
    groups:
      - "12345678@chatroom"   # 白名单：群 chatId（用工具的 resolve <群名> 查）
    source: wechat-db
    sourceToolDir: /path/to/macos-wechat-export   # 必填，无默认值
    sourceDbRoot: ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid_hash>/db_storage  # 必填，无默认值
    sourcePython: /opt/homebrew/bin/python3.14    # 建议绝对路径
```

重启 DSH（或等 patch 热加载）即生效。插件状态目录默认 `DSH_HOME/dsh-group-lurker/`。

## 配置参考

| 字段 | 默认 | 说明 |
|---|---|---|
| `groups` | `[]` | **白名单**。空 = 拒绝读取（fail-closed） |
| `source` | `none` | `none`（不读取）\| `wechat-db`（本地库读取）。选后者必须显式配置下列三项 |
| `sourceToolDir` | —（必填） | macos-wechat-export 工具目录 |
| `sourceDbRoot` | —（必填） | 微信 `db_storage` 绝对路径 |
| `sourcePython` | `python3` | python 解释器 |
| `pollIntervalSec` | `10` | 轮询间隔（秒） |
| `readLimit` | `50` | 每次读取条数 |
| `backfillOnStart` | `0` | 启动回灌条数（受监管原则：默认不回灌） |
| `bufferSize` | `60` | 每群环形缓冲 |
| `distillEveryMessages` | `25` | 每攒 N 条触发一次 LLM 提炼 |
| `distillIntervalMin` | `15` | 定时提炼间隔（分钟） |
| `persona` | `default` | 默认人格名 |
| `groupPersonas` | `{}` | 按群人格覆盖：chatId → 人格名 |
| `stateDir` | `DSH_HOME/dsh-group-lurker` | 状态目录 |

状态目录内容：`insights.jsonl`（提炼结果）、`report-YYYY-MM-DD.md`（日报）、`audit.log`（读取审计）、`cursor.json`（增量游标）、`personas/`（人格）。

## 成本可观测（T9）

每份报告的末尾统计行写明本次生成用了什么模型、花了多少 token、多少钱：

```
> 统计：批 2（失败 0）· 最大批耗时 31.4 s · 缓存命中 0 · LLM 调用 3 次 / 45.2 s · 模型 glm-5.3 · 输入 ~12.3k / 输出 ~4.5k tok · ≈¥0.0223
```

- **数据来源**：每次 `llm.complete` 落一行结构化 JSON 到 `groups/<chatId>/llm-calls.jsonl`（含 `model / inTokens / outTokens / costCny / tokensEst` 五个成本字段）；报告尾统计行 = 当次生成的累计。
- **token 计量口径**：宿主 LLM 回传 usage 时用真实值（此时统计行不带 `~`）；当前生产路径（complete/chat → stream → openai 兼容 fetch）只回传纯文本、拿不到 usage，因此默认按智谱官方换算估算——**GLM token : 汉字 ≈ 1 : 1.6，即 tokens ≈ 字符数 ÷ 1.6**。估算值一律带 `tokensEst: true` 标记、统计行带 `~`，与真实值可区分。
- **费用口径**：`costCny = 输入 tokens/1M × input 价 + 输出 tokens/1M × output 价`，保留 4 位小数（日级费用常在分厘级）；费用恒带 `≈`（价格表可能滞后于供应商调价）。未知模型费用记 0 并 warn 提示一次"未配置价格"。
- **价格表配置 `llmPricing`**（键 = 模型名，值 = 元/百万 tokens；**调价只改配置，不动代码**）：

```yaml
llmPricing:
  glm-5.3: { input: 8, output: 28 }        # 智谱官方定价页 2026-10 抓取
  glm-5.3-flash: { input: 0.8, output: 2.8 }
```

默认值即上表；**以供应商页面为准**：[智谱官方定价页](https://docs.bigmodel.cn/cn/guide/start/pricing)。模型名取自 `llmModel` 配置（空 = `glm-5.3`）。

### 两段式生成实验开关（T8 `schemaTwoStage`）

报告生成的每次 LLM 调用默认是"一步出 JSON"——金字塔 schema + 字段断言属强格式约束。实验依据（EMNLP 2024 Industry《Let Me Speak Freely?》）：格式约束越严，模型推理性能下降越大。开关打开后（默认 `false` = 零变化），report 生成路径（map 批 / merge 合并 / refine 段）的每次调用拆两步：第一步输出**无 schema 约束的自由文本归纳**（保留消息序号 n 供溯源），第二步独立调用把自由文本**格式化为既有 schema**（小输入、无超时风险），再走既有断言与降级链路。两步都进 `llm-calls.jsonl` 与报告尾统计行（phase 沿用原值），成本天然可见——**如何对比观察**：同一窗口分别在 `schemaTwoStage: false / true` 下生成（或结合 `reportPipeline: 'ab'` 双跑），对照报告尾"LLM 调用次数/费用"行与归纳质量（连贯性、evidence 溯源命中率）人工评审；开关仅作用于 report，distiller 不受影响。

## 安全模型（红线）

五条红线，任何一条被测试击穿即为 **P0 事故**、必须停止发版。完整基线、威胁模型与验收矩阵见 **[docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md)**。

| # | 红线 | 实现锚点 |
|---|---|---|
| **R1** | **受控单出口**：微信发送仅允许 `src/sender.ts` 一个模块、仅 filehelper 一个通道（`ALLOWED_CHANNELS` 代码级硬编码）；四道闸 = 总闸 `senderEnabled`（默认 `false`）+ `sendDryRun`（默认 `true`）+ 通道闸 + 交互闸（前台 + 用户空闲）+ 合规闸（OCR 核验当前会话）；另有频控 `maxSendsPerDay`、重试 ≤3 防风暴、审计只记元数据。**sender.ts 以外任何模块出现发送原语 = P0** | `src/sender.ts` + `no-send` 哨兵 |
| **R2** | **默认全拒**：白名单为空或未列出的群 → 零读取、零子进程调用 | `src/source/wechat-db.ts` 构造闸门 + `gate()` |
| **R3** | **路径围栏**：所有 fs 写入必须落在 `stateDir` 内 | `src/guard.ts` `assertInsideState()` + `src/store.ts` 唯一写入点 |
| **R4** | **注入隔离**：消息原文永远只是数据，不是指令 | `src/guard.ts` `sanitize()` + distiller 指令区/数据区分离 |
| **R5** | **密钥零接触**：不读取、不复制、不打印 `keys.json`，不写微信数据 | 子进程经外部 CLI，密钥由工具自解析；解密经 stdin（不进命令行参数） |

其它边界：不逆向微信通信协议；不修改微信客户端；UI 自动化发送仅走上面 R1 的受控通道。

## 开发

```bash
npm install
npm run build   # tsc → lib/
npm test        # node --test，379 例，全离线 mock，不碰真实库
```

> 测试导入的是**编译产物 `lib/`**，所以改完 `src/` 必须先 `npm run build` 再 `npm test`。

- **文档索引（从这里进）**：[docs/README.md](docs/README.md)
- 安装 / 授权 / 白名单 / 审计 / 卸载：[docs/RUNBOOK.md](docs/RUNBOOK.md)
- 安全政策与漏洞上报：[SECURITY.md](SECURITY.md)
- 贡献方式与提交规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- 版本变更：[CHANGELOG.md](CHANGELOG.md)
- 开发进度日志：[docs/PROGRESS.md](docs/PROGRESS.md)
- 历史：第一代 im-connect 路线的 vendor 参考副本已于 2026-10-13 删除（路线淘汰）

## License

[MIT](LICENSE)
