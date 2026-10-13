// wechat-db-source.test.mjs —— W2 受监管读取适配器测试（全部 mock 子进程，零真实库访问）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

function makeRunner(output) {
  const calls = []
  const runner = async (args) => {
    calls.push([...args])
    let o
    if (typeof output === 'function') o = output(calls.length, args)
    else if (typeof output === 'string') o = { code: 0, stdout: output, stderr: '' }
    else o = output ?? {}
    return { code: o.code ?? 0, stdout: o.stdout ?? JSON.stringify({ messages: [] }), stderr: o.stderr ?? '' }
  }
  return { runner, calls }
}

function setup({ groups = ['10000@chatroom'], output, base: givenBase } = {}) {
  const base = givenBase ?? mkdtempSync(join(tmpdir(), 'w2src-'))
  const logger = makeLogger()
  const store = new Store(base, logger)
  store.ensureDir('.')
  const { runner, calls } = makeRunner(output)
  const collected = []
  const source = new WechatDbSource({
    groups,
    dbRoot: '/tmp/fake-db-root',
    store,
    stateDir: base,
    logger,
    runner,
    pollIntervalMs: 1000,
    onMessages: (msgs) => collected.push(...msgs),
  })
  return { source, base, logger, calls, collected, store }
}

test('白名单为空 → 构造即抛错（fail-closed）', () => {
  assert.throws(() => setup({ groups: [] }), /fail-closed/)
})

test('白名单外 chatId → 抛错且零子进程调用', async () => {
  const { source, calls } = setup()
  await assert.rejects(() => source.readOnce('99999@chatroom'), /not in the whitelist/)
  assert.equal(calls.length, 0, '名单外群不得产生任何子进程调用')
})

test('消息解析映射 + server_id 去重 + 无 server_id 行跳过', async () => {
  const rows = {
    messages: [
      { server_id: 'a1', create_time: 1791862498, sender_id: 'wxid_x', text: '你好' },
      { server_id: 'a1', create_time: 1791862499, sender_id: 'wxid_x', text: '重复行' },
      { server_id: null, create_time: 1791862500, sender_id: 'wxid_x', text: '本地行' },
    ],
  }
  const { source, collected } = setup({ output: JSON.stringify(rows) })
  // pollOnce 驱动（readOnce → 解析去重 → onMessages 投递）
  await source.pollOnce()
  assert.equal(collected.length, 1)
  assert.equal(collected[0].messageId, 'a1')
  assert.equal(collected[0].sender, 'wxid_x')
  assert.equal(collected[0].text, '你好')
  assert.equal(collected[0].ts, 1791862498)
  assert.equal(collected[0].chatId, '10000@chatroom')
  // 再轮询同样输出 → 去重后 0 条新
  await source.pollOnce()
  assert.equal(collected.length, 1, 'onMessages 只收到去重后的消息')
})

test('CLI 失败 → readOnce 抛错、审计记 ok:false、轮询指数退避', async () => {
  let now = 1000000
  const { source, base, logger } = setup({
    output: { code: 3, stderr: 'boom' },
  })
  // 注入时钟替换（构造后不可改，这里用 pollOnce 语义验证 consecutiveFailures）
  await assert.rejects(() => source.readOnce('10000@chatroom'))
  await source.pollOnce()
  const st = source.status()
  assert.ok(st.consecutiveFailures >= 1, '失败计数递增')
  assert.ok(st.nextAttemptAt > 0, '进入退避窗口')
  const auditLine = readFileSync(join(base, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(auditLine.every((e) => e.ok === false))
  assert.ok(logger.lines.error.length >= 1)
})

test('审计日志只含元数据，绝无消息内容', async () => {
  const { source, base } = setup({
    output: JSON.stringify({ messages: [{ server_id: 's1', create_time: 1, sender_id: 'wxid_s', text: '秘密正文LEAK' }] }),
  })
  await source.readOnce('10000@chatroom')
  const raw = readFileSync(join(base, 'audit.log'), 'utf8')
  assert.ok(!raw.includes('秘密正文LEAK'), '审计不得含消息正文')
  for (const line of raw.trim().split('\n')) {
    const e = JSON.parse(line)
    assert.deepEqual(Object.keys(e).sort(), ['chatId', 'count', 'ok', 'ts'])
  }
})

test('单实例锁：同 stateDir 二次 start 拒绝；清理后可重启', () => {
  const a = setup()
  const cleanup = a.source.start()
  // 同一 stateDir 的第二个实例 → 锁冲突
  const b = setup({ base: a.base })
  assert.throws(() => b.source.start(), /another instance holds/)
  assert.equal(a.source.status().running, true)
  cleanup()
  assert.equal(a.source.status().running, false)
  assert.equal(existsSync(join(a.base, 'wechat-db.lock')), false, '清理应释放锁文件')
  const c = b.source.start()
  c()
  rmSync(a.base, { recursive: true, force: true })
  rmSync(b.base, { recursive: true, force: true })
})

test('pollOnce 在退避窗口内整轮跳过（不产生子进程调用）', async () => {
  let now = 0
  const base = mkdtempSync(join(tmpdir(), 'w2clk-'))
  const logger = makeLogger()
  const store = new Store(base, logger)
  store.ensureDir('.')
  const { runner, calls } = makeRunner(JSON.stringify({ messages: [] }))
  const source = new WechatDbSource({
    groups: ['10000@chatroom'],
    dbRoot: '/tmp/fake',
    store,
    stateDir: base,
    logger,
    runner,
    pollIntervalMs: 1000,
    now: () => now,
    onMessages: () => {},
  })
  now = 0
  await source.pollOnce() // 成功 → nextAttemptAt = 1000
  assert.equal(calls.length, 1)
  now = 500
  await source.pollOnce() // 退避/间隔窗口内 → 跳过
  assert.equal(calls.length, 1, '窗口内不得重复轮询')
  now = 1001
  await source.pollOnce()
  assert.equal(calls.length, 2)
  rmSync(base, { recursive: true, force: true })
})
