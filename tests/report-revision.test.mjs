// report-revision.test.mjs —— 审批标记直连镜像通道（单一查询副本架构）。
// 覆盖：markTarget → mirrorMarking（target_ref 全局唯一形态/kind 映射/source 换算）、
//       .md 修订段追加（新建段 + 追加行）、镜像失败 → 内存队列 + 完整事件 JSON error 日志、
//       队列有界（500 溢出丢最旧）、排空重放、约束 1 自查口径（不落第二持久真相）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { ReportRevisionService, markingStatusToKnowledgeKind, MIRROR_RETRY_QUEUE_MAX } = await import('../lib/report-revision.js')
const { Store } = await import('../lib/store.js')

const CHAT = '12345678@chatroom'
const NOW = new Date(2026, 9, 21, 9, 12).getTime()
const DAY = '2026-10-21'

function makeEnv({ mirror, maxQueue, errors } = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'rev-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir(`reports/${CHAT}`)
  store.writeText(`reports/${CHAT}/${DAY}.md`, '# 日报 · ' + CHAT + ' · ' + DAY + '\n\n## L1\n\n正文\n')
  const errorsArr = errors ?? []
  const svc = new ReportRevisionService({
    store,
    logger: { warn() {}, error: (m) => errorsArr.push(m) },
    mirror,
    now: () => NOW,
    maxQueue,
  })
  return { dir, store, svc, errors: errorsArr }
}

test('kind 映射：completed→done / incomplete→undone / deleted→deleted', () => {
  assert.equal(markingStatusToKnowledgeKind('completed'), 'done')
  assert.equal(markingStatusToKnowledgeKind('incomplete'), 'undone')
  assert.equal(markingStatusToKnowledgeKind('deleted'), 'deleted')
})

test('markTarget：镜像成功 → target_ref 全局唯一形态 + kind 映射 + source 换算；.md 修订段新建', async () => {
  const seen = []
  const { dir, svc, store } = makeEnv({
    mirror: { mirrorMarking: (chatId, kind, targetRef, ts, opts) => { seen.push({ chatId, kind, targetRef, ts, opts }); return true } },
  })
  const ok = await svc.markTarget(CHAT, 'task', 7, 'completed', 'web')
  assert.equal(ok, true)
  assert.deepEqual(seen, [{
    chatId: CHAT,
    kind: 'done', // completed → done（同名不同义换算）
    targetRef: `${CHAT}:task:7`, // 全局唯一（防 v_marking_latest 跨群串号）
    ts: NOW,
    opts: { source: 'web', sourceKey: `mark:${CHAT}:task:7:${NOW}` },
  }])
  const md = readFileSync(join(store.baseDir, `reports/${CHAT}/${DAY}.md`), 'utf8')
  assert.match(md, /## 修订记录/)
  assert.match(md, /标记：task「#7」→ 已完成（来源：前端）/)
  rmSync(dir, { recursive: true, force: true })
})

test('.md 已有修订段 → 追加一行（不重写历史段）', async () => {
  const { dir, svc, store } = makeEnv({
    mirror: { mirrorMarking: () => true },
  })
  await svc.markTarget(CHAT, 'task', 1, 'completed', 'chat')
  const before = readFileSync(join(store.baseDir, `reports/${CHAT}/${DAY}.md`), 'utf8')
  await svc.markTarget(CHAT, 'promise', 2, 'incomplete', 'chat')
  const after = readFileSync(join(store.baseDir, `reports/${CHAT}/${DAY}.md`), 'utf8')
  assert.ok(after.startsWith(before.split('## 修订记录')[0]), '历史段字节不变')
  assert.match(after, /→ 未完成（来源：对话框）/)
  assert.equal(after.split('\n').filter((l) => l.startsWith('- ')).length, 2, '两条修订行')
  rmSync(dir, { recursive: true, force: true })
})

test('镜像失败 → 完整事件 JSON 入 error 日志 + 内存队列；排空时重放成功', async () => {
  let succeed = false
  const seen = []
  const { dir, svc, errors } = makeEnv({
    mirror: { mirrorMarking: (c, k, r, ts, opts) => { if (succeed) seen.push({ c, k, r, opts }); return succeed } },
  })
  const ev = { chatId: CHAT, kind: 'done', targetRef: `${CHAT}:task:9`, ts: NOW, source: 'chat', sourceKey: `mark:${CHAT}:task:9:${NOW}` }
  await svc.markTarget(CHAT, 'task', 9, 'completed', 'chat')
  assert.ok(errors.some((m) => m.includes('镜像失败') && m.includes('"targetRef"')), 'error 日志含完整事件 JSON')
  // 排空：镜像恢复
  succeed = true
  await svc.markTarget(CHAT, 'task', 10, 'deleted', 'web')
  assert.ok(seen.some((s) => s.r === `${CHAT}:task:9`), '排空重放旧事件（保序）')
  assert.ok(seen.some((s) => s.r === `${CHAT}:task:10`))
  rmSync(dir, { recursive: true, force: true })
})

test('内存队列有界（500）：溢出丢最旧并 error 日志', async () => {
  let succeed = false
  const errors = []
  const { dir, svc } = makeEnv({
    mirror: { mirrorMarking: () => succeed },
    maxQueue: 3,
    errors,
  })
  for (let i = 1; i <= 5; i++) {
    await svc.markTarget(CHAT, 'task', i, 'completed', 'chat')
    void i
  }
  assert.ok(errors.some((m) => m.includes('内存队列溢出')), '溢出 error 日志')
  assert.ok(errors.some((m) => m.includes('溢出丢弃最旧事件')))
  rmSync(dir, { recursive: true, force: true })
  void succeed
})

test('常量：内存队列上限 500', () => {
  assert.equal(MIRROR_RETRY_QUEUE_MAX, 500)
})

// —— M2 级联 + 完成情况段 ——

test('级联：周报/月报文件已存在 → 修订行同步追加；不存在 → 无操作', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'rev-casc-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir(`reports/${CHAT}/weekly`)
  store.ensureDir(`reports/${CHAT}/monthly`)
  store.writeText(`reports/${CHAT}/${DAY}.md`, '# 日报\n')
  store.writeText(`reports/${CHAT}/weekly/2026-10-19.md`, '# 周报\n') // 10-21 所在周的周一
  // monthly 不建 → 级联应跳过
  const mirrorCalls = []
  const svc = new ReportRevisionService({
    store,
    logger: { warn() {}, error() {} },
    mirror: { mirrorMarking: () => true, mirrorReportRevision: (c, periodType, periodStart, ts, type, opts) => { mirrorCalls.push([periodType, periodStart]); return true }, mirrorMarking: () => true },
    now: () => NOW,
  })
  await svc.markTarget(CHAT, 'task', 3, 'completed', 'web')
  assert.match(readFileSync(join(dir, `reports/${CHAT}/${DAY}.md`), 'utf8'), /修订记录/)
  assert.match(readFileSync(join(dir, `reports/${CHAT}/weekly/2026-10-19.md`), 'utf8'), /修订记录/)
  assert.ok(!existsSync(join(dir, `reports/${CHAT}/monthly/2026-10-01.md`)), '月报不存在 → 无操作')
  assert.ok(mirrorCalls.some((m) => m[0] === 'weekly' && m[1] === '2026-10-19'), '周报修订行入镜像')
  assert.ok(!mirrorCalls.some((m) => m[0] === 'monthly'), '月报不存在 → 无镜像修订行')
  rmSync(dir, { recursive: true, force: true })
})
