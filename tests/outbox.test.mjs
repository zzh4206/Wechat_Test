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

test('W-4：并发追加 + 状态补丁交织 → 最终状态正确、无行丢失（追加补丁行替代整文件读改写）', () => {
  const { dir, outbox } = makeEnv()
  const entries = []
  for (let i = 1; i <= 10; i++) entries.push(outbox.appendOutbox({ kind: 'daily', title: `t${i}`, body: 'b', evidence_ref: 'x' }))
  // 交织：每一条状态补丁之间穿插新条目追加（模拟 regen 报告入箱与 sender 推进并发）
  const appends = []
  entries.forEach((e, i) => {
    if (i % 3 === 1) appends.push(outbox.appendOutbox({ kind: 'remind', title: `mid${i}`, body: 'b', evidence_ref: 'x' }))
    assert.equal(outbox.updateSendState(e.id, { status: 'sent', attempts: 1 }), true, `补丁 ${i} 成功`)
  })
  const all = outbox.listOutbox()
  assert.equal(all.length, entries.length + appends.length, '无行丢失（补丁行归并不吞追加）')
  for (const e of entries) {
    const folded = all.find((x) => x.id === e.id)
    assert.equal(folded.status, 'sent', `${e.title} 最终 sent`)
    assert.equal(folded.attempts, 1)
    assert.equal(folded.kind, 'daily', '原行字段保留')
  }
  for (const a of appends) assert.equal(all.find((x) => x.id === a.id).status, 'pending', '穿插追加不受补丁影响')
  // 未知 id 补丁 → false；幂等推进链 pending→sent_pending_verify→sent 后写覆盖先写
  assert.equal(outbox.updateSendState('no-such-id', { status: 'sent' }), false)
  const last = entries[9]
  outbox.updateSendState(last.id, { status: 'sent_pending_verify', transmittedAt: 5 })
  outbox.updateSendState(last.id, { status: 'sent', serverId: 'svr-1', sentAt: 6 })
  const final = outbox.listOutbox().find((x) => x.id === last.id)
  assert.equal(final.status, 'sent')
  assert.equal(final.serverId, 'svr-1')
  assert.equal(final.transmittedAt, 5, '前序补丁字段保留（fold 合并非替换）')
  rmSync(dir, { recursive: true, force: true })
})

test('W-11：appendOutbox 接受调用方预生成 id（evidence_ref 可指向条目自身）', () => {
  const { dir, outbox } = makeEnv()
  const id = 'fix-0001-digest'
  const entry = outbox.appendOutbox({ kind: 'digest', title: '速览', body: 'b', evidence_ref: `outbox/${id}`, id })
  assert.equal(entry.id, id)
  assert.equal(entry.evidence_ref, `outbox/${id}`)
  assert.equal(outbox.listOutbox().find((x) => x.id === id).evidence_ref, `outbox/${id}`)
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
