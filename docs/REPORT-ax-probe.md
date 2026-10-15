# 实证报告：AX 能力探针（WP-AX1 / 闸门 G1）

> 编号：REPORT-AX-PROBE-2026-10-15
> 依据：[PLAN-ax-targeting.md](PLAN-ax-targeting.md) WP-AX1、[REPORT-ax-tree-research.md](REPORT-ax-tree-research.md)
> 探针：[spikes/ax-probe.swift](../spikes/ax-probe.swift)（Swift 单文件，原生 AX API 直连，零外部依赖）+ [spikes/pyprobe.py](../spikes/pyprobe.py)（pyobjc 交叉验证）
> 环境：macOS 15.x，微信 4.1.13（pid 493，`com.tencent.xinWeChat`）小号登录，主窗口打开
> 红线遵守：仅只读 AX 枚举；未点击任何会话/按钮（探针在行定位阶段即终止，未发生任何合成点击）；未写微信进程内存；未碰 cordis.patch.yml / sec-tests

---

## 1. 结论速览

**G1 = 不通过。** 三项实证中第 ① 项（侧栏行可枚举）失败，第 ② 项因无行对象而不可执行，第 ③ 项数据显示内容树在全部采样中均未物化。**未写任何产品代码**（按闸门约定）。

| 实证项 | 判据 | 结果 |
|---|---|---|
| ① 侧栏行可枚举 | dump 出 `session_item_*` 行，文件传输助手可精确匹配 | **✗ 失败**（Swift 与 pyobjc 双载体一致：0 行） |
| ② 点击跳转 + 会话确认 | 点击行中心/AXPress → `chat_message_list` ≤5s | **— 不可执行**（无行对象；策略 A–E 无可点击目标） |
| ③ 稳定性画像 | 窗口"消失/出现"归因、遍历耗时预算 | **数据已取得**：窗口级懒物化实锤；**内容树 15/15 样本未物化** |

## 2. 核心实证数据

### 2.1 AX 树真实形态（原生 AXUIElementCopyAttributeValue 直连）

从 app 元素全量深走（深度≤40，15 轮以上、跨越约 40 分钟多状态采样）：

```
AXApplication "微信"
├─ AXWindow "微信"
│   ├─ AXButton（关闭）      ← 原生 NSWindow 标题栏三键
│   ├─ AXButton（最小化）
│   │   └─ AXGroup（1 层）
│   └─ AXButton（全屏）
├─ AXMenuBar（Apple/微信/文件/编辑/显示/窗口/帮助，完整可读）
├─ AXFunctionRowTopLevelElement
└─ AXMenuBar（辅助）
总节点 191，最大深度 6 —— 其中不含任何微信内容控件
```

- `session_item_*` 行：**0**（多轮 dump 一致）
- `chat_message_list` / `chat_bubble_item_view`：**0**
- 窗口内容树从未出现：即使行定位成功所需的 `session_list`（AXList）也不存在

### 2.2 双载体交叉验证（排除"读法不对"）

| 载体 | 配方 | 结果 |
|---|---|---|
| Swift（本探针） | AXUIElementCreateApplication(pid) → AXWindows/MainWindow → DFS | 窗口内容 = 仅 3 个标题栏按钮 |
| pyobjc venv（复刻 wechat-mcp 原样代码：`activate(0.35s settle)` + DFS，逐行对照其 `wechat_accessibility.py`） | 同上 | **完全一致**：5 节点，0 行 |

两载体走树均为毫秒级（树存在时 0.01s / 5 节点）——工具链没问题，是微信侧没暴露。

### 2.3 实证②多策略探针（A–E）执行记录

探针已实现完整多策略（`--open2`，见 §4），但按红线**只在精确定位到唯一 `session_item_文件传输助手` 行后才点击**。本机该行不可枚举，故：

| 策略 | 内容 | 执行结果 | 用户目视（待填） |
|---|---|---|---|
| 自查 | 行 BoundingRectangle + 中心点 | 不可执行（行不存在） | — |
| A | 坐标点击行几何中心 | 不可执行（无坐标来源） | — |
| B | `AXPress`（含 actionNames 读取） | 不可执行（无元素） | — |
| C | 子节点中找可 AXPress 元素 | 不可执行 | — |
| D | AXRaise + 坐标点击 | 不可执行 | — |
| E | 双击行中心 | 不可执行 | — |
| F | 行完整属性集 + actionNames dump | 降级执行：已 dump **窗口级**属性集（28 个属性）与结构（§2.1） | — |

**对"点击只切到主窗"反馈的归因**：本探针从未发出过合成点击（每次都在行定位失败处退出，exit=3）。切换到主窗的效果来自定位前的**激活步骤**（`NSRunningApplication.activate`，wechat-mcp 同款前置）——这是"切了窗但没跳会话"的确切解释，与"行点击失败"无关：根本没有发生过行点击。

### 2.4 实证③稳定性画像

窗口级懒物化**存在且已量化**（可解释用户/历史观察到的"时而 0,34 856x1007、时而无效的索引"）：

- 后台态：`AXWindows` 返回**空数组**（err=0）——对应历史记录中的"无效的索引"；
- `activate()` 后 0.4s：`AXWindows` 返回 1 个窗口——窗口对象随前台状态物化/回收；
- 细粒度采样（activate 后 250ms 步进 ×40）：窗口在 ~0.4s 出现，之后稳定。

但**内容树物化从未发生**：

| 采样序列 | 条件 | 样本数 | 内容树（节点>6）出现 |
|---|---|---|---|
| `--stability 15`（间隔 1s，混合前台/后台） | 常规 | 15 | **0**（全部 ≤6 节点） |
| activate 后 250ms 步进 | 前台 | 40 | 0 |
| VoiceOver 运行中采样 | 辅助技术激活 | 2 轮 | 0 |
| activate 后 1s 间隔 ×30（diag4，激活风暴期） | 前台重建窗口期 | 30 | 0（此期窗口读全失败 -25205，~30s 后恢复） |

遍历耗时预算（若树可用）：5–6 节点 0.01s，即使全树物化按 wechat-mcp 规模（~2.5s 侧栏）也远低于 60s 消费周期——**性能不是问题，可用性才是**。

### 2.5 已排除的"未物化"解释（尽职清单）

| 手段 | 结果 |
|---|---|
| 设置 `AXEnhancedUserInterface=true`（app/window 元素） | ✗ -25208 attributeUnsupported |
| 设置 `AXManualAccessibility`（Electron/Chromium 门） | ✗ -25205 |
| VoiceOver 实际运行中（pgrep 确认 pid 24150）再采样 | ✗ 树无变化 |
| activate + wechat-mcp 0.35s settle 时序 | ✗ |
| System Events AppleScript（按红线已弃用，仅作历史对照） | 与历史一致：只见三键 |
| `defaults read com.tencent.xinWeChat` 找 a11y 开关 | 无相关键 |
| WeChatAppEx 子进程承载主 UI？ | 否——Chromium 容器只跑小程序/渲染，主 UI 在 WeChat 主进程 |

## 3. G1 结论与建议

**G1 不通过，PLAN-ax-targeting 全线暂停（按闸门约定，未写任何产品代码）。**

结论修正（对 REPORT-ax-tree-research.md §6 的再次修订）：*"微信 4.x mac 的 AX 树信息丰富"*这一社区论断**在本机微信 4.1.13 上不成立**——原生 AX API 直连下，微信只暴露窗口壳（标题栏三键 + 菜单栏），Qt 自绘内容树（`session_item_*` / `chat_message_list` / `chat_bubble_item_view`）完全未暴露，且无可用的非侵入物化开关。推测 wechat-mcp 实证基于更早的 4.0.x（其 a11y 适配在 4.1.x 中回退/移除），建议 PM 在 wechat-mcp issue 区核对版本对应关系。

后续建议（供 PM 决策，均未实施）：

1. **降级路线（推荐评估）**：回到路线 A（wechat-ui 截图 + OCR 核验）做发送前会话确认，需申请屏幕录制权限；定位跳转可用像素锚点（侧栏"文件传输助手"图标/行 OCR 命中坐标）+ 合成点击实现，OCR 命中后才点击即保留白名单语义；
2. **版本对照实验**：若能装微信 4.0.x 副本验证 `session_item_*` 可枚举，则可确认"版本回退"并锁定可用版本区间；
3. **监控回归**：本探针保留（`spikes/ax-probe.swift --dump` 一条命令），微信每次升级后跑一次即可低成本判断 AX 路线是否复活；
4. 探针的 `--open2` 多策略点击（A–E + F 属性/动作 dump）已实现并通过编译，**一旦内容树可枚举即可直接复跑**，无需重写。

## 4. 复跑方法（供 PM/用户）

```bash
cd $HOME/WeChat/2水群/spikes
# 编译（一次性）
xcrun swiftc -O -target "$(uname -m)-apple-macosx14.0" \
  -module-cache-path "$PWD/.mcache" ax-probe.swift -o ax-probe
./ax-probe --dump            # 实证①：session_item_* 行清单 + 节点/深度/耗时（exit 0=找到文件传输助手行, 2=未找到）
./ax-probe --dump --json out.json
./ax-probe --open            # 实证②单策略：定位→点击中心→轮询 chat_message_list（仅点文件传输助手行）
./ax-probe --open2           # 实证②多策略：A坐标/B AXPress/C子节点press/D raise+点击/E双击，Esc恢复，F属性dump
./ax-probe --stability 15    # 实证③：窗口计数/树就绪/节点/深度/耗时采样
# pyobjc 交叉验证（可选，venv 已建在 spikes/.venv）
./.venv/bin/python -u pyprobe.py
```

运行前提：调用方进程链（DSH 宿主/终端）已获「辅助功能」授权；微信运行且已登录。

## 5. 探针产物清单

| 文件 | 说明 |
|---|---|
| [spikes/ax-probe.swift](../spikes/ax-probe.swift) | 主探针（--dump / --open / --open2 / --stability），Swift 原生 AX 直连 |
| [spikes/pyprobe.py](../spikes/pyprobe.py) | pyobjc 交叉验证（复刻 wechat-mcp 配方） |
| [spikes/diag2–diag9.swift](../spikes/) | 过程诊断脚本（唤醒手段排除、时序采样），留档可复跑 |
| spikes/.venv/ | pyobjc venv（外部依赖：pyobjc-framework-Cocoa/ApplicationServices，仅诊断用，不入库） |
