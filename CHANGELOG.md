# 更新日志

本文件记录本项目的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `sender` 发送前**定位闸**：keyboard 模式先 `wechat-ui open --chat` 精确锁定目标会话（侧栏 OCR 唯一命中才点击），免除"文件传输助手须常驻前台"这一使用前提；失败按 `target_missing` / `env_unavailable` / `ui_tool_missing` / `tcc_denied` 分类延迟处理并落审计（`result='locate_deferred'`），**不计入失败重试次数**
- 发送段改用 `wechat-ui deliver --chat`：定位打开 → 点焦点 → 合成 Cmd+V → OCR 复核草稿 → OCR 锚定"发送"按钮 → 轮询草稿清空（替代对微信 4.x 输入框无效的合成 Return）
- 仓库防线：`scripts/check-sensitive.sh` 与 CI `sensitive-scan` job，阻止真实 `wxid` / 群 ID / 家目录路径 / 密钥再次进入仓库
- 治理文件：`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`.github/` 工作流与模板、`.gitattributes`、`.editorconfig`、`docs/README.md` 文档索引

### Changed

- 文档与测试中的真实标识符一律替换为占位符（`wxid_xxx`、`12345678@chatroom`）
- golden 夹具改名并匿名化：`tests/fixtures/seg-golden/12345678@chatroom-2026-10-15.json`（保留 `ts` 与 `boundaries`，`msgId` 替换为合成值）
- `.gitignore` 补入本地运行配置（`cordis.local.yml`、`*.local.*`）、`.env` 与编辑器目录

### Security

- **清理已推送的公开历史**：历史提交中的真实 `wxid`（主号与小号）与群 ID 已用 `git filter-repo` 抹除，并强推覆盖。**注意：`v0.2.0` 之前历史的提交 SHA 已全部改变**，旧的 commit URL 不再可用

## [0.2.0] - 2026-10-16

### Added

- 每群独立人格与独立消息缓冲；按群覆盖人格（`groupPersonas`）
- 昵称解析：群消息自动映射 `wxid` → 群内显示名（备注名优先）
- 增量游标与去重窗口：重启不重投、不漏新；默认不回灌历史（`backfillOnStart`）
- 单实例锁（含 PID 已死时安全接管）
- 日报系统：金字塔 schema 归纳 + 证据溯源 + 降级链路
- 成本可观测：`groups/<chatId>/llm-calls.jsonl` 记录 `model / inTokens / outTokens / costCny / tokensEst`，报告尾输出统计行
- 两段式生成实验开关 `schemaTwoStage`（默认关闭）
- T1.5 积压追赶：单轮持续向前翻页直至读空，超上限时告警并建议人工 backfill
- 审计日志：仅记录元数据（时间、群、条数、成败），绝无消息内容

### Security

- 受监管读取三原则：白名单为空即 fail-closed；白名单外群在适配器层零子进程调用；读取行为全程审计
- `no-send` 静态哨兵测试：钉死读取路径不持有消息发送通道
- 解密密钥经 stdin 传入，不进入命令行参数

[Unreleased]: https://github.com/zzh4206/Wechat_Test/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zzh4206/Wechat_Test/releases/tag/v0.2.0
