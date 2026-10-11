// journal.test.mjs —— WP4：insights.jsonl 落盘 / 二次类型校验 / 引用截断 /
// mock 时钟跨天日报 / 计数器 / 写入路径全在 stateDir 内。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../lib/store.js'
import { InsightsJournal, localDayKey, MAX_QUOTE_CHARS } from '../lib/journal.js'

// macOS 上 /var 是 /private/var 的 symlink，先 realpath 再断言
const base = realpathSync(mkdtempSync(join(tmpdir(), 'lurker-journal-')))

test.after(() => rmSync(base, { recursive: true, force: true }))

function makeLogger() {
  const warnings = []
  return { warnings, warn(m) { warnings.push(m) }, info() {}, error() {} }
}

/** 搭一套可注入时钟的 journal，并记录 store 的全部写入目标路径 */
function setup({ nowMs = Date.UTC(2026, 0, 10, 12, 0, 0) } = {}) {
  const clock = { now: nowMs }
  const logger = makeLogger()
  const targets = []
  const store = new Store(base, logger)
  const origEnsure = store.ensureDir.bind(store)
  const origAppend = store.appendJsonl.bind(store)
  const origWrite = store.writeText.bind(store)
  store.ensureDir = (rel) => { targets.push(join(base, rel)); return origEnsure(rel) }
  store.appendJsonl = (rel, entry) => { targets.push(join(base, rel)); return origAppend(rel, entry) }
  store.writeText = (rel, text) => { targets.push(join(base, rel)); return origWrite(rel, text) }
  const journal = new InsightsJournal({ store, logger, now: () => clock.now })
  return { journal, logger, targets, clock, store }
}

const topic = (over = {}) => ({
  ts: '2026-01-10T12:00:00Z', type: 'topic', title: '周末爬山',
  summary: '讨论东线还是西线', actors: ['A', 'B'], ...over,
})

test('jsonl 逐行合法 JSON 且 type 仅四类；junk 被拒', () => {
  const { journal, logger, targets } = setup()
  journal.record('chat1', [
    topic(),
    { ts: 't', type: 'junk', title: '非法类型' },
    { ts: 't', type: 'viewpoint', who: 'A', about: '路线', stance: '东线', quote: '东线人少' },
  ])
  const rel = join(base, 'groups/chat1/insights.jsonl')
  assert.ok(existsSync(rel))
  const lines = readFileSync(rel, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2) // junk 未落盘
  const entries = lines.map((l) => JSON.parse(l))
  for (const e of entries) {
    assert.ok(['topic', 'viewpoint', 'quote', 'opportunity'].includes(e.type))
    assert.equal(e.group, 'chat1')
  }
  assert.equal(entries[0].type, 'topic')
  assert.equal(entries[1].type, 'viewpoint')
  assert.equal(logger.warnings.length, 1) // junk 触发 warn
  assert.match(logger.warnings[0], /illegal type/)
  // 写入目标路径全部位于 stateDir 内
  for (const t of targets) {
    assert.ok(resolve(t).startsWith(base + '/'), `path outside stateDir: ${t}`)
  }
})

test('引用超长截断到 ≤50 字（原始消息全文不落盘）', () => {
  const { journal } = setup()
  const long = '非'.repeat(80)
  journal.record('chat2', [
    { ts: 't', type: 'quote', text: long, reason: '测试' },
    { ts: 't', type: 'viewpoint', who: 'A', about: 'x', stance: 'y', quote: long },
  ])
  const entries = readFileSync(join(base, 'groups/chat2/insights.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(MAX_QUOTE_CHARS, 50)
  for (const e of entries) {
    const q = e.text ?? e.quote
    assert.ok(q.length <= 50, `quote length ${q.length} > 50`)
    assert.ok(!q.includes('非'.repeat(51)))
  }
})

test('mock 时钟跨天：生成两天日报 + 计数器按本地自然日切', () => {
  // 本地时区构造两个自然日 10:00
  const day1 = new Date(2026, 0, 10, 10, 0, 0).getTime()
  const day2 = new Date(2026, 0, 11, 10, 0, 0).getTime()
  assert.equal(localDayKey(day1), '2026-01-10')
  const { journal, clock } = setup({ nowMs: day1 })

  clock.now = day1
  journal.record('g1', [topic()])
  journal.record('g2', [topic({ title: '另一群话题' })])
  const f1 = join(base, 'reports/2026-01-10.md')
  assert.ok(existsSync(f1))

  clock.now = day2
  journal.record('g1', [topic({ title: '次日话题' })])
  const f2 = join(base, 'reports/2026-01-11.md')
  assert.ok(existsSync(f2), '跨天应生成新文件')

  const report2 = readFileSync(f2, 'utf8')
  assert.ok(report2.includes('# 群聊日报 2026-01-11'))
  assert.ok(report2.includes('次日话题'), '当日内容应在')
  assert.ok(!report2.includes('周末爬山'), '昨日内容不应出现在新日报')
  const report1 = readFileSync(f1, 'utf8')
  assert.ok(report1.includes('周末爬山'))
  assert.ok(!report1.includes('次日话题'), '当日文件不应被次日写入污染')

  // 计数器：g1 当日 1 条（跨天后今日归零），g2 仍是昨天的 → 0
  assert.deepEqual(journal.status('g1'), { todayCount: 1, lastDistillAt: day2 })
  assert.deepEqual(journal.status('g2'), { todayCount: 0, lastDistillAt: null })
  // 同日多次累加
  journal.record('g1', [topic({ title: '再补一条' })])
  assert.equal(journal.status('g1').todayCount, 2)
})

test('日报含群分节、topic 标题 + 摘要 + actors，及其余三类代表条目', () => {
  const { journal } = setup()
  journal.record('g9', [
    topic(),
    { ts: 't', type: 'viewpoint', who: 'A', about: '路线', stance: '主张东线', quote: '东线人少' },
    { ts: 't', type: 'quote', text: '爬山五分钟拍照两小时', reason: '可能复用' },
    { ts: 't', type: 'opportunity', topic: '爬山', angle: '自嘲体力', urgency: 'low' },
  ])
  const md = readFileSync(join(base, 'reports/2026-01-10.md'), 'utf8')
  assert.ok(md.includes('## g9'))
  assert.ok(md.includes('**周末爬山**：讨论东线还是西线'))
  assert.ok(md.includes('参与者：A、B'))
  assert.ok(md.includes('`viewpoint`'))
  assert.ok(md.includes('`quote`'))
  assert.ok(md.includes('`opportunity`'))
  // 增量更新：同一群再提炼，小节整节替换、不重复堆叠
  journal.record('g9', [topic({ title: '新增话题' })])
  const md2 = readFileSync(join(base, 'reports/2026-01-10.md'), 'utf8')
  assert.equal((md2.match(/## g9/g) ?? []).length, 1)
  assert.ok(md2.includes('新增话题'))
  assert.ok(md2.includes('**周末爬山**'), '旧话题仍应汇总在当日小节里')
})

test('dispose 清引用：status 归零且不抛错', () => {
  const { journal } = setup()
  journal.record('gd', [topic()])
  assert.equal(journal.status('gd').todayCount, 1)
  journal.dispose()
  assert.deepEqual(journal.status('gd'), { todayCount: 0, lastDistillAt: null })
})
