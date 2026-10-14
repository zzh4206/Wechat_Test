#!/bin/bash
# spike-search-shortcut.sh —— 实证微信 mac 4.x 搜索快捷键（PM/用户代跑；勿由 agent 自主执行——
# 键序会真实敲进前台应用）。本机实测环境：WeChat 4.1.13（macOS）。
#
# 用法（终端手工执行，需 TCC"辅助功能"授权给终端宿主）：
#   1. 把微信切到前台（任意聊天列表界面即可，无需常驻文件传输助手窗口）；
#   2. bash spike-search-shortcut.sh
#   3. 看输出里哪一段后 AXFocusedUIElement 变成搜索框（wx search field），即为真实键位。
#
# 判读：输出 "FOCUSED=<描述>"。Cmd+F 后描述含 "搜索"/"search"/"text field" → Cmd+F 成立；
#       否则脚本自动试 Ctrl+F 与 Cmd+Ctrl+F；都不中则改走 AX 路径（见文件尾注释）。
# 结论请回填 docs/RUNBOOK.md §12.5 "真实键位实证"。

run_probe() {
  local label="$1" script="$2"
  echo "=== 探测 $label ==="
  osascript -e "$script"
  sleep 1
  echo -n "FOCUSED: "
  osascript -e 'tell application "System Events" to tell process "WeChat" to get value of attribute "AXFocusedUIElement" of front window' 2>/dev/null \
    || osascript -e 'tell application "System Events" to tell process "WeChat" to get role description of focused UI element of front window' 2>/dev/null \
    || echo "(取焦点元素失败——TCC 未授权或窗口结构异常)"
  # 清理：按 Esc 退出搜索框，避免残留状态影响下一段探测
  osascript -e 'tell application "System Events" to key code 53'
  sleep 0.5
}

osascript -e 'tell application "WeChat" to activate'
sleep 1

run_probe "Cmd+F"   'tell application "System Events" to keystroke "f" using command down'
run_probe "Ctrl+F"  'tell application "System Events" to keystroke "f" using control down'
run_probe "Cmd+Ctrl+F" 'tell application "System Events" to keystroke "f" using {command down, control down}'

echo "=== 完成 ==="
echo "判读标准：FOCUSED 含 搜索/search/text field 的那段即真实键位。"
echo "若全不中（AX 路径备选，KeyboardSender 可改造为免按键定位）："
echo "  tell application \"System Events\" to tell process \"WeChat\""
echo "    set frontmost to true"
echo "    perform action \"AXPress\" of (first UI element of front window whose description contains \"搜索\")"
echo "  end tell"
echo "（元素层级用 UI Browser / Accessibility Inspector 现场确认后回填。）"
