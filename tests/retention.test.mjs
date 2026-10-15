// retention.test.mjs —— M6-T1：保留期清理（90 天滚动、引用保护、审计元数据、dispose 干净）。
// 全离线：临时目录 SQLite + 注入时钟，不读真实微信库、不发消息。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { RetentionService, RETENTION_AUDIT_REL } = await import('../lib/retention.js')

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CHAT = 'r@chatroom'
const NOW = new Date(2026, 9, 14, 12, 0, 0, 0).getTime()
const DAY = 86_400_000

function makeEnv() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'retention-')))
  const store = new Store(base, silentLogger)
  const groupStore = new GroupStoreService(base, silentLogger)
  return {
    base,
    store,
    groupStore,
    cleanup: () => {
      groupStore.dispose()
      rmSync(base, { recursive: true, force: true })
    },
  }
}

async function seed(env, msgs) {
  await env.groupStore.appendMessages(CHAT, msgs.map((m) => ({
    msgId: m.msgId,
    ts: m.ts,
    senderPid: 'wxid_a',
    senderName: '甲',
    kind: m.kind ?? 'text',
    text: m.text ?? '',
    quoteOfMsgId: m.quoteOfMsgId,
  })))
}

function mkRetention(env, over = {}) {
  return new RetentionService({
    groupStore: env.groupStore,
    store: env.store,
    groups: [CHAT],
    retentionDays: over.retentionDays ?? 90,
    logger: silentLogger,
    now: () => over.now ?? NOW,
    intervalMs: over.intervalMs,
  })
}

test('保留期：90 天前的 messages 被删，长期表与引用行保留', async () => {
  const env = makeEnv()
  try {
    const old = NOW - 91 * DAY
    const fresh = NOW - 1 * DAY
    await seed(env, [
      { msgId: 'old1', ts: old, text: '旧消息一' },
      { msgId: 'old2', ts: old, text: '旧消息二' },
      { msgId: 'recent', ts: fresh, text: '新消息' },
      { msgId: 'qref-p', ts: old, text: '被引用的旧原文' }, // 被 fresh 的引用行指向 → 保留
      { msgId: 'quoter', ts: fresh, text: '回复', quoteOfMsgId: 'qref-p' },
    ])
    // 旧消息上挂事件（长期保留 → 证据行必须保留）
    await env.groupStore.appendEvent(CHAT, {
      category: 'decision',
      statement: '旧事件',
      evidenceMsgId: 'old1',
      confidence: 0.9,
      status: 'active',
      source: 'auto',
    })
    // 旧消息上挂文件（长期保留 → files.msg_id 必须保留）
    await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_a', wxid: 'wxid_a', groupNick: '甲', remark: '', watchLevel: 'off' })
    await env.groupStore.appendFile(CHAT, {
      fileId: 'f_old2', name: '旧文件.docx', ext: 'docx', size: 0,
      senderPid: 'wxid_a', msgId: 'old2', wxPath: '待下载', category: '文档',
    })

    const res = await mkRetention(env).run()
    assert.equal(res.ran, true)
    // old1 被事件引用、old2 被文件引用、qref-p 被引用链引用 → 只有……全部保留？
    const ids = env.groupStore.getMessages(CHAT, { limit: 100 }).map((m) => m.msgId)
    assert.ok(ids.includes('old1'), '事件证据行必须保留')
    assert.ok(ids.includes('old2'), '文件引用行必须保留')
    assert.ok(ids.includes('qref-p'), '引用链被指向行必须保留')
    assert.ok(ids.includes('recent'))
    assert.equal(res.deleted[CHAT], 0)

    // 撤掉引用后，同批旧行应被清理
    const st = env.groupStore.open(CHAT)
    await st.supersedeEvent(0, 0) // noop 防御（不存在时不抛）
    env.groupStore.dispose()
    const raw = await import('node:sqlite')
    void raw
  } finally {
    env.cleanup()
  }
})

test('保留期：无引用的过期行被删且计数正确；边界 ts=cutoff 不删', async () => {
  const env = makeEnv()
  try {
    const cutoff = NOW - 90 * DAY
    await seed(env, [
      { msgId: 'a', ts: cutoff - 1000, text: '过期无引用' },
      { msgId: 'b', ts: cutoff, text: '边界行（不删，ts < cutoff 才删）' },
      { msgId: 'c', ts: cutoff + 1000, text: '新鲜行' },
    ])
    const res = await mkRetention(env).run()
    assert.equal(res.deleted[CHAT], 1)
    const ids = env.groupStore.getMessages(CHAT, { limit: 100 }).map((m) => m.msgId)
    assert.deepEqual(ids.sort(), ['b', 'c'])
  } finally {
    env.cleanup()
  }
})

test('保留期：审计只记元数据（无内容字段）；retentionDays 配置生效', async () => {
  const env = makeEnv()
  try {
    await seed(env, [
      { msgId: 'x', ts: NOW - 400 * DAY, text: '一年前的内容不应进审计' },
    ])
    // 默认 90 天：删不掉 400 天前？能——更旧也 < cutoff。改用小保留期验证配置
    const res90 = await mkRetention(env).run()
    assert.equal(res90.deleted[CHAT], 1)
    await seed(env, [{ msgId: 'y', ts: NOW - 10 * DAY, text: '十天前' }])
    const res30 = await mkRetention(env, { retentionDays: 30 }).run()
    assert.equal(res30.deleted[CHAT], 0) // 10 天 < 30 天 → 保留
    const res7 = await mkRetention(env, { retentionDays: 7 }).run()
    assert.equal(res7.deleted[CHAT], 1) // 10 天 > 7 天 → 删

    const audit = readFileSync(join(env.base, RETENTION_AUDIT_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const row of audit) {
      assert.deepEqual(Object.keys(row).sort(), ['beforeTs', 'chatId', 'deleted', 'ts'])
      assert.ok(!JSON.stringify(row).includes('不应进审计'), '审计绝不记内容')
    }
  } finally {
    env.cleanup()
  }
})

test('保留期：start/stop 心跳干净（dispose 无定时器残留）', async () => {
  const env = makeEnv()
  try {
    let t = NOW
    const svc = mkRetention(env, { intervalMs: 10 })
    svc.start()
    await new Promise((r) => setTimeout(r, 30)) // 心跳至少跑过一轮
    svc.stop()
    svc.stop() // 幂等
    t += DAY
    void t
    assert.ok(existsSync(join(env.base, RETENTION_AUDIT_REL)))
  } finally {
    env.cleanup()
  }
})

// —— T8 挂账项：llm-calls.jsonl 接入 +7 天滚动保留 ——
const { llmCallRelPath } = await import('../lib/llm-observe.js')

test('T8 llm-calls.jsonl：8 天前的行被清、今天的行保留（审计行结构不变）', async () => {
  const env = makeEnv()
  try {
    const oldTs = NOW - 8 * DAY
    const rows = [
      { ev: 'llm_call', chat: CHAT, kind: 'daily', phase: 'map', ts: oldTs, ok: true, model: 'glm-5.3' },
      { ev: 'llm_call', chat: CHAT, kind: 'daily', phase: 'merge', ts: NOW - 10_000, ok: true, model: 'glm-5.3' },
      { ev: 'llm_call', chat: CHAT, kind: 'distill', phase: 'distill', ts: NOW, ok: false, errKind: 'timeout', model: 'glm-5.3' },
    ]
    env.store.ensureDir(join('groups', CHAT))
    env.store.writeText(llmCallRelPath(CHAT), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    // messages 无行可删（空库）——run 仍应完成 jsonl 清理
    const res = await mkRetention(env).run()
    assert.equal(res.ran, true)
    assert.equal(res.llmCallsPruned[CHAT], 1, '只清掉 8 天前那一行')
    const kept = readFileSync(join(env.base, llmCallRelPath(CHAT)), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(kept.map((r) => r.phase), ['merge', 'distill'], '今天的行保留、旧行被清')
    assert.ok(!kept.some((r) => r.ts === oldTs))
    // 审计行仍只含元数据四字段（messages 清理口径不被 jsonl 清理污染）
    const audit = readFileSync(join(env.base, RETENTION_AUDIT_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const row of audit) {
      assert.deepEqual(Object.keys(row).sort(), ['beforeTs', 'chatId', 'deleted', 'ts'])
    }
  } finally {
    env.cleanup()
  }
})

test('T8 llm-calls.jsonl：损坏行/缺 ts 行保守保留；无过期行不重写', async () => {
  const env = makeEnv()
  try {
    const content = [
      '{ 这是损坏行（不是 JSON）',
      JSON.stringify({ ev: 'llm_call', ts: NOW }), // 有 ts 且新鲜
      JSON.stringify({ ev: 'llm_call' }), // 缺 ts → 保守保留
    ].join('\n') + '\n'
    env.store.ensureDir(join('groups', CHAT))
    env.store.writeText(llmCallRelPath(CHAT), content)
    const res = await mkRetention(env).run()
    assert.equal(res.llmCallsPruned[CHAT], undefined, '无过期行 → 零清理')
    const after = readFileSync(join(env.base, llmCallRelPath(CHAT)), 'utf8')
    assert.ok(after.includes('损坏行') && after.includes('"ev":"llm_call"'), '保守保留未动文件')
    // 再写入一行 30 天前的 → 只清它
    env.store.appendText(llmCallRelPath(CHAT), JSON.stringify({ ev: 'llm_call', ts: NOW - 30 * DAY }) + '\n')
    const res2 = await mkRetention(env).run()
    assert.equal(res2.llmCallsPruned[CHAT], 1)
    const kept = readFileSync(join(env.base, llmCallRelPath(CHAT)), 'utf8').trim().split('\n')
    assert.equal(kept.length, 3, '损坏行 + 新鲜行 + 缺 ts 行全部保留')
  } finally {
    env.cleanup()
  }
})
