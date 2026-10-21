// distiller-batching.test.mjs —— T8 子任务 1：distiller 接入 safeBatch 估算。
// 覆盖：① snapshot 60 条、上限 25 → 3 批调用 + insights 合并去重；
//       ② 某批调用失败重试一次仍失败 → 该批跳过其余照常（warn 含批号）；
//       ③ timeout 批对半切分自愈；④ 无 safe-batch 状态时回退 min(distillEveryMessages, batchThreshold)；
//       ⑤ 有 safe-batch 状态时只读采用（不写回）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BufferPool } from '../lib/buffer.js'
import { PersonaService } from '../lib/persona.js'
import { Distiller } from '../lib/distiller.js'

function makeLogger() {
  const warnings = []
  return { warnings, warn(m) { warnings.push(m) }, info() {}, error() {} }
}

/** 搭一套可注入的批处理提炼器：60 条消息、批上限 25（无 safe-batch 状态 → min(25, 120)） */
function setup({ messages = 60, everyMessages = 25, batchThreshold = 120, readSafeBatch = undefined, llm } = {}) {
  const logger = makeLogger()
  const buffer = new BufferPool({ bufferSize: 200 })
  for (let i = 0; i < messages; i++) {
    buffer.push('g1', { ts: 1_000 + i, sender: `u${i % 5}`, text: JSON.stringify(`消息${i}`) })
  }
  const calls = []
  const llmDefault = {
    async complete(prompt) {
      calls.push(prompt)
      return JSON.stringify([{ type: 'quote', text: '卷不动了', reason: '梗' }])
    },
  }
  const produced = []
  const distiller = new Distiller({
    buffer,
    llm: llm ?? llmDefault,
    personas: new PersonaService({ stateDir: join(tmpdir(), 'lurker-dtest'), logger }),
    groupPersonas: {},
    logger,
    distillEveryMessages: everyMessages,
    distillIntervalMin: 15,
    onInsights: (chatId, insights) => produced.push([chatId, insights]),
    now: () => 1_700_000_000_000,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    batchThreshold,
    readSafeBatch,
  })
  return { distiller, calls, produced, logger, buffer }
}

test('① snapshot 60 条、上限 25 → 3 批调用；insights 合并去重（quote.text 相同只留一条）', async () => {
  const { distiller, calls, produced } = setup()
  const ok = await distiller.tryDistill('g1', 'interval')
  assert.equal(ok, true)
  assert.equal(calls.length, 3, '60/25 → 3 批')
  // 每批 prompt 数据区各含 ≤25 条（时间序切分：25/25/10）
  assert.deepEqual(calls.map((p) => JSON.parse(p.trimEnd().split('\n').pop()).length), [25, 25, 10])
  // 三批各回同一条 quote（text 相同）→ 精确去重后只剩 1 条
  assert.equal(produced.length, 1)
  const [chatId, insights] = produced[0]
  assert.equal(chatId, 'g1')
  assert.equal(insights.length, 1)
  assert.equal(insights[0].text, '卷不动了')
})

test('①b 三批各回不同 insights → 合并保留全部', async () => {
  const calls = []
  const llm = {
    async complete(prompt) {
      calls.push(prompt)
      return JSON.stringify([{ type: 'topic', title: `话题${calls.length}`, summary: 's' }])
    },
  }
  const { distiller, produced } = setup({ llm })
  assert.equal(await distiller.tryDistill('g1', 'interval'), true)
  assert.equal(produced[0][1].length, 3)
})

test('② 批 2 调用失败重试一次仍失败 → 该批跳过、批 1/3 照常（warn 含批号）', async () => {
  const calls = []
  const llm = {
    async complete(prompt) {
      calls.push(prompt)
      const data = JSON.parse(prompt.trimEnd().split('\n').pop())
      // C3 wire：ts 收为秒级整数（样例毫秒时间戳全落在 1 秒内）、n 为批内序号，
      // 故改用首条原文识别批次（批 1 消息0 起、批 2 消息25 起、批 3 消息50 起）
      const first = Number(data[0].text.replace('消息', ''))
      if (first === 25) throw new Error('connection reset')
      return JSON.stringify([{ type: 'quote', text: `引用-${first}`, reason: 'r' }])
    },
  }
  const { distiller, produced, logger } = setup({ llm })
  const ok = await distiller.tryDistill('g1', 'interval')
  assert.equal(ok, true, '部分批失败不整体失败')
  assert.equal(calls.length, 4, '批 1 一次 + 批 2 两次（重试）+ 批 3 一次')
  // warn：重试一次 + 重试后仍失败跳过（均含批号 2/3）
  assert.ok(logger.warnings.some((w) => /batch 2\/3 .*retry once/.test(w)), `重试 warn 缺批号：${logger.warnings}`)
  assert.ok(logger.warnings.some((w) => /batch 2\/3 .*batch skipped/.test(w)), `跳过 warn 缺批号：${logger.warnings}`)
  assert.deepEqual(
    produced[0][1].map((i) => i.text).sort(),
    ['引用-0', '引用-50'],
    '批 2 的产出被跳过，批 1/3 照常合并',
  )
})

test('③ timeout 批对半切分自愈：批 2 整批 timeout → 对半为 12+13 后成功', async () => {
  const calls = []
  const llm = {
    async complete(prompt) {
      calls.push(prompt)
      const data = JSON.parse(prompt.trimEnd().split('\n').pop())
      // 批 2（25 条，首条消息25）整批调用 timeout；左右半批（12/13 条）正常成功
      const first = Number(data[0].text.replace('消息', ''))
      if (first === 25 && data.length === 25) throw new Error('llm stream finished with error: Request timed out.')
      return JSON.stringify([{ type: 'quote', text: `引用-${first}`, reason: 'r' }])
    },
  }
  const { distiller, produced, logger } = setup({ llm })
  const ok = await distiller.tryDistill('g1', 'interval')
  assert.equal(ok, true)
  // 调用序列：批1 + 批2(timeout) + 批2左半(12) + 批2右半(13) + 批3 = 5 次
  assert.equal(calls.length, 5, `期望 5 次调用（对半自愈），实际 ${calls.length}`)
  assert.deepEqual(
    produced[0][1].map((i) => i.text).sort(),
    ['引用-0', '引用-25', '引用-37', '引用-50'],
    '对半子批产出并入合并（批 2 左半消息25 起 / 右半消息37 起）',
  )
  // timeout 自愈成功 → 无"跳过"warn
  assert.ok(!logger.warnings.some((w) => /batch skipped/.test(w)))
})

test('③b 叶子批（<5 条）仍 timeout → 该批跳过、其余照常', async () => {
  const llm = {
    async complete(prompt) {
      const data = JSON.parse(prompt.trimEnd().split('\n').pop())
      // 批 1（消息0–24）整条对半链（25→12→6→3 叶子）全 timeout → 跳过
      const first = Number(data[0].text.replace('消息', ''))
      if (first < 25) throw new Error('Request timed out.')
      return JSON.stringify([{ type: 'quote', text: `引用-${first}`, reason: 'r' }])
    },
  }
  const { distiller, produced, logger } = setup({ llm })
  const ok = await distiller.tryDistill('g1', 'interval')
  assert.equal(ok, true, '批 1 整链超时被跳过，批 2/3 照常')
  assert.deepEqual(
    produced[0][1].map((i) => i.text).sort(),
    ['引用-25', '引用-50'],
  )
  assert.ok(logger.warnings.some((w) => /timeout at leaf/.test(w)), '叶子批跳过 warn')
})

test('④ 无 safe-batch 状态 → 上限 = min(distillEveryMessages, batchThreshold)', async () => {
  const { distiller, calls } = setup({ everyMessages: 30, batchThreshold: 20, messages: 45 })
  await distiller.tryDistill('g1', 'interval')
  assert.equal(calls.length, 3, '45 条 / min(30,20)=20 → 3 批')
})

test('⑤ 有 safe-batch 状态 → 只读采用（不写回文件）', async () => {
  const state = { daily: { safeBatch: 15, streak: 0, durs: [] } }
  const { distiller, calls } = setup({ messages: 45, readSafeBatch: () => state.daily.safeBatch })
  await distiller.tryDistill('g1', 'interval')
  assert.equal(calls.length, 3, '45 条 / safeBatch 15 → 3 批')
  assert.deepEqual(state.daily, { safeBatch: 15, streak: 0, durs: [] }, 'distiller 只读不写——safe-batch 状态零变化')
})

test('≤上限单批路径零变化：仍一次调用、产出语义与旧路径一致', async () => {
  const { distiller, calls, produced } = setup({ messages: 10 })
  assert.equal(await distiller.tryDistill('g1', 'manual'), true)
  assert.equal(calls.length, 1)
  assert.equal(produced[0][1].length, 1)
})
