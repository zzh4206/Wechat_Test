# 技术报告：不等上游 im-connect，我们能否自己实现"读取微信群聊消息"？

> 调查日期：2026-10-11 · 调查范围：本仓库 vendor 只读副本、本地补丁、公开网络资料。
> 结论速览：**情形 b —— 在腾讯官方 iLink Bot 协议（bot_type=3 扫码登录）内，微信群消息当前收不到，官方协议内无解**。协议消息体里存在 `group_id` 字段（服务端疑似预留），但实测 `getupdates` 对普通群消息（含 @ 扫码账号）不投递任何事件。因此"自己实现微信群读取"在**不违反封号红线的前提下不可行**；可行的只剩：①协议内替代（多账号私聊聚合，不满足水群场景）②持续探测服务端是否放开群投递（低成本实验，见 §5）③换官方支持的群载体（企业微信群机器人 / QQ 群官方机器人，超出本报告范围但已在 PRD 联调建议中提及）。§6 仍给出"若服务端放开"的条件化子任务拆解，可直接用于那一刻到来时分派。

---

## 1. 协议面盘点（vendor/dsh-im-connect 只读副本，0.1.72 同版）

### 1.1 已实现端点（weixin.ts）

| 端点 | 方法/用途 | 证据 |
|---|---|---|
| `/ilink/bot/get_bot_qrcode?bot_type=3` | 扫码登录取二维码 | weixin.ts:319 |
| `/ilink/bot/get_qrcode_status?qrcode=…` | 长轮询扫码状态，confirmed 后返回 `bot_token` / `ilink_user_id` / `baseurl` | weixin.ts:343,349-359 |
| `/ilink/bot/getupdates` | **消息接收 = HTTP 长轮询**，body `{ get_updates_buf: <cursor>, base_info }`，游标持久化于 `state.syncBuf` | weixin.ts:588-592,624-628 |
| `/ilink/bot/sendmessage` | 出站文本/媒体，需 `context_token` | weixin.ts:43,683-701 |
| `/ilink/bot/getconfig` | 取 `typing_ticket`（也用于诊断） | weixin.ts:712-716,886 |
| `/ilink/bot/sendtyping` | "正在输入"状态 | weixin.ts:722-726 |
| `/ilink/bot/getuploadurl` + CDN `novac2c.cdn.weixin.qq.com/c2c` 上传/下载 | 媒体收发，AES-128-ECB | weixin.ts:41,741-774 |

- **鉴权**：`Authorization: Bearer <botToken>` + `AuthorizationType: ilink_bot_token`，token 来自扫码 confirmed 响应，存 Host credentials vault（weixin.ts:277-288,350-357）。
- **接收机制**：无 webhook，单账号单 poller 的 `getupdates` 长轮询（约 70s 超时，weixin.ts:8,591）；token 失效码 errcode -14（weixin.ts:178-181,597）。
- **会话类型字段线索**：
  - 入站解析只认 `message_type === 1`（weixin.ts:530），`chatId = userId = from_user_id`（weixin.ts:531,668-669），**不设置 `kind`**，engine 侧缺省当 dm（SPIKE-bus §4，gateway.ts:605）。
  - 全文件无 group/room 逻辑（weixin.ts 头注释明言"仅私聊"weixin.ts:8）。
  - 但协议消息体本身**有 `group_id` 字段**：hermes-agent 实测 raw inbound 含 `"group_id": ""`（DM 时为空，见 §2 证据 ③）；rust 社区实现 ilink-hub 的 `WeixinMessage` 结构体亦有 `group_id` 字段（[docs.rs/ilink-hub](https://docs.rs/ilink-hub/latest/ilink_hub/ilink/types/struct.WeixinMessage.html)）。⇒ **协议 schema 预留了群维度，瓶颈在服务端是否投递**，不在字段缺失。
- **白名单**：`state.allowedUserId` 绑定扫码用户，非白名单直接 continue（weixin.ts:360-366,637）。
- **本项目已有补丁**：access 过滤前 emit `im-connect/message { channel, message }`（patches/im-connect-0.1.72-emit-inbound-message.patch:8；lib/engine/gateway.js handleInbound 去重之后、decideAccess 之前）。⇒ **只要 iLink 投递了群消息，本插件侧 0 改动即可旁听到**，缺口完全在消息源。

## 2. 官方能力调查（按可信度分层）

| # | 来源 | 时间 | 说法 | 定性 |
|---|---|---|---|---|
| ① | OpenClaw 官方插件同款指南（[DjangoPeng/agentic-ai wechat-clawbot.md](https://github.com/DjangoPeng/agentic-ai/blob/main/openclaw-im/wechat-clawbot.md)）：ClawBot「当前限制：仅支持一对一私聊，暂不支持群聊」 | 2026-03 版本语境 | 不支持群 | **确证（与官方插件行为一致）** |
| ② | [hermes-agent issue #17094](https://github.com/NousResearch/hermes-agent/issues/17094)（实测报告）：扫码 bot 身份为 `…@im.bot`，**无法像普通联系人被拉进微信群**；群内消息（含 @ 扫码账号）在 `getupdates` 处 `ret=0 errcode=0 msgs=0`，**服务端根本不下发** | 2026（issue→[PR #17105](https://github.com/NousResearch/hermes-agent/pull/17105) 落地告警文案） | 不投递群消息 | **确证（一手实测 + 两个 PR 固化）**；另有 [PR #17433](https://github.com/NousResearch/hermes-agent/pull/17433) 再次强化同一告警 |
| ③ | hermes 上述 issue 的 raw inbound 样例：消息体含 `group_id`（空）与 `from_user_id …@im.wechat` / `to_user_id …@im.bot` | 同上 | 字段存在但群场景恒无数据 | **确证** |
| ④ | [cc-connect 官方文档 docs/weixin.md「群聊：chat_id 以 @chatroom 结尾」](https://github.com/chenhg5/cc-connect/blob/main/docs/weixin.md)与转述文章（[七牛云，2026-07-28](https://news.qiniu.com/archives/1785136404735)）声称个人微信 ilink 支持群聊 | 2026-07 | 支持群（`1234567890@chatroom`） | **传闻级，可信度低**：与 ①②③ 直接矛盾；`@chatroom` 是企业微信/旧客户端命名习惯，而 ilink 用户 ID 形如 `…@im.wechat`（同一文档自述），文档自身口径可疑；且该文判定流程是"看日志里出现 @chatroom"——若服务端不下发群消息，日志永远不会出现，无法证伪。注意七牛云页面含 `localhost` 分类链接等 AI 生成痕迹 |
| ⑤ | 微信开放社区 / 微信官方文档：**未检索到任何关于 iLink Bot（ClawBot）群聊能力的官方公开文档或公告**（多轮检索仅命中第三方转述） | 检索日 2026-10-11 | — | **无公开信息** |
| ⑥ | MichengAI/dsh-im-connect GitHub issues：检索 `weixin group` **0 条** | 2026-10-11 | 上游无群支持计划痕迹 | 无公开信息 |

**小结**：两个独立一手实测源（①②，且 ② 附服务端响应证据）一致指向"bot_type=3 扫码 bot 收不到群消息、也进不了群"；④ 是唯一反例且为孤证、自相矛盾；⑤ 说明官方从未承诺群能力。① 的"进不了群"与 ② 的"不下发"是双重锁死——即使某天其中一环放开，另一环仍在。

## 3. 三情形分析

### a) iLink 官方支持群 → 缺口只在 im-connect 实现？
**不成立（现状）**。im-connect 的 weixin.ts 虽无私聊之外的任何逻辑，但缺口不在它：`getupdates` 层面服务端就不投递群事件（§2 证据②）。反过来说，这也是好消息：**若服务端未来放开，本仓库几乎零自研**——已打的 `im-connect/message` 补丁在 access 过滤前广播一切入站消息，群消息一旦到达 weixin.ts:631 的 `rawList` 循环就会被旁听到（顶多需要扩展 `parseInbound` 对 `group_id`/`message_type` 的处理与 `ImMessage.kind='group'+addressed` 标注，见 §6 预案）。

### b) iLink 不支持群 → 官方协议内无解 ✅（当前结论）
- **协议内替代 1：多账号私聊聚合**。让 N 个群成员各自扫码绑定 bot，把与 bot 的私聊当"群消息代理"。**不满足水群场景**：① 覆盖率趋近于零——群友不会为了旁听工具私聊一个机器人；② 每账号一个 poller + 一套登录态/限频/封号面，维护成本随人数线性增长（weixin.ts:8 明言一账号一 poller）；③ 私聊里没有群上下文、没有发言人以外的互动，"提炼关键信息"无从谈起；④ PRD 红线是"群友无感"，此方案要求每位群友主动操作，直接违背。
- **协议内替代 2：公众号/企业微信**。公众号客服消息有 48h 窗口且无法旁听群；企业微信群机器人是**单向 webhook（只能发不能收）**，群消息回调需企业微信自建应用 + 群内成员为企业成员——朋友水群场景不可行。均不满足。
- **结论**：在"只允许官方 API/平台能力"的约束下，**读微信个人群聊在现阶段无解**。这是腾讯平台能力缺口，不是任何工程投入能弥补的。

### c) 信息不足 → 最小验证实验（仍建议做，成本 ~1 小时）
尽管证据偏向 b，cc-connect 文档（④）留有 1% 可能是"部分 bot_type/灰度账号已放开"。建议一个**完全在官方协议内**的探测（用现有 token，不触碰 ToS）：
1. 用 im-connect 现有登录态起一个独立 spike 脚本（模式照抄 `spikes/bus-probe.mjs`）：直接 POST `/ilink/bot/getupdates`（同 weixin.ts:588 的 headers/body），记录每轮 `msgs` 数量与全部 raw 字段 key（脱敏）。
2. 用扫码绑定的那个小号把 bot 拉入一个测试群（如果微信允许——预期 ② 会被拒），并在群内发文字/@ 小号。
3. 判定：群消息时段 `msgs=0` 且 DM 正常 ⇒ 复现 ②，坐实情形 b，归档；若出现任何含非空 `group_id` 的消息 ⇒ 情形 a，立即按 §6 预案分派。
4. 顺带记录 `get_bot_qrcode` 对不同 `bot_type` 的响应字段差异（只读探测，不发消息），留档供未来比对。

## 4.（衔接）若实验翻案为 a：本插件侧需要的增量
见 §6 的 WP-G0–WP-G5 预案。总体量级 2–3 人日，因为消息合流管线（补丁事件 → guard → buffer → distiller）本项目已建成，群场景只多了：会话类型扩展、群白名单、发言人归因、限频收紧。

## 5. 风险与红线
- **封号红线（不可逾越）**：任何逆向个人微信、非官方协议、自动化客户端方案一律排除（PRD §3）。iLink 是官方产品（[微信 ClawBot 使用条款](https://github.com/DjangoPeng/agentic-ai/blob/main/openclaw-im/wechat-clawbot.md) §一），但其群能力不存在，**切勿**为绕过而转向 web 协议/mac 协议类项目——那正是红线本身。
- **限频**：iLink 无公开频控文档；hermes 实测中出现 errcode -14 会话过期（weixin.ts:597 已处理）。探测实验务必复用现有 poller 之外**不并行第二个长轮询**——同一 token 双 poller 可能互踢游标（协议未文档化，保守假设）。
- **token 权限**：`bot_token` 是扫码 bot 身份的全部权限；群能力若未来开放，预期需要新的 `bot_type` 或服务端授权，届时应重走扫码并 diff confirmed 响应字段。
- **证据时效**：腾讯该产品迭代快（hermes 一年内两个相关 PR），本报告结论有效期建议 1 个季度；§3c 实验可低成本低频复跑（如每季度一次）。

## 6. 子任务拆解（条件预案：仅当 §3c 实验证实 iLink 投递群消息后启动）

依赖图：

```
G0（实验翻案）──▶ G1 ──▶ G3 ──▶ G5
                    └▶ G2（与 G3 并行）──▶ G4（依赖 G3）
（G1–G5 全部依赖既有 WP1 骨架与 WP0.5 补丁事件，属增量）
```

### G0 · iLink 群能力探测 spike（0.5 天，前置闸门）
- **目标**：按 §3c 实验设计，实测 bot_type=3 当前是否投递群消息。
- **产出**：`docs/SPIKE-ilink-group.md`（raw 响应样例脱敏 + 明确判定）+ `spikes/ilink-group-probe.mjs`。
- **验收**：报告含 ≥3 轮群消息测试窗口的 `getupdates` 记录与同窗口 DM 对照；结论三选一并给出证据行。
- **commit**: `docs(spike): iLink bot 群消息投递能力实测`
- **量级**：0.5 天。**风险**：拉 bot 入群可能被微信直接拒绝（预期行为，本身即结论的一部分）。

### G1 · 上游/补丁层：群消息接收与解析（1 天，依赖 G0 翻案）
- **目标**：让 weixin 渠道把群消息解析为一等公民。
- **产出**：`parseInbound` 扩展——识别 `group_id` 非空的消息，`chatId = group_id`、`userId = from_user_id`、`kind='group'`；保持 DM 路径零行为变化；若走上游 PR，则改 vendor 对应源码并同步本地 patch 文件。
- **验收**：单测覆盖群/私聊/未知 message_type 三类样本（用 §2③ 的真实字段形态做 fixture）；DM 回归测试全绿。
- **commit**: `feat(weixin): 解析 iLink 群消息并标注 kind=group`
- **量级**：1 天。**风险**：群消息的 `context_token` 语义未知（群内回复策略），MVP 只读不回，先不消费。

### G2 · ImMessage.kind 扩展与发言人归因（0.5 天，依赖 G1，可并行）
- **目标**：让旁听事件携带发言人。
- **产出**：补丁事件 payload 增加 `group_id`/`from_user_id`/`username`（若服务端下发）；`engine/types.ts` 的 `ImMessage` 补 `senderName?` 字段（上游 PR 文案同步 SPIKE-bus §6 的 issue 草稿修订）。
- **验收**：`im-connect/message` 事件中群消息含群 id 与发言人；私聊消息字段不变。
- **commit**: `feat(engine): 群消息事件携带 group_id 与发言人`
- **量级**：0.5 天。

### G3 · 群白名单与准入（0.5 天，依赖 G1）
- **目标**：只旁听配置的群，群消息视为不可信数据。
- **产出**：Config schema `groups.<chatId>.enabled`；guard 在白名单外直接丢弃（不经 buffer）；现有令牌桶按群粒度收紧（群流量 >> 私聊）。
- **验收**：非白名单群消息 0 处理、0 日志泄漏原文；白名单群正常进缓冲。
- **commit**: `feat(guard): 群白名单准入与按群限流`
- **量级**：0.5 天。

### G4 · 管线合流与人格（0.5 天，依赖 G2+G3）
- **目标**：接入既有 WP3 提炼管线。
- **产出**：`bus.ts` 从 `im-connect/message` 取 `kind==='group'` 消息，chatId 用 `group_id`；每群人格映射沿用 WP2。
- **验收**：模拟注入群消息触发提炼，条目可归因发言人；与私聊消息互不串扰。
- **commit**: `feat(bus): 群消息接入缓冲与提炼管线`
- **量级**：0.5 天。

### G5 · 灰度验证与运维（1 天，依赖 G4）
- **目标**：一个真实测试群灰度 1 天。
- **产出**：灰度记录写入 `docs/RUNBOOK.md`；重点观察：消息重复（messageId 形态变化）、-14 频率、媒体下载失败率；回滚路径 = 关闭群白名单（不动 DM）。
- **验收**：PRD §5 成功标准在群场景复验；连续 24h 无未处理异常。
- **commit**: `release: 微信群旁听灰度验证`
- **量级**：1 天。

**预案总量级**：4 人日（不含 G0 已单列）。**硬前置**：G0 必须先做且结论为 a，否则本节整体冻结。

---

## 7. 验收对照
- 三选一结论：**b，官方协议内无解**（§3b，非含糊）。当前产品主线应回到 PRD §8 修订方向 B+A（被 @ 群消息经其他渠道 / 私聊聚合之外的落地路径）或等待平台。
- 官方能力来源：≥4 个独立来源（§2 ①②③④⑤⑥），其中反例 ④ 已被降级为传闻并说明理由；微信官方无公开文档这一点已明确标注。
- 子任务：6 项（G0–G5），含验收标准、commit message、依赖与风险，可直接分派。
