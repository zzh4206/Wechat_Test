// report-regen-revision-concurrency.test.mjs —— W-5 并发断言：regen 整文件覆写与修订段追加并发 → 修订段不丢。
// 钉死行为：regen 的「镜像读修订 → 渲染 → writeReport 覆写」span 内无 await（单线程原子），
// markTarget 的「镜像 → .md 追加」span 同样无 await——两者只能整块交错，修订行要么被 regen 渲染收录、
// 要么落在覆写之后，文件与 knowledge.db 恒一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { ReportRevisionService } = await import('../lib/report-revision.js')
const { Store } = await import('../lib/store.js')

const CHAT = '12345678@chatroom'
const DAY = '2026-10-20'
const REL = `reports/${CHAT}/${DAY}.md`
const NOW = new Date(2026, 9, 20, 21, 12).getTime() // 标记发生在 DAY 当天（日报已生成）——标记修订归属当天日报
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function makeEnv() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'regen-race-')))
  const store = new Store(dir, { warn() {}, error() {} })
  const revisionRows = [] // 镜像 report_revision（单一查询副本）
  const mirror = {
    mirrorMarking: () => true,
    mirrorReportRevision: (c, pt, ps, ts, type, opts) => { revisionRows.push({ pt, ps, summary: opts?.summary ?? null }); return true },
  }
  const svc = new ReportRevisionService({
    store,
    logger: { warn() {}, error() {} },
    mirror,
    now: () => NOW,
    resolveTarget: () => ({ createdAt: new Date(2026, 9, 20, 9, 0).getTime() }),
  })
  // W-5 读侧：store.listRevisions 直连镜像（接线层同构）——测试里把 fake 镜像挂到读侧
  store.listRevisions = (c, periodType, periodStart) => revisionRows.filter((r) => r.pt === periodType && r.ps === periodStart)
  store.ensureDir(`reports/${CHAT}`)
  store.writeText(REL, `# 日报 ${DAY}\n\n## 待办\n- 示例任务\n`)
  return { dir, store, svc }
}

/** regen 的 report.ts:793-797 同构路径：draft await 之后「镜像读修订 → 渲染 → 整文件覆写」span 内零 await */
async function regen(store) {
  await tick() // 模拟 LLM draft（await 点在镜像读之前——与实现一致）
  const revisionLines = store
    .listRevisions(CHAT, 'daily', DAY)
    .map((r) => `- ${r.summary ?? ''}`)
  const md = `# 日报 ${DAY}\n\n## 待办\n- 示例任务\n${revisionLines.length > 0 ? `\n## 修订记录\n\n${revisionLines.join('\n')}\n` : ''}`
  assert.equal(store.writeReport('daily', CHAT, DAY, md), true)
}

const line = (dir) => (dir.store.readText(REL) ?? '')

test('W-5 并发：mark 落在 regen 覆写之后 → 追加不丢', async () => {
  const env = makeEnv()
  await Promise.all([regen(env.store), (async () => { await tick(5); return env.svc.markTarget(CHAT, 'task', 7, 'completed', 'web') })()])
  assert.match(line(env), /标记：task「#7」→ 已完成/, '修订行在文件')
  assert.match(line(env), /## 修订记录/)
  rmSync(env.dir, { recursive: true, force: true })
})

test('W-5 并发：mark 先落镜像 → regen 渲染收录修订段（不因覆写丢失）', async () => {
  const env = makeEnv()
  // markTarget 镜像先行（.md 追加随后），regen 从镜像读侧渲染——即使 .md 行先于覆写存在也不丢
  await Promise.all([regen(env.store), (async () => { await tick(); return env.svc.markTarget(CHAT, 'task', 8, 'completed', 'web') })()])
  assert.match(line(env), /标记：task「#8」→ 已完成/, '修订行在文件（渲染收录或后置追加）')
  rmSync(env.dir, { recursive: true, force: true })
})

test('W-5 顺序回归：regen 覆写后 mark 追加；mark 后 regen 渲染收录', async () => {
  const env = makeEnv()
  await regen(env.store)
  await env.svc.markTarget(CHAT, 'task', 9, 'completed', 'web')
  assert.match(line(env), /标记：task「#9」→ 已完成/)
  await regen(env.store) // 再 regen：修订来自镜像读侧 → 不丢
  assert.match(line(env), /标记：task #9 → 已完成/, 'regen 后修订段仍在（渲染自镜像 summary）')
  rmSync(env.dir, { recursive: true, force: true })
})
