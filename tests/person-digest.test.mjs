// person-digest.test.mjs —— M2-T2.3 人物按天增量摘要（全离线 mock，node:sqlite 临时目录）。
// 覆盖：mock llm 三种输出（合法/非法/超时）、降级占位（不静默缺天）、兜底上下文（发言前后
//       他人消息进 prompt）、活跃度突变标注、路径围栏、关闭开关零活动、v1→v2 迁移只前不退、
//       隐私纪律（prompt 无 msg_id / 无 wxid，人名只用群内显示名）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { GroupStoreService } = await import('../lib/group-store.js')
const { PersonDigestService, localDayKey, digestRelPath, parsePersonDigest } = await import('../lib/person-digest.js')
const { derivePid } = await import('../lib/persona-track.js')

const CHAT = '777@chatroom'
const WXID = 'wxid_boss001'
// 人物键：测试直接传 wxid（服务内部展开为 [wxid, derivePid(wxid)] 两条键，兼容两种落库形态）
const PID = WXID

/** 两天窗口的固定时间轴：base 日 10:00 起，逐条 +60s；前 7 天每天 1 条低活跃消息 */
const BASE = new Date(2026, 5, 10).getTime() // 2026-06-10 本地
const T = (h, m = 0) => BASE + h * 3600_000 + m * 60_000

function makeEnv(stateDir) {
  const groupStore = new GroupStoreService(stateDir, { warn() {}, error() {} })
  return groupStore
}

/** mock llm：脚本队列（字符串或抛错函数），记录每次收到的 prompt */
function mockLlm(script) {
  const calls = []
  return {
    calls,
    async complete(prompt) {
      calls.push(prompt)
      const next = script.shift()
      if (typeof next === 'function') return next()
      if (next instanceof Error) throw next
      return next ?? '{}'
    },
  }
}

function legalOutput(pid, day, evidence = [2]) {
  return JSON.stringify({
    person_pid: pid,
    date: day,
    topics: [{ title: '项目排期', summary: '在催 UI 稿交付', evidence }],
    mood_or_stance: '略急',
    open_questions: ['周四能否交付'],
  })
}

async function seedDay(groupStore, dayBaseTs) {
  // 三条：他人 09:59 / 本人 10:00 / 他人 10:01 —— 兜底上下文应含前后他人消息
  await groupStore.appendMessages(CHAT, [
    { msgId: 'm-pre', ts: dayBaseTs - 60_000, senderPid: 'wxid_alice', senderName: '爱丽丝', text: '上午有人有空吗' },
    { msgId: 'm-own', ts: dayBaseTs, senderPid: WXID, senderName: '老板', text: 'UI 稿今天必须定稿' },
    { msgId: 'm-post', ts: dayBaseTs + 60_000, senderPid: 'wxid_bob', senderName: 'Bob', text: '收到，下午给' },
  ])
}

test.after(() => {}) // 各 test 自管临时目录

test('合法输出：落 topic_clusters（person 维度）+ 一页 md + 证据映射回 msg_id', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-ok-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  await seedDay(gs, T(10))
  const day = localDayKey(T(10))
  const llm = mockLlm([legalOutput(PID, day, [2])])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  const res = await svc.generateDaily(CHAT, PID, day)
  assert.equal(res.status, 'ok')
  assert.equal(res.topics, 1)

  const rows = gs.getPersonDigests(CHAT, PID, day)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '项目排期')
  assert.deepEqual(rows[0].evidenceMsgIds, ['m-own']) // 序号 2 → 映射回真实 msg_id
  assert.equal(rows[0].moodOrStance, '略急')
  assert.deepEqual(rows[0].openQuestions, ['周四能否交付'])
  assert.ok(existsSync(join(dir, res.path)), 'md 落盘')

  const md = readFileSync(join(dir, res.path), 'utf8')
  assert.match(md, /# 人物速览 · 老板 · /)
  assert.match(md, /### 项目排期/)
  assert.match(md, /m-own/)
  assert.doesNotMatch(md, /活跃度异常/) // 单日无 7 日基线（均值为 0）→ 不标注
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('隐私纪律：prompt 只含显示名，无 msg_id、无 wxid', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-privacy-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  await seedDay(gs, T(10))
  const day = localDayKey(T(10))
  const llm = mockLlm([legalOutput(PID, day)])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  await svc.generateDaily(CHAT, PID, day)
  assert.equal(llm.calls.length, 1)
  const p = llm.calls[0]
  assert.match(p, /老板/)
  assert.match(p, /爱丽丝/) // 兜底上下文里的他人显示名
  assert.doesNotMatch(p, /m-own|m-pre|m-post/, 'msg_id 不送模型')
  assert.doesNotMatch(p, /wxid_alice|wxid_bob/, '他人 wxid（小号库元数据）不送模型')
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('兜底上下文：本人消息前后各 2 条他人消息进数据区（上下文保留）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-ctx-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  const t0 = T(10)
  await gs.appendMessages(CHAT, [
    { msgId: 'c1', ts: t0 - 300_000, senderPid: 'wxid_a', senderName: 'A', text: '背景一' },
    { msgId: 'c2', ts: t0 - 200_000, senderPid: 'wxid_b', senderName: 'B', text: '背景二' },
    { msgId: 'c3', ts: t0 - 60_000, senderPid: 'wxid_c', senderName: 'C', text: '贴邻上文' },
    { msgId: 'c4', ts: t0, senderPid: WXID, senderName: '老板', text: '结论发言' },
    { msgId: 'c5', ts: t0 + 60_000, senderPid: 'wxid_d', senderName: 'D', text: '贴邻下文' },
    { msgId: 'c6', ts: t0 + 300_000, senderPid: 'wxid_e', senderName: 'E', text: '次邻下文' },
    { msgId: 'c7', ts: t0 + 400_000, senderPid: 'wxid_e', senderName: 'E', text: '远处一' },
  ])
  const day = localDayKey(t0)
  const llm = mockLlm([legalOutput(PID, day)])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true, contextPad: 2 })
  const { buildPrompt } = svc
  const dayMsgs = gs.getPersonDayContext(CHAT, [PID], t0 - 86_400_000, t0 + 86_400_000, 2)
  // 切片 = 本人 ±2 条（按条数计）：c2..c6
  assert.deepEqual(dayMsgs.map((m) => m.msgId), ['c2', 'c3', 'c4', 'c5', 'c6'])
  const { prompt, wire } = buildPrompt.call(svc, PID, day, '老板', dayMsgs, dayMsgs.filter((m) => m.senderPid === PID))
  assert.match(prompt, /背景二/)
  assert.match(prompt, /贴邻上文/)
  assert.match(prompt, /贴邻下文/)
  assert.doesNotMatch(prompt, /远处一/, '窗口外的远处消息不进数据区')
  assert.equal(wire.length, 5)
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('非法输出 → 重试一次成功（llm 被调 2 次）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-retry-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  await seedDay(gs, T(10))
  const day = localDayKey(T(10))
  const llm = mockLlm(['not json at all', legalOutput(PID, day)])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  const res = await svc.generateDaily(CHAT, PID, day)
  assert.equal(res.status, 'ok')
  assert.equal(llm.calls.length, 2)
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('非法两次 → degraded 占位（md + topic_clusters 行，不静默缺天）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-deg-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  await seedDay(gs, T(10))
  const day = localDayKey(T(10))
  const llm = mockLlm(['{"person_pid":"wrong"}', 'garbage'])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  const res = await svc.generateDaily(CHAT, PID, day)
  assert.equal(res.status, 'degraded')
  assert.equal(llm.calls.length, 2, '只重试一次')
  const rows = gs.getPersonDigests(CHAT, PID, day)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'degraded')
  const md = readFileSync(join(dir, res.path), 'utf8')
  assert.match(md, /degraded/)
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('超时/异常输出 → degraded 占位', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-timeout-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  await seedDay(gs, T(10))
  const day = localDayKey(T(10))
  const llm = mockLlm([() => { throw new Error('timeout') }, new Error('timeout again')])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  const res = await svc.generateDaily(CHAT, PID, day)
  assert.equal(res.status, 'degraded')
  assert.ok(res.path && existsSync(join(dir, res.path)))
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('活跃度突变：今日 > 7 日均值×3 → md 标注"活跃度异常"（仅内部信号）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-anomaly-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  // 前 7 天每天 1 条
  for (let i = 1; i <= 7; i++) {
    await gs.appendMessages(CHAT, [{ msgId: `h${i}`, ts: BASE - i * 86_400_000, senderPid: WXID, senderName: '老板', text: '日常冒泡' }])
  }
  // 今日 4 条（> 1×3）
  await gs.appendMessages(CHAT, [
    { msgId: 'd1', ts: T(9), senderPid: WXID, senderName: '老板', text: '一' },
    { msgId: 'd2', ts: T(10), senderPid: WXID, senderName: '老板', text: '二' },
    { msgId: 'd3', ts: T(11), senderPid: WXID, senderName: '老板', text: '三' },
    { msgId: 'd4', ts: T(12), senderPid: WXID, senderName: '老板', text: '四' },
  ])
  const day = localDayKey(T(10))
  const llm = mockLlm([legalOutput(PID, day)])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  const res = await svc.generateDaily(CHAT, PID, day)
  const md = readFileSync(join(dir, res.path), 'utf8')
  assert.match(md, /活跃度异常/)
  assert.match(md, /今日 4 条/)
  // 无独立发言量产出：topic_clusters 行 summary 不含条数统计、无 messages 之外的量产表
  const rows = gs.getPersonDigests(CHAT, PID, day)
  assert.equal(rows.length, 1)
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('当日无发言：占位速览（不静默缺天），不调 llm', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-empty-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  const day = localDayKey(T(10))
  const llm = mockLlm([])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  const res = await svc.generateDaily(CHAT, PID, day)
  assert.equal(res.status, 'empty')
  assert.equal(llm.calls.length, 0)
  assert.match(readFileSync(join(dir, res.path), 'utf8'), /当日无发言/)
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('路径围栏：非法 chatId / pid 拒绝且不落盘', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-fence-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  const llm = mockLlm([])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: true })
  await assert.rejects(() => svc.generateDaily('../evil', PID, '2026-06-10'))
  await assert.rejects(() => svc.generateDaily(CHAT, '../../escape', '2026-06-10'))
  await assert.rejects(() => svc.generateDaily(CHAT, PID, 'not-a-date'))
  assert.ok(!existsSync(join(dir, 'digests')))
  assert.equal(llm.calls.length, 0)
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('关闭开关：enabled=false 零活动（零 llm 调用、零落盘、零行）', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-off-')))
  const { Store } = await import('../lib/store.js')
  const store = new Store(dir, { warn() {}, error() {} })
  const gs = makeEnv(dir)
  await seedDay(gs, T(10))
  const day = localDayKey(T(10))
  const llm = mockLlm([legalOutput(PID, day)])
  const svc = new PersonDigestService({ groupStore: gs, store, stateDir: dir, llm, logger: { warn() {}, error() {} }, enabled: false })
  const res = await svc.generateDaily(CHAT, PID, day)
  assert.equal(res.status, 'disabled')
  assert.equal(res.path, null)
  assert.equal(llm.calls.length, 0)
  assert.ok(!existsSync(join(dir, 'digests')))
  assert.equal(gs.getPersonDigests(CHAT, PID, day).length, 0)
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('schema v1→v2 迁移只前不退：旧 v1 库打开后自动加列、schema_version=2、旧数据完好', () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'pd-mig-')))
  const dbDir = join(dir, 'groups', CHAT)
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'store.db')
  // 手工搭一个 v1 库（messages + topic_clusters 基线结构，user_version=1）
  const raw = new DatabaseSync(dbPath)
  raw.exec(`
    CREATE TABLE messages (
      msg_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, sender_pid TEXT NOT NULL,
      sender_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'text',
      text TEXT NOT NULL DEFAULT '', quote_of_msg_id TEXT, file_id TEXT, raw_class TEXT
    );
    CREATE TABLE topic_clusters (
      cluster_id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT ''
    );
    PRAGMA user_version = 1;
  `)
  raw.prepare("INSERT INTO messages (msg_id, ts, sender_pid) VALUES ('old1', 1, 'wxid_old')").run()
  raw.close()

  const gs = makeEnv(dir)
  gs.open(CHAT) // 惰性建/开库触发迁移
  assert.equal(gs.schemaVersion(CHAT), 2, '打开即迁移到 v2')
  // 旧数据完好 + 新列可用（写一条 person 摘要行）
  const msgs = gs.getMessages(CHAT)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].msgId, 'old1')
  gs.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('parsePersonDigest：person_pid/date 不符、evidence 越界、非法结构均判非法', () => {
  assert.equal(parsePersonDigest('totally not json', 'p', '2026-06-10', 3), null, '非 JSON')
  const good = parsePersonDigest('```json\n{"person_pid":"p","date":"d","topics":[{"title":"t","summary":"s","evidence":[1,3]}]}\n```', 'p', 'd', 3)
  assert.ok(good)
  assert.deepEqual(good.topics[0].evidenceMsgIds, ['1', '3'])
  assert.equal(parsePersonDigest('{"person_pid":"x","date":"d","topics":[]}', 'p', 'd', 3), null, 'pid 不符')
  assert.equal(parsePersonDigest('{"person_pid":"p","date":"x","topics":[]}', 'p', 'd', 3), null, 'date 不符')
  assert.equal(parsePersonDigest('{"person_pid":"p","date":"d","topics":[{"title":"t","summary":"s","evidence":[4]}]}', 'p', 'd', 3), null, 'evidence 越界')
  assert.equal(parsePersonDigest('{"person_pid":"p","date":"d","topics":[{"title":"","summary":"s"}]}', 'p', 'd', 3), null, '空 title')
  assert.equal(parsePersonDigest('{"person_pid":"p","date":"d","topics":"no"}', 'p', 'd', 3), null, 'topics 非数组')
})
