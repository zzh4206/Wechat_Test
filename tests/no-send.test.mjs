// no-send.test.mjs —— 静态断言 src/ 不含任何消息发送类调用。
// 黑名单词表：出现即视为插件持有发送通道，测试失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SEND_BLACKLIST = [
  'sendMessage',
  'send(',
  '.send',
  'deliver',
  'postMessage',
  'reply',
  'respond',
  'broadcast',
  'pushMessage',
  'bot.send',
  'session.send',
  'channel.send',
  'writeToChannel',
  'publish(',
  'axios.post',
  'fetch(',
]

const srcDir = join(import.meta.dirname, '..', 'src')

function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter(f => /\.(ts|js|mjs)$/.test(f))
    .map(f => join(dir, f))
}

test('src/ 不含发送类调用（黑名单词表）', () => {
  const violations = []
  for (const file of listFiles(srcDir)) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      // 去掉行内注释与字符串后再匹配，避免中文注释/文档误伤
      const code = lines[i].replace(/\/\/.*$/, '')
      for (const word of SEND_BLACKLIST) {
        if (code.includes(word)) violations.push(`${file}:${i + 1} 含 "${word}"`)
      }
    }
  }
  assert.deepEqual(violations, [], `发现疑似发送调用：\n${violations.join('\n')}`)
})

test('index.ts 的 inject 数组仅含 llm', () => {
  const text = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  const m = text.match(/export const inject = (\[[^\]]*\])/)
  assert.ok(m, '未找到 inject 声明')
  const arr = JSON.parse(m[1].replace(/'/g, '"'))
  assert.deepEqual(arr, ['llm'])
})
