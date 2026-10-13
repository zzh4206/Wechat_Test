# dsh-group-lurker（群聊水友引擎）

一个独立的 DeepSeek Harness（DSH）Cordis 插件：**只读旁听群聊，按群维护独立上下文与人格，提炼关键信息并生成日志。MVP 不发送任何消息。**

- 产品需求：[docs/PRD.md](docs/PRD.md)
- 技术设计：[docs/TECH-DESIGN.md](docs/TECH-DESIGN.md)
- 工作拆分（供分派编码 agent）：[docs/WORKBREAKDOWN.md](docs/WORKBREAKDOWN.md)

## 与 im-connect 的关系（重要约定）

本插件**叠加**在社区插件 [`@michengai/dsh-im-connect`](https://github.com/MichengAI/dsh-im-connect) 之上，把它当作只读消息源，**不 fork、不修改、不参与构建**：

- im-connect 的运行实例是 DSH profile（`~/.dsh/profiles/web`）里安装的那份，由它自己升级维护；
- 【已废弃 2026-10-13】vendor 约定随 im-connect 路线淘汰而失效，vendor/ 已删除。原约定（仅历史存档）：~~本仓库如需放置其源码，只允许放在 `vendor/dsh-im-connect/`，用途仅限只读参考~~：
  - 原项目采用 Apache-2.0，保留其 LICENSE 与版权声明，注明"只读参考副本，有改动一律不接受"；
  - `vendor/` 不安装依赖、不进构建路径、不出现在插件发布产物中；
  - 若将来必须改动 im-connect 才能拿到群消息，走 GitHub fork / 上游 PR，不在本地 vendor 上改。
- 本插件自身永远不持有任何消息发送通道（验收见 PRD §5 与 WP1 的 `no-send` 测试）。
- **（2026-10-11 转向）** 微信消息源改为本地库读取（wx-chatbot 路线），im-connect 解耦、补丁已回滚；新实施计划见 [docs/REPORT-wechat-db-plan.md](docs/REPORT-wechat-db-plan.md)。

## 运行前提

- **（2026-10-11 路线转向后）** 大号登录 macOS 微信客户端 + 完全磁盘访问授权；插件经本地库读取适配器获取白名单群消息（见 docs/REPORT-wechat-db-plan.md）。读取严格受控：白名单默认全拒、用户显式维护、读取行为留审计。
- DSH ≥ 0.2.0-rc.2；im-connect 仍安装在 profile 但与本项目解耦（原 WP0.5 补丁已回滚，patches/ 已删除）。
- 用户侧交互纯本地：在 DSH 会话中查看 `state/` 下的关键信息日志（insights.jsonl）与每日 Markdown 日报，群内零操作、群友无感。

## 仓库结构

```
docs/            PRD、技术设计、工作拆分、spike 报告
vendor/          【已删除 2026-10-13】第一代 im-connect 路线遗物，随路线淘汰清理
src/ …           插件源码（WP1 起逐步落地）
state/           本地运行数据（gitignore，绝不提交真实群数据）
```

## 状态

MVP「只观察」规划完成，即将进入开发。工作包 WP0–WP5 见 WORKBREAKDOWN；当前进度记录于下方。

| 日期 | 进展 |
|---|---|
| 2026-10-11 | 立项文档与仓库约定定稿（commit 8308dd4）；补充运行前提（账号/渠道）；vendor 副本就位 |
| 2026-10-11 | WP1 骨架完成并验收（e46be79）：guard/store/三组测试，tsc OK、9 pass 0 fail |
| 2026-10-11 | WP0 spike 完成并验收（a34a3f2）：**未 @ 群消息不可旁听**，且当前 im-connect 微信渠道仅支持私聊；产品方向修订为 B+A（PRD §8，1cff209） |
| 2026-10-11 | WP2 人格模块完成并验收（b4dbba9）：15 pass / 0 fail |
| 2026-10-11 | WP0.5 补丁完成并验收（55f657f），已应用到 web profile（回滚见 patches/README.md） |
| 2026-10-11 | 渠道战略定为微信优先（98b9efc）；可行性研究完成（cb95b94）：**官方 iLink 协议内微信读群现阶段无解**，附 ~1h 探测实验与 G0–G5 冻结预案 |
| 2026-10-11 | WP3 提炼管线完成并验收（f8257f6）：bus/buffer/distiller，38 pass / 0 fail，注入防护用例通过 |
| 2026-10-11 | WP4 日志落盘完成并验收（a602107）：insights.jsonl + 每日日报，43 pass / 0 fail。**MVP 代码全部就绪** |
| 2026-10-11 | 技术路线转向本地库读取（4d41134），实施计划定稿（22b99c9），补丁回滚/patches 删除；W1 生死步通过（727707c）：**结论 b，key 途径可行**（复用 macos-wechat-export 取钥） |
| 2026-10-12 | **小号彩排全链路打通**：sqlcipher 装机 → 二轮取钥 19/19 库验证（首轮因新账号时序失败，--db-root 限定小号后成功；keys.json 0600 本地保存）→ resolve/read 实测读出 Test 群消息（chatroom 1234567890）。大号全程零接触 |
| 2026-10-12 | W2 读取适配器完成并验收（362ee5b）：白名单硬闸门/审计/退避/单实例，50 pass / 0 fail |
| 2026-10-12 | W3 规范化+昵称解析完成并验收（df648b5）：映射链经 name2id 中转破解，Test 群冒烟昵称解析成功，58 pass / 0 fail |
| 2026-10-12 | W4 持久化游标完成并验收（2dcc988）：重启不重投不漏新，64 pass / 0 fail。**只剩 W5 端到端** |
| 2026-10-13 | M2 第一波完成并验收：T1.2/T2.2 引用链解析+落库接线+多级追溯（6e4fdfe，占位行满足外键、畸形 XML 降级）、T2.1/T2.4 关注名单+wxid 归一+跨群检索（a92a746，空名单 fail-closed）。合并态 116/116 全绿。剩 T2.3 人物增量摘要 |
| 2026-10-13 | **M3 报告引擎完成并验收**：三层金字塔 L1/L2/L3 + 断言重试降级（2ac23fe，144/144 绿）；outbox 发件箱最小版提前落地；scheduler onTick 接真报告；T2.3 遗留两点定夺实现（pid 反查在 digest 层、同日重跑=superseded 覆盖）。样例报告 PM 人工审读通过 |
| 2026-10-13 | **M2 人物追踪全部完成并验收**：T2.3 人物按天增量摘要+一页速览（e5aa014，schema v1→v2 只前不退、LLM 输出强校验降级占位、msg_id 不进 prompt、活跃度仅内部信号）。合并态 128/128 全绿、build 干净。M2 收官，下一步 M3 报告引擎 |
| 2026-10-13 | RUNBOOK 增补 §9 换机/重装不迁移 .wechat-local（b944ba8）；macos-wechat-export 移除上游 remote（转纯本地仓库） |
| 2026-10-13 | **M1 群数据空间与调度底座完成并验收（D2 开工）**：T1.1 每群 SQLite 数据桶+迁移（89c8f17）、T1.0 RUNBOOK 小号边界（ff9cf59）、T1.3/T1.4 调度器+通知通道 dry_run（0387851）、T1.5 掉线积压追赶补读（插件 a866aad + 工具 d5eda50 `--before-id`）。合并态 build 干净、92/92 测试绿、工具仓库 29/29。账号模型确认：大号只拉人入群，读取只走小号库 |
| 2026-10-13 | W5 管线合流完成并验收：source→`bus.ingest`→buffer→distiller→journal 端到端接通；修复 cordis 服务暴露（`ctx.provide`，Proxy 直赋抛错）与 CLI 子进程 cwd（keys.json 相对路径）；64 pass / 0 fail。本地 profile 观察模式运行（patch.yml 含机器路径不入库）。RUNBOOK 待补 |
