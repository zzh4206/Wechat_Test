# patches/ — @michengai/dsh-im-connect 本地只读事件补丁（WP0.5）

## 原理

im-connect 0.1.72 中，未被 @ 的群消息在 `handleInbound` 里经 `decideAccess`
判 `ignore` 后直接 return，且全库无出站事件（WP0 已验收结论）。
本补丁在 **access 过滤之前、seen 去重之后** 插入一行只读广播：

```js
this.ctx.emit('im-connect/message', { channel, message: msg });
```

- Gateway 构造函数持有 `private readonly ctx: Context`（cordis Context，自带
  `emit`），`channel` 是该作用域已有的 `ChannelAdapter`（含 `id`/`label`），
  `msg` 是完整 `ImMessage`。
- **插入点选在去重之后**：重复投递的同一 `messageId` 不应重复刷事件；
  **在 `decideAccess` 之前**：保证被 ignore 的消息也进入总线，这正是本任务目标。
- 广播是同步、无返回值消费的 emit，不改变任何既有分支/返回路径；不改 `.d.ts`
  （事件为字符串字面量，无类型导出需求）。

## 插入点（文件:行号）

- 源码参考：`vendor/dsh-im-connect/src/engine/gateway.ts` — `handleInbound`
  定义于 **L388**，去重两行在 **L392–393**，`decideAccess` 在 **L394**。
- 补丁实际目标（profile 安装的是编译产物）：
  `lib/engine/gateway.js` — `handleInbound` 定义于 **L342**，去重结束于
  **L349**，插入新行位于 **L350–351**（注释 + emit），`decideAccess` 顺延为 L352。
- 校验基准：vendor 副本与 profile 安装文件的 `gateway.js` SHA1 一致
  （`7c6d4dafd7216f4254f74c84d019c89d2d96fe7a`），补丁可精确套用。

## 补丁文件

- `im-connect-0.1.72-emit-inbound-message.patch` — 针对
  `lib/engine/gateway.js` 的 unified diff（+2 行）。

## 重放步骤（pnpm patch 不可用时的退化方案，可重复执行）

> 本机 sandbox 限制导致 pnpm/corepack 无法运行，故采用 `patch(1)` 方案。
> 若环境允许 pnpm，也可用标准流程 `pnpm patch @michengai/dsh-im-connect@0.1.72`
> 做同样 2 行修改，效果等价。

```sh
cd ~/.dsh/profiles/web/node_modules/@michengai/dsh-im-connect
patch -p1 < $HOME/WeChat/2水群/patches/im-connect-0.1.72-emit-inbound-message.patch
```

幂等性：重复执行时 `patch` 会检测到已应用并提示 `Reversed (or previously
applied) patch`，选 `N` 跳过即可，不会重复插入。也可先校验基准：

```sh
shasum -c <<< '7c6d4dafd7216f4254f74c84d019c89d2d96fe7a  lib/engine/gateway.js'
```

应用后重启 DSH profile 生效（编译产物直接改，无需构建）。

## 验证步骤

用 `spikes/bus-probe.mjs`（已含 `'im-connect/message'` 候选事件，只打印脱敏
字段，不落群数据）：

1. `cd ~/.dsh/profiles/web && pnpm add file:$HOME/WeChat/2水群`
2. 在 `cordis.patch.yml` 顶部临时加：
   `- id: group-lurker-probe` / `name: "@zzh4206/dsh-group-lurker/spike-bus-probe"`
3. 重启 DSH，在群里**不 @ 机器人**发一条消息，观察日志
   `[bus-probe] event=im-connect/message shape={"__keys":["channel","message"],...}`。
4. 验证完从 `cordis.patch.yml` 删除该条目并 `pnpm remove` 该链接。

## 回滚步骤

```sh
cd ~/.dsh/profiles/web/node_modules/@michengai/dsh-im-connect
patch -R -p1 < $HOME/WeChat/2水群/patches/im-connect-0.1.72-emit-inbound-message.patch
```

或直接 `pnpm reinstall`/删除 `node_modules/@michengai/dsh-im-connect` 后重装。

## 升级注意

im-connect 版本变化后 `lib/engine/gateway.js` 内容/行号可能漂移，补丁失效
（`patch` 会报 hunk failed）。届时需在新版本副本上重新定位插入点（同一原则：
去重之后、`decideAccess` 之前）并重打补丁。
