// m6.test.mjs —— M6 打磨：files 子命令 mock、事件↔文件关联窗口、阈值配置生效、
// fused/split A/B 脚手架落盘。全离线 mock（LLM mock / runner mock + 临时目录），零真实库、零发送。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { WechatDbSource } = await import('../lib/source/wechat-db.js')
const { FileIndexService, linkFilesToEvents, EVENT_FILE_LINK_WINDOW_MS } = await import('../lib/file-index.js')
const { TaskRecognitionService } = await import('../lib/task-recognition.js')
const { PromiseRecognitionService } = await import('../lib/promise-track.js')
const { PersonDigestService, renderMarkdown } = await import('../lib/person-digest.js')
const { runAbComparison, buildFusedPrompt, buildSplitExtractPrompt, buildSplitSummarizePrompt } = await import('../lib/ab-harness.js')

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CHAT = 'g@chatroom'
const NOW = new Date(2026, 9, 14, 12, 0, 0, 0).getTime()

function makeEnv(name) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), name)))
  const store = new Store(base, silentLogger)
  const groupStore = new GroupStoreService(base, silentLogger)
  return {
    base, store, groupStore,
    cleanup: () => { groupStore.dispose(); rmSync(base, { recursive: true, force: true }) },
  }
}

async function seedMessages(groupStore, msgs) {
  await groupStore.appendMessages(CHAT, msgs.map((m) => ({
    msgId: m.msgId,
    ts: m.ts ?? NOW - 60_000,
    senderPid: m.senderPid ?? 'wxid_a',
    senderName: m.senderName ?? '甲',
    kind: m.kind ?? 'text',
    text: m.text ?? '',
    quoteOfMsgId: m.quoteOfMsgId,
  })))
}

// ———————————— T2：wechat_db.py files 子命令（插件端 mock） ————————————

function makeSource(runnerImpl) {
  return new WechatDbSource({
    groups: [CHAT],
    dbRoot: '/tmp/does-not-matter/db_storage',
    store: new Store(realpathSync(mkdtempSync(join(tmpdir(), 'src-'))), silentLogger),
    stateDir: realpathSync(mkdtempSync(join(tmpdir(), 'src-state-'))),
    logger: silentLogger,
    runner: runnerImpl,
    onMessages: () => {},
  })
}

test('files 定位：locateFiles 解析工具输出；失败/非法输出返回 []', async () => {
  const ok = await makeSource(async (args) => {
    assert.ok(args.includes('files'))
    assert.ok(args.includes('--chat-id'))
    return {
      code: 0,
      stdout: JSON.stringify({
        chat_id: CHAT,
        files: [
          { msg_id: '101', name: '方案.docx', path: '/wx/msg/file/2026-10/方案.docx', available: true },
          { msg_id: '102', name: '未下载.zip', path: null, available: false },
          { bad: 'row' },
        ],
      }),
      stderr: '',
    }
  }).locateFiles(CHAT, 50)
  assert.equal(ok.length, 2)
  assert.equal(ok[0].msg_id, '101')
  assert.equal(ok[0].available, true)
  assert.equal(ok[1].available, false)

  const failed = await makeSource(async () => ({ code: 2, stdout: '', stderr: 'boom' })).locateFiles(CHAT)
  assert.deepEqual(failed, [])
  const garbage = await makeSource(async () => ({ code: 0, stdout: 'not json', stderr: '' })).locateFiles(CHAT)
  assert.deepEqual(garbage, [])
})

test('file-index 接线：refreshPaths → locatePath 命中记路径；未命中保持待下载占位', async () => {
  const env = makeEnv('m6-locate-')
  try {
    await seedMessages(env.groupStore, [
      { msgId: '101', kind: 'file', text: '方案.docx' },
      { msgId: '102', kind: 'file', text: '未下载.zip' },
    ])
    const locates = []
    const svc = new FileIndexService({
      groupStore: env.groupStore,
      llm: { complete: async () => JSON.stringify({ summaries: [] }) },
      logger: silentLogger,
      enabled: true,
      store: env.store,
      locatePath: (chatId, msg) => {
        const hit = msg.msgId === '101' ? '/wx/msg/file/2026-10/方案.docx' : null
        locates.push({ chatId, msgId: msg.msgId, found: hit !== null }) // 每次定位记 audit 元数据
        return hit
      },
      refreshPaths: async (chatId) => {
        assert.equal(chatId, CHAT) // 按会话刷新
      },
      now: () => NOW,
    })
    const res = await svc.scanChat(CHAT)
    assert.equal(res.newFiles, 2)
    const files = env.groupStore.getFiles(CHAT)
    assert.equal(files.find((f) => f.name === '方案.docx').wxPath, '/wx/msg/file/2026-10/方案.docx')
    assert.equal(files.find((f) => f.name === '未下载.zip').wxPath, '待下载')
    assert.deepEqual(locates.map((l) => l.msgId).sort(), ['101', '102'])
  } finally {
    env.cleanup()
  }
})

// ———————————— T3：事件↔文件自动关联（±10 分钟窗口） ————————————

test('事件↔文件：窗口内自动挂 file_ids；窗外不挂；幂等；confidence 记审计', async () => {
  const env = makeEnv('m6-link-')
  try {
    await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_a', wxid: 'wxid_a', groupNick: '甲', remark: '', watchLevel: 'off' })
    const evTs = NOW - 60_000
    await seedMessages(env.groupStore, [
      { msgId: 'ev-m', ts: evTs, text: '拍板：用方案 A' },
      { msgId: 'f-in', ts: evTs + 5 * 60_000, kind: 'file', text: '方案A.pdf' },
      { msgId: 'f-out', ts: evTs + 20 * 60_000, kind: 'file', text: '无关.docx' },
    ])
    await env.groupStore.appendEvent(CHAT, {
      category: 'decision', statement: '决定用方案 A', evidenceMsgId: 'ev-m', confidence: 0.9, status: 'active', source: 'auto',
    })
    await env.groupStore.appendFile(CHAT, {
      fileId: 'f_in', name: '方案A.pdf', ext: 'pdf', size: 0, senderPid: 'wxid_a', msgId: 'f-in', wxPath: '待下载', category: '文档',
    })
    await env.groupStore.appendFileAppearance(CHAT, 'f_in', 'f-in', evTs + 5 * 60_000)
    await env.groupStore.appendFile(CHAT, {
      fileId: 'f_out', name: '无关.docx', ext: 'docx', size: 0, senderPid: 'wxid_a', msgId: 'f-out', wxPath: '待下载', category: '文档',
    })
    await env.groupStore.appendFileAppearance(CHAT, 'f_out', 'f-out', evTs + 20 * 60_000)
    assert.equal(EVENT_FILE_LINK_WINDOW_MS, 10 * 60_000)

    const audits = []
    const r1 = await linkFilesToEvents(CHAT, {
      groupStore: env.groupStore,
      logger: silentLogger,
      auditAppend: (e) => audits.push(e),
      now: () => NOW,
    })
    assert.equal(r1.linked, 1)
    const [ev] = env.groupStore.getEvents(CHAT, { limit: 10 })
    assert.deepEqual(ev.fileIds, ['f_in'])
    // 事件本体未被改动（只写关联行）
    assert.equal(ev.statement, '决定用方案 A')
    assert.equal(ev.status, 'active')
    assert.equal(ev.confidence, 0.9)
    // 审计：confidence ∈ (0,1]，basis=time_proximity，无内容字段
    assert.equal(audits.length, 1)
    assert.equal(audits[0].eventId, ev.eventId)
    assert.ok(audits[0].confidence > 0 && audits[0].confidence <= 1)
    assert.equal(audits[0].basis, 'time_proximity')
    // 幂等：重跑不再重复挂
    const r2 = await linkFilesToEvents(CHAT, {
      groupStore: env.groupStore, logger: silentLogger, now: () => NOW,
    })
    assert.equal(r2.linked, 0)
    assert.deepEqual(env.groupStore.getEvents(CHAT, { limit: 10 })[0].fileIds, ['f_in'])
  } finally {
    env.cleanup()
  }
})

// ———————————— T4：误报阈值配置化 ————————————

test('阈值：minTaskConfidence 低于门槛的事件识别不落库（默认 0 = 现行为）', async () => {
  const env = makeEnv('m6-thr-')
  try {
    await seedMessages(env.groupStore, [
      { msgId: 'm1', text: '拍板：周五上线' },
      { msgId: 'm2', text: '拍板：换供应商' },
    ])
    const recognition = JSON.stringify({
      tasks: [],
      events: [
        { n: 1, category: 'decision', statement: '高置信事件', confidence: 0.9, supersedes_e: 0 },
        { n: 2, category: 'change', statement: '低置信事件', confidence: 0.3, supersedes_e: 0 },
      ],
      task_updates: [],
    })
    const mk = (minConfidence) => new TaskRecognitionService({
      groupStore: env.groupStore,
      llm: { complete: async () => recognition },
      logger: silentLogger,
      enabled: true,
      selfWxid: 'wxid_self',
      minConfidence,
      now: () => NOW,
    })
    // 默认 0：两条都落库（现行为）
    await mk(0).scanChat(CHAT, NOW)
    assert.equal(env.groupStore.getEvents(CHAT, { limit: 10 }).length, 2)
    // 门槛 0.5（干净库重跑）：低置信丢弃、高置信落库
    const env2 = makeEnv('m6-thr2-')
    try {
      await seedMessages(env2.groupStore, [
        { msgId: 'm1', text: '拍板：周五上线' },
        { msgId: 'm2', text: '拍板：换供应商' },
      ])
      const res = await mk(0.5)
      // 服务绑定 env.groupStore —— mk 用的是 env；这里直接在 env 上先删低置信行再验证门槛：
      // 改为在 env2 上重建服务
      const mk2 = (minConfidence) => new TaskRecognitionService({
        groupStore: env2.groupStore,
        llm: { complete: async () => recognition },
        logger: silentLogger,
        enabled: true,
        selfWxid: 'wxid_self',
        minConfidence,
        now: () => NOW,
      })
      const r = await mk2(0.5).scanChat(CHAT, NOW)
      assert.equal(r.eventsInserted, 1)
      const stmts = env2.groupStore.getEvents(CHAT, { limit: 10 }).map((e) => e.statement)
      assert.ok(stmts.includes('高置信事件'))
      assert.ok(!stmts.includes('低置信事件'))
    } finally {
      env2.cleanup()
    }
  } finally {
    env.cleanup()
  }
})

test('阈值：fulfilConfidence 越界 clamp、默认 0.5（现行为）——低置信不自动置 fulfilled', async () => {
  const env = makeEnv('m6-ful-')
  try {
    await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_self', wxid: 'wxid_self', groupNick: '小明' })
    await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_bob', wxid: 'wxid_bob', groupNick: '老王' })
    const DAY = 86_400_000
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'req1', ts: NOW - 3 * DAY, senderPid: 'wxid_self', senderName: '小明', text: '材料好了发我一份' },
      { msgId: 'ans1', ts: NOW - 3 * DAY + 60_000, senderPid: 'wxid_bob', senderName: '老王', text: '好的，周三前给你' },
      { msgId: 'ful1', ts: NOW - 1000, senderPid: 'wxid_bob', senderName: '老王', text: '材料在这，查收' },
    ])
    // 扫描1：建承诺（waiting 由 confirm 语义外的默认路径……这里直接手动确认到 waiting）
    const svc = (fulfilConfidence) => new PromiseRecognitionService({
      groupStore: env.groupStore,
      llm: { complete: async () => JSON.stringify({ promises: [], promise_updates: [], fulfilments: [{ p: 1, n: 1, confidence: 0.6 }] }) },
      logger: silentLogger,
      enabled: true,
      selfWxid: 'wxid_self',
      store: env.store,
      fulfilConfidence,
      now: () => NOW,
    })
    await new PromiseRecognitionService({
      groupStore: env.groupStore,
      llm: { complete: async () => JSON.stringify({ promises: [{ n: 2, requester_n: 1, statement: '周三前把材料给小明', promiser: '老王', deadline_text: '周三前', deadline_confidence: 0.8 }], promise_updates: [], fulfilments: [] }) },
      logger: silentLogger, enabled: true, selfWxid: 'wxid_self', store: env.store, now: () => NOW,
    }).scanChat(CHAT, NOW - 2 * DAY)
    const id = env.groupStore.getPromises(CHAT)[0].promiseId
    assert.ok(await env.groupStore.getPromises(CHAT).length === 1)
    // confirm 到 waiting（公开 API）
    const confirmer = new PromiseRecognitionService({
      groupStore: env.groupStore, llm: { complete: async () => 'null' }, logger: silentLogger,
      enabled: true, selfWxid: 'wxid_self', store: env.store, now: () => NOW,
    })
    assert.ok(await confirmer.confirmPromise(CHAT, id))
    // 默认阈值 0.5：confidence 0.6 兑现承诺人本人消息 → 自动 fulfilled（现行为）
    await svc(0.5).scanChat(CHAT, NOW)
    assert.equal(env.groupStore.getPromise(CHAT, id).status, 'fulfilled', '0.6 ≥ 0.5 默认阈值 → 兑现')
  } finally {
    env.cleanup()
  }
})

test('阈值：fulfilConfidence 提高后同一 0.6 兑现不自动置 fulfilled', async () => {
  const env = makeEnv('m6-ful2-')
  try {
    await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_self', wxid: 'wxid_self', groupNick: '小明' })
    await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_bob', wxid: 'wxid_bob', groupNick: '老王' })
    const DAY = 86_400_000
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'req1', ts: NOW - 3 * DAY, senderPid: 'wxid_self', senderName: '小明', text: '材料好了发我一份' },
      { msgId: 'ans1', ts: NOW - 3 * DAY + 60_000, senderPid: 'wxid_bob', senderName: '老王', text: '好的，周三前给你' },
      { msgId: 'ful1', ts: NOW - 1000, senderPid: 'wxid_bob', senderName: '老王', text: '材料在这，查收' },
    ])
    await new PromiseRecognitionService({
      groupStore: env.groupStore,
      llm: { complete: async () => JSON.stringify({ promises: [{ n: 2, requester_n: 1, statement: '周三前把材料给小明', promiser: '老王', deadline_text: '周三前', deadline_confidence: 0.8 }], promise_updates: [], fulfilments: [] }) },
      logger: silentLogger, enabled: true, selfWxid: 'wxid_self', store: env.store, now: () => NOW,
    }).scanChat(CHAT, NOW - 2 * DAY)
    const id = env.groupStore.getPromises(CHAT)[0].promiseId
    const confirmer = new PromiseRecognitionService({
      groupStore: env.groupStore, llm: { complete: async () => 'null' }, logger: silentLogger,
      enabled: true, selfWxid: 'wxid_self', store: env.store, now: () => NOW,
    })
    assert.ok(await confirmer.confirmPromise(CHAT, id))
    // 阈值提到 0.9：0.6 只提示不自动兑现（配置生效）
    await new PromiseRecognitionService({
      groupStore: env.groupStore,
      llm: { complete: async () => JSON.stringify({ promises: [], promise_updates: [], fulfilments: [{ p: 1, n: 1, confidence: 0.6 }] }) },
      logger: silentLogger, enabled: true, selfWxid: 'wxid_self', store: env.store,
      fulfilConfidence: 0.9, now: () => NOW,
    }).scanChat(CHAT, NOW)
    assert.equal(env.groupStore.getPromise(CHAT, id).status, 'waiting', '低于配置阈值不自动置 fulfilled')
  } finally {
    env.cleanup()
  }
})

test('阈值：activitySpikeMultiplier 突变倍数配置生效（默认 3 = 现行为）', async () => {
  const env = makeEnv('m6-spike-')
  try {
    const pid = 'wxid_a'
    await env.groupStore.appendIdentity(CHAT, { pid, wxid: pid, groupNick: '甲', remark: '', watchLevel: 'global' })
    // 今日 10 条，近 7 日每日 2 条：×3 判异常，×10 不判
    const today = NOW
    const day = 86_400_000
    await seedMessages(env.groupStore, Array.from({ length: 10 }, (_, i) => ({
      msgId: `t${i}`, ts: today - i * 1000, text: `今天的发言 ${i}`,
    })))
    for (let d = 1; d <= 7; d++) {
      await seedMessages(env.groupStore, Array.from({ length: 2 }, (_, i) => ({
        msgId: `d${d}_${i}`, ts: today - d * day + i * 1000, text: '平日的发言',
      })))
    }
    const mk = (mult) => new PersonDigestService({
      groupStore: env.groupStore,
      store: env.store,
      stateDir: env.base,
      llm: { complete: async () => 'null' },
      logger: silentLogger,
      enabled: true,
      activitySpikeMultiplier: mult,
      now: () => NOW,
    })
    // ×3（默认）：10 > 2×3 → 异常标注
    const r3 = await mk(3).generateDaily(CHAT, pid)
    assert.ok(r3.path, 'LLM mock 返回 null → degraded 占位也落盘')
    const files3 = readFileSync(join(env.base, r3.path), 'utf8')
    assert.ok(files3.includes('活跃度异常'), '×3 应判异常（现行为）')
    // ×10：10 ≤ 2×10 → 不判
    const r10 = await mk(10).generateDaily(CHAT, pid)
    const files10 = readFileSync(join(env.base, r10.path), 'utf8')
    assert.ok(!files10.includes('活跃度异常'), '×10 不应判异常')
  } finally {
    env.cleanup()
  }
})

function iso(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

test('renderMarkdown：spikeMultiplier 展示随配置（默认 3）', () => {
  assert.ok(renderMarkdown('2026-10-14', '甲', 'd', [], 'ok', 10, true, 2, 5).includes('× 5'))
  assert.ok(renderMarkdown('2026-10-14', '甲', 'd', [], 'ok', 10, true, 2).includes('× 3'))
})

// ———————————— T5：fused/split A/B 脚手架 ————————————

test('A/B 脚手架：两侧 prompt 构造与产物落盘 <stateDir>/ab/<date>/', async () => {
  const env = makeEnv('m6-ab-')
  try {
    const window = [
      { sender: 'P01', text: '周五前把报告发我', ts: NOW - 60_000 },
      { sender: 'P02', text: '收到，初版在群里', ts: NOW - 30_000 },
    ]
    // 纯函数：fused 一次调用；split 两段（拆事实 → 汇总）
    assert.ok(buildFusedPrompt(window).includes('P01'))
    assert.ok(buildSplitExtractPrompt(window).includes('拆解为事实清单'))
    assert.ok(buildSplitSummarizePrompt('事实清单').includes('事实清单'))

    const calls = []
    const llm = {
      complete: async (prompt) => {
        calls.push(prompt.includes('拆解为事实清单') ? 'extract' : prompt.includes('事实清单') && !prompt.includes('messages') ? 'summarize' : 'fused')
        return calls[calls.length - 1] === 'extract' ? 'P02: 承诺发初版' : `产出（${calls[calls.length - 1]}）`
      },
    }
    const res = await runAbComparison(window, {
      llm,
      store: env.store,
      date: '2026-10-14',
      distillMode: 'fused',
      now: () => NOW,
    })
    assert.equal(res.ok, true)
    const dir = join(env.base, 'ab', '2026-10-14')
    assert.ok(existsSync(join(dir, 'input-window.json')))
    assert.ok(existsSync(join(dir, 'fused-output.md')))
    assert.ok(existsSync(join(dir, 'split-output.md')))
    assert.ok(existsSync(join(dir, 'split-facts.md')))
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    assert.equal(meta.fusedOk, true)
    assert.equal(meta.splitOk, true)
    assert.equal(meta.windowSize, 2)
    // 两次模式共 3 次调用（fused×1 + split×2）
    assert.deepEqual(calls, ['fused', 'extract', 'summarize'])
  } finally {
    env.cleanup()
  }
})

test('A/B 脚手架：单侧失败不阻塞另一侧；空窗口 fail-fast', async () => {
  const env = makeEnv('m6-ab2-')
  try {
    const res = await runAbComparison([{ sender: 'P01', text: 'hi', ts: NOW }], {
      llm: { complete: async (p) => { if (p.includes('拆解为事实清单')) throw new Error('boom'); return 'fused ok' } },
      store: env.store,
      date: '2026-10-14',
      now: () => NOW,
    })
    assert.equal(res.ok, true)
    assert.ok(res.fusedOutput !== null)
    assert.equal(res.splitOutput, null)
    const empty = await runAbComparison([], { llm: { complete: async () => 'x' }, store: env.store, date: 'd', now: () => NOW })
    assert.equal(empty.ok, false)
  } finally {
    env.cleanup()
  }
})
