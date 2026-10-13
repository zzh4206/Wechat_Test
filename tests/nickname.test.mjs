// nickname.test.mjs + normalize —— W3 规范化与昵称解析测试（全 mock，零真实库）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeRowText } from '../lib/source/wechat-db.js'
import { NicknameResolver } from '../lib/source/nickname.js'

// —— normalizeRowText（纯函数快照）——

test('normalize：type 1 文本保留 + 发送者前缀剥离', () => {
  assert.equal(normalizeRowText('你好', 1, 'wxid_a'), '你好')
  assert.equal(normalizeRowText('wxid_a:\n你好', 1, 'wxid_a'), '你好')
  // 前缀与 sender 不匹配但形如 wxid → 仍剥离（历史消息形态兜底）
  assert.equal(normalizeRowText('wxid_b:\n早上好', 1, 'wxid_a'), '早上好')
  // sender 未知时不盲剥
  assert.equal(normalizeRowText('随便:\n内容', 1, 'unknown'), '随便:\n内容')
})

test('normalize：媒体占位与未知类型', () => {
  assert.equal(normalizeRowText('', 3, 'wxid_a'), '[图片]')
  assert.equal(normalizeRowText('', 34, 'wxid_a'), '[语音]')
  assert.equal(normalizeRowText('', 43, 'wxid_a'), '[视频]')
  assert.equal(normalizeRowText('', 999, 'wxid_a'), '[type:999]')
})

test('normalize：系统通知与 XML 系统消息跳过', () => {
  assert.equal(normalizeRowText('撤回了一条消息', 10000, 'wxid_a'), null)
  assert.equal(normalizeRowText('', 10002, 'wxid_a'), null)
  assert.equal(normalizeRowText('<sysmsg type="pat">…</sysmsg>', 1, 'wxid_a'), null)
  assert.equal(normalizeRowText('<emoji md5="xx"></emoji>', 1, 'wxid_a'), null)
})

// —— NicknameResolver（mock runner/readKey）——

const FAKE_KEY = 'ab'.repeat(32)

function makeResolver({ stdout = '', code = 0, ttlMs = 600_000 } = {}) {
  const calls = []
  const logger = { lines: { warn: [], error: [] }, info() {}, warn(m) { this.lines.warn.push(m) }, error(m) { this.lines.error.push(m) } }
  const runner = async (argv, stdin) => {
    calls.push({ argv: [...argv], stdin })
    return { code, stdout, stderr: '' }
  }
  const base = mkdtempSync(join(tmpdir(), 'w3nick-'))
  writeFileSync(join(base, 'keys.json'), JSON.stringify({ keys: { 'contact/contact.db': { enc_key: FAKE_KEY } } }), { mode: 0o600 })
  const resolver = new NicknameResolver({
    contactDbPath: join(base, 'contact.db'),
    keysJsonPath: join(base, 'keys.json'),
    logger,
    runner,
    ttlMs,
  })
  return { resolver, calls, logger, base }
}

test('resolveGroup：解析 tabs 输出；remark 优先；"ok" 回显被忽略', async () => {
  const stdout = ['ok', 'wxid_a\t备注名', 'wxid_b\t昵称B', 'wxid_c\twxid_c'].join('\n')
  const { resolver, calls, base } = makeResolver({ stdout })
  const map = await resolver.resolveGroup('10000@chatroom')
  assert.equal(map.get('wxid_a'), '备注名')
  assert.equal(map.get('wxid_b'), '昵称B')
  // 密钥纪律：argv 无密钥；stdin 经 PRAGMA 传钥；只读 URI
  assert.equal(calls.length, 1)
  assert.ok(calls[0].argv[0].includes('mode=ro'), '只读 URI')
  assert.ok(!calls[0].argv.join(' ').includes(FAKE_KEY), 'argv 不得含密钥')
  assert.ok(calls[0].stdin.includes(`x'${FAKE_KEY}'`), '密钥经 stdin PRAGMA')
  assert.ok(calls[0].stdin.includes('query_only'), '只读 PRAGMA')
  rmSync(base, { recursive: true, force: true })
})

test('resolveGroup：非法 chatId 拒查（SQL 注入面收口）', async () => {
  const { resolver } = makeResolver()
  await assert.rejects(() => resolver.resolveGroup("10000' OR '1'='1"), /invalid chatId form/)
})

test('resolveGroup：失败降级为空映射 + TTL 内不重查', async () => {
  const { resolver, calls, logger, base } = makeResolver({ code: 7 })
  const m1 = await resolver.resolveGroup('10000@chatroom')
  assert.equal(m1.size, 0)
  assert.ok(logger.lines.warn.some((w) => w.includes('degrade')))
  // TTL 内第二次 → 走缓存，不产生新子进程
  await resolver.resolveGroup('10000@chatroom')
  assert.equal(calls.length, 1)
  // 失败结果也被缓存（避免每轮轮询都打失败库）
  rmSync(base, { recursive: true, force: true })
})

test('lookup：命中返回昵称；miss 返回原 id 并 warn', async () => {
  const { resolver, logger, base } = makeResolver({ stdout: 'wxid_a\t小明' })
  assert.equal(await resolver.lookup('10000@chatroom', 'wxid_a'), '小明')
  assert.equal(await resolver.lookup('10000@chatroom', 'wxid_z'), 'wxid_z')
  assert.ok(logger.lines.warn.some((w) => w.includes('nickname miss')))
  rmSync(base, { recursive: true, force: true })
})

test('TTL 过期后重新查询', async () => {
  let t = 0
  const base = mkdtempSync(join(tmpdir(), 'w3ttl-'))
  writeFileSync(join(base, 'keys.json'), JSON.stringify({ keys: { 'contact/contact.db': { enc_key: FAKE_KEY } } }), { mode: 0o600 })
  const calls = []
  const resolver = new NicknameResolver({
    contactDbPath: join(base, 'contact.db'),
    keysJsonPath: join(base, 'keys.json'),
    logger: { info() {}, warn() {}, error() {} },
    ttlMs: 1000,
    now: () => t,
    runner: async (argv, stdin) => { calls.push(1); return { code: 0, stdout: 'wxid_a\t小明', stderr: '' } },
  })
  await resolver.resolveGroup('10000@chatroom')
  t = 500
  await resolver.resolveGroup('10000@chatroom')
  assert.equal(calls.length, 1, 'TTL 内走缓存')
  t = 1500
  await resolver.resolveGroup('10000@chatroom')
  assert.equal(calls.length, 2, 'TTL 过期重查')
  rmSync(base, { recursive: true, force: true })
})
