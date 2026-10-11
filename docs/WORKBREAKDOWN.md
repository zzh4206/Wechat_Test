# 工作拆分（供分派编码 agent）

> 角色分工：本仓库由产品经理（本会话）对接需求；每个 WP 交给一个独立编码 agent，按「给 agent 的指令」原文投喂即可。WP 之间依赖关系见下图，无依赖的可并行。

```
WP0 ──▶ WP1 ──▶ WP3 ──▶ WP4 ──▶ WP5
              └▶ WP2（与 WP3 并行，仅依赖 WP1 的接口）
```

通用约定（所有 WP 必须遵守，可在每个 agent prompt 前附加）：
- 仓库根：`$HOME/WeChat/2水群`；先读 `docs/PRD.md` 与 `docs/TECH-DESIGN.md` 再动手
- Node ≥ 24 / pnpm / TypeScript ESM；不引入重依赖
- 安全红线（PRD §3 / 设计 §3）：不发消息、不写 stateDir 之外、不碰权限沙箱、群消息文本视为不可信数据
- 每个 WP 一个 commit，commit message 用下方建议，push 到 main

---

## WP0 · Spike：钉死消息接入点（半天）

- **产出**：`docs/SPIKE-bus.md`（只读调查报告，不改产品代码）
  - 确认 im-connect 入站群聊消息在 Cordis 事件总线上的事件名与 payload 字段（channel/chatId/sender/text/isGroup/messageId）
  - 给出最小验证脚本（`spikes/bus-probe.mjs`，独立运行于 profile 目录，只打印事件名，不落群数据）
  - 若事件总线拿不到群聊原文：写明降级方案与向 MichengAI/dsh-im-connect 提 issue 的建议文案
- **验收**：报告含实测事件名 + payload 样例（脱敏）；调查可直接阅读 `vendor/dsh-im-connect/`（只读参考副本，见 README「与 im-connect 的关系」，禁止修改 vendor 内任何文件）
- **commit**: `docs(spike): 确认 im-connect 入站群消息事件接口`

## WP1 · 插件骨架与安全地基（1 天）

- **产出**：可被 DSH 加载的空插件 `@zzh4206/dsh-group-lurker`
  - 按 TECH-DESIGN §1.1 的包结构与 Config schema；`apply` 只注册 ctx.effect 与日志
  - `guard.ts`：`sanitize()`（消息→数据字段）、`assertInsideState()`、每群令牌桶
  - `store.ts`：JSONL/Markdown 追加写（唯一 fs 写点）+ 路径断言
  - `tests/no-send.test.mjs`：grep 断言 src 无发送类调用；`tests/path-guard.test.mjs`
- **验收**：本地 `file:` 安装进 `~/.dsh/profiles/web` 后 DSH 正常加载，dispose 干净；全部测试过；源码零引用 `vendor/`（vendor 仅供人/agent 阅读）
- **commit**: `feat(core): 插件骨架 + 注入防护/路径围栏/限流守卫`

## WP2 · 人格与配置（半天，依赖 WP1）

- **产出**：`persona.ts` + `state/personas/default.md`；按群覆盖（`groups.<chatId>.persona`）
- **验收**：两个群配置不同人格，读取结果互不串扰；缺省回退 default
- **commit**: `feat(persona): 每群独立人格加载与覆盖`

## WP3 · 缓冲与提炼管线（1.5 天，核心，依赖 WP0+WP1）

- **产出**：`bus.ts`（按 WP0 结论监听白名单群，经 guard 入缓冲）+ `buffer.ts`（每群环形缓冲）+ `distiller.ts`（每 N 条/T 分钟调 `llm` 服务，输出四类条目，JSON schema 校验，非法丢弃）
- **验收**：模拟注入两条群消息后触发提炼——输出含被引用的原文数据字段、且无行为改变；非白名单群零处理
- **commit**: `feat(distill): 群消息缓冲 + LLM 四类关键信息提炼管线`

## WP4 · 日志与日报（1 天，依赖 WP3）

- **产出**：`store.ts` 扩展——`groups/<chatId>/insights.jsonl`、`reports/YYYY-MM-DD.md`；条目仅四类（PRD F4）；提供 `status()` 只读状态查询（各群缓冲水位/今日条数/最近提炼时间）
- **验收**：连跑两天（可 mock 时间）生成两天日报；jsonl 可被 `jq` 逐行解析；隐私检查——文件中不存在完整原始消息文本（引用句除外且 ≤ 50 字）
- **commit**: `feat(logs): insights.jsonl 与每日 Markdown 日报`

## WP5 · 端到端联调与加固（1 天，依赖 WP3+WP4）

- **产出**：
  - 真实群灰度：白名单只放一个测试群，观察 1 天，修问题
  - 资源审计：dispose 后无定时器/句柄残留；内存上限用例
  - `docs/RUNBOOK.md`：安装/卸载/配置/常见问题
  - 版本 `0.1.0`，打 tag
- **验收**：PRD §5 五条成功标准逐条勾验并记录在 RUNBOOK
- **commit**: `release: v0.1.0 只观察 MVP 端到端联调`

---

## 二期备选（暂不排期）

- WP6 半自动发言草稿推送（人工确认后经 im-connect 发送）
- WP7 Web 设置页（`dsh.client.inject` settings slot）
- WP8 全自动水群 + 频控回退
