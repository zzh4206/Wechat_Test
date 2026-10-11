# SPIKE 报告：im-connect 入站消息与 Cordis 事件总线（WP0）

> 结论先行：**未被 @ 的普通群聊消息，外部插件不能只读旁听到（针对微信渠道则连被 @ 的都没有——该渠道不产生群消息）。**
> 外部插件唯一可稳定订阅的入口是宿主（DSH）自身发出的 `agent/inbox/inserted` 事件，但它只在 im-connect 真正把消息注入 agent 会话之后才触发，而未被 @ 的群消息在 im-connect 内部就已被丢弃，永远到不了会话。

考察对象：`vendor/dsh-im-connect`（只读参考副本，@michengai/dsh-im-connect 0.1.72 同版），宿主 `app.asar` 二进制中 `agent/inbox/*` 的发射点已交叉确证。以下行号均指 vendor 副本。

## 1. 入站消息完整路径（源码追踪）

```
平台回调/长连接
  → src/channels/<channel>.ts  解析为 ImMessage，调 handler（即 gateway.handleInbound）
      - weixin.ts:668-673   构造消息（无 kind 字段 ⇒ dm；无群概念，见 §4）
  → src/engine/gateway.ts:388  handleInbound(channelId, msg)
      - :392-393  messageId 去重
      - :394-399  decideAccess()（engine/access.ts:17-26）：
            kind==='group' && addressed===false  ⇒  'ignore' ⇒ 直接 return（:399）
      - :427-448  /命令 处理
      - :496-505  合并窗口（merger.ingest）
  → gateway.ts:594  inject(channel, msg)
      - :605-608  router.getOrCreate(channelId, kind, chatId) → sessionId
      - :610-618  组装 content=[{type:'text',text}]（原始文本，未 @ 消息已不存在于此）
      - :640-646  router.followup(...) → 宿主 agent.followup()
  → 宿主把消息 splice 进 agent.inbox，emit 'agent/inbox/inserted' { agent, message }
```

关键点：im-connect **自己从不向 Cordis 总线 emit 任何"原始消息"事件**。全仓库对 `ctx.emit`/`dispatch.emit` 的自定义出站事件为零（`grep -rn "emit(" src/` 仅命中 quiet-logger 与插件更新 UI）。它在 gateway.ts:185-235 里只是**订阅方**（`agent/inbox/<kind>`、`session/event`、`agent/assistant-stream` 等，均带 `{ global: true }`）。

## 2. 核心问题：能否旁听未被 @ 的群消息？

### 判定：不能

- `decideAccess`（src/engine/access.ts:22-23）：群消息 `addressed === false` 直接返回 `'ignore'`；
- `handleInbound`（src/engine/gateway.ts:394-399）：`decision === 'ignore'` 时 `return`，消息在此**静默蒸发**——不进合并窗口、不进 inject、不产生任何事件；
- `addressed` 的来源（渠道侧）：
  - feishu.ts:145,209-210：群消息未 @ 机器人在渠道层直接丢弃；
  - telegram.ts:212-233：未 @ 时 `continue` 丢弃（相册逻辑除外）；
  - discord.ts:324,516-519：未 @ 的消息仍会调 handler 传给引擎（`:517`），但进入 gateway 后同样被 access ignore——是全链路中最接近"能摸到原文"的位置，但依旧无事件；
  - qq.ts:293、wecom.ts:284/337、dingtalk.ts:264：恒 `addressed: true`（平台机器人协议本身只推送 @ 消息）。

### 唯一可订阅的候选事件：`agent/inbox/inserted`

宿主（app.asar 内）在每次向 agent inbox 插入消息时 `dispatch.emit("agent/inbox/inserted", { agent, message })`；配套还有 `agent/inbox/claimed { message, turn }`、`agent/inbox/discarded { message }`、`agent/inbox/spliced`。im-connect 自己就是这么消费的（gateway.ts:188-196）。

**但该事件只在消息已通过 access 过滤、已注入会话之后触发**，因此：

| 消息类型 | `agent/inbox/inserted` 可见？ |
|---|---|
| 私聊（白名单用户） | ✅ 可见 |
| 群聊、@ 了机器人的消息 | ✅ 可见 |
| **群聊、未被 @ 的普通消息** | ❌ **不可见（在 im-connect 内部被丢弃，从未产生宿主事件）** |

### payload 结构（脱敏样例）

```jsonc
// ctx.on('agent/inbox/inserted', ({ agent, message }) => …)   { global: true }
{
  "agent": {
    "id": "agent-xxxx",
    "session": { "id": "im:qq_abc:group:1731290000000:g-DEMO01" }
  },
  "message": {
    "id": "msg-uuid-demo",
    "role": "user",
    "content": [ { "type": "text", "text": "@助理 帮我总结一下刚才的讨论" } ],
    "source": { "kind": "user", "rpcId": "request-uuid-demo" }
  }
}
```

字段清单与来源映射（message 本体是宿主的 user message，不含 ImMessage 全部字段）：

| 旁听者想要 | 从哪拿 | 说明 |
|---|---|---|
| channel | 解析 `agent.session.id`（`im:<channelInstance>:<kind>:<stamp>:<chatId>`） | engine/session-id.ts:14-16,55-77 `parseImSessionId` |
| 群标识 chatId | 同上，第 4 段 | `g-DEMO01` 等 |
| 群/私聊判定 | 同上，第 2 段 `kind` ∈ {`group`,`dm`} | **没有 isGroup 布尔字段，只能解析 sessionId** |
| sender/userId | ❌ 事件里没有 | im-connect 存在内存 map `sessionActors`（gateway.ts:620），不外发；`/delivery` 记录里有但那是私聊。群消息发送人身份拿不到 |
| username | ❌ 同上 | 仅作会话标题落过盘 |
| text | `message.content[].text` | 被 @ 消息的原文（含 "@助理 " 前缀，渠道是否剥离视渠道而定） |
| messageId | `message.source.rpcId`（= im-connect 生成的 requestId，gateway.ts:624）或 `message.id` | 不是平台原生消息 id |
| addressed/kind（ImMessage 层） | ❌ 不在 payload | 只能由 sessionId 推 kind |

### im-connect 的会话记录（旁路数据源，有限可用）

`~/.dsh/dsh-im-connect/` 下的 store/delivery 文件含有 `SessionRecord { sessionId, channel, kind, chatId, title }`（engine/session-id.ts:20-31），可建立 sessionId ↔ 群 的映射表，弥补 payload 里没有 chatId 平台原文的问题。**运行时实时性差，只能做静态映射辅助，不是消息流。**

## 3. 降级方案评估

| 方案 | 能拿到什么 | 改动面 | 评估 |
|---|---|---|---|
| A. 订阅 `agent/inbox/inserted`（现宿主即可用） | 仅被 @ 的群消息 + 全部私聊 | 0（纯外部插件） | MVP 可先落地"被 @ 内容"侧的提炼；与 PRD"旁听闲聊"目标不符，只算部分实现 |
| B. 读 im-connect 会话/投递落盘文件（只读 tail） | 元数据（哪个群活跃），无文本 | 0 | 只能当活跃度信号，且跨插件读它的私有状态文件耦合脆弱 |
| C. **上游 issue：请求 MichengAI/dsh-im-connect 增加只读出站事件**（如 `im-connect/message <ImMessage>`，在 handleInbound 入口、access 过滤**之前** emit，或在 access.ts 加 `'observe'` 分支） | 全部原始群消息 | 上游一个小 patch：gateway.ts:394 前插一次 `ctx.emit(...)`；对本插件改动面 0 | **推荐主路径**。上游已大量使用 `{global:true}` 事件总线（gateway.ts:185-235），加一个出站事件风格一致、改动 <10 行 |
| D. fork / 本地 patch im-connect | 全部 | 违背仓库约定（README"不 fork、不修改"）；升级即失效 | 仅作最后手段，不采用 |
| E. 绕过 im-connect 直连平台（如微信 ilink、QQ 官方）自建只读通道 | 全部 | 大：自研渠道接入 | 超出 MVP；微信 ilink bot 协议本身私聊 only，群聊需别的协议 |

### 上游 issue 英文草稿（方案 C）

> **Title:** Feature request: emit a read-only inbound message event for companion plugins
>
> Hi, I'm building a companion Cordis plugin that passively summarizes group conversations (never sends anything). I found that un-@'d group messages are silently dropped in `ImEngine.handleInbound` via `decideAccess` returning `'ignore'` (src/engine/access.ts, src/engine/gateway.ts), so they never reach the agent session and are invisible on the event bus. Only addressed messages can be observed externally via the host's `agent/inbox/inserted` event.
>
> Would you consider emitting a lightweight read-only event, e.g. `ctx.emit('im-connect/message', { channel, message })` at the top of `handleInbound` (before dedup/access filtering), or letting `decideAccess` return an `'observe'` outcome for group messages that are ignored but still observable? Plugins could then subscribe with `{ global: true }` without affecting the reply pipeline at all. I'm happy to send a PR if the general shape sounds acceptable.

## 4. 微信渠道专项说明

vendor 副本的 `src/channels/weixin.ts` 是 **ilink bot 私聊通道**：入站消息的 `chatId`/`userId` 都是 `fromUserId`，**不设置 `kind`（engine 侧按缺省当 dm，gateway.ts:605）、全文件无任何 group 逻辑**（weixin.ts:668-673）。即：当前版本的 im-connect **根本不支持微信群聊**。本项目要旁听微信群的第一个前置条件不是事件总线，而是上游需要支持微信群的接入方式（或本项目走方案 E 自建）。

## 5. 风险

- `agent/inbox/inserted` 是宿主事件，payload 形状（`message.content`、`message.source.rpcId`）随 DSH 版本演进（app.asar 内文档自述"载荷刻意最小"），需在 dsh 0.2.0-rc.2 上钉死并加防御性解析。
- 事件无渠道字段，sessionId 解析是唯一来源；im-connect 更名 instance id（`<channel>_<stable>`，session-id.ts:13）时前缀仍以 `_` 前平台名开头，解析逻辑需按 `parseImSessionId` 同款规则实现。
- `session/event` / `agent/assistant-stream`（gateway.ts:197-205）承载的是**助手输出**与回合事件，不是用户入站消息，不能作为消息源；`agent/inbox` 的确是"注入给 DSH 会话的任务文本"，TECH-DESIGN §1.3 的怀疑成立。
- 方案 A 下拿不到发送者身份，"viewpoint/quote 谁说的"类条目在群场景无法归因（除非上游方案 C 的 payload 带上 `userId/username`——issue 草稿里应补充请求这一点）。

## 6. 验收回答

**未被 @ 的普通群聊消息，外部插件能否只读旁听？——不能。**
依据：access.ts:22-23（`addressed===false ⇒ 'ignore'`）+ gateway.ts:399（ignore 即 return，之后无任何 emit）；im-connect 全库无自定义出站事件；宿主 `agent/inbox/inserted` 只在 inject 之后触发。唯一例外是 discord 渠道未 @ 消息会流经 handler（discord.ts:517），但同样终止于 gateway 的 ignore 分支，外部不可见。
