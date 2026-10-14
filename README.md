# @zzh4206/dsh-group-lurker

一个独立可复用的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) Cordis 插件：**只读旁听微信群聊，按群维护独立上下文与人格，提炼关键信息并生成日志。不发送任何消息。**

> 仅支持 macOS 微信 4.x（本地 SQLCipher 库读取路线）。MVP 阶段只观察、零发送。

## 特性

- **只读**：经只读子进程读取微信本地库，永不写微信数据、永不动微信进程；静态 `no-send` 测试哨兵钉死"零发送通道"
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

## 安全模型（红线）

- 插件不持有任何消息发送通道（发送类调用黑名单静态测试）
- 取钥产物 `keys.json` 只存在于工具目录（0600），本插件不复制、不打印、不提交；解密经 stdin 传钥（不进命令行参数）
- 不逆向微信协议；不修改微信客户端；UI 自动化发送属二期，另行评估
- 白名单外群：适配器第一行闸门拒绝，零子进程调用

## 开发

```bash
npm install
npm run build   # tsc → lib/
npm test        # node --test（64 例，全离线 mock，不碰真实库）
```

- 项目文档（PRD/技术设计/工作拆分/spike 报告）：[docs/](docs/)
- 历史：第一代 im-connect 路线的 vendor 参考副本已于 2026-10-13 删除（路线淘汰）
- 开发进度日志：[docs/PROGRESS.md](docs/PROGRESS.md)

## License

[MIT](LICENSE)
