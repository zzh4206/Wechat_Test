// report-revision.test.mjs —— 标记/审批修订流（存在性校验 + origin 归属 + 镜像直连 + 内存队列）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { ReportRevisionService, markingStatusToKnowledgeKind, MIRROR_RETRY_QUEUE_MAX } = await import('../lib/report-revision.js')
const { Store } = await import('../lib/store.js')

const CHAT = '12345678@chatroom'
const NOW = new Date(2026, 9, 21, 9, 12).getTime()          // 标记时刻 10-21 09:12
const ORIGIN = new Date(2026, 9, 20, 9, 0).getTime()        // 条目出身 10-20 09:00
const ORIGIN_DAY = '2026-10-20'

function makeEnv({ mirror, maxQueue, errors, origin } = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'rev-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const errorsArr = errors ?? []
  const svc = new ReportRevisionService({
    store,
    logger: { warn: (m) => errorsArr.push(m), error: (m) => errorsArr.push(m) },
    mirror,
    now: () => NOW,
    maxQueue,
    resolveTarget: (c, k, id) => (origin === null ? null : { createdAt: origin ?? ORIGIN }),
  })
  return { dir, store, svc, errors: errorsArr, errorsArr }
}

const md = (store, rel) => (store.readText(rel) ?? '')

test('kind 映射：completed→done / incomplete→undone / deleted→deleted', () => {
  assert.equal(markingStatusToKnowledgeKind('completed'), 'done')
  assert.equal(markingStatusToKnowledgeKind('incomplete'), 'undone')
  assert.equal(markingStatusToKnowledgeKind('deleted'), 'deleted')
})

test('① 不存在目标 → 整链零副作用 + false（无镜像/无修订行/.md 不动/无级联）', async () => {
  let mirrorCalled = 0
  const { dir, store, svc, errorsArr } = makeEnv({
    origin: null,
    mirror: { mirrorMarking: () => { mirrorCalled += 1; return true }, mirrorReportRevision: () => { mirrorCalled += 1; return true } },
  })
  store.ensureDir(`reports/${CHAT}`)
  store.writeText(`reports/${CHAT}/${ORIGIN_DAY}.md`, '# 日报\n')
  const ok = await svc.markTarget(CHAT, 'task', 999999, 'completed', 'web')
  assert.equal(ok, false, '不存在 → false（ActionInbox 结果码 not_found）')
  assert.equal(mirrorCalled, 0, '无镜像事件')
  assert.equal(errorsArr.filter((m) => m.includes('标记目标不存在')).length, 1, 'warn 一条')
  const after = md(store, `reports/${CHAT}/${ORIGIN_DAY}.md`)
  assert.ok(!after.includes('修订记录'), '.md 不动')
  rmSync(dir, { recursive: true, force: true })
})

test('② 存在目标 → 修订行落 origin 日报（非标记日）+ 镜像 + 级联跟随 origin 周/月', async () => {
  const mirrorRows = []
  const { dir, store, svc } = makeEnv({
    mirror: {
      mirrorMarking: (c, k, r, ts, opts) => { mirrorRows.push(['marking', k, r]); return true },
      mirrorReportRevision: (c, pt, ps, ts, type, opts) => { mirrorRows.push(['revision', pt, ps]); return true },
    },
  })
  // origin 日报 + origin 所在周周一的周报 + 当月 1 号月报都存在
  store.ensureDir(`reports/${CHAT}`)
  store.writeText(`reports/${CHAT}/${ORIGIN_DAY}.md`, '# 日报\n')
  store.ensureDir(`reports/${CHAT}/weekly`)
  store.ensureDir(`reports/${CHAT}/monthly`)
  store.writeText(`reports/${CHAT}/${ORIGIN_DAY}.md`, '# 日报\n')
  store.writeText(`reports/${CHAT}/weekly/2026-10-19.md`, '# 周报\n')
  store.writeText(`reports/${CHAT}/monthly/2026-10-01.md`, '# 月报\n')
  await svc.markTarget(CHAT, 'task', 3, 'completed', 'chat')
  // 修订行落 origin 日报（非标记日 10-21）
  const daily = md(store, `reports/${CHAT}/${ORIGIN_DAY}.md`)
  assert.match(daily, /## 修订记录/)
  assert.match(daily, /task「#3」→ 已完成/)
  // 级联跟随 origin 周/月
  assert.match(md(store, `reports/${CHAT}/weekly/2026-10-19.md`), /修订记录/)
  assert.match(md(store, `reports/${CHAT}/monthly/2026-10-01.md`), /修订记录/)
  // 镜像：1 marking + 3 revision（daily+weekly+monthly）
  assert.equal(mirrorRows.filter((r) => r[0] === 'marking').length, 1)
  assert.equal(mirrorRows.filter((r) => r[0] === 'revision').length, 3)
  assert.deepEqual(mirrorRows.find((r) => r[0] === 'marking').slice(1, 3), ['done', `${CHAT}:task:3`])
  rmSync(dir, { recursive: true, force: true })
})

test('③ origin 日无报告文件 → 无 .md 追加，但 revisions+镜像照记、级联照常', async () => {
  const mirrorRows = []
  const { dir, store, svc } = makeEnv({
    mirror: {
      mirrorMarking: (c, k, r) => { mirrorRows.push(['marking', k, r]); return true },
      mirrorReportRevision: (c, pt, ps) => { mirrorRows.push(['revision', pt, ps]); return true },
    },
  })
  // 只建周报（origin 日报不建）
  store.ensureDir(`reports/${CHAT}/weekly`)
  store.writeText(`reports/${CHAT}/weekly/2026-10-19.md`, '# 周报\n')
  await svc.markTarget(CHAT, 'task', 3, 'completed', 'chat')
  assert.ok(!existsSync(join(dir, `reports/${CHAT}/${ORIGIN_DAY}.md`)), 'origin 日报不落盘')
  const weekly = md(store, `reports/${CHAT}/weekly/2026-10-19.md`)
  assert.match(weekly, /修订记录/)
  assert.ok(mirrorRows.some((r) => r[0] === 'revision' && r[2] === ORIGIN_DAY), 'origin 修订行照记')
  rmSync(dir, { recursive: true, force: true })
})

test('④ onApproval 同修：origin 归属 + 不存在目标零副作用', async () => {
  const mirrorRows = []
  const { dir, store, svc } = makeEnv({
    mirror: {
      mirrorMarking: () => true,
      mirrorReportRevision: (c, pt, ps) => { mirrorRows.push(['revision', pt, ps]); return true },
    },
  })
  store.ensureDir(`reports/${CHAT}`)
  store.writeText(`reports/${CHAT}/${ORIGIN_DAY}.md`, '# 日报\n')
  // 不存在（独立 env：origin=null）
  const missingEnv = makeEnv({ origin: null, mirror: { mirrorMarking: () => true, mirrorReportRevision: () => true } })
  assert.equal(await missingEnv.svc.onApproval(CHAT, 'task', 999999, '任务「x」确认为真', 'chat'), false)
  assert.equal(missingEnv.errors.some((m) => m.includes('审批目标不存在')), true, 'warn 一条')
  // 存在 → origin
  await svc.onApproval(CHAT, 'task', 3, '任务「x」确认为真', 'chat')
  const daily = md(store, `reports/${CHAT}/${ORIGIN_DAY}.md`)
  assert.match(daily, /审批：任务「x」确认为真/)
  assert.ok(mirrorRows.some((r) => r[0] === 'revision' && r[2] === ORIGIN_DAY))
  rmSync(dir, { recursive: true, force: true })
})

test('镜像失败 → 完整事件 JSON 入 error 日志 + 内存队列；排空时重放成功', async () => {
  let succeed = false
  const seen = []
  const { dir, svc, errorsArr } = makeEnv({
    mirror: { mirrorMarking: (c, k, r, ts, opts) => { if (succeed) seen.push({ c, k, r, opts }); return succeed } },
  })
  await svc.markTarget(CHAT, 'task', 9, 'completed', 'chat')
  assert.ok(errorsArr.some((m) => m.includes('镜像失败') && m.includes('"targetRef"')))
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
  for (let i = 1; i <= 5; i++) await svc.markTarget(CHAT, 'task', i, 'completed', 'chat')
  assert.ok(errors.some((m) => m.includes('内存队列溢出')))
  rmSync(dir, { recursive: true, force: true })
})

test('常量：内存队列上限 500', () => {
  assert.equal(MIRROR_RETRY_QUEUE_MAX, 500)
})
