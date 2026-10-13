// cursor.test.mjs —— W4 持久化增量游标测试（真 Store + 临时目录，零真实库访问）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { WechatDbSource } from '../lib/source/wechat-db.js'

function makeLogger() {
  const lines = { warn: [], error: [] }
  return {
    lines,
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    info: () => {},
  }
}

/** 构造接 mock runner 的 source（output 可为函数：按调用序返回不同输出） */
function setup({ groups = ['10000@chatroom'], output, base: givenBase, backfillOnStart } = {}) {
  const base = givenBase ?? mkdtempSync(join(tmpdir(), 'w4cur-'))
  const logger = makeLogger()
  const store = new Store(base, logger)
  store.ensureDir('.')
  const calls = []
  const runner = async (args) => {
    calls.push([...args])
    const o =
      typeof output === 'function'
        ? output(calls.length, args)
        : { code: 0, stdout: output ?? JSON.stringify({ messages: [] }), stderr: '' }
    return { code: o.code ?? 0, stdout: o.stdout ?? JSON.stringify({ messages: [] }), stderr: o.stderr ?? '' }
  }
  const collected = []
  let clock = 0
  const source = new WechatDbSource({
    groups,
    dbRoot: '/tmp/fake-db-root',
    store,
    stateDir: base,
    logger,
    runner,
    pollIntervalMs: 1000,
    now: () => clock,
    backfillOnStart,
    onMessages: (msgs) => collected.push(...msgs),
  })
  return { source, base, logger, calls, collected, store, tick: () => (clock += 1001) }
}

const rowsOf = (...ids) =>
  JSON.stringify({
    messages: ids.map((id, i) => ({
      server_id: id,
      create_time: 1000 + i,
      sender_id: 'wxid_x',
      text: `msg-${id}`,
    })),
  })

test('首轮 3 条新消息 → recent 记录 3 个 id；重放同输出 → 0 新', async () => {
  const out = rowsOf('a', 'b', 'c')
  const { source, base, collected, tick } = setup({ output: out })
  await source.pollOnce()
  assert.equal(collected.length, 3)
  const cursor = JSON.parse(readFileSync(join(base, 'cursor.json'), 'utf8'))
  assert.deepEqual(cursor['10000@chatroom'].recent, ['a', 'b', 'c'])
  assert.equal(cursor['10000@chatroom'].total, 3)
  tick() // 越过轮询间隔，确保第二轮真正执行（而非被间隔窗口跳过）
  await source.pollOnce() // 重放同输出
  assert.equal(collected.length, 3, '重放不得重复投递')
  rmSync(base, { recursive: true, force: true })
})

test('持久化-恢复：新实例同 stateDir → 重放同输出依然 0 新（核心防重投用例）', async () => {
  const out = rowsOf('a', 'b', 'c')
  const { source: first, base, collected } = setup({ output: out })
  await first.pollOnce()
  assert.equal(collected.length, 3)
  // 模拟插件重启：同 stateDir 新实例（游标应从 cursor.json 恢复）
  const { source: second, collected: collected2 } = setup({ output: out, base })
  await second.pollOnce()
  assert.equal(collected2.length, 0, '重启后重放已读输出 → 零新消息（不重投递、不漏由下一用例保证）')
  // 不漏新消息：恢复后的实例收到全新 id → 正常投递
  const { source: third, collected: collected3 } = setup({ output: rowsOf('c', 'd'), base })
  await third.pollOnce()
  assert.equal(collected3.length, 1)
  assert.equal(collected3[0].messageId, 'd', '窗口内旧 id 去重、新 id 放行')
  rmSync(base, { recursive: true, force: true })
})

test('超窗裁剪：灌入 600 条后 recent ≤ 500，且最旧 id 不在窗口内', async () => {
  const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`)
  const { source, base, collected } = setup({ output: rowsOf(...ids) })
  await source.pollOnce()
  assert.equal(collected.length, 600) // 首轮全新 → 全投递（去重只挡已读）
  const cursor = JSON.parse(readFileSync(join(base, 'cursor.json'), 'utf8'))
  const recent = cursor['10000@chatroom'].recent
  assert.ok(recent.length <= 500, `recent 应 ≤500，实际 ${recent.length}`)
  assert.equal(recent[0], 'id-100', '裁掉最旧 100 个')
  assert.equal(cursor['10000@chatroom'].total, 600, 'total 记累计已读数')
  rmSync(base, { recursive: true, force: true })
})

test('损坏 cursor.json → 空游标降级 + warn，不抛错', async () => {
  const base = mkdtempSync(join(tmpdir(), 'w4corrupt-'))
  writeFileSync(join(base, 'cursor.json'), '{not valid json!!', 'utf8')
  const { source, collected, logger } = setup({ output: rowsOf('x'), base })
  await source.pollOnce() // 降级为空游标 → 首轮重投（可接受，已 warn）
  assert.equal(collected.length, 1)
  assert.ok(logger.lines.warn.some((m) => m.includes('corrupt')), '损坏必须 warn 且不抛错')
  rmSync(base, { recursive: true, force: true })
})

test('backfillOnStart=1 → 首轮允许回灌最新 1 条；=0 → 默认不回灌', async () => {
  const out = rowsOf('a', 'b', 'c')
  // 先建立游标
  const seed = setup({ output: out })
  await seed.source.pollOnce()
  // 重启 + backfillOnStart=1：最新 1 条（c）出窗 → 可回灌
  const bf = setup({ output: out, base: seed.base, backfillOnStart: 1 })
  await bf.source.pollOnce()
  assert.equal(bf.collected.length, 1)
  assert.equal(bf.collected[0].messageId, 'c', '回灌且仅回灌最新 1 条')
  // 再重启（无回灌）→ 0 新（bf 轮询后 c 已回游标并持久化）
  const plain = setup({ output: out, base: seed.base })
  await plain.source.pollOnce()
  assert.equal(plain.collected.length, 0, '默认 backfillOnStart=0 不回灌')
  rmSync(seed.base, { recursive: true, force: true })
})

test('写入时机：readOnce 不落盘，pollOnce 结束一次持久化', async () => {
  const { source, base } = setup({ output: rowsOf('a') })
  await source.readOnce('10000@chatroom')
  assert.equal(existsSync(join(base, 'cursor.json')), false, 'readOnce 不写盘（防每条消息 IO）')
  await source.pollOnce()
  assert.equal(existsSync(join(base, 'cursor.json')), true, 'pollOnce 结束统一落盘')
  rmSync(base, { recursive: true, force: true })
})
