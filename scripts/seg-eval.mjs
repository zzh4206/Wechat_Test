#!/usr/bin/env node
// seg-eval.mjs —— T5：切分质量评测入口。
//
// 用法：node scripts/seg-eval.mjs <golden.json> [--splitter rate] [--k <int>]
//   golden.json：tests/fixtures/seg-golden/<chatId>-<date>.json
//               { chat, date, messages:[{ts,msgId}], boundaries:[...] }
//
// 扩展点（对接 T6/T1）：当前只实现 `rate` 切分器演示版（时间间隔 >30 分钟切点，
// 与 golden 预填规则一致，仅作管线演示——此时 hyp==ref，WindowDiff/Pk 恒 0）。
// 将来 report.ts 落地 `splitByRate`（另一任务）后，只需在此处：
//     import { splitByRate } from '../lib/report.js'
//     splitters['rate'] = (msgs) => boundariesFromSegments(splitByRate(msgs, {...}))
// 并在 splitters 表注册新切分器（如 embedding、supervised）即可，评测循环不用改。
import { readFileSync } from 'node:fs'
import { windowDiff, boundaryPk, boundariesByTimeGap } from '../lib/segment-eval.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const splitterName = args.includes('--splitter') ? args[args.indexOf('--splitter') + 1] : 'rate'
const kArg = args.includes('--k') ? Number(args[args.indexOf('--k') + 1]) : undefined

if (!file) {
  console.error('用法: node scripts/seg-eval.mjs <golden.json> [--splitter rate] [--k <int>]')
  process.exit(1)
}

const golden = JSON.parse(readFileSync(file, 'utf8'))
const msgs = golden.messages ?? []
const ref = golden.boundaries ?? []
const n = msgs.length

// 切分器注册表：返回 hyp 切点位置数组（1-based 新段首条消息序号）
const splitters = {
  // rate 演示版：时间间隔 >30 分钟切点（AUTO-PRELIM 同款规则）
  rate: (messages) => boundariesByTimeGap(messages.map((m) => m.ts)),
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
