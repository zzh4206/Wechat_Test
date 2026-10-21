# 参考：编号前缀注册表（REF-prefixes）

> 目的：多 agent/多文档并行时代，**新增编号前缀先查本表再启用**，避免语义冲突
> （2026-10-20 事故：前端分期 P0/P1/P2 与事故严重级别 P0/P1/P2 三重撞车 → 规范化为 FE-N 并建本表）。
> 规则：新前缀在本表「已占用」登记后才可使用；**单字母前缀原则上不再新批**（存量沿用）。

## 已占用

| 前缀 | 语义 | 归属/出处 |
|---|---|---|
| P0/P1/P2 | 事故/缺陷严重级别（**保留专用**，不再作他用） | 安全报告系列、验收审核 |
| R1–R5 | 五条安全红线 | SECURITY-TEST-PLAN §0 |
| Q1–Q5 | 前端设计待决问题 | [TECH-DESIGN-frontend](TECH-DESIGN-frontend.md) §11 |
| T1–T8 | 模板侧落点（0数据格式 协同项） | REQUIREMENT-v0.6 §8 |
| PLG-1–3 | 插件侧职责（v0.6 追溯矩阵；原 P1–P3 规范化） | REQUIREMENT-v0.6 §8 |
| C1–C3 | 审批闭环实施分期 | TECH-DESIGN-confirm-loop §6 |
| M1–M3 | 审批标记实施分期 | DESIGN-approval-marking §8 |
| FE-1–3 | 前端工作台实施分期（原 P0–P2 规范化；**已分配给前端会话**） | [TECH-DESIGN-frontend](TECH-DESIGN-frontend.md) §1 / §9 |
| G1–G4 | 知识库接入缺口编号；G1 亦为 AX 能力闸门（语境区分） | 缺口分析报告 / AX 探针报告 |
| E1/E2 | LLM 治理证据分级 | TECH-DESIGN-llm-overload-mitigation |
| F1–F8 | 产品功能编号 | 功能文档 |
| L1/L2/L3 | 报告三层结构 | 报告模板 |
| M5/M6(-T*) | 里程碑与任务 | WORKBREAKDOWN |
| WP-* | 工作包 | WORKBREAKDOWN |
| ERR-* | 错误定位编号（本地台账） | ERROR-REFERENCE（本地） |
| v0.x | schema/设计版本号 | 0数据格式 |

## 空闲（可申请，先登记后使用）

- 双字母：WEB、TPL、APP、SRV、CFG、DIG 等
- 单字母：H I J K N O S V X Y Z（原则上不再新批）
