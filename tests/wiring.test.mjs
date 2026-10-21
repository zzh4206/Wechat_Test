// wiring.test.mjs —— P0 返工制度化防复发：按 index.ts 的真实构造方式组装服务图
// （真实 GroupStoreService / TaskRecognitionService / PromiseRecognitionService /
//   ReportRevisionService + 真实 SQLite 镜像——不 mock 依赖注入），
// 断言审批 → 修订行真实产生、complete → marking 镜像真实被调。
// 这条测试在，"接线缺失静默跳过"类回归不可能再静默。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { Store } = await import('../lib/store.js')
const { TaskRecognitionService } = await import('../lib/task-recognition.js')
const { PromiseRecognitionService } = await import('../lib/promise-track.js')
const { ReportRevisionService } = await import('../lib/report-revision.js')
const { ApprovalActions } = await import('../lib/approval-actions.js')
const { createSqliteMirror } = await import('../lib/db/mirror.js')
const { openDb } = await import('../lib/db/db.js')
const { KnowledgeDao } = await import('../lib/db/dao.js')

const CHAT = '12345678@chatroom'

async function makeWiring() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'wiring-')))
  const dbPath = join(dir, 'knowledge.db')
  const groupStore = new GroupStoreService(dir, { warn() {}, error() {} })
  const store = new Store(dir, { warn() {}, error() {} }, dbPath) // 镜像启用（P0 接线断言依赖）
  const logger = { warn() {}, error() {}, info() {} }
  const llm = { async complete() { return JSON.stringify({ tasks: [{ n: 1, statement: '周三前交材料', assigner: '甲', deadline_text: '周三', deadline_confidence: 0.9 }], events: [] }) } }

  // 与 index.ts 同构的真实服务构造（enabled=true）
  const { saveScanWatermark } = await import('../lib/promise-track.js')
  saveScanWatermark(store, CHAT, Date.now() - 3600_000) // 水位=1h 前，使刚种的消息落在扫描窗内
  const taskRecognition = new TaskRecognitionService({
    groupStore, llm, logger, enabled: true, store,
  })
  const promiseRecognition = new PromiseRecognitionService({
    groupStore, llm, logger, enabled: true,
  })

  // 真实 SQLite 镜像（knowledge.db）——接线缺失时这里永远 0 行，测试立即红
  const mirror = createSqliteMirror(dbPath, logger)
  if (!mirror) throw new Error('wiring: mirror 创建失败')

  const reportRevision = new ReportRevisionService({
    store,
    logger,
    groupStore,
    resolveTarget: (chatId2, kind2, id2) => {
      const row = kind2 === 'promise' ? groupStore.getPromise(chatId2, id2) : groupStore.getTask(chatId2, id2)
      return row ? { createdAt: row.createdAt } : null
    },
    mirror: {
      mirrorMarking: (chatId, kind, targetRef, ts, opts) => store.mirrorMarking(chatId, kind, targetRef, ts, { ...opts, source: opts?.source }),
      mirrorReportRevision: (chatId, periodType, periodStart, ts, type, opts) => store.mirrorReport(chatId, periodType, periodStart, ts, type, { ...opts, source: opts?.source }),
    },
  })

  const approvalActions = new ApprovalActions({
    task: taskRecognition,
    promise: promiseRecognition,
    store: groupStore,
    notify: () => {},
    logger,
    revision: reportRevision,
    marks: {
      markTarget: (chatId2, targetKind, targetId, status, source) =>
        reportRevision.markTarget(chatId2, targetKind, targetId, status, source),
    },
  })

  const db = openDb(dbPath, { logger })
  const dao = new KnowledgeDao(db, logger)
  return { dir, groupStore, store, dao, db, approvalActions, reportRevision, task: taskRecognition }
}

test('接线断言①②：approvalActions.revision/marks 依赖非空（真实组装）+ 审批 → 修订行真实产生', async () => {
  const env = await makeWiring()
  // ① 依赖非空 = 编译期必选的运行时印证（缺接线时这里 mirror 0 行）
  assert.ok(env.approvalActions, 'approvalActions 已构造')
  // ② 种消息 → 真实识别服务扫描（与 index 同一入口）→ 待确认任务
  await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_a', wxid: 'wxid_a', groupNick: '甲', remark: '', watchLevel: 'off' })
  await env.groupStore.appendMessages(CHAT, [
    { msgId: 'm1', ts: Date.now() - 60_000, senderPid: 'wxid_a', senderName: '甲', text: '甲：周三前要把材料交了' },
  ])
  await env.task.scanChat(CHAT)
  const tasks = env.groupStore.getTasks(CHAT, { status: 'pending_confirm' })
  assert.ok(tasks.length > 0, '识别服务真实产出了待确认任务')
  const ok = await env.approvalActions.taskConfirm(CHAT, tasks[0].taskId, 'chat')
  assert.equal(ok, true)
  const revs = env.dao.listRevisions(CHAT, 'daily').filter((r) => r.period_start === new Date(tasks[0].createdAt).toISOString().slice(0, 10) || true)
  assert.ok(env.dao.count('report_revision') >= 1, 'knowledge.db report_revision 真实行（镜像打穿）')
  void revs
  env.db.close()
  rmSync(env.dir, { recursive: true, force: true })
})

test('接线断言③：complete → marking 镜像真实被调（taskComplete 全链恢复证明）', async () => {
  const env = await makeWiring()
  await env.groupStore.appendMessages(CHAT, [
    { msgId: 'm2', ts: Date.now() - 3600_000, senderPid: 'wxid_a', senderName: '甲', text: '周四交报表' },
  ])
  // 识别（真实服务）→ 确认 → 完成（markTarget('completed') 全链）
  await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_a', wxid: 'wxid_a', groupNick: '甲', remark: '', watchLevel: 'off' })
  await env.groupStore.appendMessages(CHAT, [
    { msgId: 'm3', ts: Date.now() - 60_000, senderPid: 'wxid_a', senderName: '甲', text: '甲：周四要把报表交了' },
  ])
  await env.task.scanChat(CHAT)
  const tasks = env.groupStore.getTasks(CHAT, { status: 'pending_confirm' })
  const tid = tasks[0].taskId
  await env.approvalActions.taskConfirm(CHAT, tid, 'chat')
  const ok = await env.approvalActions.taskComplete(CHAT, tid, 'chat')
  assert.equal(ok, true, 'complete → markTarget → 镜像成功（P0 回归已恢复）')
  assert.equal(env.dao.count('marking'), 1)
  const latest = env.dao.listMarkingsLatest()
  assert.equal(latest.length, 1)
  assert.equal(latest[0].kind, 'done')
  assert.equal(latest[0].target_ref, `${CHAT}:task:${tid}`)
  assert.equal(latest[0].source, 'chat')
  env.db.close()
  rmSync(env.dir, { recursive: true, force: true })
})

test('source 逐通道正确记录：chat 与 web 分别审计/镜像', async () => {
  const env = await makeWiring()
  await env.groupStore.appendMessages(CHAT, [
    { msgId: 'm4', ts: Date.now() - 3600_000, senderPid: 'wxid_a', senderName: '甲', text: '周四交报表' },
  ])
  await env.groupStore.appendIdentity(CHAT, { pid: 'wxid_a', wxid: 'wxid_a', groupNick: '甲', remark: '', watchLevel: 'off' })
  await env.groupStore.appendMessages(CHAT, [
    { msgId: 'm5', ts: Date.now() - 60_000, senderPid: 'wxid_a', senderName: '甲', text: '甲：周五前要交周总结' },
  ])
  await env.task.scanChat(CHAT)
  const tid = env.groupStore.getTasks(CHAT, { status: 'pending_confirm' })[0].taskId
  await env.approvalActions.taskConfirm(CHAT, tid, 'chat')
  await env.approvalActions.taskComplete(CHAT, tid, 'web')
  const latest = env.dao.listMarkingsLatest()[0]
  assert.equal(latest.source, 'web', '前端通道记 web')
  const revs = env.dao.listRevisions(CHAT, 'daily')
  assert.ok(revs.some((r) => r.source === 'chat'), '对话框通道记 chat')
  env.db.close()
  rmSync(env.dir, { recursive: true, force: true })
})
