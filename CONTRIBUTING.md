# 贡献指南

感谢你有兴趣改进本项目。这份文档写的是**本仓库实际执行的约定**——不是模板套话，每条都在 CI 或 review 中会被真正检查。

## 目录

- [敏感数据红线（先读这条）](#敏感数据红线先读这条)
- [开发环境](#开发环境)
- [提交信息](#提交信息)
- [分支与 PR](#分支与-pr)
- [测试要求](#测试要求)
- [文档要求](#文档要求)

## 敏感数据红线（先读这条）

本项目读取本地微信数据库。**任何真实标识符都不得进入仓库内容或提交信息**，包括：

| 禁止 | 用占位符代替 |
|---|---|
| 真实微信 `wxid`（主号、小号） | `wxid_xxx`、`wxid_a` |
| 真实群 ID `NNNNNNNN@chatroom` | `12345678@chatroom` |
| 真实昵称、备注名、群名 | `张三`、`测试群` |
| 真实聊天内容、真实消息 ID | 合成数据 |
| 家目录绝对路径 | `$HOME/...`、`/path/to/...` |
| `keys.json`、`*.db`、密钥 | 永不入库 |

**为什么这么严**：本仓库是公开仓库，且历史上真的发生过两次泄露（一次是 `src/index.ts` 里的 wxid、一次是 `docs/` 中的账号目录），两次都只能靠改写 git 历史来补救——代价是全部提交 SHA 改变。

**你要把真实值写在哪**：DSH profile 的 `cordis.patch.yml`（如 `~/.dsh/profiles/desktop/cordis.patch.yml`），或仓库内被忽略的 `cordis.local.yml`。仓库自带的 `cordis.patch.yml` 只放 `insert` 骨架，不放配置。

**自检**（提交前跑一次，CI 也会跑）：

```bash
./scripts/check-sensitive.sh
```

## 开发环境

```bash
npm install
npm run build   # tsc → lib/
npm test        # node --test，全离线 mock，不碰真实微信库
```

测试用例导入的是**编译产物 `lib/`**，所以改完 `src/` 必须先 `npm run build` 再 `npm test`，否则测的是旧代码。

## 提交信息

遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-CN/v1.0.0/)，type 只取这 11 个：

```
build chore ci docs feat fix perf refactor revert style test
```

- 描述用祈使句、不加句号，**标题 ≤ 72 字符**
- 破坏性变更用 `!`（如 `feat(api)!: …`）或在 footer 写 `BREAKING CHANGE: …`
- 正文写清 **what 与 why**，不写"怎么改的"（diff 自己会说）

```
feat(sender): 发送前用 wechat-ui open 精确定位目标会话

废除"文件传输助手须常驻前台"这一使用前提。侧栏 OCR 唯一命中才点击，
失败按 target_missing / env_unavailable / ui_tool_missing / tcc_denied
分类延迟处理，不计入失败重试次数。

Refs: docs/HANDOFF-sender-autotarget.md
```

## 分支与 PR

- 主分支 `main` 保持随时可发布；**直接向 `main` 推送仅限文档错字级别的修改**
- 分支命名 `<type>/<简短描述>`，type 与提交 type 同表，如 `fix/locate-gate-retry`、`docs/readme-config`
- 分支寿命尽量短（trunk-based：理想 ≤ 2 天），大改动拆成可独立合并的小 PR
- **合并方式为 squash**：PR 标题会被用作最终的提交信息，所以**标题必须符合上面的提交规范**
- PR 描述按 [.github/pull_request_template.md](.github/pull_request_template.md) 填写

## 测试要求

- 行为改动必须带测试；本仓库的测试全部离线（mock 微信 CLI），**不得依赖真实微信库或真实群**
- 修复 bug 的 PR 请先写一个能复现的失败测试，再修
- **不得削弱 `tests/no-send.test.mjs` 之类的哨兵测试**——它们钉死"读取路径不持有发送通道"的安全断言；要改必须单独开 PR 并在描述里说明为什么
- CI 必须全绿（`build-test` 与 `sensitive-scan` 两个检查）

## 文档要求

- 改代码时同步更新受影响的文档（`README.md` 的配置表、`docs/RUNBOOK.md` 的操作步骤、本仓库 `docs/` 下的设计文档）
- `CHANGELOG.md` 在 `[Unreleased]` 下累加，小节名只用 Keep a Changelog 的六个：`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`；**空小节删掉**
- 一次性过程文档（报告、调研）文件名带日期或主题前缀，长期文档用不带日期的全大写名（`PRD`、`TECH-DESIGN`、`RUNBOOK`）
- 文档索引见 [docs/README.md](docs/README.md)
