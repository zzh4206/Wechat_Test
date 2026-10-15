# 调查报告：微信 4.x mac "AX 树封闭"问题——误判复盘与成熟方案调研

> 编号：REPORT-AX-RESEARCH-2026-10-15
> 背景：sender 键序依赖"文件传输助手是当前打开的会话"这一人工前提，会话不符时粘贴+回车将**误发到错误会话**（P0 级隐患，用户 2026-10-15 明确指出）。排查"发送前合规检测"方案时，此前"微信 4.x mac AX 树封闭"的结论成为路线 B（AX 标题核验）的拦路石，故立项本调查。
> 调查人：PM（配合 DSH 宿主同款运行时实测 + 社区方案研究）
> 性质：技术调查，未修改任何产品代码

---

## 1. 问题定义

发送合规闸需要回答一个问题：**"微信当前打开的会话，是不是文件传输助手？"**

若能在粘贴前回答，误发风险归零。回答手段的候选：

| 路线 | 手段 | 前置依赖 |
|---|---|---|
| A | 截图 + OCR 标题核验（wechat-ui read，工具仓库现成） | 屏幕录制权限 |
| B | AX 读取窗口标题/焦点元素 | 辅助功能权限（已有） |
| C | 侧栏定位 + 点击跳转（从根上不依赖当前会话） | 辅助功能权限（已有） |

路线 B 曾被我们自己的诊断**否决**，依据是"微信 4.x mac 的 AX 树封闭"。本调查复核这一结论。

## 2. "AX 树封闭"结论的由来与复盘

### 2.1 我们当时的诊断证据

2026-10-14/15 期间多次诊断，记录如下：

| 诊断 | 结果 |
|---|---|
| System Events：`count of windows of process "WeChat"` | **时好时坏**：有时 1（position/size 可读 0,34 856x1007），有时"无效的索引"（零窗口）——**微信进程明明活着** |
| System Events：深度遍历 `UI elements of window 1`（递归 4–5 层） | 只见窗口三键（关闭/最小化/全屏），无任何内容控件 |
| System Events：搜索含"搜索"描述/AXTextField 的元素 | 零命中 |
| 全程 | 辅助功能与自动化权限**均已授权**（Esc 键码发送成功实证） |

结论当时写作："微信 4.x 的 AX 树封闭/不暴露"。

### 2.2 复盘：三个方法论缺陷

**缺陷一：工具不对等。** 我们用 System Events 的 AppleScript 桥做 AX 遍历。对自定义 AX 实现（WeChat 4.x 为 Qt 自绘 + 私有 `mmui::` 控件体系），AppleScript 桥的枚举能力显著弱于原生 `AXUIElementCopyAttributeValue` 直连——后者才是辅助功能 API 的一等公民。

**缺陷二：时机不对。** 微信的 AX 树是**懒物化**的：视图销毁/重建期间整棵树暂时消失（这正是我们反复撞上的"无效的索引"），搜索浮层弹出时主树还会进一步收敛。我们的遍历恰好多次发生在这些窗口期。社区实现为此准备了专门对策（见 §3.1：树就绪检查 + `ensure_materialized` 唤醒 + 唤醒后重新锚定根控件——"旧句柄指向的是唤醒前的空壳"）。

**缺陷三：深度与枚举方式。** 我们递归 4–5 层即止。社区实现把深度上限设到 40（微信真实树只有十几层，但视图销毁期会出现病态深链/环链，必须防爆栈），并用批量属性读把每节点成本降为 1/4。

### 2.3 结论修正

**"AX 树封闭"不成立。** 准确表述应为："**System Events AppleScript 桥在我们的诊断时机下，未能枚举微信 4.x 的 AX 树**"。微信的 AX 树真实存在且信息丰富（见 §3），但需要原生 AX API + 树就绪处理才能读到。

## 3. 社区实证：微信 4.x mac 的 AX 树真实形态

### 3.1 wechat-mcp（MIT，BiboyQG/WeChat-MCP 的 fork）

dustin573/wechat-mcp：通过**系统 AX API 直连**（AXUIElementCreateApplication → AXUIElementCopyAttributeValue 树遍历 + 合成鼠标/滚轮事件）读写 macOS 微信 4.x 客户端。明确定位："无微信 API、无协议逆向、无数据库爬取、无注入代码——驱动的是 VoiceOver 读的同一棵树，微信无法分辨它和真人"。**针对 WeChat 4.x 构建**。关键实证：

| AX 能力 | 细节 |
|---|---|
| 侧栏会话行 | 标识符形如 `session_item_<name>`，整行 AXTitle 打包 `<显示名>\n<发送者>: <最后消息>\n<时间戳>`——**2.5 秒读完全部会话列表，无需打开任何会话** |
| 会话打开确认 | `chat_message_list`（AXList）出现 = 目标会话已打开（确定性判据） |
| 消息行 | `chat_bubble_item_view` / `virtual_cell`，文本从 AX 树直读；行分类 message / timestamp / system |
| 发送 | `reply_to_messages_by_chat(chat_name, msg)`：侧栏定位行 → 合成鼠标点击打开 → 确认列表出现 → 发送 |
| 已知陷阱（均已总结对策） | ① 行按 (name, y 坐标) 键控（列表回收 + 重名会话）；② 深度上限 40（销毁期病态深链）；③ 批量属性读省 4 倍成本；④ 调用必须串行；⑤ 搜索框"故意不用"（会改变状态、可能落在联系人而非会话）——**与我们的判断互相印证** |
| AX 读不到的部分 | 发送者归属（行横跨全宽）、附件本体——需像素分析/截图，**我们的场景不需要** |

### 3.2 wechatauto-replica（Windows 侧佐证）

PyPI 项目，微信 4.x **Windows** 客户端自动化。其版本史证实：微信 4.x 全平台采用 **Qt 自绘渲染 + 无障碍门（accessibility gate）默认关闭**——冷启动时 AX 只见 `Qt51514QWindowIcon` 空壳。其 Windows 解法是**热激活**：RVA 扫描定位 Weixin.dll 内的 Qt accessibility gate 标志位并写内存开启，物化 `mmui::*` UIA 树。

**对 mac 的含义**：等价操作 = 写微信进程内存。**踩红线第一条（不碰微信进程），排除**。macOS 幸运地不需要这条路：mac 微信的 AX 树经 wechat-mcp 实证是可读的（§3.1），无需任何内存操作。

### 3.3 微信 4.x mac 的 UI 框架

公开报道确认微信 4.0 桌面端为 **Qt + C++ 跨平台重写**。Qt 的 macOS 无障碍桥默认惰性/不完整，这正是"System Events 看到空壳"的框架层根源——是微信的适配欠账，不是不可逾越的系统限制。

## 4. 方案评估（修订版）

| 路线 | 修订后评估 |
|---|---|
| A. wechat-ui read OCR 核验 | ✅ 成熟现成，保留——作为**发送后**DB 回读之外的界面级核验可选，或作为 C 的定位确认辅助；需屏幕录制权限 |
| B. AX 标题核验 | ✅ **复活**——改用原生 AX API 直连（绕开 System Events 局限），可读侧栏 `session_item_` 行确认文件传输助手会话存在与状态；零新增权限 |
| C. 侧栏定位跳转 | ✅ **复活**——wechat-mcp 已实证"侧栏行点击打开指定会话"的确定性；配合 B 的行标识符（`session_item_文件传输助手`）天然实现白名单式定位（**只点名字精确匹配的行**，任何模糊/缺失都不点击） |
| D. DB 写库 / 协议逆向 / 进程内存 | ❌ 维持排除（红线） |
| E. 无定位、依赖当前会话（现状） | ❌ 误发风险源头，C 落地后废除 |

**推荐组合**：C（AX 侧栏定位打开会话）→ B'（AX 确认 `chat_message_list` 就绪）→ 粘贴 → 回车 → DB 回读验证（既有 P0 兜底不变）。

## 5. 遗留风险与对策

| 风险 | 对策 |
|---|---|
| 微信 AX 树懒物化/销毁期不稳定 | 树就绪检查 + 重试 + 唤醒重锚定（wechat-mcp/wechatauto 双方均有成熟模式） |
| 重名会话（两个群同名） | 行按 (name, y) 键控 + 只认精确名匹配行，缺失即 defer |
| AX 遍历性能（每节点属性读） | 批量属性读（单次往返），侧栏全量 ~2.5s |
| AppleScript 桥与原生 API 行为差异 | **不再使用 System Events 做 AX 读取**；按键仍可用（已实证） |

## 6. 结论

1. "微信 4.x mac AX 树封闭"**结论修正为**："AppleScript 桥 + 不当时机下的枚举失败"；原生 AX API 直连下，侧栏行/消息行/会话确认均可用；
2. 发送前合规检测存在**成熟、零新增权限、社区已验证**的实现路径（AX 侧栏定位 + `chat_message_list` 确认）；
3. 建议：先做一次对本机微信 4.1.13 的 AX 实证（分钟级），通过后按计划报告实施。

## 7. 参考来源

- dustin573/wechat-mcp（MIT）：https://github.com/dustin573/wechat-mcp
- BiboyQG/WeChat-MCP（MIT，上游）：https://github.com/BiboyQG/WeChat-MCP
- wechatauto-replica（Windows 侧佐证）：https://pypi.org/project/wechatauto-replica/1.2.4.1/
- 微信 4.0 桌面端 Qt 重写报道：https://cloud.tencent.cn/developer/article/2463831
- 本仓内部实证：audit/sender.jsonl、/tmp 诊断记录、spike-search-shortcut.sh
