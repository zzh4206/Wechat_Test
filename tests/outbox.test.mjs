// outbox.test.mjs —— M3 提前落地 M4-T4.4 最小发件箱（全离线）。
// 覆盖：schema 逐字段断言（channel='filehelper'、status='pending'、ts ISO）、
//       追加只落盘（零发送调用静态断言 + 无网络/子进程原语）、tailOutbox 只读取尾 n 条。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdirSync, statSync } from 'node:fs'

const { Outbox, OUTBOX_REL } = await import('../lib/outbox.js')
const { Store } = await import('../lib/store.js')

function makeEnv() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'outbox-')))
  const store = new Store(dir, { warn() {}, error() {} })
  let t = new Date(2026, 5, 10, 20, 30).getTime()
  const outbox = new Outbox({ store, now: () => (t += 1000) })
  return { dir, store, outbox }
}

test('appendOutbox：schema 逐字段（ts ISO / channel=filehelper / status=pending）+ 落盘 jsonl', () => {
  const { dir, outbox } = makeEnv()
  const entry = outbox.appendOutbox({ kind: 'daily', title: '日报已生成', body: '关键判断 3 条', evidence_ref: 'reports/c/2026-06-10.md' })
  assert.ok(entry)
  assert.equal(entry.channel, 'filehelper')
  assert.equal(entry.status, 'pending')
  assert.equal(entry.kind, 'daily')
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/)
  const raw = readFileSync(join(dir, OUTBOX_REL), 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), entry)
  rmSync(dir, { recursive: true, force: true })
})

test('appendOutbox：多次追加成行；tailOutbox(n) 只读取尾 n 条（不改文件）', () => {
  const { dir, outbox } = makeEnv()
  for (let i = 1; i <= 5; i++) {
    outbox.appendOutbox({ kind: 'remind', title: `t${i}`, body: 'b', evidence_ref: 'x' })
  }
  const before = readFileSync(join(dir, OUTBOX_REL), 'utf8')
  const tail = outbox.tailOutbox(2)
  assert.equal(tail.length, 2)
  assert.equal(tail[0].title, 't4')
  assert.equal(tail[1].title, 't5')
  assert.equal(readFileSync(join(dir, OUTBOX_REL), 'utf8'), before) // 只读：内容不变
  assert.deepEqual(outbox.tailOutbox(0), [])
  assert.deepEqual(outbox.tailOutbox(-3), [])
  assert.equal(outbox.tailOutbox(100).length, 5)
  rmSync(dir, { recursive: true, force: true })
})

test('tailOutbox：文件不存在返回 []；损坏行跳过不抛出', () => {
  const { dir, store, outbox } = makeEnv()
  assert.deepEqual(outbox.tailOutbox(3), [])
  store.ensureDir('.')
  store.appendText(OUTBOX_REL, '{"kind":"a"}\n{broken\n')
  const tail = outbox.tailOutbox(10)
  assert.equal(tail.length, 1)
  assert.equal(tail[0].kind, 'a')
  rmSync(dir, { recursive: true, force: true })
})

test('零发送断言：outbox.ts / report.ts 无任何发送原语（no-send 红线沿用）', () => {
  const srcDir = join(import.meta.dirname, '..', 'src')
  const files = ['outbox.ts', 'report.ts']
  const blacklist = ['sendMessage', 'send(', 'deliver', 'postMessage', 'broadcast', 'pushMessage', 'axios.post', 'fetch(', 'execFile', 'spawn', 'http.request', 'https.request']
  const violations = []
  for (const f of files) {
    const text = readFileSync(join(srcDir, f), 'utf8')
    for (const word of blacklist) {
      if (text.includes(word)) violations.push(`${f} 含 "${word}"`)
    }
    if (/\.send(?![a-zA-Z])/.test(text)) violations.push(`${f} 含 ".send" 调用`)
  }
  assert.deepEqual(violations, [])
})
