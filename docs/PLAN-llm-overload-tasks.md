# 实施计划：LLM 消息过载治理任务分解

> **✅ 完成记录（2026-10-16 凌晨）**：T1–T9 全部实施完毕并提交，累计 8 个功能提交、
> 测试 371/371 全绿（基线 302 → +69）。提交映射：T5=c1b5f19、T1+T2=507517b（含负责人
> 审查加固：检查点键绑定 start+count）、T3=9ac8ad3、T4=e36ea69、T9=011a8c7、T6=4a56bdf、
> T7=8f6988d、T8=f4793b2。挂账项：端到端真实窗口验证（待下次日报调度自然触发后查验
> llm-calls.jsonl / 报告尾统计行 / alert-state.json）；A/B 灰度评审（需先人工复核
> golden set 切点 + 配置 reportPipeline:'ab' 跑对照）；schemaTwoStage 实验观察。

- 上游文档：`docs/ANALYSIS-2026-10-15-llm-report-timeout.md`（v2）、`docs/TECH-DESIGN-llm-overload-mitigation.md`（v2）
- 代码库：`$HOME/WeChat/2水群`
- 撰写：LLM 部分负责人
- 日期：2026-10-15 深夜（基于 be0ab15 提交后的仓库状态）

---

## 0. 基线确认（写计划前实测）

| 基线项 | 状态 | 证据 |
|---|---|---|
| 分批归纳+合并（Map-Reduce 雏形） | ✅ 已提交 | commit `be0ab15`；`src/report.ts` `runBatched()` |
| `batchThreshold` 配置接线 | ✅ 已提交 | `src/index.ts:227`（Schema，默认 120）、`:456`（透传） |
| 分批测试 | ✅ 6/6 绿 | `tests/report-batching.test.mjs`（181→2批+合并/单批降级/小窗口零变化/全批失败可见化） |
| timeout 对半切分 + 退避加抖动 | ❌ 未做 | 现状：批内失败仍是原样重试一次（`report.ts` runBatched 内层 for attempt 循环） |
| 检查点缓存 | ❌ 未做 | 现状：批摘要不落盘，重跑全量重调 |
| llm_call 结构化观测 | ❌ 未做 | 现状：仅 warn 文本日志 |
| 事务性说明 | ~~`cordis.patch.yml` 有未提交改动（本地运行配置，含 distillEveryMessages=100000 疑似误关，另行人认确认）~~ **已决（2026-10-15 负责人拍板）**：distillEveryMessages/distillIntervalMin 由 100000（当晚超时排障时临时关闭 distiller，非肇事方却忘了恢复，导致 insights 自 15:22 断流）改回默认 25/15，已在 cordis.patch.yml 就地修改并留注释存档。该文件属本地运行配置，按其头部注释约定不提交上游。 | `git status: M cordis.patch.yml`（本地配置，不随代码提交） |

测试命令：`pnpm test`（即 `node --test 'tests/*.test.mjs'`）；构建：`pnpm build`（tsc → lib/）。**改动必须 src/ 与编译后 lib/ 同步、全测试绿，但一律不自行 git commit——由负责人审后提交。**

## 1. 任务总表与依赖

```
T1 timeout 对半切分+退避 ──┐
T2 检查点缓存 ────────────┤ (T1、T2 同改 runBatched，串行：T1→T2 合并为 Agent-A 一个任务)
                          ├──→ T4 自适应 safeBatch（依赖 T1/T2 落地后的骨架）
T3 llm_call 观测+batch_stats ─┘   （依赖 T1/T2 完成避免冲突）
T5 WindowDiff 度量 + golden set 脚手架（独立新文件，可与 T1/T2 并行）
T6 splitByRate 节奏分段（纯函数，依赖 T1/T2 合入后开做）
T7 方案 B 滚动流水线 + A/B 灰度开关（依赖 T6）
T8 distiller 接入 safeBatch + 两段式生成实验（P2 尾，依赖 T4）
```

排期映射：T1+T2=P0 剩余；T3=P1；T4–T8=P2（本轮只启动 T1/T2 与 T5，其余按依赖滚动开）。

## 2. 任务卡

### T1（P0，Agent-A）：timeout 错误分类 + 对半切分重试 + 批间退避加抖动
- **改动**：`src/report.ts`
  1. 新增 `errKindOf(error): 'timeout' | 'other'`：匹配 `distiller.ts:181` 抛出的 `llm stream finished with error: Request timed out.`（用 `/timed?\s?out|timeout/i` 容错匹配 message）；
  2. `runBatched()` 内层重试改为错误分类：**timeout → 不原样重试，对该批对半切分递归**（复用 runBatched 或抽 `distillRange(msgs)` 辅助；叶子批 <5 条仍超时 → 标 degraded 跳过，禁止无限切分）；断言/解析失败 → 保持重试一次；
  3. 批间退避：连续失败后 sleep，指数 2s→30s 封顶**加随机抖动**（jitter ±25%）；测试注入 `sleep` 函数（默认 setTimeout 的 Promise 封装）；
  4. person-digest.ts 若有同构分批逻辑，同步同样改造（读代码确认）。
- **依据**：技术文档 §3.3（Brooker：容量型故障须改变参数重试）。
- **验收**：新增测试 `tests/report-timeout-split.test.mjs`：① 批 120 条首次调用抛 timeout、对半为 60 后成功 → 报告 ok 且总调用数符合预期；② 叶子 4 条仍 timeout → 该批 degraded + partialNote；③ 退避被调用且带抖动（注入 sleep 断言次数与时长范围）；④ 非 timeout 错误仍走"重试一次"。全部现有测试保持绿。

### T2（P0，Agent-A 顺承）：检查点缓存（断点续跑）
- **改动**：`src/report.ts` + `src/store.ts`（如需新增通用 kv 接口）
  1. 键：`report-ckpt:{chatId}:{kind}:{win.start}:{win.dateKey}:{batchIndex}`（含 `win.start` 防 backfill 失效——技术文档 §6）；
  2. 生成前查检查点，命中则跳过该批 LLM 调用直接用缓存摘要；批成功即写检查点；
  3. 整窗成功后按现有 retention 体系清理（+7 天；复用 retention.ts 机制或最简 mtime 清理，读代码后择一）；
  4. 合并调用不缓存（输入依赖全批，缓存意义小）。
- **验收**：新增测试（可并入 T1 测试文件）：① 同窗口第二次生成只调用上次的失败批（mock LLM 计数断言）；② 检查点命中路径产出与全量路径等价（draft 一致）；③ `win.start` 变化后检查点不命中。

### T3（P1，Agent-B，T1/T2 合入后启动）：llm_call 结构化观测 + batch_stats + 告警
- **改动**：`src/report.ts`、`src/distiller.ts`、`src/store.ts`
  1. 每次 `llm.complete` 落一行结构化 JSON（进 store，非 console）：`{ev:'llm_call', chat, kind, phase:'map|merge', batch, msgs, promptChars, durMs, ok, errKind}`；
  2. 日报 meta 增加 `batch_stats`（批数/失败批/最大批耗时），`renderReport` 尾部渲染一行统计；
  3. 告警：同群连续 2 个窗口 degraded → 走现有 notify 通道（dry_run 默认）。
- **验收**：测试断言 JSONL 落盘字段齐全、batch_stats 出现在报告文本、连续 2 次 degraded 触发一次 notify 调用。

### T4（P2）：自适应 safeBatch（`safeBatch ×0.7 / ×1.2` 反馈环，指标持久化 groups store）
- 依赖 T1/T2/T3 骨架与指标来源；改造点在 runBatched 的批大小决策处（现为常量 `size = this.batchThreshold`）。
- 验收：注入耗时序列驱动 safeBatch 收缩/扩张的单元测试；指标跨实例化保留。

### T5（P2 先行件，Agent-C，可立即并行）：WindowDiff 度量 + golden set 脚手架
- **改动**：新增 `src/segment-eval.ts` + `tests/segment-eval.test.mjs` + `scripts/seg-eval.mjs`（纯新增，不碰 report.ts，可与 T1/T2 并行）
  1. 实现 **WindowDiff**（Pevzner & Hearst 2002）与边界 Pk 作对照：`windowDiff(refBoundaries, hypBoundaries, k)`；
  2. golden set 格式定义：`tests/fixtures/seg-golden/*.json`（`{messages:[{ts,msgId}], boundaries:[...]}`），先放 1 份从 `12345678@chatroom 2026-10-15` 真实数据导出的样例（从 groups store 读当日消息生成，标注切点由负责人后续人工补）；
  3. `scripts/seg-eval.mjs`：输入 golden 文件 + 切分函数名，输出 WindowDiff/Pk 表。
- **依据**：技术文档 §4.4。**验收**：WindowDiff 经典用例测试（完美切分=0、全错=1、偏移 1 条得部分惩罚）；golden 样例文件可被脚本加载。

### T6（P2）：`splitByRate` 节奏分段纯函数
- `src/report.ts` 新增 `splitByRate(messages, {minSeg:20, maxSeg, overlap:5..10, gapWindowMs})`：速率低谷切点 + 段长钳制 + 重叠带 + 引用边禁切（消息含 quote 引用字段——读 group-store 确认字段名）。
- 验收：单测覆盖四要素；与 golden set 对接跑 WindowDiff（T5 产出）。

### T7（P2 尾）：方案 B 滚动流水线 + A/B 灰度开关
- σ 状态 schema（人物/悬置/任务/承诺）+ 串行 refine + 每段校验；群级长期记忆持久化（groups store）；配置开关 `reportPipeline: 'map-reduce'|'refine'|'ab'`。BooookScore 修正案：**不预设 B 优**，`ab` 模式双跑产出对比材料（三维度人工评审由负责人执行）。

### T8（P2 尾）：distiller 接入 safeBatch + 两段式生成实验
- distiller 批大小改走同一估算式；两段式（自由归纳→独立格式化）作为 `schemaTwoStage` 实验开关，仅灰度。

### T9（P1.5，负责人 2026-10-16 指示新增）：模型/token/费用透明化
- **需求原话**：报告里明确写出用什么模型、花费多少 token、多少钱；同步更新 README 等资料字眼。
- **改动**：
  1. `llm-observe.ts`：LlmCallEntry 增 `model` / `inTokens` / `outTokens` / `costCny`；宿主回传 usage 则用真实值，否则按官方换算估算（GLM token:汉字≈1:1.6，即 inTokens≈promptChars/1.6），字段标注 est.；
  2. 价格表配置 `llmPricing`（Schema.dict，元/百万 tokens，{input, output}）：默认值取智谱官方定价页 GLM-5.3=8/28（2026-10 抓取，注释注明"以供应商页面为准"）；`HostLlmClient` 暴露 modelId（this.model 已存在）；
  3. 报告尾统计行扩展为 `> 统计：批 x（失败 y）· 最大批耗时 z s · 缓存命中 n · 模型 glm-5.3 · 输入 ~12.3k / 输出 ~4.5k tok · ≈¥0.22`（tokens/费用为估算时带 ~ 与 ≈）；distiller 汇总同口径；
  4. 资料更新：README.md / docs/RUNBOOK.md 增"成本可观测"小节（价格表配置方法、估算口径、官方定价页链接）。
- **验收**：测试断言估算 token 数与费用计算正确（含 Flash 价表分支）、报告尾含模型/费用行、README/RUNBOOK 有对应章节；322+ 存量测试不破。

## 3. 执行编排（本轮启动）

| 波次 | 任务 | Agent | 冲突规避 |
|---|---|---|---|
| 第 1 波（现在） | T1+T2 | Agent-A | 独占 `src/report.ts`、`src/store.ts` |
| 第 1 波（同时） | T5 | Agent-C | 只新增 `src/segment-eval.ts`、`tests/segment-eval.test.mjs`、`scripts/seg-eval.mjs`、fixtures——与 Agent-A 零交集 |
| 第 2 波（A 合入后） | T3 | Agent-B | report.ts 已空闲 |
| 第 3 波起 | T4→T6→T7、T8 | 滚动派发 | 每波单 agent 独占 report.ts |

**全局红线**（对每个 agent 生效）：不 git commit/ push；不改 `cordis.patch.yml`；不碰 sender/安全相关代码；改 src 后必须 `pnpm build` 同步 lib；`pnpm test` 全绿；新代码风格与现有文件一致（中文注释、纯函数优先、测试注入依赖）。

## 4. 完成定义（本轮）

- T1/T2/T5 代码 + 测试全部合入工作区，全测试绿；
- 负责人（我）审查后统一提交为 2–3 个 commit（T1+T2 一个、T5 一个）；
- 向上级（你）汇报：P0 完整闭环（含 be0ab15），P1/P2 排期滚动。
