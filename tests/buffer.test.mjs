// buffer.test.mjs —— WP3 环形缓冲：容量淘汰、群隔离、内存上限。
import test from 'node:test'
import assert from 'node:assert/strict'
import { RingBuffer, BufferPool } from '../lib/buffer.js'

const m = (i, ts = i) => ({ ts, sender: `u${i}`, text: JSON.stringify(`msg ${i}`) })

test('RingBuffer：未满时按序快照', () => {
  const rb = new RingBuffer(3)
  rb.push(m(1)); rb.push(m(2))
  assert.deepEqual(rb.snapshot().map((x) => x.text), ['"msg 1"', '"msg 2"'])
  assert.equal(rb.size, 2)
})

test('RingBuffer：满后淘汰最旧', () => {
  const rb = new RingBuffer(3)
  for (let i = 1; i <= 5; i++) rb.push(m(i))
  assert.equal(rb.size, 3)
  assert.deepEqual(rb.snapshot().map((x) => JSON.parse(x.text)), ['msg 3', 'msg 4', 'msg 5'])
})

test('RingBuffer：容量非法参数抛错', () => {
  assert.throws(() => new RingBuffer(0))
  assert.throws(() => new RingBuffer(1.5))
})

test('BufferPool：各群独立，snapshot 未知群为空', () => {
  const pool = new BufferPool({ bufferSize: 2 })
  pool.push('a', m(1))
  pool.push('b', m(2))
  assert.equal(pool.size('a'), 1)
  assert.equal(pool.size('c'), 0)
  assert.deepEqual(pool.snapshot('c'), [])
})

test('BufferPool：每群容量独立淘汰', () => {
  const pool = new BufferPool({ bufferSize: 2 })
  for (let i = 1; i <= 4; i++) pool.push('a', m(i))
  assert.equal(pool.size('a'), 2)
  assert.deepEqual(pool.snapshot('a').map((x) => JSON.parse(x.text)), ['msg 3', 'msg 4'])
})

test('BufferPool：总条目超上限时淘汰最久未活跃群的旧条目', () => {
  // bufferSize=2, multiplier=2 → maxTotal=4（三群合计可超过，触发全局上限）
  const pool = new BufferPool({ bufferSize: 2, maxTotalMultiplier: 2 })
  pool.push('old-group', m(1, 100)) // 最久未活跃
  pool.push('old-group', m(2, 200))
  pool.push('mid-group', m(3, 500))
  pool.push('new-group', m(4, 950))
  assert.equal(pool.total, 4)
  // 第 5 条触发上限：应从最久未活跃的 old-group 淘汰最旧
  pool.push('new-group', m(5, 990))
  assert.ok(pool.total <= 4, `total=${pool.total}`)
  assert.equal(pool.size('old-group'), 1)
  assert.deepEqual(pool.snapshot('old-group').map((x) => JSON.parse(x.text)), ['msg 2'])
  assert.ok(pool.evictedTotal >= 1)
})

test('BufferPool：清空后归零', () => {
  const pool = new BufferPool({ bufferSize: 4 })
  pool.push('a', m(1))
  pool.clear()
  assert.equal(pool.total, 0)
  assert.equal(pool.groupCount, 0)
})
