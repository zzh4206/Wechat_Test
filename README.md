# dsh-group-lurker（群聊水友引擎）

一个独立的 DeepSeek Harness（DSH）Cordis 插件：**只读旁听群聊，按群维护独立上下文与人格，提炼关键信息并生成日志。MVP 不发送任何消息。**

- 产品需求：[docs/PRD.md](docs/PRD.md)
- 技术设计：[docs/TECH-DESIGN.md](docs/TECH-DESIGN.md)
- 工作拆分（供分派编码 agent）：[docs/WORKBREAKDOWN.md](docs/WORKBREAKDOWN.md)

## 与 im-connect 的关系（重要约定）

本插件**叠加**在社区插件 [`@michengai/dsh-im-connect`](https://github.com/MichengAI/dsh-im-connect) 之上，把它当作只读消息源，**不 fork、不修改、不参与构建**：

- im-connect 的运行实例是 DSH profile（`~/.dsh/profiles/web`）里安装的那份，由它自己升级维护；
- 本仓库如需放置其源码，只允许放在 `vendor/dsh-im-connect/`，用途**仅限只读参考**（供编码 agent 阅读事件接口）：
  - 原项目采用 Apache-2.0，保留其 LICENSE 与版权声明，注明"只读参考副本，有改动一律不接受"；
  - `vendor/` 不安装依赖、不进构建路径、不出现在插件发布产物中；
  - 若将来必须改动 im-connect 才能拿到群消息，走 GitHub fork / 上游 PR，不在本地 vendor 上改。
- 本插件自身永远不持有任何消息发送通道（验收见 PRD §5 与 WP1 的 `no-send` 测试）。

## 运行前提

- DSH ≥ 0.2.0-rc.2，profile（如 `~/.dsh/profiles/web`）中已安装并登录 `@michengai/dsh-im-connect`；
- im-connect 登录的账号必须在目标群里（微信用独立小号静默挂机，MVP 永不发言；联调建议先用 QQ/钉钉官方机器人渠道）；
- 用户侧交互纯本地：在 DSH 会话中查看 `state/` 下的关键信息日志（insights.jsonl）与每日 Markdown 日报，群内零操作、群友无感。

## 仓库结构

```
docs/            PRD、技术设计、工作拆分、spike 报告
vendor/          只读参考副本（见上，暂未放置）
src/ …           插件源码（WP1 起逐步落地）
state/           本地运行数据（gitignore，绝不提交真实群数据）
```

## 状态

MVP「只观察」规划完成，即将进入开发。工作包 WP0–WP5 见 WORKBREAKDOWN；当前进度记录于下方。

| 日期 | 进展 |
|---|---|
| 2026-10-11 | 立项文档与仓库约定定稿（commit 8308dd4）；补充运行前提（账号/渠道）；WP0 待分派 |
