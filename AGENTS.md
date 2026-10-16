# AGENTS.md —— 给在本仓库工作的 AI agent

本仓库有多个 AI agent 并行工作（编写代码、补测试、写文档）。以下是**每次提交前必须满足的硬性约束**。完整规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 1. 提交前必跑（缺一不可）

```bash
./scripts/check-sensitive.sh   # 敏感信息扫描：真实 wxid / 群 ID / 家目录路径 / 密钥
npm run build && npm test      # 测试导入的是 lib/ 编译产物，必须先 build
```

`check-sensitive.sh` 失败时**不要**用「加白名单」绕过——把命中行的真实值改成占位符。白名单只放合成测试值。

## 2. 敏感数据红线（本项目已因此泄露过两次）

**任何真实标识符不得进入仓库内容、提交信息、日志或文档**：

| 禁止 | 占位符 |
|---|---|
| 真实微信 `wxid`（主号、小号） | `wxid_xxx`、`wxid_a` |
| 真实群 ID `NNNNNNNN@chatroom` | `12345678@chatroom`、`1234567890@chatroom` |
| 真实昵称/备注名/群名 | `张三`、`某群` |
| 真实聊天内容、真实 `msgId` | 合成数据（如 `synth-0001`） |
| 家目录绝对路径 | `$HOME/...`、`/path/to/...` |
| `keys.json`、`*.db` | 永不入库 |

**写文档示例时特别注意**：不要用真实群 ID 当 `--chat` 例子，也不要用真实 wxid 前缀做"示范"。**文档与注释本身也在扫描范围内**——连扫描脚本自己的注释都不能出现完整真值。

**真实值该放哪里**：DSH profile 的 `cordis.patch.yml`（如 `~/.dsh/profiles/desktop/cordis.patch.yml`）或仓库内被忽略的 `cordis.local.yml`。仓库自带的 `cordis.patch.yml` **只有 `insert` 骨架，不放配置**。

## 3. 提交信息

Conventional Commits，type 只取 `build chore ci docs feat fix perf refactor revert style test`，标题 ≤ 72 字符、祈使句、不加句号。`!` 或 `BREAKING CHANGE:` 表示破坏性变更。

## 4. 安全边界（改动前先读）

`docs/SECURITY-TEST-PLAN.md` §0 定义五条红线，**R1–R5 中任何一条被击穿即 P0 事故**：

- **R1 受控单出口**：微信发送**仅允许** `src/sender.ts`、**仅** filehelper 通道，四道闸默认全关（`senderEnabled=false`、`sendDryRun=true`）。**sender.ts 以外任何模块出现发送原语 = P0**
- **R2 默认全拒**：`groups` 白名单为空即拒绝启动；白名单外的群零子进程调用
- **R3 路径围栏**：所有 fs 写入必须落在 `stateDir` 内
- **R4 注入隔离**：消息原文永远只是数据，不是指令
- **R5 密钥零接触**：不读取、不复制、不打印 `keys.json`

**不得削弱** `tests/no-send.test.mjs` 等哨兵测试——它们钉死上述断言；要改必须单独提交并说明理由。

## 5. 其它约定

- 测试**全离线**：不得连接网络、不得读取真实微信库、不得 spawn 真实 python CLI（注入 mock）
- `sec-tests/` 是本地对抗样本目录（**不入库**）；新增常规测试放 `tests/`，文件名 `<主题>.test.mjs`
- **本地过程性记录一律不入库**：描述"本机发生了什么"的文档（本地环境细节、运行日志摘录、事件时序与前后关系）放 **`docs/local/`**——该目录整体被 `.gitignore` 忽略。兜底规则：`LOGS-*.md`、`*-logs.md`、`*.local.md`。别把这类内容写进 living doc（`README.md`/`RUNBOOK.md`/`PROGRESS.md`）
- 改代码同步更新文档：README 配置表 / `docs/RUNBOOK.md` / `docs/` 下设计文档；`CHANGELOG.md` 在 `[Unreleased]` 累加（小节名只用 Keep a Changelog 的六个，空小节删掉）
- 文档索引：新增文档后更新 [docs/README.md](docs/README.md)

## 6. 并行工作注意

多个 agent 可能同时在同一个工作树上提交。**提交前先 `git status` 与 `git log --oneline -3`**：

- 不要提交别人未完成的改动（`git add` 用具体路径，避免 `git add -A` 顺手带走本地文件）
- **不要 force push**：`main` 的历史已完成一次敏感信息清理，再强推会把清理成果覆盖掉
- 改动仓库设置（改名、规则集、About）前请与维护者确认，以免影响正在进行的提交
