# 调研报告：sender 自动定位发送——广泛调研（HANDOFF-sender-autotarget.md 对应）

> 编号：REPORT-AUTOTARGET-RESEARCH-2026-10-16
> 任务来源：[HANDOFF-sender-autotarget.md](HANDOFF-sender-autotarget.md)
> 性质：技术调研 + 本机只读实证（未改产品代码；未点击任何会话/发送任何消息）
> 结论速览：**AX 路线在本机可判死（含全部未试过的物化触发器）；推荐主路线 = 截图+OCR 定位链（侧栏行点击 / Cmd+N 发起会话选择器）+ 既有 OCR 合规闸 + DB 回读三层防线。**

---

## 1. 本机事实复核（修正一处关键记录错误）

| 项 | 结果 |
|---|---|
| 操作系统 | **macOS 26.6.2 (25G83)** —— ⚠️ [REPORT-ax-probe.md](REPORT-ax-probe.md) 头部写的"macOS 15.x"**是错的**（或机器此后升级过）。这不是小事：上游核心 issue 的分野恰好卡在 macOS 26（见 §2.1） |
| 微信版本 | 4.1.13（build 4066647330，中文版，直装非 App Store），pid 493 |
| `ax-probe --dump` 复跑 | 窗口数 0 / 树就绪 8 次尝试失败 / 0 节点（微信当时在后台；与历史结论一致） |
| **hit-test 物化触发**（此前从未试过） | `AXUIElementCopyElementAtPosition` 打内容区/侧栏三个点 → 全部 **-25208 (attributeUnsupported)** —— 窗口内容视图**未实现** `accessibilityHitTest:`，即 Qt 的 Cocoa a11y 桥三个激活入口（见 §2.2）在这棵内容视图上根本不存在 |
| AXFocusedUIElement | None |
| 激活后窗口 AXChildren | 仍只有 3 个标题栏按钮 |

**判定**：微信 4.1.13 中文版在 macOS 26 上的内容视图压根没挂 Qt 无障碍桥（Tencent 禁用了 QAccessible 或带了损坏的 Qt 6.9 桥，hoppie00 在 [WeChat-MCP#8](https://github.com/BiboyQG/WeChat-MCP/issues/8) 的源码级分析同此结论）。客户端侧无任何非侵入开关可用——**方案 A（侧栏 AX 定位）在本机可判死，不再投入**。

### 1.1 本机新实证：菜单栏完整可用（唯一活着的 AX 表面）

菜单栏 AX 完整暴露，且 `AXMenu` 懒物化——对 `AXMenuBarItem` 执行 `AXPress` 后菜单项即完整可读（本机实测，pyobjc 只读 + 菜单自动关闭，无点击动作）。提取到**与定位直接相关的菜单项与快捷键**（mod=0 即 Cmd）：

| 菜单路径 | 快捷键 | 对定位的价值 |
|---|---|---|
| **文件 → 发起会话** | **Cmd+N** | ⭐ 打开"发起会话"选择器（联系人/群聊搜索面板）——**这是被 Cmd+F 废案掩盖的、从未评估过的定位入口**（与搜一搜完全不同的进程内搜索面板） |
| 显示 → 显示上一个/下一个会话 | Cmd+↑ / Cmd+↓ | 确定性切换会话（无法定向，但可作扰动恢复手段） |
| 显示 → 显示下一个未读会话 | Cmd+Alt+↓ | 同上 |
| 窗口 → 聊天/通讯录/收藏/朋友圈 | — | tab 切换（确保在"聊天"tab） |
| 编辑 → 搜索 | Cmd+F | 已废弃（搜一搜），维持结论 |

## 2. 上游与社区证据链

### 2.1 WeChat-MCP（BiboyQG 上游）issue 矩阵 —— "macOS 26 分水岭"

- [#8](https://github.com/BiboyQG/WeChat-MCP/issues/8)：macOS 26.1~26.3 + 微信 4.1.5/4.1.6/4.1.7 多人复现空树（含 hoppie00 的完整 AX dump：与我们的三按钮壳一模一样）；**但 zhangenming 报告 macOS 15.7.2 同样空树**，BiboyQG 本人 15.3 + 4.1.5.26 可用——版本矩阵并不干净，真实变量可能是 **微信构建批次（中文直装 vs 国际版）× macOS × UI 语言**。
- [#15](https://github.com/BiboyQG/WeChat-MCP/issues/15)：4.1.5 + macOS 26.3.1 空树，诊断输出与我们逐字一致（含"菜单栏正常暴露"）。BiboyQG 回复归因 macOS 26。
- [#17](https://github.com/BiboyQG/WeChat-MCP/issues/17)：**国际版（App Store, EN）默认不暴露 `chat_message_list`/`chat_input_field`，中文直装版暴露的树不同**——构建差异实锤。
- [PR #22](https://github.com/BiboyQG/WeChat-MCP/pull/22)：**在微信 4.1.13 + macOS 27.0（英文 UI）上全功能实证可用**。标识符协议完整记录：`session_list`/`session_item_<name>`、搜索弹层是**独立 AXDialog**（`search_item_<name>`）、`current_chat_name_label`、`chat_message_list`、`chat_input_field`；文本可经 `AXValue` 写入；列表虚拟化须滚动收集；**4.x 全局搜索不返回"File Transfer"，侧栏滚动是唯一途径**（他们环境）。→ 若未来本机 AX 复活（微信更新/macOS 27），这份协议就是现成实现蓝本。
- [ginqi7/macos-wechat-cli](https://github.com/ginqi7/macos-wechat-cli)（曾最流行的 brew AX 方案）已归档，作者注明 "WeChat 4.x does not support the Accessibility API required by this tool"。

### 2.2 Qt 6 桥机制（为什么所有"开关"都无效）

- Qt 的 macOS a11y 是**懒激活**：`accessibilityAttributeValue:` / `accessibilityHitTest:` / `accessibilityFocusedUIElement` 三入口被系统查询时才 `setActive(true)`（[commit e58b1efc](https://invent.kde.org/qt/qt/qtbase/-/commit/e58b1efcae5c38fdb2fb0aebe61d51d97ba003ef)）。**我们已把三个入口全部试过**（树遍历、hit-test、focused element）——内容视图不响应，说明桥本身缺席，不是激活时机问题。
- `AXEnhancedUserInterface`/`AXManualAccessibility` 是 **Chromium/Electron 机制**，Qt 桥不监听——历史探针的 -25208/-25205 是"目标是 Qt"的指纹而非手法错误。此路彻底关死。
- Qt 6.9 macOS a11y 有 P0 级 bug 族（[audacity#9429](https://github.com/audacity/audacity/issues/9429)：updateAccessibility 随机崩溃、树被错误清空，行为随 OS 状态/常驻进程漂移）——Tencent 很可能因此整体禁用 QAccessible。客户端侧无 workaround。
- macOS 26 (Tahoe) 另有每进程 AX 缓存陈旧报告（需每次重建 AXUIElement 引用）——即便树复活也要按"每次重建引用"写代码。

## 3. 替代路线评估（对应 HANDOFF §4 候选表更新）

| 路线 | 评级 | 依据与先例 |
|---|---|---|
| A. 侧栏 AX 定位 | ❌ **判死（本机）** | §1/§2 全链证据；保留 `ax-probe --dump` 作微信升级后的复活探针 |
| B1. **截图+OCR 侧栏行定位点击** | ✅ **高（推荐主选）** | [jackwener/wechat-summary](https://github.com/jackwener/wechat-summary)：Vision OCR（zh-Hans+en-US）+ 像素扫描自适应布局（侧栏分隔线/深浅色）+ OCR 侧栏会话名 → 点击行中心——正是"定位侧栏会话行并点击"的完整开源实现；[wq19901103wq/wechat-mac-rpa](https://github.com/wq19901103wq/wechat-mac-rpa)：生产级视觉 RPA（OCR 会话名准确率 96.6%，明确不碰协议/数据库/注入）。**本仓 `wechat-ui read` 已具备 Vision OCR + 截图 + clickPoint 全部组件，只差"侧栏行 OCR→坐标→点击"一段** |
| B2. **Cmd+N 发起会话选择器**（本调研新发现） | ✅ **中高（推荐备选/组合）** | Cmd+N 打开进程内搜索面板（非搜一搜）：粘贴"文件传输助手"→ 结果区 OCR 精确匹配 → Enter → OCR 标题闸确认。与 B1 共用全部安全设施。风险：选择器结果排序未知、面板行为需实测（WP 第一步实证） |
| C. URL scheme 打开会话 | ❌ 低 | `weixin://dl/*` 只有功能页（扫一扫/朋友圈/设置），`dl/chat` 是聊天设置页非打开会话；mac 端 dl/* 多显示错误页。无任何"打开指定会话"先例 |
| D. 菜单栏自动化 | ◐ 辅助 | 无"打开指定会话"菜单项；但菜单栏 AX 完整可用（本机实测），`文件→发起会话` 可经 **AXPress 菜单项**触发（等价 Cmd+N，且不依赖键盘焦点）、`窗口` 菜单可置前主窗口 |
| E. 键盘流（Cmd+F 搜索） | ❌ 维持废弃 | 多先例明确列入勿用（全局搜一搜）；keystroke 直输中文必乱码，唯一可靠文本输入 = 剪贴板粘贴（francismiko 踩坑表） |
| F. 接受现状+运维补偿 | ❌ 用户已否决 | — |

### 组合安全架构（红线全保留）

```
定位段（二选一，均在 OCR 确认后才许进入发送段）
  B1: 激活微信 → CGWindowList 截主窗 → 像素定侧栏区 → Vision OCR 行文本
      → 精确匹配"文件传输助手"（模糊/缺失/重名 → defer）→ 合成点击行中心
  B2: Cmd+N（或菜单栏 AXPress）→ 剪贴板粘贴"文件传输助手" → 等待
      → 截图 OCR 结果区精确匹配 → Enter
发送段（现状不动）
  → wechat-ui read --chat 文件传输助手（既有 OCR 合规闸，三败 defer）
  → 剪贴板粘贴 + Return → DB 回读 #l<id8> + server_id（P0 兜底）
对账：发送前后 DB diff，除 filehelper 外零新消息
```

三层防线（OCR 定位命中才点击 / OCR 标题闸 / DB 回读）+ 零正文审计，全部红线兼容：不碰进程内存、不写 DB、白名单硬编码。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 文件传输助手不在侧栏可视区（列表虚拟化/滚动） | B1 首屏未命中 → 侧栏滚轮下滚 N 屏再 OCR，仍未命中切 B2 或 defer；PR#22 证实 4.x 侧栏确实虚拟化 |
| OCR 误读（96.6% 单次准确率） | 精确匹配 + 失败重试 + 命中后才点击 + 后续两层闸兜底 |
| 深浅色/DPI 布局漂移 | jackwener 式像素扫描自适应（分隔线检测），不硬编码坐标；`--composer-top` 校准机制先例已在 wechat-ui |
| 搜索词落入错误输入框（历史 P0 教训） | B2 面板内粘贴后**先截图 OCR 验证面板态**再 Enter；任何非预期态 → Esc 恢复 + defer |
| 微信小版本更新改 UI | 截图 OCR 天然抗小改；`ax-probe --dump` 保留为 AX 复活探针（PR#22 协议已存档，复活即切换回 AX 路线） |
| 权限 | 屏幕录制（截图 OCR）+ 辅助功能（点击/键盘）均已具备；osascript 自动化权限在本 DSH 宿主曾报 -10004，B1/B2 均可绕开 System Events（原生 CGEvent + Vision） |

## 5.1 T1 闭环实验结果（2026-10-16 22:00，用户配合，已通过）

按负对照设计现场执行，**三步全部达成**：

| 步骤 | 结果 |
|---|---|
| 第 1 步 负对照（用户切走会话） | 闸 blocked（`chat_title_not_verified`，exit 2）——"不是文件传输助手"被正确识别 ✓ |
| 第 2 步 OCR 定位 + 合成点击 | 侧栏 Vision OCR 精确命中"文件传输助手"（conf=1.00，y=132，x=116..202）→ 行中心 (160,181) CGEvent 点击 ✓ |
| 第 3 步 验证 | 闸 `readable`（exit 0），消息区 OCR 全为 lurker 历史日报 + `#l<id8>` 特征串（filehelper 独有内容）✓ |

实验过程额外产出 **4 个生产级发现**（实现 WP-T2 时必须处理）：

1. **多窗口态下 wechat-ui 主窗判定脆弱**：用户开独立聊天窗/聊天记录窗后，`targetWindow()`（onScreenWindowsOnly + 标题精确匹配 + count==1 + 单屏包含检查）出现 `main_window_unavailable`/`window_must_fit_one_display` 间歇失败——定位模块要自带更稳的主窗解析（如按窗格最大 + 重试 + 必要时让用户关独立窗）。
2. **后台进程 activate 不切 Space；点击必须先验证前置**：微信主窗在另一桌面/被遮挡时，坐标点击会打到当时前台的浏览器（本次第一发点击即落在了网页上，万幸无害）。点击前的硬闸：`frontmostApplication == 微信` 且屏上坐标处截图确认是微信，否则 defer——这必须写进 locate-and-open 的前置检查。
3. **Retina 2x 坐标换算**：`screencapture` 产 2x 图（2600px 宽），`wechat-ui` SCStream 产 1x（1300px）——OCR 坐标→屏幕坐标必须按截图实际 scale 换算，两种截图源不可混用。
4. **侧栏虚拟化确认**：文件传输助手当前在首屏（置顶/近期活跃）；一般情形需滚动收集兜底（未命中→滚 N 屏→仍未命中 defer）。

## 5.2 E2E 实战验收（2026-10-16 22:2X，用户配合，通过）

完整链路实测：**定位（wechat-ui open，负对照态起始）→ 粘贴 → 发送 → DB 回读命中（server_id=6515714820362366659）**。
定位段表现：解析→OCR 命中（conf=1.0）→点击→标题核验 `opened`，全程 ~3s。

E2E 过程产出 **2 个发送段集成发现**（WP-T3 收尾必办）：

5. **Enter/Cmd+Return 在本机微信均不触发发送**：粘贴后草稿滞留输入框（OCR 实证两条草稿），Return 与 Cmd+Return 都无效——本机微信"按 Enter 发送"设置关闭。**解法（已实证）**：OCR 定位输入区右下"发送"按钮（本机坐标随窗口几何动态求取）并合成点击——一次成功、确定性。生产 KeyboardSender 的 `OSC_KEY_RETURN` 在当前微信设置下会把消息滞留为草稿（DB 回读失败→重试→草稿重复粘贴），**上线前必须二选一**：① 用户在微信设置开启"按 Enter 键发送消息"（零代码，恢复设计键序）；② KeyboardSender 发送键序改为"OCR 定位发送按钮 + 点击"（语言锚点"发送"，需处理国际化/深浅色——OCR 文本锚点天然抗后者）。
6. **窗口几何必须实时求取**：E2E 中用户把主窗从 1300pt 缩放到 853pt——固定坐标/固定 composer-top 立即失效；发送按钮点击用"截窗→OCR 找'发送'→换算（注意 screencapture 2x scale 与窗口原点偏移）"动态定位后成功。教训与发现 3（Retina 换算）同源：**坐标永远来自当次截图，绝不缓存**。




## 5.3 建议的下一步（交实施者）

1. **WP-T1（实证，0.5 天，含负对照设计——2026-10-16 补）**：用 `wechat-ui` 现有截图/OCR 组件写 spike：`read-sidebar`（dump 侧栏 OCR 行 + 坐标）+ 点击定位；同时实测 Cmd+N 面板行为（打开/粘贴/结果区/Enter/Esc 全程截图记录）。
   **负对照（必须）**：初始态恰为目标会话时"定位成功"与"什么都没做"不可区分，实验前须先制造错误态：
   ```
   准备  OCR 标题闸读一次 = 文件传输助手（记录通过态）
   第1步  Cmd+↓「显示下一个会话」切走 → OCR 标题闸必须 ≠ 文件传输助手
          （否则本步失败实验作废；可辅以目视确认）
   第2步  跑被测 locate-and-open 原语（点击前 dump OCR 命中行文本 + bounding box 留痕）
   第3步  OCR 标题闸再读 + 截图存档
   判据  第1步"不是" + 第3步"是" → 定位真实生效；若第3步仍"不是" → 原语失效立刻露馅
   ```
   注意：切换会话不写消息表，DB 对账只能证明"没发错地方"，切换本身只能靠 OCR 标题闸验证——故第 1 步负对照不可省略。
2. **WP-T2（定位模块，0.5–1 天）**：按胜出路线实现 `locate-and-open` 原语（精确匹配、缺失/重名 defer、滚动收集、Esc 恢复），mock OCR 四场景单测（命中/缺失/重名/误读）。
3. **WP-T3/T4**：sender 集成（定位段+发送段、defer 语义）+ RUNBOOK/验收——沿用 [PLAN-ax-targeting.md](PLAN-ax-targeting.md) WP3/WP4 骨架不变。

## 6. 主要参考来源

- [BiboyQG/WeChat-MCP #8](https://github.com/BiboyQG/WeChat-MCP/issues/8)、[#15](https://github.com/BiboyQG/WeChat-MCP/issues/15)、[#17](https://github.com/BiboyQG/WeChat-MCP/issues/17)、[PR #22](https://github.com/BiboyQG/WeChat-MCP/pull/22)、[dustin573/wechat-mcp](https://github.com/dustin573/wechat-mcp)
- [ginqi7/macos-wechat-cli（归档声明）](https://github.com/ginqi7/macos-wechat-cli)
- Qt 桥源码：[qnsview_accessibility.mm / commit e58b1efc](https://invent.kde.org/qt/qt/qtbase/-/commit/e58b1efcae5c38fdb2fb0aebe61d51d97ba003ef)；[audacity#9429](https://github.com/audacity/audacity/issues/9429)
- [jackwener/wechat-summary](https://github.com/jackwener/wechat-summary)、[wq19901103wq/wechat-mac-rpa](https://github.com/wq19901103wq/wechat-mac-rpa)、[francismiko/wechat-automation](https://skillsmp.com/zh/creators/francismiko/wechat-automation/skill)
- weixin:// scheme 清单：[CSDN](https://blog.csdn.net/weixin_48141487/article/details/143172377)、[mac 端实测](https://blog.csdn.net/qq_23564667/article/details/105113883)
- 本机实证：`spikes/ax-probe --dump` 复跑、pyobjc hit-test/focused-element 探针、菜单栏 AXPress 读取（2026-10-16，本会话）
