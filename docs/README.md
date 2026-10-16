# 文档索引

本目录存放 `dsh-group-lurker` 的设计、运维与过程文档。分四类（参考 [Diátaxis](https://diataxis.fr/) 的分类思路）：

- **教程 / 上手** —— 带你从零跑通一次
- **操作指南** —— 解决具体任务（安装、授权、排障、卸载）
- **参考** —— 准确描述机制与字段
- **解释** —— 背景、取舍与决策理由

> 约定：**长期文档**用不带日期的英文大写名（`PRD`、`TECH-DESIGN`、`RUNBOOK`），随代码演进持续更新；
> **一次性过程文档**带日期或主题前缀（`REPORT-*`、`ANALYSIS-*`、`PLAN-*`），完成后**归档保留、不删除**
> ——它们是决策的审计凭据。新增过程文档时请直接按前缀命名，无需再改本索引以外的地方。

## 教程 / 上手

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 项目定位、特性、前提条件、安装与配置参考（对外主入口） |

## 操作指南

| 文档 | 内容 |
|---|---|
| [RUNBOOK.md](RUNBOOK.md) | **运维主文档**：安装 / 授权 / 白名单 / 审计 / 卸载，以及本地配置值该放哪里 |
| [SECURITY-TEST-PLAN.md](SECURITY-TEST-PLAN.md) | **五条红线总纲**：安全基线、威胁模型、测试矩阵与缺口（安全验收的唯一依据） |

## 参考

| 文档 | 内容 |
|---|---|
| [PRD.md](PRD.md) | 产品需求：MVP「只观察」的范围与验收标准 |
| [TECH-DESIGN.md](TECH-DESIGN.md) | 技术设计：模块划分、数据流、状态目录结构 |
| [WORKBREAKDOWN.md](WORKBREAKDOWN.md) | 工作拆分（供分派编码 agent） |
| [dispatch-prompts.md](dispatch-prompts.md) | 分派指令模板（可直接粘贴给编码 agent） |
| [TECH-DESIGN-llm-overload-mitigation.md](TECH-DESIGN-llm-overload-mitigation.md) | LLM「消息过多 → 响应失败」的治理方案 |
| [REF-mac-wechat-report.md](REF-mac-wechat-report.md) | 参考资料：macOS 端微信群聊消息读取与自动应答 |

## 解释（背景与决策）

| 文档 | 内容 |
|---|---|
| [PROGRESS.md](PROGRESS.md) | 开发进度日志（按时间倒序，持续追加） |
| [REPORT-route-pivot.md](REPORT-route-pivot.md) | 路线调整：本地库读取 vs iLink Bot 的取舍 |
| [REPORT-wechat-group.md](REPORT-wechat-group.md) | 「能否自己实现读取微信群聊消息」的可行性报告 |
| [REPORT-wechat-db-plan.md](REPORT-wechat-db-plan.md) | 受监管读取的实施计划（wx-chatbot 路线） |
| [REPORT-db-access.md](REPORT-db-access.md) | 生死步验证：本机微信库可读性 |
| [REPORT-ax-tree-research.md](REPORT-ax-tree-research.md) | 微信 4.x mac「AX 树封闭」问题的误判复盘与调研 |
| [REPORT-ax-probe.md](REPORT-ax-probe.md) | AX 能力探针实证（WP-AX1 / 闸门 G1） |
| [PLAN-ax-targeting.md](PLAN-ax-targeting.md) | sender 定位升级（AX 侧栏定位）实施计划 |
| [HANDOFF-sender-autotarget.md](HANDOFF-sender-autotarget.md) | 交接简报：sender 自动定位发送 |
| [REPORT-sender-autotarget-research.md](REPORT-sender-autotarget-research.md) | sender 自动定位发送的广泛调研 |
| [ANALYSIS-2026-10-15-llm-report-timeout.md](ANALYSIS-2026-10-15-llm-report-timeout.md) | 事故分析：日报 LLM 调用超时导致降级 |
| [PLAN-llm-overload-tasks.md](PLAN-llm-overload-tasks.md) | LLM 消息过载治理的任务分解 |
| [SPIKE-bus.md](SPIKE-bus.md) | SPIKE：im-connect 入站消息与 Cordis 事件总线（WP0） |
| [handout-总结报告系统.md](handout-总结报告系统.md) | Handout：微信群聊总结报告系统 |
| [功能文档-微信群聊分析与提醒助手.md](功能文档-微信群聊分析与提醒助手.md) | 功能文档：分析与提醒助手 |
| [技术报告-mac端微信群聊读取与应答.md](技术报告-mac端微信群聊读取与应答.md) | 技术报告：mac 端群聊读取与应答 |
| [报告模板.md](报告模板.md) | 报告的统一模板 |

## 不入库的本地台账

以下文件**被 `.gitignore` 排除**，只存在于本地（含真实群名、审计细节与安全测试记录），**不要**试图提交，**也不要在其他文档里用链接指向它们**（会 404）：

- `SECURITY-REPORT-YYYY-MM-DD-NN.md` —— 安全检测报告（本地台账，`.gitignore` 规则 `SECURITY-REPORT-*.md`）
- `ERROR-REFERENCE.md` —— 报错定位手册（含本地环境细节）
- `sec-tests/` —— 安全专项对抗样本测试（对抗样本属攻击性知识，整体不入库，覆盖历史见 `SECURITY-TEST-PLAN.md` §7 台账）

> **约定（2026-10-17 起）**：凡记录**本机运行过程**的文档——本地环境细节、运行日志摘录、事件时序与前后关系——**一律不入库**。
> 新文件请直接放 **`docs/local/`**（该目录整体被 `.gitignore` 忽略，无需再加规则）；
> 放在别处的话，`LOGS-*.md`、`*-logs.md`、`*.local.md` 这三条兜底规则也会拦住它。
> 判断标准很简单：**这份文档描述的是"这台机器上发生了什么"，而不是"软件该怎么用"** → 它属于 `docs/local/`。
>
> 注意：`docs/SECURITY-TEST-PLAN.md` **不在此列**——它是公开契约，在仓库内。
> 忽略规则已从宽泛的 `SECURITY-*.md` 收窄为 `SECURITY-REPORT-*.md`，避免再把总纲一起排除。

> 如果你的真实运行配置（群白名单、机器路径、`selfWxid`）需要留档，请放在 **DSH profile 的 `cordis.patch.yml`**
> 或仓库内被忽略的 `cordis.local.yml`。**仓库自带的 `cordis.patch.yml` 只有 `insert` 骨架，不放配置**——
> 配置放进去会连同真实群 ID 一起被推到公开仓库（本仓库历史上正是这样泄露过一次）。

## 相关

- 给 AI agent 的硬性约束：[../AGENTS.md](../AGENTS.md)
- 贡献方式与提交规范：[../CONTRIBUTING.md](../CONTRIBUTING.md)
- 安全政策与漏洞上报：[../SECURITY.md](../SECURITY.md)
- 版本变更：[../CHANGELOG.md](../CHANGELOG.md)
