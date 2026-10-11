// token-bucket.test.mjs —— 限流与恢复。
import test from 'node:test'
import assert from 'node:assert/strict'
import { TokenBucket } from '../lib/guard.js'

test('突发上限：默认容量 5，第 6 条被丢弃并计数', () => {
  let t = 0
  const bucket = new TokenBucket({ now: () => t })
  const got = []
  for (let i = 0; i < 8; i++) got.push(bucket.take('g1'))
  assert.deepEqual(got, [true, true, true, true, true, false, false, false])
  assert.equal(bucket.dropped('g1'), 3)
  // 各群独立
  assert.equal(bucket.dropped('g2'), 0)
})

test('恢复：按速率补充令牌（默认 1 条/秒）', () => {
  let t = 0
  const bucket = new TokenBucket({ now: () => t })
  for (let i = 0; i < 5; i++) assert.equal(bucket.take('g'), true)
  assert.equal(bucket.take('g'), false)
  t += 500 // 半秒：半枚令牌，仍不够
  assert.equal(bucket.take('g'), false)
  t += 600 // 累计 1.1 秒：够 1 枚
  assert.equal(bucket.take('g'), true)
  assert.equal(bucket.take('g'), false)
})

test('不超容量：长时间闲置后突发仍以 burst 为上限', () => {
  let t = 0
  const bucket = new TokenBucket({ now: () => t, ratePerSec: 1, burst: 3 })
  t += 60_000
  let allowed = 0
  while (bucket.take('g')) allowed++
  assert.equal(allowed, 3)
})
