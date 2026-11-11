# 合成基准：故障注入、重放与判定

> 方法论见 [SYNTHETIC-BENCH-METHODOLOGY.md](SYNTHETIC-BENCH-METHODOLOGY.md)。本文只讲
> **判定侧**怎么跑、判什么、以及哪些结论它*不能*给。

## 1. 定位

没有真实群聊数据时，用三层代换验证「分批 / 退避 / 瘦身 / 成本治理」这些策略：

- 输入代换：合成流（3 天 × 50 条等）+ 植入真值清单；
- 故障代换：故障注入 LLM 客户端（超时 / 429 / 5xx / 鉴权 / 400 / 非法 JSON / 慢响应）；
- 判据代换：不变量（成本、调用数、结构映射）+ 植入真值召回。

**全离线**：不联网、不读真实微信库、不写 `~/.dsh`；重放用 `mkdtemp` 建临时 state 目录，
`finally` 里关闭 SQLite 句柄并整目录删除。合成流只含占位词，清单只有话题/任务/引用的
合成文本，不含真实 ID、昵称或路径。

## 2. 交付物

| 文件 | 作用 |
|---|---|
| `scripts/lib/fault-llm.mjs` | 故障注入客户端：序列 / 概率 / alwaysOk 三种脚本，内置调用、字符、token、费用、故障分类计数 |
| `scripts/bench.mjs` | 重放基准：真实 `GroupStoreService` / `BufferPool` / `Distiller` / `ReportService`，临时 state 目录，输出人读表 + `--json` |
| `scripts/bench-quality.mjs` | 植入真值质量评测：解析报告 md，算话题/任务/引用召回与编造引用 |
| `tests/bench-harness.test.mjs` | 离线哨兵：故障注入、30% 失败、变体参数、质量算法、临时目录清理 |

## 3. 输入契约

`stream.jsonl`（每行一个 JSON 对象）：

```json
{"ts": 1792459200000, "sender": "合成成员1", "kind": "text", "text": "合成消息：接口联调排期", "quoteOf": null}
```

`manifest.json`：

```json
{
  "topics": [{"id": "T1", "title": "接口联调排期", "msgIdx": 2}],
  "tasks": [{"id": "K1", "statement": "周五前给出联调环境", "evidenceIdx": [5]}],
  "quotes": [{"pair": [3, 4], "text": "联调环境周五一定给"}]
}
```

两个文件都通过 `--stream` / `--manifest` 传入；缺失或非法会以退出码 2 报清晰错误
（不猜测、不静默降级）。`--synth` 可用内置最小合成器替代（3 天 × 50 条 + 植入真值），
仅用于本仓库离线演示与测试，不替代 G1 的合成器产物。

## 4. 用法

```bash
# 正式基准（G1 产物）
node scripts/bench.mjs --stream /path/to/stream.jsonl --manifest /path/to/manifest.json \
  --seed 42 --fail 0.3 --json

# 内置最小合成器（无文件依赖）
node scripts/bench.mjs --synth --seed 42 --variant legacy
node scripts/bench.mjs --synth --seed 42 --variant guard --json

# 变体对比：同 fixture 各跑一次，diff 两份 JSON 的 distill/report/invariants
node scripts/bench.mjs --synth --seed 42 --variant legacy --json > legacy.json
node scripts/bench.mjs --synth --seed 42 --variant guard  --json > guard.json

# 质量评测（报告由真实 LLM 产出；不进离线 CI）
node scripts/bench-quality.mjs --report /path/to/2026-10-20.md \
  --manifest /path/to/manifest.json [--stream /path/to/stream.jsonl] --json
```

主要参数：`--seed`（同种子同输出）、`--fail`（传输层失败概率）、`--bad-json`（成功调用
返回非法 JSON 的概率）、`--days`（只重放前 N 个自然日）、`--every`（每 N 条触发提炼，
默认 5）、`--interval-min`（定时 tick，默认 30）、`--batch-threshold`（报告分批阈值，
默认 120）、`--buffer-size`、`--chat`、`--strict`（任一条不变量 FAIL 时退出码 1）。

## 5. 故障注入能力矩阵

| 维度 | 形态 | 说明 |
|---|---|---|
| 序列回放 | `[{ok:true,text,delayMs}]` / `[{ok:true,badJson:true}]` / `[{err:'timeout'}]` | 按调用序消费；耗尽后回落 `tail`（缺省 `{ok:true,text:'[]'}`） |
| 概率注入 | `{pFail, errWeights, pTimeout, pBadJson, text}` | `pFail` 为失败总概率；`pTimeout` 是其中 timeout 的绝对概率；其余失败按 `errWeights` 在非 timeout 类型间加权；`pBadJson` 是成功调用里返回非法 JSON 的概率 |
| 永远成功 | `'alwaysOk'` / `{alwaysOk:true, text}` | 用于 baseline（calls 应等于理论最少批数） |
| 故障类型 | `timeout` / `rate_limit` / `server` / `auth` / `bad_request` | 错误文案对齐生产：timeout 含 `Request timed out.`（`errKindOf` 归为 timeout，触发对半切分），其余 HTTP 状态错误归为 other（重试一次） |
| 非法 JSON | `pBadJson` / 序列 `badJson:true` | 返回可配置文本（默认 `not json at all`） |
| 延迟 | 条目 `delayMs` / 全局 `delayMs` / 注入 `sleep` | 每次调用都 `await sleep(delayMs ?? 0)`；测试注入零延迟时钟 |
| 计数 | `calls` / `okCalls` / `failCalls` / `promptChars` / `estimatedInTokens` / `estimatedOutTokens` / `estimatedCostCny` / `failByKind` / `badJsonCalls` | token 口径 `round(chars/1.6)`；费用与 `lib/llm-observe.js` 同款（glm-5.3 输入 ¥8 / 输出 ¥28 每百万 tokens，保留 1e-6 元） |
| 模型 | `modelId()` 返回 `glm-5.3` | 供 `LlmCallRecorder` 查价格表 |

确定性：概率模式用 seed 驱动的 mulberry32；同 seed 同调用序 → 同故障序列。

## 6. 重放口径（诚实披露）

`bench.mjs` 用**真实服务类**，但重放编排有三条约定：

1. **成功即消费窗口**：一次成功 `tryDistill` 后，待处理窗口清空（等价于 C2 增量水位
   的效果）；失败**不消费**（真实计数器语义），于是「失败后每条新消息重触发」的
   legacy 形态被如实还原。alwaysOk 下 calls 恒等于 `ceil(msgs/batch)`。
2. **串行 await**：每次 `tryDistill` 都 await，不复现生产里并发调用导致的「_distilling
   丢触发」。因此重放的触发数是保守上界，不会比生产更容易失败。
3. **不做环形淘汰干扰**：默认 `--buffer-size 10000`（生产默认 60），避免缓冲淘汰把
   待处理窗口截断；要复现线上淘汰可显式调小。

触发复刻真实语义：`onNewMessage` 的「每 N 条」计数（失败不清零）+ 每 30 分钟 tick
（`now - 上次成功 ≥ interval` 才触发）。报告按「每天窗口 = 前日 20:20 → 当日 23:59:59.999」
调 `ReportService.generateReport`，禁自适应批大小、注入零延迟 `sleep`、临时 Store 落盘。

## 7. 不变量

| 编号 | 定义 | 实现要点 |
|---|---|---|
| **I1** | 提炼调用数 ≤ `ceil(msgs/batch) × (1 + 2×失败率×4)` | 失败率取**提炼阶段**实测值；batch = `min(distillEveryMessages, batchThreshold)`；上界随失败率放宽 |
| **I2** | 单日总成本 ≤ ¥0.5 | 逐日 `distill + report` 费用取最大值；口径为 585 规模 300 条/日画像的预算线 |
| **I3** | 失败注入 30% 时重试放大系数 ≤ 3.0 | `提炼 calls / 理论最少调用数`；理论最少 = `ceil(msgs/batch)`；只统计提炼阶段 |
| **I4** | 报告必需产出（ok 或 degraded，不抛） | 每天 `generateReport` 不抛、状态 ∈ {ok, degraded}（窗口无消息时允许 empty）、`path` 非空；逐日明细进 detail |
| **I5** | evidence / quotes 序号映射合法 | 解析报告 md 的 `[evidence: …]` 与原文引用 `[msgId]`，全部必须落在当天报告窗口的 msg_id 集合内 |

输出同时包含：`days` / `calls` / `costCny` / `failRate` / `retryAmplification` /
`invariants.{I1..I5}.{pass,detail}`，以及 `meta` / `variant` / `distill` / `report` /
`perDay` / `failByKind` / `observed`（`llm-calls.jsonl` 观测层交叉校验）。

## 8. 变体探测（guard vs legacy）

`probeVariant()` 先看 `lib/distiller.js`（回退 `src/distiller.ts`）是否含
`nextAttemptDelayMs` / `distillStateRelPath` / `distill-state.json` /
`DISTILL_CIRCUIT_THRESHOLD` 标记，再检查模块是否导出对应符号；命中即 `guard`，否则
`legacy`。重放结束后还会检查 `groups/<chat>/distill-state.json` 是否真的被写出。

- `--variant guard|legacy` 只强制**输出标签**，不会把保护塞进不支持的代码；
- 强制值与探测值不一致时，`variant.warnings` 明确写出「实际行为与 legacy 相同」或
  「代码已带保护，无法在本进程关闭」；
- 同一 fixture 在两个分支上各跑一次，对比 `distill.calls` / `costCny` /
  `retryAmplification` / `stateFileWritten` 即可证明保护是否生效。

> 当前分支已 revert 掉 C1+C2（退避/熔断/增量水位），因此探测结果为 `legacy`、
> `stateFileWritten=false`。保护分支合回后，同一命令应自动变为 `guard` 并写出状态文件。

## 9. 植入真值质量评测

`bench-quality.mjs` 解析报告 md 的 L1 关键判断、L2 话题、L3 原文引用：

- **话题召回**：`manifest.topics[].title` 是否被报告语料命中（整句精确子串优先；
  否则中文二元组 + 英文词覆盖：≤2 词命中 1 个，或 ≥2 词且覆盖率 ≥30%）；
- **任务召回**：`manifest.tasks[].statement` 同口径；
- **引用召回**：`manifest.quotes` 的原文是否出现在报告引用区（报告引用被截到 50 字，
  故按「报告引用文本是原文子串」匹配）；
- **编造引用**：报告引用区文本能否在消息级源文本（`--stream` 或 `manifest.messages`）
  中逐字找到。只有 `manifest.quotes[].text`、没有消息级源文本时，`quoteVerifiable=false`，
  编造判据关闭（避免把兜底引用误判为编造）。

阈值：`recall ≥ 0.8` 且 `hallucinated = 0`；退出码 PASS=0 / FAIL=1。
该脚本需要真实 LLM 产出的报告，**不进离线 CI**；离线测试只测解析与召回算法。

## 10. 示例与边界

内置合成器、`--seed 42` 的实测（数值随 seed/规模变动，仅示意）：

| 场景 | calls | costCny | failRate | retryAmplification | I1/I2/I3 |
|---|---|---|---|---|---|
| alwaysOk | 33 | 0.3687 | 0 | 1.00 | PASS |
| 注入 30% | 55 | 0.5517 | 0.382 | 1.67 | PASS |
| 注入 90% | 262 | 1.8990 | 0.893 | 8.53 | FAIL |

诚实结论：**30% 失败下 legacy 没有出现 >3 倍调用风暴**（每 5 条一个窗口，两次重试
后整次失败的概率约 5–10%）；把失败率提到 90% 才复现生产级的重试风暴。基准只负责
如实输出这个事实，不为了「证明策略有效」而调参；要证明 C1/C2 的价值，应在 guard
分支上跑同一 fixture 对比，而不是在本分支上期待它变好。

它**不能**证明：语义质量与真实群聊等价、真实 API 的所有失败模式、生产并发下的丢触发。
这些仍需本地小样本人工抽查与真实验证（方法论 §4）。
