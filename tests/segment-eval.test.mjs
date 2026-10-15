// segment-eval.test.mjs —— T5：WindowDiff / Pk 度量测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { windowDiff, boundaryPk, boundariesFromSegments, boundariesByTimeGap } from '../lib/segment-eval.js'

// —— 已知小算例手工推导（n=6, k=2, ref=[4], hyp=[5]）——
// 切点 b → 二值串 s[b-1]=1：
//   ref=[4] → r = 0 0 0 1 0 0（下标 3 置 1）
//   hyp=[5] → h = 0 0 0 0 1 0（下标 4 置 1）
// WindowDiff（窗口 i=0..n-k-1=0..3，每窗 = |边界数差| + (r[i]!=h[i]?1:0)）：
//   i=0: |0-0| + (0==0→0) = 0
//   i=1: |0-0| + 0        = 0
//   i=2: r(0,1)=1 vs h(0,0)=0 → 1 + (r2==h2→0) = 1
//   i=3: r(1,0)=1 vs h(0,1)=1 → 0 + (r3=1 != h3=0 →1) = 1
//   WindowDiff = 2/4 = 0.5
// Pk（i=0..3，比较 (s[i]==s[i+2]) 是否一致）：
//   ref: i0(0,0)同 i1(0,1)异 i2(0,0)同 i3(1,0)异 → [同,异,同,异]
//   hyp: i0(0,0)同 i1(0,0)同 i2(0,1)异 i3(0,1)异 → [同,同,异,异]
//   不一致: i1, i2, i3 → Pk = 3/4 = 0.75
//   （注意 Pk 对「偏移 1 条」给 0.75 而非部分折中——这正是 §4.4 选 WindowDiff 为主的原因）
//
// —— 全错算例（n=6, k=2, ref=[4], hyp=[1]，偏移 3 > k）——
//   hyp=[1] → h = 1 0 0 0 0 0
//   i=0: |0-1| + (0!=1→1) = 2
//   i=1: |0-0| + 0        = 0
//   i=2: |1-0| + 0        = 1
//   i=3: |1-0| + (1!=0→1) = 2
//   WindowDiff = 5/4 = 1.25 → 按接口约定夹取到 1
//   Pk: ref [同,异,同,异] vs hyp [异,同,同,同] → i0/i1/i3 不一致 → Pk = 3/4 = 0.75
//
// —— 边界全丢算例（n=8, k=2, ref=[2,4,6,8], hyp=[]）——
//   r = 0 1 0 1 0 1 0 1（周期 2 交替），h = 全 0
//   WindowDiff 每窗 |1-0|=1 且 r[i]!=h[i] 恒真 → 每窗 2，7 窗 14/7 = 2 → 夹取 1
//   Pk：周期 2 的串在距离 k=2 处 r[i]==r[i+2] 恒真（同 hyp 全 0），Pk = 0
//   ——这是 Pk 对「边界间距恰=k」的已知退化（距离-k 采样跨不进段内），仅断言 WindowDiff。

test('完美切分：WindowDiff=0 且 Pk=0', () => {
  assert.equal(windowDiff([2, 5], [2, 5], 2, 6), 0)
  assert.equal(boundaryPk([2, 5], [2, 5], 2, 6), 0)
  assert.equal(windowDiff([4], [4], 2, 6), 0)
})

test('已知小算例（偏移 1 条，k=2）：WindowDiff=0.5、Pk=0.75', () => {
  assert.equal(windowDiff([4], [5], 2, 6), 0.5)
  assert.equal(boundaryPk([4], [5], 2, 6), 0.75)
})

test('全错（切点偏移 >k）：WindowDiff=1、Pk 显著高', () => {
  assert.equal(windowDiff([4], [1], 2, 6), 1) // 1.25 夹取到 1
  assert.equal(boundaryPk([4], [1], 2, 6), 0.75)
  // 边界全丢（hyp 单段 vs ref 四段交替）——Pk 在边界间距=k 时退化，仅看 WindowDiff
  assert.equal(windowDiff([2, 4, 6, 8], [], 2, 8), 1)
})

test('部分惩罚：偏移 1 条 + k 足够大 < 全错', () => {
  const partialWd = windowDiff([4], [5], 2, 6)
  const partialPk = boundaryPk([4], [5], 2, 6)
  const allWrongWd = windowDiff([4], [1], 2, 6)
  assert.ok(partialWd > 0 && partialWd < allWrongWd, `0 < ${partialWd} < ${allWrongWd}`)
  assert.ok(partialPk > 0 && partialPk <= 0.75) // Pk 部分惩罚弱于 WindowDiff，属已知特性
})

test('边界情况：空切点（双方单段）= 0', () => {
  assert.equal(windowDiff([], [], 2, 10), 0)
  assert.equal(boundaryPk([], [], 2, 10), 0)
})

test('边界情况：n 不足以开窗（单段/超小 n）= 0，不抛错', () => {
  assert.equal(windowDiff([], [], undefined, 1), 0)
  assert.equal(boundaryPk([], [], undefined, 1), 0)
  // n 缺省推断：切点 [2] → n=2，缺省 k=max(1,round(2/1))=2 → n-k<=0 → 0
  assert.equal(windowDiff([2], [2]), 0)
})

test('边界情况：ref/hyp 段数不同（多切/少切均受罚）', () => {
  // ref=[3,6]（3 段，r=00100100）vs hyp=[3]（2 段，h=00100000），n=8, k=2
  // 手工：i=0..3 窗全一致 0 分；i=4 窗边界数 1 vs 0 → 1；i=5 窗 1 + 起点不一致 1 → 2
  // WindowDiff = (0+0+0+0+1+2)/6 = 0.5（少切一个边界 → 部分惩罚而非满分）
  const wd = windowDiff([3, 6], [3], 2, 8)
  assert.ok(wd > 0 && wd < 1, `0 < ${wd} < 1`)
  assert.ok(Math.abs(wd - 0.5) < 1e-9)
  // 反向（hyp 多切）：同样非零受罚
  assert.ok(windowDiff([3], [3, 6], 2, 8) > 0)
})

test('缺省 k：按 ref 平均段长取整（golden 形状冒烟）', () => {
  // n=202, ref=[2,180,198] → 段数 4 → k=round(202/4)=51；切分一致 → 0
  assert.equal(windowDiff([2, 180, 198], [2, 180, 198], undefined, 202), 0)
  // 偏移 1 条仍有部分惩罚
  const wd = windowDiff([2, 180, 198], [2, 180, 199], undefined, 202)
  assert.ok(wd > 0 && wd < 1)
})

test('辅助函数：boundariesFromSegments', () => {
  // [[1,2],[3,4,5],[6]] → 段起点 3、6；第一段起点不算切点
  assert.deepEqual(boundariesFromSegments([[1, 2], [3, 4, 5], [6]]), [3, 6])
  assert.deepEqual(boundariesFromSegments([[1, 2, 3]]), [])
  assert.deepEqual(boundariesFromSegments([]), [])
})

test('辅助函数：boundariesByTimeGap（>30 分钟切点，1-based 新段首条序号）', () => {
  const min = 60_000
  const ts = [0, 10 * min, 40 * min + 1, 50 * min] // 间隔 10min / 30min1s / 10min
  assert.deepEqual(boundariesByTimeGap(ts), [3])
  assert.deepEqual(boundariesByTimeGap([0, min]), [])
})
