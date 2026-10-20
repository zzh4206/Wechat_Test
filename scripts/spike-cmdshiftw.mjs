#!/usr/bin/env node
// spike-cmdshiftw.mjs —— 用户指定键序键位验证（PM/用户在终端代跑；会真实敲键，agent 不自主执行）。
// 验证点：① Cmd+Shift+W 能否调出微信窗口（用户自定义热键 vs 系统/微信原生）；
//         ② Cmd+F 是否打开微信搜索框；③ 中文搜索词直接键入是否被 IME 拦截（回退剪贴板方案的判据）。
// 用法：node scripts/spike-cmdshiftw.mjs
// 判读：每步观察微信窗口状态/焦点元素；Ctrl+C 中止。全程约 30 秒。
import { execFileSync } from 'node:child_process'
const osa = (script) => {
  try {
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10_000 })
    console.log('ok  :', script.slice(0, 60))
    return out
  } catch (e) {
    console.log('FAIL:', script.slice(0, 60), '→', String(e.message).slice(0, 120))
    return null
  }
}
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
console.log('step0: 剪贴板设为测试文本')
osa('set the clipboard to "spike-test"')
console.log('step2: Cmd+Shift+W（观察微信窗口是否调出）')
osa('tell application "System Events" to keystroke "w" using {command down, shift down}')
sleep(1500)
console.log('step3: Cmd+F（观察微信是否进入搜索框）')
osa('tell application "System Events" to keystroke "f" using command down')
sleep(800)
console.log('step4a: 直接键入中文搜索词（观察是否被 IME 拦截；被拦 → 需剪贴板回退）')
osa('tell application "System Events" to keystroke "老大"')
sleep(1200)
console.log('step4b(回退对照): 剪贴板设搜索词 + Cmd+V')
osa('set the clipboard to "老大"')
osa('tell application "System Events" to keystroke "v" using command down')
sleep(1200)
console.log('step5: Return（观察是否进入"老大"对话）')
osa('tell application "System Events" to key code 36')
sleep(800)
console.log('done: 人工判读三步结果；Cmd+Shift+W 无效 → 键序需改（回 activate 或其他热键）')
