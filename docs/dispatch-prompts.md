# 分派指令（可直接粘贴给编码 agent）

> 用法：整段复制给新对话。WP0 已外派；WP1 与 WP0 无依赖，可并行。

## WP1 · 插件骨架与安全地基

```text
你是编码 agent，执行 dsh-group-lurker 项目的 WP1 任务：插件骨架与安全地基。

## 背景（必读）
- 仓库：$HOME/WeChat/2水群（先读 README.md、docs/PRD.md、docs/TECH-DESIGN.md，尤其 TECH-DESIGN §1.1、§1.2、§3）
- 项目：DSH (DeepSeek Harness) Cordis 插件 @zzh4206/dsh-group-lurker，MVP 只观察群聊、不发消息。
- 只读参考（了解 Cordis 插件写法）：vendor/dsh-im-connect/src/index.ts；禁止修改 vendor、禁止让本项目源码 import vendor。

## 任务
1. 按 TECH-DESIGN §1.1 建包：package.json（type module、main lib/index.js、exports 含 ./cordis.patch.yml、peerDependencies 按 §1.1、dsh.bundle.patch）、cordis.patch.yml（insert id group-lurker）、tsconfig.json。
2. src/index.ts：name='dsh-group-lurker'、inject 仅 ['llm']、Config schema 按 §1.2（stateDir 默认 ~/.dsh/dsh-group-lurker、groups 白名单数组默认空、bufferSize 60、distillEveryMessages 25、distillIntervalMin 15、persona 'default'）；apply 中仅注册 ctx.effect 与 logger，占位导出后续模块接口；确保 dispose 干净（所有定时器/监听走 ctx.effect 或 ctx.on）。
3. src/guard.ts：
   - sanitize(raw: string): object —— 把消息原文封装为纯数据字段（JSON 字符串化后拼接），并截断超长（默认 2000 字符）
   - assertInsideState(base: string, target: string): void —— 路径解析后断言 target 在 base 内，否则抛错
   - TokenBucket：每群令牌桶（默认 1 条/秒，突发 5），超限丢弃并计数
4. src/store.ts：项目内唯一 fs 写入点；ensureDir/appendJsonl/appendText 均先过 assertInsideState；写失败只记 logger 不抛出致命错误。
5. 测试（node:test，tests/ 目录）：
   - no-send.test.mjs：grep 断言 src/ 与最终产物不含 send/deliver/postMessage/reply 等发送类调用（列出精确黑名单词表）
   - path-guard.test.mjs：assertInsideState 对 ../、绝对路径逃逸、符号链接形态的用例
   - token-bucket.test.mjs：限流与恢复
   - 通过 node --test tests/ 全绿；构建 npm run build 通过（tsc）
6. 不实现 bus/buffer/distiller/persona（WP2/WP3 范围）；不碰 ~/.dsh（本地加载验证由项目经理执行）；不 commit。

## 验收标准
- npm run build 与 node --test tests/ 全部通过（在报告中贴输出）
- src/index.ts 的 inject 数组仅含 'llm'
- 报告中说明：如何保证 dispose 无残留定时器（引用具体代码位置）
```
