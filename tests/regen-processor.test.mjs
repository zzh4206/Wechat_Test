// regen-processor.test.mjs —— 错号空报告两段队列 FIFO 处理器（全离线 mock）。
// 覆盖：FIFO 顺序、pop 重试 2 次后 empty_confirmed 出队（共 3 次生成尝试）、
//       环境失败放回队首不耗次数、有内容正常出队走发送链路、satisfied 去重、错号入队不出 outbox（wiring 语义由 index 接线保证，这里验队列侧）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { RegenQueue, REGEN_QUEUE_REL, REGEN_QUEUE_MAX } = await import('../lib/regen-queue.js')
const { processRegenHead } = await import('../lib/regen-processor.js')
const { Store } = await import('../lib/store.js')
const { Outbox, OUTBOX_REL } = await import('../lib/outbox.js')

const CHAT = '12345678@chatroom'
const DAY = '2026-06-10'

function makeEnv(script) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'regenp-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store, now: () => 1000 })
  const queue = new RegenQueue({ store, logger: { warn() {}, error() {} } })
  const audits = []
  const notifies = []
  const deps = {
    queue, store, outbox,
    report: {
      generateReport: async () => {
        const next = script.shift() ?? 'empty'
        return next === 'throw'
          ? (() => { throw new Error('boom') })()
          : next === 'empty'
            ? { status: 'empty', path: `reports/${CHAT}/${DAY}.md`, judgmentCount: 0, topicCount: 0, messageCount: 0 }
            : { status: 'ok', path: `reports/${CHAT}/${DAY}.md`, judgmentCount: 3, topicCount: 1, messageCount: 9 }
      },
    },
    groupStore: { getReportMetas: () => [] },
    logger: { warn() {}, error() {} },
    notify: (title, body) => notifies.push({ title, body }),
    audit: (entry) => audits.push(entry),
    now: () => 5000,
  }
  return { dir, store, outbox, queue, deps, audits, notifies }
}

test('FIFO 顺序：两元素按入队序逐轮处理（队首先出）', async () => {
  const env = makeEnv(['ok', 'ok'])
  env.queue.enqueue('c1@chatroom', '2026-06-10', 1)
  env.queue.enqueue('c2@chatroom', '2026-06-10', 2)
  const r1 = await processRegenHead(env.deps)
  assert.equal(r1.action, 'regenerated')
  assert.equal(r1.entry.chatId, 'c1@chatroom', '队首先处理')
  const r2 = await processRegenHead(env.deps)
  assert.equal(r2.action, 'regenerated')
  assert.equal(r2.entry.chatId, 'c2@chatroom')
  assert.equal(env.queue.list().length, 0, '全部出队')
  rmSync(env.dir, { recursive: true, force: true })
})

test('空产出重试：第 1、2 次空 → deferred 放回队首（regenAttempts 落条目）；第 3 次空 → empty_confirmed 出队', async () => {
  const env = makeEnv(['empty', 'empty', 'empty'])
  env.queue.enqueue(CHAT, DAY, 1)
  const r1 = await processRegenHead(env.deps)
  assert.equal(r1.action, 'deferred_sync_pending')
  assert.equal(env.queue.list().length, 1, '仍在队（绝不发送空报告）')
  assert.equal(env.outbox.listOutbox().length, 0, '空报告绝不进 outbox')
  assert.equal(env.queue.peek().regenAttempts, 1)
  const r2 = await processRegenHead(env.deps)
  assert.equal(r2.action, 'deferred_sync_pending')
  assert.equal(env.queue.peek().regenAttempts, 2)
  const r3 = await processRegenHead(env.deps)
  assert.equal(r3.action, 'empty_confirmed', '3 次全空 → 如实定稿出队')
  assert.equal(env.queue.list().length, 0)
  // 如实定稿：空报告 outbox 条目正常创建（按既有链路发送）
  const entry = JSON.parse(readFileSync(join(env.dir, OUTBOX_REL), 'utf8').trim())
  assert.match(entry.body, /无消息/)
  assert.ok(env.audits.some((a) => a.result === 'regen_empty_confirmed'))
  assert.ok(env.audits.filter((a) => a.result === 'regen_deferred_sync_pending').length === 2)
  rmSync(env.dir, { recursive: true, force: true })
})

test('有内容 → regenerated：报告落盘 + outbox 条目创建（进发送链路）+ notify + 出队', async () => {
  const env = makeEnv(['ok'])
  env.queue.enqueue(CHAT, DAY, 1)
  const r = await processRegenHead(env.deps)
  assert.equal(r.action, 'regenerated')
  assert.equal(env.queue.list().length, 0, 'done 出队')
  const entry = JSON.parse(readFileSync(join(env.dir, OUTBOX_REL), 'utf8').trim())
  assert.match(entry.title, /补发日报/)
  assert.equal(env.notifies.length, 1)
  assert.ok(env.audits.some((a) => a.result === 'regen_regenerated'))
  rmSync(env.dir, { recursive: true, force: true })
})

test('环境类失败 → 放回队首不耗次数（regenAttempts 不变），下轮再处理', async () => {
  const env = makeEnv(['throw', 'ok'])
  env.queue.enqueue(CHAT, DAY, 1)
  const r1 = await processRegenHead(env.deps)
  assert.equal(r1.action, 'env_deferred')
  assert.equal(env.queue.list().length, 1, '放回队首')
  assert.equal((env.queue.peek().regenAttempts ?? 0), 0, '不消耗重试次数')
  const r2 = await processRegenHead(env.deps)
  assert.equal(r2.action, 'regenerated')
  rmSync(env.dir, { recursive: true, force: true })
})

test('satisfied：已有非 empty 报告 → 直接出队不重生成（去重语义）', async () => {
  const env = makeEnv(['ok'])
  env.deps.groupStore.getReportMetas = () => [{ date: DAY, status: 'ok' }]
  env.queue.enqueue(CHAT, DAY, 1)
  const r = await processRegenHead(env.deps)
  assert.equal(r.action, 'satisfied')
  assert.equal(env.queue.list().length, 0)
  assert.equal(env.outbox.listOutbox().length, 0, 'satisfied 不创建 outbox')
  assert.ok(env.audits.some((a) => a.result === 'regen_satisfied'))
  rmSync(env.dir, { recursive: true, force: true })
})

test('持久化：regenAttempts 跨实例保留；上限 31 去重淘汰（既有语义回归）', () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'regenp2-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const q = new RegenQueue({ store, logger: { warn() {}, error() {} } })
  q.enqueue(CHAT, DAY, 1)
  q.setRegenAttempts(CHAT, DAY, 2)
  const q2 = new RegenQueue({ store, logger: { warn() {}, error() {} } })
  assert.equal(q2.peek().regenAttempts, 2, 'regenAttempts 跨重启保留')
  for (let i = 0; i < REGEN_QUEUE_MAX + 1; i++) q2.enqueue(`c${i}@chatroom`, `2026-07-${String(1 + i).padStart(2, '0')}`, i)
  assert.equal(q2.list().length, REGEN_QUEUE_MAX, '上限 31')
  rmSync(dir, { recursive: true, force: true })
})
