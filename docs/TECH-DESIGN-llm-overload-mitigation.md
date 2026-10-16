# 技术文档：群聊 LLM 归纳「消息过多 → 响应失败」治理方案

- 关联事故：`docs/ANALYSIS-2026-10-15-llm-report-timeout.md`（585 群 181 条消息日报超时降级）
- 涉及代码库：`$HOME/WeChat/2水群`
- 版本：v2（基于两轮调研重写——每项决策附直接依据，并记录两处被证据修正的预设）
- 状态：方案定稿，待排期
- 负责：LLM 部分负责人

---

## 0. 写作说明与证据等级

本版把"决策"与"依据"写在一起。每条决策标注依据等级：
- **E1 实证研究**（有实验数据的论文/人工标注对比）
- **E2 权威工程实践**（模型厂商官方 / AWS Builders' Library 级别）
- **E3 行业事实标准**（主流框架的定性共识）

两处预设在调研中被证据**修正**，已如实记录（§3.2 质量注记、§6 风险表），不隐瞒不利证据。

## 1. 问题定义

日报/周报/月报与 distiller 实时提炼都要把消息原文送进 LLM。窗口消息数 N 增长时：
- 单次调用输入 token ≈ N × 平均消息长度，总时长随 N 线性上升，超过宿主 dsh-llm 超时 → `finish reason = timeout` → 整次失败；
- 现有重试为同 payload 原样重试，成功率 ~0（依据 E2：Marc Brooker, [AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)——容量型故障须改变参数重试）；
- **即使不超时**，大输入的中段信息利用率也显著塌陷（依据 E1：[Lost in the Middle, TACL 2024, Stanford](https://aclanthology.org/2024.tacl-1.9/)）——大批不仅易超时，还漏召回。

目标：**任意消息量下报告不缺、不静默；失败面收敛到单批且可自愈、可观测；归纳质量不随消息量增长而退化。**

## 2. 总体架构：三层防线

```
                ┌─────────────────────────────────────────┐
 L0 预防层      │ 输入规模治理：分段调用，单批 ≤ safeBatch   │
                │   safeBatch 自适应：由批次成功率/耗时反馈    │
                ├─────────────────────────────────────────┤
 L1 容错层      │ 方案A map-reduce ∥ 方案B 滚动流水线        │
                │   错误分类重试（timeout→对半切分）+ 退避     │
                │   单批降级 → partialNote；全批失败 → 骨架    │
                ├─────────────────────────────────────────┤
 L2 兜底层      │ 无 LLM 骨架报告（已有）+ 检查点缓存：        │
                │   批摘要落盘，断点续跑、不重复计费           │
                └─────────────────────────────────────────┘
```

架构选型依据（E3）：[LangChain CombineDocuments](https://langchain-doc.readthedocs.io/en/latest/_sources/modules/indexes/combine_docs.md) 将长输入处理归纳为 Stuff / Map-Reduce / Refine / Map-Rerank 四范式。事发旧逻辑 = Stuff（官方明示大输入必失效）；方案 A = Map-Reduce；方案 B = Refine。Map-Rerank 不适用（无法跨段合成）。

## 3. 方案 A：固定切批 map-reduce（保底，已有雏形）

### 3.1 输入规模治理（L0 核心）

**批大小估算式**（进 `report.ts` 常量区，可配置覆盖）：

```
safeBatch = clamp( (inputBudget − instructionTokens) / avgTokensPerMsg , 20, 120 )
inputBudget   默认 24k tokens，以 P1 实测 durMs 反推标定（§7 观测）
avgTokensPerMsg 中文群聊实测 ≈ 30–60 tokens/条
```

- **依据（E1）**：Lost in the Middle——性能随输入长度单调下降、中段塌陷。小批上限不是只为防超时，是防中段消息漏召回；120 为上限而非目标值。
- **Prompt 布局依据（E1）**：同文——首尾位置利用率最高 → 指令区置最前、数据区在后（现有两段式结构正确，保持）。
- **接线要求**：`src/index.ts` Config schema 增加 `batchThreshold?: number`（0=自动估算），装配 ReportService 时透传。此为事故遗留缺口 G1。

### 3.2 自适应批大小（第二版，可后置）

为每个 `(chatId, kind)` 维护滑动指标 `{成功率, 平均批耗时, 平均输入条数}`：
- 批超时 → `safeBatch ×= 0.7`（下限 20），该批以新批大小重切，不计入重试次数；
- 连续 5 批成功且耗时 < 预算 50% → `safeBatch ×= 1.2`（上限 120）；
- 指标持久化进 groups store，跨重启保留。

### 3.3 错误分类重试（修事故根因之一）

- **timeout 类** → 不原样重试，**对半切分该批**（分治），叶子批（<5 条）仍失败按宿主故障处理走退避+兜底，避免无限切分。依据（E2）：Brooker——容量型故障的有效重试必须改变参数（缩小请求），对半切分正是"改变参数的重试"。
- **断言/解析失败类** → 保持"重试一次"。
- 判别来源：dsh-llm finish reason 透传（`distiller.ts:181` 已有 `c.reason.kind`）。
- **批间退避**：连续超时时批间 sleep 2s 起、指数增长至 30s 封顶，**加随机抖动**。依据（E2）：同文，防重试风暴与同步拥塞。

### 3.4 合并调用保护

合并输入是各批摘要（非原文），天然小；但月报等批数 >30 时合并 prompt 自身会过大 → **树形两级合并**。依据（E1 衍生）：Stanford Hashimoto 组 [RAPTOR](https://arxiv.org/abs/2401.18059) 证明递归"聚类→摘要"树可无损层级压缩，两级合并是其两层特例。

## 4. 方案 B：节奏分段 + 滚动记忆流水线（日报候选）

### 4.1 分段：burst 切分 + 冗余带（不追求切准，追求切错无害）

- **切点**：滑动窗口（如 10 分钟）统计消息速率，速率局部低谷设候选切点；段长钳制在 [20, safeBatch] 条。依据（E1）：[Kleinberg, Bursty and Hierarchical Structure in Streams（KDD 2002）](https://dl.acm.org/doi/pdf/10.1145/775047.775061)——消息流突发结构的奠基模型，"集中讨论形成消息峰"正是其建模对象；我们的速率切分是其工程简化版。
- **重叠带**：相邻段保留 5–10 条重叠，出稿阶段按 `msg_id` 去重——重要消息（老师发作业的小峰）即使被切断，两段各有完整上下文；
- **关联边保护**：引用/@回复对之间禁切（消息数据已含引用字段，零成本）；
- 实现为 `report.ts` 纯函数 `splitByRate(messages, opts)`，单测覆盖切点/钳制/重叠带/引用边。

### 4.2 滚动记忆：串行 refine 流水线

```
seg₁ → AI₁ → (摘要S₁, 状态σ₁：人物/悬置问题/任务/承诺)
seg₂(+重叠带+σ₁) → AI₂ → (S₂, σ₂)
… → 末段 AI 以 σₙ₋₁ + Sₙ 产出最终金字塔 schema → 既有断言/降级链路
```

- 状态 σ 为固定 JSON schema，每段输出过校验，失败重试该段——防中间段失败污染后续状态；
- σ 同时**持久化为群级长期记忆**（跨窗口延续"本群在备赛/备考"等背景，出稿时注入）。依据（E1）：[MemGPT（arXiv 2310.08560，UC Berkeley Stoica/Gonzalez 团队）](https://ar5iv.labs.arxiv.org/html/2310.08560)——"核心状态 + 溢出摘要 + 外部存储"的虚拟上下文范式，σ 即其核心内存页。

### 4.3 A/B 取舍——被实证修正的预设（重要）

原预设"B 质量更优"**被证据修正**。[BooookScore（Chang/Lo/Goyal/Iyyer, ICLR 2024）](https://arxiv.org/abs/2310.00785)是唯一对两种工作流做过系统人工对比的研究（1193 条细粒度标注，100 本书，GPT-4）：

> **增量滚动更新（=B）细节更丰富但连贯性得分更低；层级合并（=A）连贯性更高**——标注者对该取舍偏好不一。

因此决策改为：
- **A 为保底默认**（P0 落地，连贯性有保证、可并行、失败面小）；
- **B 以灰度实验引入**：同一真实窗口 A/B 双跑，人工评审（连贯性/细节召回/任务识别三维度），数据定夺，不预设赢家；
- 分工底线不变：distiller 实时提炼永远用并行小批（延迟敏感，B 的串行延迟不可接受）。

### 4.4 切分质量评测与"训模型"升级阶梯

- **golden set**：人工切分 10–20 个真实窗口，只做评测集不做训练集（训练需千级切点标注，差两个数量级）；
- **度量（E1）**：[WindowDiff（Pevzner & Hearst, Computational Linguistics 2002）](https://dlnext.acm.org/doi/abs/10.1162/089120102317341756)——文本切分标准指标，对"切点差一两条"部分惩罚，与重叠带容错语义一致；
- **升级阶梯**：速率切分 WindowDiff 不达标 → 先试 embedding 相似度切分（无标注，RAG 领域成熟做法，参考 [语义切分实践](https://learn.microsoft.com/en-us/training/modules/aaai-implement-advanced-rag-azure-ai-search/5-optimize-chunk-embed-strategies)）→ 仍不行才用切分日志训监督小模型。**暂不训模型**的学理依据（E1）：无监督信号切分自 [TextTiling（Hearst, 1997）](https://acm-stag.literatumonline.com/doi/10.5555/972684.972687)起即是强基线，监督方法仅在大标注量下有增量。
- 任务可行性先例（E1）：[QMSum（NAACL 2021）](https://preview.aclanthology.org/update-css-js/2021.naacl-main.472.pdf)确立"长对话→结构化摘要"的标准化基准范式。

## 5. 成本与缓存

- **Prompt cache 固定前缀**（E2：[Claude Cookbook 成本优化](https://platform.claude.com/cookbook/cost-optimization-cost-optimization)）：指令区（人格+schema+约束）对所有批次逐字节一致、置于 prompt 最前，数据区在后——多批调用命中前缀缓存，降本提速。批间禁改指令区任何字符。该要求与 §3.1 的位置布局（E1）恰好同向。
- **检查点缓存**：键 `report-ckpt:{chatId}:{kind}:{win.start}:{win.dateKey}:{batchIndex}`，值=批摘要 JSON，存 groups store；生成前先查，命中跳过调用；窗口成功后随 retention 清理（+7 天）。依据（E2）：生产级批处理共识——幂等单元 + 检查点续跑；故从原 P1 提前至 P0 交付。

## 6. 风险表（含对我们现有设计的反向证据）

| 风险 | 依据 | 缓解 |
|---|---|---|
| **严格 JSON schema 断言可能压低归纳质量** | （E1，反向证据）[Let Me Speak Freely?（Tam et al., EMNLP 2024 Industry，台大李宏毅/陈缊侬组）](https://aclanthology.org/2024.emnlp-industry.91/)：格式约束越严，推理性能下降越大；我们的金字塔 schema + 字段长度断言属强约束 | P2 备选两段式生成：先自由文本归纳、再独立调用格式化为 schema（格式化步输入小、无超时风险）；是否启用以灰度数据定 |
| 宿主超时阈值未知且可能变动 | — | 以 P1 实测 durMs 反推标定 inputBudget，不拍脑拍 |
| 极小批（<5 条）仍超时 | — | 按宿主故障处理：退避 + 骨架兜底，禁止无限切分 |
| 检查点与窗口定义耦合（backfill 改变起点） | — | 键纳入 `win.start` |
| B 方案中间段失败污染后续状态 | — | 每段 σ 过 schema 校验，失败重试该段（§4.2） |

## 7. 可观测性

每次 `llm.complete` 记录结构化日志（进 store）：

```json
{"ev":"llm_call","chat":"...","kind":"daily","phase":"map|merge","batch":2,"msgs":118,
 "promptChars":45230,"durMs":58231,"ok":false,"errKind":"timeout"}
```

**成本透明（2026-10-16 负责人指示增补）**：每行追加 `model` / `inTokens` / `outTokens` / `costCny`——宿主回传 usage 用真实值，否则按官方换算估算（GLM token:汉字≈1:1.6）；价格表 `llmPricing` 可配置，默认取智谱官方定价页（GLM-5.3：输入 ¥8 / 输出 ¥28 每百万 tokens，2026-10 抓取）；报告尾统计行扩展为含模型名、token 消耗（est. 标注）与费用（≈ 标注）。README/RUNBOOK 增"成本可观测"章节说明口径与配置。

- 日报 meta 增加 `batch_stats`（批数/失败批/最大批耗时），报告尾渲染一行统计；
- 告警：同群连续 2 个窗口 degraded → notify 推送负责人；
- 用途：标定 inputBudget（§3.1）、驱动自适应（§3.2）、支撑 A/B 评审（§4.3）。

## 8. 边界与红线（不变量）

- API key 只从环境变量读、绝不落日志/prompt；`redactSecretLike` 覆盖所有错误字符串；
- 指令区/数据区分离与「数据非指令」防护在所有 prompt（批/合并/流水线/distiller）保留；
- 「不缺报告、不静默」：任何失败路径必须产出骨架 + degraded 原因；
- 序号映射不变量：分治切分保证批内序号全局化（`n = start + i + 1`）成立；
- distiller 配置核对：`cordis.patch.yml` 中 `distillEveryMessages: 100000`（实为关闭）需负责人确认是否有意（事故缺口 G4）。

## 9. 实施计划与验收

| 阶段 | 内容 | 验收标准 |
|------|------|----------|
| P0（本周，热修收口） | 提交现有 runBatched；接线 `batchThreshold`（G1/G2）；timeout 对半切分 + 退避加抖动（§3.3）；检查点（§5，自 P1 提前） | 2026-10-15 真实窗口回放：585 群日报 status=ok（或 partial 非全 degraded）；重跑仅调用失败批；`pnpm test` 全绿 |
| P1 | llm_call 结构化日志 + batch_stats + 告警（§7）；以实测标定 inputBudget | 日报含 batch_stats；两周观测数据产出 inputBudget 标定值 |
| P2 | 自适应 safeBatch（§3.2）；树形合并（§3.4）；`splitByRate` + 流水线 B（§4）A/B 灰度；两段式生成实验（§6）；distiller 接入同一估算 | 1000 条合成窗口全批成功；月报无合并超时；A/B 以三维人工评审 + WindowDiff golden set 定夺；B 不劣于 A 才切换 |

固定回放用例：`12345678@chatroom 2026-10-15`（181 条真实事故窗口）+ 一个 >600 条合成窗口。

## 10. 决策依据总表

| 决策 | 依据（等级） | 性质 |
|---|---|---|
| 单批上限 ~120、指令前数据后 | Lost in the Middle, TACL 2024, Stanford（E1） | 支持：小批防超时且防中段漏召回 |
| A 为默认、B 灰度实验 | BooookScore, ICLR 2024（E1，1193 条人工标注） | **修正**：B 细节↑连贯↓，非全面占优 |
| 速率低谷切段 | Kleinberg, KDD 2002（E1） | 支持：burst 模型的工程简化 |
| golden set + WindowDiff，暂不训模型 | Pevzner & Hearst 2002；TextTiling 1997（E1） | 支持：度量由"边界 F1"更正为 WindowDiff |
| timeout 对半切分 + 退避加抖动 | Marc Brooker, AWS Builders' Library（E2） | 支持：改变参数的重试 |
| 严格 schema 断言 | Let Me Speak Freely?, EMNLP 2024（E1） | **风险**：入 §6，备选两段式生成 |
| 滚动状态 σ + 群级长期记忆 | MemGPT, UC Berkeley（E1） | 支持 |
| 树形两级合并 | RAPTOR, Stanford（E1） | 支持 |
| 固定前缀吃 prompt cache | Claude Cookbook（E2） | 支持：与 E1 位置布局同向 |
| 四范式架构分类 | LangChain 文档（E3） | 支持：仅作分类框架，质量结论以 E1 为准 |
