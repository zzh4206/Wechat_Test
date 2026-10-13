// notify.test.mjs —— M1-T1.4 系统通知通道：离线 mock（注入 execFile / 时钟）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Store } from '../lib/store.js'
import { SystemNotifier, clampText, MAX_TITLE_CHARS, MAX_BODY_CHARS } from '../lib/notify.js'

const logs = { info: [], warn: [], error: [] }
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

test('clampText：title/body 截断', () => {
  assert.equal(clampText('abc', 5), 'abc')
  assert.equal(clampText('x'.repeat(99), MAX_TITLE_CHARS).length, MAX_TITLE_CHARS)
  assert.equal(clampText('y'.repeat(999), MAX_BODY_CHARS).length, MAX_BODY_CHARS)
})

test('execFile 调用形态：osascript + 参数数组（无 shell 拼接），内容截断', async () => {
  const calls = []
  const notifier = new SystemNotifier({
    logger: silentLogger,
    execFileFn: (file, args, cb) => {
      calls.push({ file, args })
      cb(null)
    },
  })
  const longTitle = 'T'.repeat(100)
  const longBody = 'B'.repeat(MAX_BODY_CHARS - 40) + '; rm -rf /; "quotes" $(injection)'
  const r = await notifier.notify('daily', longTitle, longBody)
  assert.deepEqual(r, { shown: true, dryRun: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'osascript')
  assert.deepEqual(calls[0].args.slice(0, 2), ['-e', calls[0].args[1]])
  assert.equal(calls[0].args.length, 2, '只有 -e + 单条脚本参数')
  const script = calls[0].args[1]
  assert.ok(script.startsWith('display notification '))
  assert.ok(script.includes('with title '))
  // 截断生效
  assert.ok(script.includes('T'.repeat(MAX_TITLE_CHARS)))
  assert.ok(script.includes('B'.repeat(MAX_BODY_CHARS - 40)))
  // 注入内容被 JSON 转义进同一参数，无法逃逸成 shell 命令
  assert.ok(script.includes('\\"quotes\\"'))
  assert.ok(script.includes('$\(injection\)') || script.includes('$(injection)'))
})

test('dry_run：不调 execFile，日志只记元数据（无正文）', async () => {
  const calls = []
  const infos = []
  const notifier = new SystemNotifier({
    logger: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
    dryRun: true,
    execFileFn: (file, args, cb) => { calls.push(1); cb(null) },
  })
  const secretBody = '秘密正文-不应出现在任何日志'
  const r = await notifier.notify('weekly', '标题', secretBody)
  assert.deepEqual(r, { shown: false, dryRun: true })
  assert.equal(calls.length, 0)
  assert.equal(infos.length, 1)
  assert.ok(infos[0].includes('dry_run'))
  assert.ok(infos[0].includes('weekly'))
  assert.ok(!infos[0].includes(secretBody), '日志不得含通知正文')
  assert.ok(!infos[0].includes('标题'))
})

test('execFile 失败：返回 shown=false，不抛出', async () => {
  const warns = []
  const notifier = new SystemNotifier({
    logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    execFileFn: (file, args, cb) => cb(new Error('osascript exploded')),
  })
  const r = await notifier.notify('monthly', 't', 'b')
  assert.deepEqual(r, { shown: false, dryRun: false })
  assert.equal(warns.length, 1)
})

test('审计落盘：只记元数据（ts/kind/dryRun），不记标题正文', async () => {
  const base = mkdtempSync(join(tmpdir(), 'notify-audit-'))
  const dir = realpathSync(base)
  try {
    const store = new Store(dir, { warn: () => {}, error: () => {} })
    const notifier = new SystemNotifier({
      logger: silentLogger,
      store,
      dryRun: true,
      now: () => Date.UTC(2026, 2, 10, 12, 30, 0),
      execFileFn: (f, a, cb) => cb(null),
    })
    await notifier.notify('daily', '含密标题', '含密正文')
    const line = JSON.parse(readFileSync(join(dir, 'notify/audit.jsonl'), 'utf8').trim())
    assert.deepEqual(line, { ts: '2026-03-10T12:30:00.000Z', kind: 'daily', dryRun: true })
    const raw = readFileSync(join(dir, 'notify/audit.jsonl'), 'utf8')
    assert.ok(!raw.includes('含密标题') && !raw.includes('含密正文'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
