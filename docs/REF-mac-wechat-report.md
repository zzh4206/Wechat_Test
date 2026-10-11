# 技术报告：macOS 端微信群聊消息读取与自动应答

> 参考项目：[sanjiao403/wx-chatbot](https://github.com/sanjiao403/wx-chatbot)（微信后台智能体）
> 本报告基于 macOS 环境评估其技术路线的可移植性，并针对「加入群聊」这一需求给出方案。
> 日期：2025（供内部讨论）

---

## 1. 参考项目技术路线回顾

wx-chatbot（Windows 实现）的核心链路：

```
微信加密数据库 ──SIWX 解密──▶ 明文库 ──▶ reader.py 按会话读取
      │
      ▼
main.py 心跳循环
      │  presence.py   作息闸门（调模型之前拦截）
      │  guard.py      内容闸门（钱财话题入站注入约束 / 出站复核）
      ▼
agent.py 调用 LLM（persona.md 人设 + 强约束 JSON 输出）
      │
      ▼
transport.py 发送（Win32 键盘 + 剪贴板注入到微信窗口）
```

其架构精髓不在具体 API，而在三条原则：

1. **不侵入微信进程**：只读本机磁盘上的聊天数据库 + 模拟键鼠操作自己的客户端窗口；
2. **安全约束硬编码在模型之外**：模型只决定「说什么」，「能不能说」由纯代码闸门决定；
3. **隐私与仓库隔离**：私人数据集中在不入库的 `private/`，提交钩子做泄露硬闸门。

---

## 2. macOS 平台可行性：逐环节对照

| 环节 | Windows 实现 | macOS 对应方案 | 可行性 |
|---|---|---|---|
| 数据库读取 | SIWX 解密 Windows 微信 SQLCipher 库 | 读 macOS 微信本地库（见 2.1） | ✅ 有替代路线 |
| 消息发送 | Win32 `SendInput` + 剪贴板 | AppleScript System Events / CGEvent + `NSPasteboard` | ⚠️ 可行但更脆弱 |
| 窗口/前台检测 | Win32 `GetForegroundWindow` | `NSWorkspace.frontmostApplication` + Accessibility API | ✅ |
| 单实例锁 | Windows 命名互斥量 | `flock` 锁文件 / `NSDistributedLock` | ✅ |
| 看门狗/计划任务 | 计划任务 + VBS | `launchd`（LaunchAgent） | ✅ 更简洁 |

### 2.1 读取：macOS 微信本地数据库

**关键结论：SIWX 本身不可用**（它解析的是 Windows 版微信的库结构），但 macOS 微信同样把聊天记录落在本机 SQLite 库中，思路可以照搬、实现需要换。

- 数据位置（历史版本）：`~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/<版本>/<hash>/Message/` 下的 `msg_*.db`、`session.msg`，联系人 / 群信息在 `BulletinCache`、`mmsetting.archive` 等文件；旧版本部分库**未加密可直接打开**，新版本逐版本引入加密（SQLCipher 类，key 与登录态相关）。
- 上游不可控：库路径、表结构、加密方式随微信 macOS 版本变动，**没有官方 API 和稳定性承诺**。社区工具（如 wechat-dump-rs 等支持 macOS 的解密/导出项目）可作参考，但需自行评估版本兼容。
- 因此读取层应设计为**适配器接口**：

```python
class MessageReader(Protocol):
    def poll(self) -> list[Message]: ...
    def contacts(self) -> dict[Wxid, Name]: ...
    def group_members(self, chatroom_id: str) -> dict[Wxid, GroupNickname]: ...
```

具体实现（直读 SQLite / 调外部解密工具）藏在适配器后面，微信版本升级只改一处。

> ⚠️ 风险提示：读取层是整个方案中对微信客户端版本**依赖最强、最易失效**的一环，必须先在本机当前微信版本上验证库是否可读、key 是否可得，再决定后续投入。

### 2.2 发送：macOS 窗口自动化

macOS 上等价于「Win32 键盘 + 剪贴板注入」的组合：

1. 用 AppleScript（System Events）或 Accessibility API 激活微信窗口、聚焦搜索框；
2. 通过 `NSPasteboard` 写入文本，模拟 `Cmd+V` 粘贴到会话输入框；
3. 模拟 `Return` 发送。

等价的安全闸门全部可以实现：
- `dry_run` 时不触发任何 CGEvent / AppleScript 按键；
- 发送前用 `NSWorkspace` 检查微信是否仍是前台应用、用户是否正在操作键鼠（`CGEventSourceSecondsSinceLastEventType`），不满足即中止；
- 辅助功能权限（Accessibility）需在系统设置中一次性授权。

对比 Windows 版，macOS 的薄弱点：AppleScript 对微信内部控件几乎无句柄级控制（微信未提供脚本字典），比 Win32 更依赖坐标/焦点，**建议发送文本一律走剪贴板粘贴而非逐键模拟**，避免中文输入法干扰。

### 2.3 进程管理

- 单实例：`flock` 一个锁文件即可（比命名互斥量还简单）；
- 常驻：`launchd` LaunchAgent，`KeepAlive=true`，天然替代「计划任务 + VBS 看门狗」，日志重定向到 `private/logs/`；
- 停止开关：沿用 `private/STOP` 文件设计。

---

## 3. 「加入群聊」需求分析

### 3.1 读取群消息：完全可行（见前次讨论）

- 群聊与单聊消息同表存储，群会话对端是 `xxxxx@chatroom`；
- 需要补充的映射工作：
  1. **发送者剥离**：`IsSender=0` 时消息正文形如 `wxid_xxx:\n内容`，需切分出真实发送者与正文，并过滤系统消息（拍一拍、撤回、入群提示）；
  2. **wxid → 昵称映射**：从联系人库 + 群成员库查群内昵称，组装 `昵称: 内容` 时间线给 LLM；
  3. **上下文策略**：按群分桶维护最近 N 条时间线。

### 3.2 「加入群聊」的正确边界

**必须明确：本方案不能、也不应自动「加入」任何群。**

- 读取层只能读到**本账号已经在的群**的数据；
- 微信没有任何受支持的「自动入群」接口；绕过（伪造邀请、协议模拟）即越界到协议逆向，违背参考项目「不侵入、不伪造协议」的根本原则，法律与封号风险完全不可接受；
- 因此需求应收窄为：**「bot 以本人账号身份，在其已加入的群中读取消息并按策略应答」**。入群仍由真人手动完成。

### 3.3 群聊触发策略（新增设计点）

一对一场景 bot 对每条消息响应即可；群聊必须收敛发言面：

| 策略 | 说明 | 建议 |
|---|---|---|
| 被 @ 触发 | 解析 @bot昵称 的消息 | ✅ 主策略，最安全 |
| 关键词触发 | 命中白名单关键词才回 | ✅ 辅助 |
| 自由插话 | 按概率/冷却插话 | ⛔ 默认关闭 |
| 冷却与频控 | 每群独立冷却 + 全局日配额 | ✅ 必须 |
| 免打扰名单 | 指定群/指定人永不回复 | ✅ 必须 |

### 3.4 群聊场景的安全闸门升级

复用 `presence` / `guard` 分层，群聊额外增加：

1. **白名单群闸门**：只有配置里列出的群才读、才回（读取也可全量，回复必须白名单）；
2. **人设风险**：在多人群里以特定真人语气说话，欺骗性和传播面远大于一对一——建议群内人设降级为「助手」而非「拟人」，或在群里只以本人明确同意的方式发言；
3. **出站复核范围扩大**：`guard.py` 的越界检查（钱财、隐私、涉及第三人）在群聊下逐条强制执行，禁止群内 @ 具体第三人评价性发言。

---

## 4. 系统架构（macOS 版）

```
~/Library/.../com.tencent.xinWeChat 本地库
        │  reader 适配器（SQLite 直读 / 外部解密工具，待验证）
        ▼
main.py 心跳循环（launchd 常驻，flock 单实例）
        │
        ├── presence.py   作息闸门
        ├── group_gate.py 群白名单 + @检测 + 频控   ← 新增
        ├── guard.py      内容闸门（入站注入 / 出站复核）
        ▼
   agent.py  LLM 决策（群聊时间线上下文 + 强约束 JSON）
        ▼
   transport.py  NSPasteboard + CGEvent/AppleScript 粘贴发送
        （dry_run / 前台检测 / 用户占用检测 三重闸门）
```

隐私设计照搬参考项目：`private/` 为唯一隐私闸门（含群聊日志——群消息涉及第三人，**日志保留期应更短**），pre-commit 隐私扫描照搬。

---

## 5. 结论与下一步

**结论**：wx-chatbot 的架构（数据库读 + 心跳 + 模型外硬闸门 + 模拟键鼠发）在 macOS 上整体可移植；SIWX 需替换为 macOS 本地库读取适配器，发送层换成剪贴板 + AppleScript/CGEvent。「加入群聊」应定义为「在已加入的群中读取并按白名单/@策略应答」，不做任何自动入群。

**下一步（按风险排序）**：

1. **验证读取层**：在本机当前微信 macOS 版本上确认聊天库是否可读、加密与 key 情况（决定整个方案生死的一步）；
2. 验证发送层：手动跑通「剪贴板粘贴 + 回车」到微信窗口的自动化，含前台检测；
3. 实现群聊读取原型：列出群会话、剥离发送者、映射昵称；
4. 再叠加闸门（presence / group_gate / guard）与 LLM 决策层。

**主要风险**：微信版本升级随时可能破坏读取层；macOS 系统权限（辅助功能、磁盘访问）需要人工授权；群聊自动化对群里真人造成的打扰与欺骗风险高于一对一，需事先取得群内相关人员的知情同意。
