# 分析报告：群聊日报 LLM 调用超时导致降级（2026-10-15）

- 事发报告：`~/.dsh/dsh-group-lurker/reports/12345678@chatroom/2026-10-15.md`
- 涉及代码库：`$HOME/WeChat/2水群`（`@zzh4206/dsh-group-lurker` 插件）
- 撰写：LLM 部分负责人
- 版本：v2（基于两轮调研重写；v1 为当晚初稿）

---

## 1. 现象

日报 `12345678@chatroom / 2026-10-15`（生成于 20:38:07）头部：

```
⚠️ degraded：LLM 调用异常：Error: llm stream finished with error: Request timed out.，本期降级输出骨架（不缺报告）。
```

影响面：
- L1 关键判断、L2 展开话题全部缺失（骨架输出），仅 L3 溯源层（本地兜底 pickQuotes）可用；
- 本期窗口消息量 **181 条**；对照群 1234567890 当日未降级（消息量更少）；
- 实时提炼层（distiller）当日 15:22 仍有正常产出（insights.jsonl 共 195 条），说明 LLM 通道本身可用——**失败与单次请求的输入规模强相关，而非服务故障**。

## 2. 调用链与失败点

```
scheduler(日报定时) → ReportService.generate()
  → groupStore.getMessages(limit: 2000)        // 一次取全窗口 181 条
  → 事发时逻辑：单次调用，无分批
      → buildPrompt()：指令区 + JSON.stringify(全部 181 条消息)
      → llm.complete(prompt)
          → dsh-llm stream()：finish reason = timeout → "Request timed out"
      → catch → 原样重试 1 次 → 再超时
  → draft = null → status = degraded → 渲染骨架报告
```

关键代码位置（修复前）：
- `src/report.ts:450` 单次 `llm.complete(buildPrompt(..., 全量 messages, ...))`
- `src/report.ts:454-459` 失败重试一次，重试不改变任何参数
- 对照 `src/distiller.ts:339-358`：distiller 每批只喂 `distillEveryMessages` 条，单次输入小，未触发

## 3. 根因认定（含调研依据）

**直接原因**：单次 LLM 请求总时长（181 条消息 JSON 输入 + 金字塔 schema 长输出）超过宿主 dsh-llm 请求超时阈值，流式补全以 `timeout` finish reason 终止。

**结构性根因，三条，各有独立依据：**

### 3.1 调用模式本身是业界明知会失效的反模式

事发逻辑等价于 LangChain 分类中的 **Stuff 模式**（全量塞入单次调用）。[LangChain CombineDocuments 文档](https://langchain-doc.readthedocs.io/en/latest/_sources/modules/indexes/combine_docs.md)对该模式的失效条件写得很明确：输入一大即超出可行范围——必须切换到 Map-Reduce 或 Refine。我们撞上的正是教科书式失效，不是意外。

### 3.2 即使不超时，大输入也在悄悄损害质量

[Lost in the Middle（Liu et al., TACL 2024，Stanford Percy Liang 组）](https://aclanthology.org/2024.tacl-1.9/)实证：LLM 对长上下文**中间位置**信息的利用率显著塌陷，任务性能随输入变长单调下降。推论：事发前那些"没超时、成功出稿"的大窗口日报，中段消息（往往正是下午的讨论高峰）的关键判断召回率也在受损——**超时只是让隐性质量问题显性化了**。这把本次事故的定性从"可靠性问题"升级为"可靠性 + 质量双重问题"。

### 3.3 重试策略违背容量型故障的处理原则

同 payload 原样重试，对超时类失败期望成功率 ~0。AWS 可靠性权威 Marc Brooker 在 [Timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) 中的结论：容量型故障下不改变参数的重试不仅无效，还加剧拥塞；正确做法是**改变请求参数（缩小规模）+ 指数退避加抖动**。

**量化判断**：消息量与调用总时长近似线性。distiller 实测 ≤25 条/次稳定成功、日报 181 条/次稳定失败，单次调用安全输入在几十条量级。**这是随群活跃度增长的必燃故障**——501 群只是当日消息少未触发。

## 4. 现场修复状态（截至当晚 23:32）

工作区存在**未提交**修复（`git status`：`src/report.ts`、`cordis.patch.yml` 修改中）：新增 `runBatched()`——窗口 > 120 条时按时间序切批逐批提炼再合并，单批失败重试一次后跳过并打 `partialNote`，全批失败才整体降级。方向正确（即标准 Map-Reduce），但遗留缺口：

| # | 缺口 | 后果 | 依据 |
|---|------|------|------|
| G1 | `batchThreshold` 未接入 `src/index.ts` Config schema 与装配 | 只能吃默认 120；且 120 条/批仍属大输入，活跃群单批可再超时 | §3.2：120 条批的中段召回同样受损，上限应下调或自适应 |
| G2 | 修复未提交、未经真实窗口回归验证 | 线上行为未确认 | — |
| G3 | 批内失败仍是原样重试 | 超时批重试必败，浪费配额 | §3.3：须改为"缩小参数的重试"（对半切分） |
| G4 | ~~配置漂移：`cordis.patch.yml` 仅配 1 个群；`distillEveryMessages: 100000` 实为关闭 distiller~~ **已解决（2026-10-15 负责人拍板）**：distiller 参数改回默认 25/15（当晚排障临时关闭后未恢复，非肇事方；distiller 单批输入小不会触发超时）。"仅配 1 个群"一项属运行配置差异，留待日常运维核对。 | — |
| G5 | 无观测：只有 warn 日志，无超时率/批耗时/输入条数指标 | 安全批大小只能靠事故反推 | 技术文档 §5 要求以实测 durMs 标定 inputBudget |

## 5. 结论

1. **定性**：可预期的容量型故障（Stuff 反模式 + 无参数变更的重试），且伴随未被察觉的长上下文质量损耗；非偶发，群越活跃越先触发。
2. **短期**：现有 Map-Reduce 修复保底正确，必须补 G1（接线）、G2（验证+提交）、G3（对半切分重试）才算闭环。
3. **中期**：分批策略、切分方式、输出格式约束均有学界实证可依，完整方案与逐决策证据见
   `docs/TECH-DESIGN-llm-overload-mitigation.md`（v2，含决策依据总表）。
