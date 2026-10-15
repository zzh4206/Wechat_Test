// split-by-rate.test.mjs —— T6：splitByRate 节奏分段纯函数测试。
//
// 覆盖验收七项：① 密集-空闲-密集切在低谷；② 段长钳制 [minSeg, maxSeg]；
// ③ 重叠带宽度与去重标记（非重叠区并集不重不漏）；④ 引用关联对不被切开；
// ⑤ 总量 < minSeg 返回单段；⑥ 确定性（两次调用 deep equal）；⑦ golden 真实数据跑通。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { splitByRate } from '../lib/split-by-rate.js'
import { splitByRate as splitByRateReExport } from '../lib/report.js'

const MIN = 60 * 1000

/** 构造时间序消息：bursts = [ [条数, 相邻毫秒间隔], ... ]，burst 之间隔 2 小时空闲 */
function buildMsgs(bursts) {
  const msgs = []
  let t = 1792000000000
  let id = 0
  for (const [count, step] of bursts) {
    for (let i = 0; i < count; i++) {
      msgs.push({ ts: t, msgId: `m${id++}` })
      t += step
    }
    t += 2 * 60 * MIN // burst 间空闲低谷
  }
  return msgs
}

/** 校验段列表结构合法：非重叠区按序拼接 = [0, n) 不重不漏 */
function assertPartition(segs, n, label) {
  let expect = 0
  for (const s of segs) {
    assert.ok(s.start <= s.end, `${label}: start<=end`)
    assert.equal(s.start, expect, `${label}: 非重叠区连续（期望起点 ${expect}）`)
    assert.ok(s.overlapStart <= s.start, `${label}: overlapStart<=start`)
    expect = s.end
  }
  assert.equal(expect, n, `${label}: 末段 end = n`)
}

test('① 密集-空闲-密集：切在空闲低谷处', () => {
  // 60 密集(1s) - 空闲 - 60 密集(1s)：低谷在两 burst 之间（下标 60 附近）
  const msgs = buildMsgs([[60, 1000], [60, 1000]])
  const segs = splitByRate(msgs, { minSeg: 20, maxSeg: 100, overlap: 8, gapWindowMs: 10 * MIN })
  assert.equal(segs.length, 2, '应切 2 段')
  assertPartition(segs, msgs.length, '①')
  // 切点应落在第一个 burst 结束（下标 59/60 之间，即后段 start=60）
  assert.equal(segs[1].start, 60, '切点应在空闲低谷（burst 边界）')
})

test('② 超长段强制再切且各段 ∈ [minSeg, maxSeg]；短段合并', () => {
  // 300 条匀速消息（无低谷）：只能在 maxSeg 处强制再切
  const msgs = buildMsgs([[300, 1000]])
  const segs = splitByRate(msgs, { minSeg: 20, maxSeg: 120, overlap: 8 })
  assertPartition(segs, msgs.length, '②-超长')
  assert.ok(segs.length >= 3, `300 条 / maxSeg=120 至少 3 段，实际 ${segs.length}`)
  for (const s of segs) {
    const len = s.end - s.start
    assert.ok(len <= 120, `段长 ${len} <= maxSeg`)
    assert.ok(len >= 20, `段长 ${len} >= minSeg（首尾段经合并也不应过短）`)
  }
  // 短段合并：105 条匀速 + minSeg=50/maxSeg=100 → 不能是 [100,5]，应并成 2 段均衡或 1 段
  const msgs2 = buildMsgs([[105, 1000]])
  const segs2 = splitByRate(msgs2, { minSeg: 50, maxSeg: 100, overlap: 8 })
  assertPartition(segs2, msgs2.length, '②-合并')
  for (const s of segs2) assert.ok(s.end - s.start >= 50, `合并后段长 >= minSeg`)
})

test('③ 重叠带恰为 overlap 条且带去重标记；非重叠区并集 = 全量不重不漏', () => {
  const msgs = buildMsgs([[60, 1000], [60, 1000]])
  const overlap = 8
  const segs = splitByRate(msgs, { minSeg: 20, maxSeg: 100, overlap, gapWindowMs: 10 * MIN })
  assert.equal(segs.length, 2)
  assert.equal(segs[0].overlapStart, segs[0].start, '首段重叠带为空（overlapStart===start）')
  assert.equal(segs[1].overlapStart, segs[1].start - overlap, '后段重叠带恰为 overlap 条')
  // 去重标记语义：按 [start,end) 拼接 = 全量索引不重不漏
  assertPartition(segs, msgs.length, '③')
  const union = []
  for (const s of segs) for (let i = s.start; i < s.end; i++) union.push(i)
  assert.deepEqual([...union].sort((a, b) => a - b), msgs.map((_, i) => i))
  assert.equal(new Set(union).size, union.length, '非重叠区无重复')
})

test('④ 引用关联对不被切开（同段或落在重叠带内）', () => {
  // 两 burst 各 60 条；后 burst 第 10 条（总下标 70）引用前 burst 末尾附近第 55 条（总下标 55）
  // 切点在 60：若保护生效，要么切点避开，要么重叠带覆盖 [55,60)
  const msgs = buildMsgs([[60, 1000], [60, 1000]])
  msgs[70].quoteOfMsgId = msgs[55].msgId
  const segs = splitByRate(msgs, { minSeg: 20, maxSeg: 100, overlap: 8, gapWindowMs: 10 * MIN })
  assertPartition(segs, msgs.length, '④')
  // 引用对 (55, 70)：断言同段或被重叠带覆盖
  const covered = segs.some((s) => s.overlapStart <= 55 && 70 < s.end)
  assert.ok(covered, `引用对 (55,70) 应同段或被重叠带覆盖，实际 ${JSON.stringify(segs)}`)
  // 更强构造：overlap=0 时切点必须避开引用对
  const segs0 = splitByRate(msgs, { minSeg: 20, maxSeg: 100, overlap: 0, gapWindowMs: 10 * MIN })
  const pairSegs = segs0.filter((s) => s.start <= 55 && 70 < s.end && s.overlapStart <= 55)
  assert.ok(pairSegs.length >= 1, `overlap=0 时引用对必须同段，实际 ${JSON.stringify(segs0)}`)
})

test('⑤ 总量 < minSeg → 单段', () => {
  const msgs = buildMsgs([[10, 1000]])
  const segs = splitByRate(msgs, { minSeg: 20, maxSeg: 100 })
  assert.deepEqual(segs, [{ start: 0, end: 10, overlapStart: 0 }])
  // 空输入
  assert.deepEqual(splitByRate([], {}), [])
})

test('⑥ 确定性：同输入两次调用 deep equal（不依赖时钟）', () => {
  const msgs = buildMsgs([[50, 1000], [80, 5000], [70, 1000]])
  const a = splitByRate(msgs, { minSeg: 20, maxSeg: 90, overlap: 5 })
  const b = splitByRate(msgs, { minSeg: 20, maxSeg: 90, overlap: 5 })
  assert.deepEqual(a, b)
})

test('⑦ golden 真实数据跑通：合法段列表（含 report.ts 再导出路径）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const golden = JSON.parse(
    readFileSync(join(here, 'fixtures/seg-golden/12345678@chatroom-2026-10-15.json'), 'utf8'),
  )
  const segs = splitByRateReExport(golden.messages, { minSeg: 20, maxSeg: 120, overlap: 8 })
  assert.ok(segs.length >= 2, '202 条消息应产生多段')
  assertPartition(segs, golden.messages.length, '⑦')
  for (const s of segs) {
    assert.ok(s.end - s.start <= 120, '真实数据段长 <= maxSeg')
    assert.ok(s.end - s.start >= 20, '真实数据段长 >= minSeg')
  }
})
