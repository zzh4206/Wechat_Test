// bench-harness.test.mjs —— 合成基准判定侧（fault-llm / bench / bench-quality）的离线测试。
//
// 覆盖：
// ① fault-llm 序列/概率/计数/费用估算精确；
// ② timeout 与 server 等错误分类正确传递（errKindOf 与 FaultLlmError.kind 双口径）；
// ③ bench 在 alwaysOk 下探测为 guard、单日成本 ≤ 预算线 0.5、I1/I4/I5 PASS（#18 降本的回归锁）；
// ④ --storm 两遍重放：I3 按规范口径判「注入失败 ≤ 零失败基线 1.5x」；单次重放下 I3 为 N/A；
// ⑤ --variant legacy|guard 被接受并体现在输出（代码不支持 guard 时给出 warning）；
// ⑥ bench-quality 召回算法：构造 manifest+md → 召回 1.0、编造引用被判出；
// ⑦ 临时目录清理（bench 只写 TMPDIR，不碰 HOME）。
//
// 全离线：不联网、不读真实库、不写 ~/.dsh；fixture 为 3 天 × 50 条合成消息。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BENCH = join(ROOT, 'scripts', 'bench.mjs')
const QUALITY = join(ROOT, 'scripts', 'bench-quality.mjs')

const { createFaultLlm, FaultLlmError } = await import('../scripts/lib/fault-llm.mjs')
const { DEFAULT_LLM_PRICING, computeCostCny, errKindOf, estimateTokens } = await import('../lib/llm-observe.js')
const { evaluateQuality, parseReportMd } = await import('../scripts/bench-quality.mjs')

const INSTANT_SLEEP = async () => {}

/** 子进程跑脚本；返回 {status, stdout, stderr}（不因非零退出抛错） */
function runNode(script, args, { env, timeout = 180_000 } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  })
}

/**
 * 最小 fixture：3 天 × 50 条（08:00 起 5 分钟一条，活跃段 08:00–12:05）。
 * 5 分钟间隔让「每 5 条触发」形成 25 分钟节拍，短于 30 分钟 tick → 阈值主导，
 * 与 I1 的 `ceil(msgs/batch)` 上界前提一致。
 */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-fixture-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const messages = []
  for (let d = 0; d < 3; d++) {
    const dayStart = new Date(2026, 9, 20 + d, 8, 0, 0, 0).getTime()
    for (let i = 0; i < 50; i++) {
      messages.push({
        ts: dayStart + i * 5 * 60_000,
        sender: `合成成员${(i % 7) + 1}`,
        kind: 'text',
        text: `合成消息 ${d + 1}-${i + 1}：接口联调排期与版本发布窗口讨论`,
        quoteOf: null,
      })
    }
  }
  const stream = join(dir, 'stream.jsonl')
  writeFileSync(stream, messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
  const manifestObj = {
    version: 1,
    topics: [
      { id: 'T1', title: '接口联调排期', msgIdx: 2 },
      { id: 'T2', title: '版本发布窗口', msgIdx: 12 },
    ],
    tasks: [
      { id: 'K1', statement: '周五前给出联调环境', evidenceIdx: [5] },
      { id: 'K2', statement: '下周一冻结发布分支', evidenceIdx: [27] },
    ],
    quotes: [
      { pair: [3, 4], text: messages[3].text },
      { pair: [28, 29], text: messages[28].text },
    ],
    messages: messages.map((m) => ({ text: m.text })),
  }
  const manifest = join(dir, 'manifest.json')
  writeFileSync(manifest, JSON.stringify(manifestObj), 'utf8')
  return { dir, stream, manifest, messages, manifestObj }
}

// —————————————————— ① fault-llm ——————————————————

test('① fault-llm 序列回放/计数/费用估算精确，序列耗尽回落 defaultText', async () => {
  const sleeps = []
  const llm = createFaultLlm({
    script: [
      { ok: true, text: 'a'.repeat(160), delayMs: 7 },
      { err: 'timeout' },
      { ok: true, text: 'b'.repeat(320), delayMs: 0 },
    ],
    seed: 1,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  const prompt = 'p'.repeat(160)
  assert.equal(llm.modelId(), 'glm-5.3')
  assert.equal(await llm.complete(prompt), 'a'.repeat(160))
  await assert.rejects(llm.complete(prompt), (error) => {
    assert.ok(error instanceof FaultLlmError)
    assert.equal(error.kind, 'timeout')
    return true
  })
  assert.equal(await llm.complete(prompt), 'b'.repeat(320))
  // 序列耗尽 → 回落 {ok:true,text:'[]'}
  assert.equal(await llm.complete(prompt), '[]')

  assert.deepEqual(sleeps, [7, 0, 0, 0], '逐调用延迟（含 0）必须 await')
  assert.equal(llm.calls, 4)
  assert.equal(llm.okCalls, 3)
  assert.equal(llm.failCalls, 1)
  assert.equal(llm.promptChars, 640)
  assert.equal(llm.estimatedInTokens, 400, '每次 160 字符 ÷1.6 = 100，4 次共 400')
  assert.equal(llm.estimatedOutTokens, 100 + 200 + estimateTokens(2), 'a=100, b=200, []≈1')
  assert.equal(
    llm.estimatedCostCny,
    computeCostCny('glm-5.3', 400, 100 + 200 + estimateTokens(2), DEFAULT_LLM_PRICING),
    '费用口径 = lib/llm-observe 同款（glm-5.3 输入 8 / 输出 28）',
  )
  assert.deepEqual(llm.failByKind.timeout, 1)
  assert.equal(llm.seqIndex, 3)
  // stats() 是快照，不共享 failByKind 引用
  const snap = llm.stats()
  snap.failByKind.timeout = 999
  assert.equal(llm.failByKind.timeout, 1)
})

test('①b fault-llm 概率模式确定性 + 非法 JSON 概率', async () => {
  const make = (seed) =>
    createFaultLlm({
      script: {
        pFail: 0.4,
        pTimeout: 0.1,
        errWeights: { timeout: 1, rate_limit: 1, server: 1, auth: 1, bad_request: 1 },
      },
      seed,
      sleep: INSTANT_SLEEP,
    })
  const a = make(7)
  const b = make(7)
  const seqA = []
  const seqB = []
  for (let i = 0; i < 40; i++) {
    for (const [llm, seq] of [[a, seqA], [b, seqB]]) {
      try {
        await llm.complete('q')
        seq.push('ok')
      } catch (error) {
        seq.push(error.kind)
      }
    }
  }
  assert.deepEqual(seqA, seqB, '同 seed 同调用序 → 同故障序列')
  assert.ok(seqA.includes('ok'), '应包含成功调用')
  assert.ok(seqA.some((k) => k !== 'ok'), '应包含失败调用')
  assert.equal(a.failCalls, seqA.filter((k) => k !== 'ok').length)
  assert.equal(
    Object.values(a.failByKind).reduce((s, v) => s + v, 0),
    a.failCalls,
    'failByKind 总和 = 失败调用数',
  )

  const bad = createFaultLlm({ script: { pFail: 0, pBadJson: 1 }, sleep: INSTANT_SLEEP })
  for (let i = 0; i < 3; i++) assert.equal(await bad.complete('x'), 'not json at all')
  assert.equal(bad.badJsonCalls, 3)
  assert.equal(bad.okCalls, 3)
  assert.equal(bad.failCalls, 0)

  const ok = createFaultLlm({ script: 'alwaysOk', sleep: INSTANT_SLEEP })
  assert.equal(await ok.complete('x'), '[]')
  assert.equal(ok.calls, 1)
  assert.equal(ok.failCalls, 0)

  assert.throws(() => createFaultLlm({ script: [{ err: 'nope' }] }), TypeError)
  assert.throws(() => createFaultLlm({ script: { pFail: 0.5, pTimeout: 0.9 } }), TypeError)
})

// —————————————————— ② 错误分类 ——————————————————

test('② timeout 与 server/rate_limit/auth/bad_request 分类正确传递', async () => {
  const expected = ['timeout', 'server', 'rate_limit', 'auth', 'bad_request']
  const errors = []
  const llm = createFaultLlm({
    script: expected.map((err) => ({ err })),
    sleep: INSTANT_SLEEP,
  })
  for (const kind of expected) {
    let caught = null
    try {
      await llm.complete('x')
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof FaultLlmError, `${kind}: 必须抛 FaultLlmError`)
    assert.equal(caught.kind, kind)
    errors.push(caught)
  }
  // errKindOf 六分类（#18 C1「错误可见」）：fault-llm 注入的每类错误都应被识别成同名类别；
  // timeout 仍单独触发对半切分，其余类别只用于退避与失败行可见
  assert.deepEqual(errors.map((e) => errKindOf(e)), expected)
  assert.equal(errors[0].status, undefined, 'timeout 不是 HTTP 状态错误')
  assert.equal(errors[1].status, 500)
  assert.equal(errors[2].status, 429)
  assert.equal(errors[3].status, 401)
  assert.equal(errors[4].status, 400)
  for (const kind of expected) assert.equal(llm.failByKind[kind], 1, `failByKind.${kind}`)
  assert.equal(llm.calls, expected.length)
  assert.equal(llm.okCalls, 0)
})

// —————————————————— ③ bench alwaysOk ——————————————————

test('③ bench 在当前代码（guard）下单日成本 ≤ 预算线 0.5，且 I1/I4/I5 PASS', (t) => {
  const fx = makeFixture(t)
  const res = runNode(BENCH, [
    '--stream', fx.stream,
    '--manifest', fx.manifest,
    '--seed', '42',
    '--fail', '0',
    '--json',
  ])
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.days, 3)
  assert.equal(out.messages, 150)
  // 生产默认：每 25 条触发 + buffer 60 条环 → 理论最少 150/25 = 6 批
  assert.equal(out.distill.theoreticalMinCalls, 6)
  assert.ok(out.distill.calls >= out.distill.theoreticalMinCalls, '调用数不少于理论批数')
  // 触发形态：消息间隔 5 分钟 < 15 分钟 tick，故 interval 主导，每轮只喂 3 条新消息。
  // 调用数 ≈ 活跃窗口数，而不是理论批数——I1 的上界按「阈值轮 + 定时轮」求和，2026-11-10 起 PASS。
  assert.equal(out.distill.calls, 51)
  assert.equal(out.distill.intervalRounds, 51)
  assert.equal(out.callFanout, 8.5)
  assert.equal(out.invariants.I1.pass, true, out.invariants.I1.detail)
  // 退避 + 增量水位已合入：探测必须是 guard（旧 legacy 行为在同一进程里无法复现，--variant 只改标签）
  assert.equal(out.variant.detected, 'guard', JSON.stringify(out.variant.evidence))
  assert.ok(out.report.calls >= 3, '每天至少一份日报')
  assert.equal(out.invariants.I4.pass, true, out.invariants.I4.detail)
  assert.equal(out.invariants.I5.pass, true, out.invariants.I5.detail)
  assert.deepEqual(out.report.statuses, ['ok', 'ok', 'ok'])
  assert.ok(out.costCny > 0, '费用必须为正（估算 token × 价格）')
  // 降本回归锁：本 fixture 旧代码单日 ¥2.2–4.9（661 次提炼），guard 后约 ¥0.18（51 次）；预算线 0.5
  assert.ok(out.perDay.every((d) => d.costCny > 0))
  assert.ok(out.perDay.every((d) => d.costCny <= 0.5), `单日成本应 ≤ 0.5，实际最高 ${Math.max(...out.perDay.map((d) => d.costCny))}`)
  assert.equal(out.variant.effective, out.variant.detected)
})

// —————————————————— ④ 30% 失败 ——————————————————

test('④ 注入失败：单次重放 I3 为 N/A；--storm 两遍重放判重试风暴 ≤ 1.5x', (t) => {
  const fx = makeFixture(t)
  // 第 1 段：单次重放。没有零失败基线可比，I3 必须如实报 N/A，而不是拿
  // 「总调用 / 理论批数」冒充重试（2026-11-10 之前就是这么写的，--fail 0 时也红）。
  const single = runNode(BENCH, [
    '--stream', fx.stream,
    '--manifest', fx.manifest,
    '--seed', '42',
    '--fail', '0.3',
    '--json',
  ])
  assert.equal(single.status, 0, single.stderr)
  const one = JSON.parse(single.stdout)
  for (const id of ['I1', 'I2', 'I4', 'I5']) {
    assert.equal(typeof one.invariants[id].pass, 'boolean', `${id}.pass`)
    assert.equal(typeof one.invariants[id].detail, 'string', `${id}.detail`)
  }
  assert.equal(one.invariants.I3.pass, null, '单次重放不得给出重试风暴结论')
  assert.match(one.invariants.I3.detail, /--storm/, 'N/A 时必须指出怎么判')
  assert.equal(typeof one.invariants.I3.detail, 'string')
  assert.ok(one.calls > 0)
  assert.ok(one.failRate > 0, `注入 30% 后实测失败率应 >0（实际 ${one.failRate}）`)
  assert.ok(one.distill.failCalls > 0)
  assert.ok(Object.values(one.failByKind).reduce((s, v) => s + v, 0) > 0)
  assert.equal(one.report.statuses.length, 3)
  assert.equal(typeof one.allPass, 'boolean')

  // 第 2 段：--storm。规范口径 = 注入失败后调用数 ≤ 零失败基线 1.5 倍
  // （docs/SYNTHETIC-BENCH-METHODOLOGY.md §2 L2）。本 fixture：51 → 68 = 1.33x。
  const res = runNode(BENCH, [
    '--stream', fx.stream,
    '--manifest', fx.manifest,
    '--seed', '42',
    '--storm',
    '--json',
  ])
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.baseline.distillCalls, 51, '基线（零失败）提炼调用数')
  assert.equal(out.distill.calls, 68)
  const ratio = out.distill.calls / out.baseline.distillCalls
  assert.ok(ratio <= 1.5, `失败注入后放大 ${ratio.toFixed(2)}x > 1.5x：重试风暴回来了`)
  assert.equal(out.invariants.I3.pass, true, out.invariants.I3.detail)
  assert.equal(out.allPass, true, JSON.stringify(out.invariants))
  t.diagnostic(
    `--storm：基线 ${out.baseline.distillCalls} → 注入 30% 后 ${out.distill.calls}（${ratio.toFixed(2)}x）` +
      ` · 扇出 ${out.callFanout}x · ${out.invariants.I3.detail}`,
  )
})

// —————————————————— ⑤ 变体参数 ——————————————————

test('⑤ --variant legacy/guard 被接受并体现在输出', (t) => {
  const fx = makeFixture(t)
  for (const variant of ['legacy', 'guard']) {
    const res = runNode(BENCH, [
      '--stream', fx.stream,
      '--manifest', fx.manifest,
      '--seed', '7',
      '--variant', variant,
      '--json',
    ])
    assert.equal(res.status, 0, `${variant}: ${res.stderr}`)
    const out = JSON.parse(res.stdout)
    assert.equal(out.variant.requested, variant)
    assert.equal(out.variant.effective, variant)
    assert.equal(typeof out.variant.guardSupported, 'boolean')
    assert.equal(typeof out.variant.stateFileWritten, 'boolean')
    assert.ok(Array.isArray(out.variant.warnings))
    if (variant === 'guard' && out.variant.guardSupported === false) {
      assert.ok(
        out.variant.warnings.some((w) => w.includes('legacy')),
        '强制 guard 但代码不支持时必须明说行为等同 legacy',
      )
    }
  }
})

// —————————————————— ⑥ bench-quality ——————————————————

const QUALITY_MD_CLEAN = `# 日报 · 12345678@chatroom · 2026-10-20

## L1 一分钟层

**接口联调排期敲定:** 本周完成联调。

### 关键判断

1. 接口联调排期已定在周五。 [evidence: synth-0003]
2. 周五前给出联调环境。 [evidence: synth-0005]
3. 下周一冻结发布分支。 [evidence: synth-0020]

### 今日行动

-（无）

## L2 五分钟层

### 话题 1：版本发布窗口

- 【变化】**锁定周五**

## L3 溯源层

### 原文引用

1. [synth-0006] 2026-10-20 09:00 合成成员（12345678@chatroom）：「联调环境周五一定给」
2. [synth-0021] 2026-10-20 13:00 合成成员（12345678@chatroom）：「分支冻结前不要再合新需求」

### 本期文件索引
`

const FABRICATED_LINE =
  '3. [synth-0099] 2026-10-20 14:00 合成成员（12345678@chatroom）：「这是编造的引用」'

function qualityManifest(fx) {
  return {
    topics: [
      { id: 'T1', title: '接口联调排期', msgIdx: 2 },
      { id: 'T2', title: '版本发布窗口', msgIdx: 12 },
    ],
    tasks: [
      { id: 'K1', statement: '周五前给出联调环境', evidenceIdx: [5] },
      { id: 'K2', statement: '下周一冻结发布分支', evidenceIdx: [27] },
    ],
    quotes: [
      { pair: [3, 4], text: '联调环境周五一定给' },
      { pair: [28, 29], text: '分支冻结前不要再合新需求' },
    ],
    messages: fx.messages.map((m) => ({ text: m.text })),
  }
}

test('⑥ bench-quality：召回 1.0，编造引用被判出', (t) => {
  const fx = makeFixture(t)
  const manifest = qualityManifest(fx)
  const parsed = parseReportMd(QUALITY_MD_CLEAN)
  assert.equal(parsed.judgments.length, 3)
  assert.equal(parsed.quotes.length, 2)
  assert.equal(parsed.topics[0].title, '版本发布窗口')

  const clean = evaluateQuality({ reportMd: QUALITY_MD_CLEAN, manifest })
  assert.equal(clean.topicRecall, 1)
  assert.equal(clean.taskRecall, 1)
  assert.equal(clean.quoteRecall, 1)
  assert.deepEqual(clean.hallucinatedQuotes, [])
  assert.equal(clean.overall, 'PASS')

  const dirtyMd = QUALITY_MD_CLEAN.replace('### 本期文件索引', `${FABRICATED_LINE}\n\n### 本期文件索引`)
  const dirty = evaluateQuality({ reportMd: dirtyMd, manifest })
  assert.equal(dirty.topicRecall, 1)
  assert.equal(dirty.taskRecall, 1)
  assert.equal(dirty.quoteRecall, 1)
  assert.equal(dirty.hallucinatedQuotes.length, 1)
  assert.equal(dirty.hallucinatedQuotes[0].text, '这是编造的引用')
  assert.equal(dirty.pass.hallucinated, false)
  assert.equal(dirty.overall, 'FAIL')

  // CLI：干净报告 → 退出码 0 + 合法 JSON
  const dir = mkdtempSync(join(tmpdir(), 'bench-quality-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const reportPath = join(dir, 'report.md')
  const manifestPath = join(dir, 'manifest.json')
  writeFileSync(reportPath, QUALITY_MD_CLEAN, 'utf8')
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
  const cli = runNode(QUALITY, ['--report', reportPath, '--manifest', manifestPath, '--json'])
  assert.equal(cli.status, 0, cli.stderr)
  const cliOut = JSON.parse(cli.stdout)
  assert.equal(cliOut.overall, 'PASS')
  assert.equal(cliOut.quoteRecall, 1)

  // CLI：含编造引用 → 退出码 1，但仍输出可解析 JSON
  const dirtyPath = join(dir, 'report-dirty.md')
  writeFileSync(dirtyPath, dirtyMd, 'utf8')
  const cliDirty = runNode(QUALITY, ['--report', dirtyPath, '--manifest', manifestPath, '--json'])
  assert.equal(cliDirty.status, 1)
  const cliDirtyOut = JSON.parse(cliDirty.stdout)
  assert.equal(cliDirtyOut.hallucinatedQuotes.length, 1)
  assert.equal(cliDirtyOut.overall, 'FAIL')
})

// —————————————————— ⑦ 临时目录清理 ——————————————————

test('⑦ bench 只写 TMPDIR 且退出后清空临时目录，不碰 HOME', (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'bench-clean-tmp-'))
  const home = mkdtempSync(join(tmpdir(), 'bench-clean-home-'))
  t.after(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const res = runNode(BENCH, ['--synth', '--seed', '42', '--json'], {
    env: { TMPDIR: tmpRoot, HOME: home, USERPROFILE: home },
  })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.ok(out.calls > 0)
  assert.equal(out.days, 3)
  assert.deepEqual(readdirSync(tmpRoot), [], '临时 state 目录必须被 finally 清理')
  assert.deepEqual(readdirSync(home), [], '基准不得在 HOME 下产生 .dsh 等任何文件')
})
