#!/usr/bin/env node
// seg-eval.mjs —— T5：切分质量评测入口。
//
// 用法：node scripts/seg-eval.mjs <golden.json> [--splitter rate|gap] [--k <int>]
//   golden.json：tests/fixtures/seg-golden/<chatId>-<date>.json
//               { chat, date, messages:[{ts,msgId}], boundaries:[...] }
//
// 扩展点（T6 已兑现）：`rate` 切分器已接 lib/split-by-rate.js 的 splitByRate 实现；
// 旧 30 分钟间隙切分逻辑保留为 `gap` 切分器作对照。注册新切分器（embedding、
// supervised 等）只需往 splitters 表加一项，评测循环不用改。
import { readFileSync } from 'node:fs'
import { windowDiff, boundaryPk, boundariesByTimeGap } from '../lib/segment-eval.js'
import { splitByRate } from '../lib/split-by-rate.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const splitterName = args.includes('--splitter') ? args[args.indexOf('--splitter') + 1] : 'rate'
const kArg = args.includes('--k') ? Number(args[args.indexOf('--k') + 1]) : undefined

if (!file) {
  console.error('用法: node scripts/seg-eval.mjs <golden.json> [--splitter rate|gap] [--k <int>]')
  process.exit(1)
}

const golden = JSON.parse(readFileSync(file, 'utf8'))
const msgs = golden.messages ?? []
const ref = golden.boundaries ?? []
const n = msgs.length

// 切分器注册表：返回 hyp 切点位置数组（1-based 新段首条消息序号）。
// rate 取的是「非重叠归属区」边界（RateSegment.start）：重叠带仅影响 prompt 上下文、
// 不产生额外切点，故切点 = 每段 start + 1（跳过首段）。
const segmentsToBoundaries = (segments) => segments.slice(1).map((s) => s.start + 1)

const splitters = {
  // rate（T6 实现）：速率低谷切点 + 段长钳制 + 重叠带 + 引用边保护
  rate: (messages) =>
    segmentsToBoundaries(splitByRate(messages, { minSeg: 20, maxSeg: 120, overlap: 8 })),
  // gap（对照，T5 演示版保留）：相邻时间间隔 >30 分钟切点（AUTO-PRELIM 同款规则）
  gap: (messages) => boundariesByTimeGap(messages.map((m) => m.ts)),
}

const splitter = splitters[splitterName]
if (!splitter) {
  console.error(`未知切分器: ${splitterName}（可选: ${Object.keys(splitters).join(', ')}）`)
  process.exit(1)
}

const hyp = splitter(msgs)
const wd = windowDiff(ref, hyp, kArg, n)
const pk = boundaryPk(ref, hyp, kArg, n)

console.log(`golden      : ${file}`)
console.log(`chat/date   : ${golden.chat} / ${golden.date}`)
console.log(`messages    : ${n}`)
console.log(`ref 切点    : [${ref.join(', ')}]${golden.boundaryNote ? `  (${golden.boundaryNote})` : ''}`)
console.log(`hyp 切点    : [${hyp.join(', ')}]  (splitter=${splitterName})`)
console.log('')
console.log('splitter | refSeg | hypSeg | WindowDiff |    Pk')
console.log('---------|--------|--------|------------|-------')
console.log(
  `${splitterName.padEnd(8)} | ${String(ref.length + 1).padStart(6)} | ${String(hyp.length + 1).padStart(6)} | ${wd.toFixed(4).padStart(10)} | ${pk.toFixed(4).padStart(5)}`,
)
