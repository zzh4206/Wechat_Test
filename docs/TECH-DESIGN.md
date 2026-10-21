# 技术设计：dsh-group-lurker

> 配套 [PRD.md](./PRD.md)。本文记录经源码考察确认的 DSH 插件机制与本项目的技术方案。

## 1. 宿主机制（已实地考察确认）

DSH 0.2.0-rc.2（本机 `/Applications/DeepSeek Harness.app`）基于 **Cordis 4** 插件框架。

参考样本：本机已安装的社区插件 `@michengai/dsh-im-connect@0.1.72`（`~/.dsh/profiles/web/node_modules/`）。

### 1.1 插件包结构（照此模板）

```
dsh-group-lurker/
├── package.json
├── cordis.patch.yml        # bundle 层：把插件 insert 进 profile
├── tsconfig.json
├── src/
│   ├── index.ts            # cordis 插件入口：name / inject / Config / apply
│   ├── bus.ts              # 监听 im-connect 入站事件
│   ├── buffer.ts           # 每群环形缓冲
│   ├── distiller.ts        # LLM 提炼 → 四类条目
│   ├── persona.ts          # 人格加载与按群覆盖
│   ├── store.ts            # state 目录 JSONL/Markdown 写入（唯一写文件处）
│   └── guard.ts            # 注入防护、限流、写入路径校验
├── web/                    # 本地前端工作台：独立 node 进程，只读 + 只监听 127.0.0.1（见 TECH-DESIGN-frontend.md）
└── tests/
```

> 插件与 web 进程只经 stateDir 下的 `web/` 子目录交换文件：插件启动时写 `web/allowed-chats.json`（白名单 + knowledge.db 路径），
> web 进程只读它；动作通道 `web/actions.jsonl` / `web/action-results.jsonl` 的约定见 RUNBOOK §13。

`package.json` 关键字段（对照 im-connect）：

```jsonc
{
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "0.2.0-rc.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: group-lurker
      name: '@zzh4206/dsh-group-lurker'
```

### 1.2 插件入口签名（TS）

```ts
export const name = 'dsh-group-lurker'
export const inject = ['llm']   // 仅声明真正需要的宿主服务，越少越安全
export const Config = Schema.object({
  stateDir: Schema.string().default(''),       // 默认 ~/.dsh/dsh-group-lurker
  groups: Schema.array(String),                // 允许旁听的 chatId 白名单（空=不监听任何人）
  bufferSize: Schema.number().default(60),     // 每群环形缓冲条数
  distillEveryMessages: Schema.number().default(25),
  distillIntervalMin: Schema.number().default(15),
  persona: Schema.string().default('default'),
})
export function apply(ctx: Context, config: PluginConfig): void
```

### 1.3 消息来源（WP0 需最终钉死的一点）

im-connect 宿主通过 Cordis 事件总线工作，已确认存在 `on('agent/inbox/<kind>')`、
`on('session/event')` 等事件（见其 `src/engine/gateway.ts`）。**WP0 spike 的任务**：
用只读脚本确认「入站群聊文本消息」对应的事件名与 payload 结构，候选路径：

1. `ctx.on('agent/inbox/im', ...)` 通配/分类监听（首选，最干净）
2. 若 1 不含群聊原文，则在 im-connect 的 GitHub（MichengAI/dsh-im-connect）issue/README 找公开事件；仍无则**降级方案**：向该仓库提 issue 请求暴露只读 hook，MVP 先用 session/event 中可见的文本（有限）。

无论哪条路径，本插件**绝不修改 im-connect 的任何文件**。

## 2. 数据流

```
im-connect 入站群消息
        │  (cordis 事件总线, 只读)
        ▼
bus.ts ──白名单/限流/注入消毒──▶ buffer.ts (每群环形缓冲, 内存)
                                      │ 满 N 条或 T 分钟
                                      ▼
                              distiller.ts ──llm 服务──▶ 四类条目(topic/viewpoint/quote/opportunity)
                                      │                    │
                                      ▼                    ▼
                              persona.ts(每群人格)   store.ts → insights.jsonl + reports/*.md
```

## 3. 安全设计（对应 PRD F1）

| 威胁 | 对策 | 实现位置 |
|---|---|---|
| 消息注入（"忽略之前指令"） | 消息文本永远作为 JSON 数据字段传入 LLM（JSON.stringify 后拼接），prompt 指令区不出现原文；提炼输出强制 JSON schema 校验，非法即丢弃 | guard.ts `sanitize()` + distiller 校验 |
| 越权写文件 | store.ts 是唯一 fs 写入点；启动时解析 stateDir 绝对路径，每次写入前断言目标路径 `startsWith(stateDir)` | store.ts + guard.ts `assertInsideState()` |
| 刷屏 DoS | 每群令牌桶（默认 ≤ 1 条/秒入缓冲，超限丢弃计数）；全局缓冲内存上限，超限淘汰最旧群缓冲 | guard.ts |
| 意外发送 | 不 import im-connect 任何发送导出、不持有 channel 句柄；CI 用 grep 断言 src 无 send/deliver 类调用 | tests/no-send.test |
| prompt 越权 | inject 只声明 `llm`；不触碰 permissionPresets/sandbox/credentials | index.ts |
| 资源泄漏 | 所有定时器/监听经 `ctx.effect()` 或 `ctx.on` 注册，dispose 自动回收 | index.ts |

## 4. 日志格式

`state/groups/<chatId>/insights.jsonl`，一行一条：

```json
{"ts":"2026-10-11T12:00:00Z","type":"topic","group":"chatId","title":"周末爬山","summary":"…","actors":["A","B"],"mood":"positive"}
{"ts":"…","type":"viewpoint","group":"…","who":"A","about":"爬山路线","stance":"主张东线","quote":"东线人少"}
{"ts":"…","type":"quote","group":"…","text":"……","reason":"谐音梗，群内可能复用"}
{"ts":"…","type":"opportunity","group":"…","topic":"爬山","angle":"自嘲体力","urgency":"low"}
```

`state/reports/YYYY-MM-DD.md`：按群分节的话题汇总，人读的日报。

隐私：不落原始消息；`viewpoint/quote` 中的引用保持最短必要长度。

## 5. 开发与调试环境事实

- 仓库：`$HOME/WeChat/2水群`（GitHub: zzh4206/Wechat_Test，main 空）
- Node ≥ 24（本机 /usr/local/bin/node v24），包管理 pnpm（`~/.dsh/profiles` 均用 pnpm）
- 本机 profile：`~/.dsh/profiles/web`（`patchReload: live` 已开，可 HMR 热重载插件）
- 本地安装调试：在 profile 的 `package.json` dependencies 加 `"@zzh4206/dsh-group-lurker": "file:$HOME/WeChat/2水群"`，并把 bundle id 加入 `dsh.profile.bundles` 不需要——bundle 由 cordis.patch.yml 的 insert 生效；profile patch 层（cordis.patch.yml）优先级更高，可直接在 profile 的 patch 里 insert 本插件。
- 状态目录默认 `~/.dsh/dsh-group-lurker/`（仓库内**不**存任何真实群数据；`state/` 已 gitignore）
