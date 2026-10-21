// synth-bench.test.mjs —— 合成基准输入侧验收（L1 画像 + L2 合成流/植入真值）。
//
// 覆盖八项：
// ① demo 画像合法（字段齐全、概率归一、量纲正确）；
// ② 同 seed 两次生成 stream/manifest 逐字节相同（核心函数 + CLI 落盘双重）；
// ③ 不同 seed 输出不同；
// ④ 条数落在 mean±20%、分时峰值贴近 hourlyCurve 峰小时；
// ⑤ 引用行号合法（quoteOf 指向更早行，manifest 对与流一致）；
// ⑥ 植入真值自洽（msgIdx/evidenceIdx 指向含关键词的模板文本，数组长度 = expected）；
// ⑦ 画像提取（--jsonl 反向喂）只含数字/枚举，无原文、无发送者假名、无真实 ts；
// ⑧ CLI 冒烟（--demo --days 1 --out tmp）。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEMO_PROFILE, extractProfile, readRowsFromJsonl } from '../scripts/synth-profile.mjs'
import { generate, TOPIC_LIBRARY, TASK_LIBRARY } from '../scripts/synth-gen.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GEN_CLI = join(ROOT, 'scripts', 'synth-gen.mjs')
const PROFILE_CLI = join(ROOT, 'scripts', 'synth-profile.mjs')

const tmpDirs = []
function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `synth-bench-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
})

const parseStream = (stream) =>
  stream
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

/** 递归收集 JSON 里的全部字符串（用于 §7 的「无原文/无 ID」断言） */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
  return out
}

function collectNumbers(value, out = []) {
  if (typeof value === 'number') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectNumbers(v, out)
  return out
}

function runCli(script, args) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  assert.equal(res.status, 0, `CLI 失败: ${res.stderr}`)
  return res
}

// —————————————— ① demo 画像合法 ——————————————

test('① demo 画像：字段齐全、gap 概率和=1、量纲/类型合法', () => {
  const p = DEMO_PROFILE
  for (const key of [
    'version',
    'seed',
    'source',
    'generatedAt',
    'days',
    'msgsPerDay',
    'hourlyCurve',
    'gapMsLogBuckets',
    'textLen',
    'ratios',
    'participants',
    'selfReplyRate',
  ]) {
    assert.ok(key in p, `画像缺少字段 ${key}`)
  }
  assert.equal(p.version, 1)
  assert.ok(Number.isInteger(p.seed))
  assert.match(p.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

  for (const key of ['mean', 'p50', 'p95']) assert.ok(Number.isFinite(p.msgsPerDay[key]), key)
  assert.ok(p.msgsPerDay.mean > 0 && p.msgsPerDay.p50 <= p.msgsPerDay.p95)

  assert.equal(p.hourlyCurve.length, 24)
  assert.ok(p.hourlyCurve.every((v) => Number.isFinite(v) && v >= 0))

  assert.equal(p.gapMsLogBuckets.length, 4)
  const pSum = p.gapMsLogBuckets.reduce((s, b) => s + b.p, 0)
  assert.ok(Math.abs(pSum - 1) <= 0.01, `gap 概率和应≈1，实际 ${pSum}`)
  assert.deepEqual(
    p.gapMsLogBuckets.map((b) => b.max),
    [1000, 10_000, 600_000, 1e15],
  )
  assert.ok(p.gapMsLogBuckets.every((b) => b.p >= 0 && b.p <= 1))

  assert.ok(p.textLen.zipfAlpha > 1)
  assert.ok(p.textLen.maxChars >= p.textLen.p95)
  for (const key of ['image', 'file', 'voice', 'system', 'quote']) {
    assert.ok(p.ratios[key] >= 0 && p.ratios[key] <= 1, `ratios.${key} 越界`)
  }
  assert.ok(Number.isInteger(p.participants.count) && p.participants.count >= 1)
  assert.ok(p.participants.topShare >= 0 && p.participants.topShare <= 1)
  assert.ok(p.selfReplyRate >= 0 && p.selfReplyRate <= 1)
})

// —————————————— ② 同 seed 逐字节相同 ——————————————

test('② 确定性：同 seed 两次生成逐字节相等（核心函数 + CLI 落盘）', () => {
  const a = generate(DEMO_PROFILE, 42, 3)
  const b = generate(DEMO_PROFILE, 42, 3)
  assert.equal(a.stream, b.stream)
  assert.equal(JSON.stringify(a.manifest), JSON.stringify(b.manifest))
  assert.equal(Buffer.compare(Buffer.from(a.stream), Buffer.from(b.stream)), 0)

  const dir1 = makeTmp('det1')
  const dir2 = makeTmp('det2')
  runCli(GEN_CLI, ['--demo', '--seed', '42', '--days', '3', '--out', dir1])
  runCli(GEN_CLI, ['--demo', '--seed', '42', '--days', '3', '--out', dir2])
  assert.deepEqual(readFileSync(join(dir1, 'stream.jsonl')), readFileSync(join(dir2, 'stream.jsonl')))
  assert.deepEqual(readFileSync(join(dir1, 'manifest.json')), readFileSync(join(dir2, 'manifest.json')))
})

// —————————————— ③ 不同 seed 不同 ——————————————

test('③ 不同 seed 生成不同（流与植入位置均变）', () => {
  const a = generate(DEMO_PROFILE, 42, 3)
  const c = generate(DEMO_PROFILE, 43, 3)
  assert.notEqual(a.stream, c.stream)
  assert.notEqual(JSON.stringify(a.manifest.topics), JSON.stringify(c.manifest.topics))
  assert.notEqual(JSON.stringify(a.manifest.quotes), JSON.stringify(c.manifest.quotes))
})

// —————————————— ④ 条数带宽与分时峰值 ——————————————

test('④ 条数在 mean±20%；分时峰值贴近 hourlyCurve 峰小时', () => {
  const { stream } = generate(DEMO_PROFILE, 42, 3)
  const msgs = parseStream(stream)
  const expected = DEMO_PROFILE.msgsPerDay.mean * 3
  assert.ok(
    msgs.length >= expected * 0.8 && msgs.length <= expected * 1.2,
    `条数 ${msgs.length} 应在 ${expected}±20% 内`,
  )

  const hist = new Array(24).fill(0)
  for (const m of msgs) hist[new Date(m.ts).getUTCHours()]++
  const peak = hist.indexOf(Math.max(...hist))
  const curvePeak = DEMO_PROFILE.hourlyCurve.indexOf(Math.max(...DEMO_PROFILE.hourlyCurve))
  const dist = Math.min(Math.abs(peak - curvePeak), 24 - Math.abs(peak - curvePeak))
  assert.ok(dist <= 1, `峰值小时 ${peak} 应贴近画像峰小时 ${curvePeak}`)

  // 时间戳必须是整数 epoch ms 且严格递增
  for (let i = 0; i < msgs.length; i++) {
    assert.ok(Number.isInteger(msgs[i].ts), `第 ${i} 行 ts 必须是整数`)
    if (i > 0) assert.ok(msgs[i].ts > msgs[i - 1].ts, `第 ${i} 行 ts 应严格递增`)
  }
})

// —————————————— ⑤ 引用行号合法 ——————————————

test('⑤ 引用行号：quoteOf 指向更早行；manifest pair 与流一致；其余为 null', () => {
  const { stream, manifest } = generate(DEMO_PROFILE, 42, 3)
  const msgs = parseStream(stream)
  let quoted = 0
  for (let i = 0; i < msgs.length; i++) {
    const q = msgs[i].quoteOf
    if (q === null) continue
    quoted++
    assert.ok(Number.isInteger(q), `第 ${i} 行 quoteOf 必须是整数或 null`)
    assert.ok(q >= 0 && q < i, `第 ${i} 行 quoteOf=${q} 必须指向更早行`)
  }
  assert.ok(quoted >= manifest.expected.quoteCount, '植入引用应计入流内引用')

  assert.equal(manifest.quotes.length, manifest.expected.quoteCount)
  for (const { pair } of manifest.quotes) {
    assert.equal(pair.length, 2)
    assert.ok(pair[0] < pair[1])
    assert.equal(msgs[pair[1]].quoteOf, pair[0], 'manifest 引用对必须与流一致')
  }
})

// —————————————— ⑥ 植入真值自洽 ——————————————

test('⑥ 植入真值：msgIdx/evidenceIdx 指向含关键词的模板文本，expected 与数组长度一致', () => {
  const { stream, manifest } = generate(DEMO_PROFILE, 42, 3)
  const msgs = parseStream(stream)

  assert.equal(manifest.version, 1)
  assert.equal(manifest.seed, 42)
  assert.equal(manifest.expected.topicCount, manifest.topics.length)
  assert.equal(manifest.expected.taskCount, manifest.tasks.length)
  assert.equal(manifest.expected.quoteCount, manifest.quotes.length)
  assert.equal(manifest.expected.topicCount, 6)
  assert.equal(manifest.expected.taskCount, 4)
  assert.equal(manifest.expected.quoteCount, 8)

  const keywordsByTitle = new Map(TOPIC_LIBRARY.map((t) => [t.title, t.keywords]))
  for (const topic of manifest.topics) {
    assert.match(topic.id, /^t\d+$/)
    assert.equal(topic.msgIdx.length, 3)
    const keywords = keywordsByTitle.get(topic.title)
    assert.ok(keywords, `未知话题标题: ${topic.title}`)
    for (const idx of topic.msgIdx) {
      assert.ok(Number.isInteger(idx) && idx >= 0 && idx < msgs.length)
      const text = msgs[idx].text
      assert.ok(
        keywords.some((k) => text.includes(k)),
        `话题 ${topic.id} 的第 ${idx} 行应含关键词之一：${text}`,
      )
    }
  }

  const statements = new Set(TASK_LIBRARY.map((t) => t.statement))
  for (const task of manifest.tasks) {
    assert.match(task.id, /^k\d+$/)
    assert.ok(statements.has(task.statement), `未知任务 statement: ${task.statement}`)
    assert.ok(Number.isInteger(task.evidenceIdx))
    assert.ok(task.evidenceIdx >= 0 && task.evidenceIdx < msgs.length)
    assert.ok(
      msgs[task.evidenceIdx].text.includes(task.statement),
      `任务 ${task.id} 的 evidence 行应包含承诺原文：${task.statement}`,
    )
  }
})

// —————————————— ⑦ 画像提取（jsonl 反向喂） ——————————————

test('⑦ 画像提取：--jsonl 输出只含数字/枚举，无原文、无假名、无真实 ts', () => {
  const { stream } = generate(DEMO_PROFILE, 123, 3)
  const dir = makeTmp('profile')
  const jsonl = join(dir, 'stream.jsonl')
  writeFileSync(jsonl, stream)
  const outFile = join(dir, 'profile.json')
  runCli(PROFILE_CLI, ['--jsonl', jsonl, '--seed', '42', '--out', outFile])

  const raw = readFileSync(outFile, 'utf8')
  const profile = JSON.parse(raw)

  // 核心函数与 CLI 同口径（generatedAt 除外）
  const fromFn = extractProfile(readRowsFromJsonl(jsonl), { source: 'jsonl', seed: 42 })
  const stripTime = (p) => ({ ...p, generatedAt: undefined })
  assert.deepEqual(stripTime(profile), stripTime(fromFn))

  // 形状
  assert.equal(profile.version, 1)
  assert.equal(profile.seed, 42)
  assert.equal(profile.source, 'jsonl')
  assert.equal(profile.days, 3)
  assert.equal(profile.hourlyCurve.length, 24)
  const pSum = profile.gapMsLogBuckets.reduce((s, b) => s + b.p, 0)
  assert.ok(Math.abs(pSum - 1) <= 0.01)
  assert.ok(profile.participants.count >= 1)
  assert.equal(profile.participants.count, DEMO_PROFILE.participants.count, '假名参与者数应可复原')
  assert.ok(profile.selfReplyRate >= 0 && profile.selfReplyRate <= 1)
  assert.ok(
    Math.abs(profile.selfReplyRate - DEMO_PROFILE.selfReplyRate) <= 0.06,
    `连续同发送者率应接近画像值，实际 ${profile.selfReplyRate}`,
  )
  for (const key of ['image', 'file', 'voice', 'system', 'quote']) {
    assert.ok(profile.ratios[key] >= 0 && profile.ratios[key] <= 1)
  }
  for (const n of collectNumbers(profile)) assert.ok(Number.isFinite(n))

  // 无原文：模板里的中文句子不得出现在画像 JSON 里
  for (const line of stream.split('\n')) {
    if (!line) continue
    const { text } = JSON.parse(line)
    if (text.length >= 4) assert.ok(!raw.includes(text), `画像泄漏了原文: ${text}`)
  }

  // 无发送者假名、无 wxid/群 ID 形态
  assert.ok(!/"u\d+"/.test(raw), '画像不应包含发送者假名')
  assert.ok(!/wxid_|\d+@chatroom/.test(raw), '画像不应包含微信 ID')

  // 无真实 ts：画像里不应出现 epoch ms 量级（1e12..1e13）的数值
  for (const n of collectNumbers(profile)) {
    assert.ok(!(n >= 1e12 && n < 1e13), `画像不应保留真实 epoch ms: ${n}`)
  }

  // 字符串只能是枚举或 ISO 时间戳
  for (const s of collectStrings(profile)) {
    assert.ok(
      /^(local-profile|jsonl|sqlite|demo)$/.test(s) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s),
      `画像出现非枚举字符串: ${s}`,
    )
  }
})

// —————————————— ⑧ CLI 冒烟 ——————————————

test('⑧ CLI 冒烟：--demo --days 1 --out tmp 产出合法 stream/manifest', () => {
  const dir = makeTmp('cli')
  runCli(GEN_CLI, ['--demo', '--seed', '7', '--days', '1', '--out', dir])

  const msgs = parseStream(readFileSync(join(dir, 'stream.jsonl'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))

  assert.ok(
    msgs.length >= DEMO_PROFILE.msgsPerDay.mean * 0.8 &&
      msgs.length <= DEMO_PROFILE.msgsPerDay.mean * 1.2,
    `1 天条数 ${msgs.length} 越界`,
  )
  for (const m of msgs) {
    assert.deepEqual(Object.keys(m), ['ts', 'sender', 'kind', 'text', 'quoteOf'])
    assert.match(m.sender, /^u\d+$/)
    assert.ok(['text', 'image', 'file', 'voice', 'system'].includes(m.kind))
    assert.equal(typeof m.text, 'string')
    assert.ok(m.text.length > 0)
  }
  assert.equal(manifest.expected.topicCount, 2)
  assert.equal(manifest.expected.taskCount, 1)
  assert.equal(manifest.expected.quoteCount, 3)
  assert.equal(manifest.topics.length, 2)
  assert.equal(manifest.tasks.length, 1)
  assert.equal(manifest.quotes.length, 3)

  // 画像 CLI 的 --demo 应与导出的默认画像一致（离线兜底可用）
  const profileOut = join(dir, 'demo-profile.json')
  runCli(PROFILE_CLI, ['--demo', '--out', profileOut])
  assert.deepEqual(JSON.parse(readFileSync(profileOut, 'utf8')), DEMO_PROFILE)
})
