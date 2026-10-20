// file-index-listing.test.mjs —— files 子命令数据源摄取路径（修复"49≠链接"归档缺口）：
// 清单入库（含 PDF）、msg_id 命名空间兜底键、幂等重扫、失败/无数据 safe、与消息流路径合并。
// 全离线 mock（listFiles 注入 + 临时目录 SQLite），不读真实微信库、不 spawn 真实 CLI。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Store } from '../lib/store.js'
import { GroupStoreService } from '../lib/group-store.js'
import { FileIndexService } from '../lib/file-index.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CHAT = 'g@chatroom'
const NOW = new Date(2026, 2, 10, 10, 0, 0, 0).getTime()

function makeEnv() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'file-index-listing-')))
  const store = new Store(base, silentLogger)
  const groupStore = new GroupStoreService(base, silentLogger)
  return { base, store, groupStore, cleanup: () => { groupStore.dispose(); rmSync(base, { recursive: true, force: true }) } }
}

const okLlm = { async complete() { return JSON.stringify({ summaries: [] }) } }

// 诊断实测形态：12 条文件清单（含 2 个 PDF），msg_id 为 CLI files 子命令命名空间
const LISTING = [
  { msg_id: 'cli1', name: '高等数学-作业2.pdf', path: '/tmp/a.pdf', available: true },
  { msg_id: 'cli2', name: '金融数学引论.pdf', path: null, available: false },
  { msg_id: 'cli3', name: '习题课2-解析 2.pdf', path: '/tmp/c.pdf', available: true },
  { msg_id: 'cli4', name: '第06周作业.pdf', path: '/tmp/d.pdf', available: true },
  { msg_id: 'cli5', name: '第06周作业.pdf', path: null, available: false },
  { msg_id: 'cli6', name: '作业4.pdf', path: '/tmp/f.pdf', available: true },
  { msg_id: 'cli7', name: '班会PPT.pptx', path: '/tmp/g.pptx', available: true },
  { msg_id: 'cli8', name: '原始数据.xlsx', path: '/tmp/h.xlsx', available: true },
  { msg_id: 'cli9', name: '金融数学第2章习题解答(含题干).pdf', path: '/tmp/i.pdf', available: true },
  { msg_id: 'cli10', name: '高温超导材料特性测试和低温温度计.tex', path: '/tmp/j.tex', available: true },
  { msg_id: 'cli11', name: '习题课3-解析.pdf', path: '/tmp/k.pdf', available: true },
  { msg_id: 'cli12', name: null, path: null, available: false }, // 无名 → file-cli12 兜底
]

function svc(groupStore, opts = {}) {
  return new FileIndexService({
    groupStore,
    llm: opts.llm ?? okLlm,
    logger: silentLogger,
    enabled: opts.enabled ?? true,
    now: () => NOW,
    listFiles: opts.listFiles,
  })
}

test('ingestFromListing：12 条清单入库（含 2 个以上 PDF）、无名兜底、待下载占位', async () => {
  const env = makeEnv()
  try {
    const svcI = svc(env.groupStore, { listFiles: async () => LISTING })
    const r = await svcI.ingestFromListing(CHAT)
    assert.equal(r.ran, true)
    assert.equal(r.newFiles, LISTING.length - 1, '12 条清单、1 对同名重键 → 11 条入库 + 1 次合并')
    const files = env.groupStore.getFiles(CHAT, { limit: 100 })
    assert.equal(files.length, LISTING.length - 1)
    const pdfs = files.filter((f) => f.ext === 'pdf')
    assert.ok(pdfs.length >= 4, `PDF 归类正确（实测 ${pdfs.length} 个）`)
    const byId = new Map(files.map((f) => [f.fileId, f]))
    assert.equal(byId.get('f_cli2').wxPath, '待下载', 'available=false → 待下载占位')
    assert.equal(byId.get('f_cli1').wxPath, '/tmp/a.pdf')
    assert.equal(byId.get('f_cli2').name, '金融数学引论.pdf')
    assert.equal(byId.get('f_cli12').name, 'file-cli12', '无名 → file-<msgId> 兜底')
    assert.ok(files.filter((f) => f.msg_id !== null).length >= 2, 'store 命中的 msg_id 保留（外键可满足）')
    assert.equal(byId.get('f_cli1').msgId, null, '孤儿命名空间 msg_id → NULL（FK：files.msg_id → messages.msg_id），来源保留在 file_id')
  } finally { env.cleanup() }
})

test('msg_id 命名空间兜底：store 同 id 命中 → ts/sender 取 store；未命中 → now/空', async () => {
  const env = makeEnv()
  try {
    const T = NOW - 5 * 60_000
    await env.groupStore.appendMessages(CHAT, [{
      msgId: 'srv1', ts: T, senderPid: 'wxid_a', senderName: '甲', kind: 'link', text: '[链接]',
    }])
    const svcI = svc(env.groupStore, {
      listFiles: async () => [
        { msg_id: 'srv1', name: '匹配store行.pdf', path: '/tmp/x.pdf', available: true },
        { msg_id: 'orphan', name: '孤儿命名空间.pdf', path: null, available: false },
      ],
    })
    const r = await svcI.ingestFromListing(CHAT)
    assert.equal(r.newFiles, 2)
    const files = env.groupStore.getFiles(CHAT, { limit: 10 })
    const byName = new Map(files.map((f) => [f.name, f]))
    assert.equal(byName.get('匹配store行.pdf').msgId, 'srv1')
    assert.equal(byName.get('匹配store行.pdf').senderPid, null, 'senderPid 不在 identities → NULL（外键口径）')
    assert.equal(byName.get('匹配store行.pdf').lastSeenTs, T, 'store 命中 → ts 取消息行')
    assert.equal(byName.get('孤儿命名空间.pdf').lastSeenTs, NOW, '未命中 → ts 回退 now')
    assert.equal(byName.get('孤儿命名空间.pdf').senderPid, null)
  } finally { env.cleanup() }
})

test('幂等重扫：同键合并 appearances、不重复入库；与消息流路径同键合并', async () => {
  const env = makeEnv()
  try {
    const svcI = svc(env.groupStore, { listFiles: async () => LISTING })
    const first = await svcI.ingestFromListing(CHAT)
    const second = await svcI.ingestFromListing(CHAT)
    assert.equal(first.newFiles, LISTING.length - 1)
    assert.equal(first.appearancesMerged, 1, '同名重键首扫即合并一次')
    assert.equal(second.newFiles, 0, '重扫零新增')
    assert.equal(second.appearancesMerged, LISTING.length, '重扫全部走 appearances 合并')
    assert.equal(env.groupStore.getFiles(CHAT, { limit: 100 }).length, LISTING.length - 1, '幂等：行数不变')

    // 消息流路径产生同键（同名+同大小0+同 sender）条目 → 清单路径合并而非重复
    await env.groupStore.appendMessages(CHAT, [{
      msgId: 'm1', ts: NOW - 60_000, senderPid: 'wxid_a', senderName: '甲', kind: 'file', text: '高等数学-作业2.pdf',
    }])
    await svcI.scanChat(CHAT) // 消息流路径入库（kind='file' 行 + 同名）
    const third = await svcI.ingestFromListing(CHAT)
    const files = env.groupStore.getFiles(CHAT, { limit: 100 })
    assert.equal(files.filter((f) => f.name === '高等数学-作业2.pdf').length, 1, '两路径同名合并为一条索引')
    assert.equal(third.appearancesMerged, LISTING.length, '全量走 appearances（11 行 + 消息流合并后的同名行）')
  } finally { env.cleanup() }
})

test('失败/无数据 safe：listFiles 抛错上抛由调用方包裹；空清单 ran=false；禁用时零活动', async () => {
  const env = makeEnv()
  try {
    const boom = svc(env.groupStore, { listFiles: async () => { throw new Error('cli boom') } })
    await assert.rejects(boom.ingestFromListing(CHAT), /cli boom/, '抛错上抛（接线层 safe 包裹）')

    const empty = svc(env.groupStore, { listFiles: async () => [] })
    const r = await empty.ingestFromListing(CHAT)
    assert.equal(r.ran, false, '空清单 = 无数据，不报错')

    const off = new FileIndexService({
      groupStore: env.groupStore, llm: okLlm, logger: silentLogger, enabled: false,
      listFiles: async () => LISTING,
    })
    const rOff = await off.ingestFromListing(CHAT)
    assert.equal(rOff.ran, false, 'fileIndexEnabled=false → 全程零活动')

    const noSource = svc(env.groupStore, {}) // 未注入 listFiles（源未就绪）
    assert.equal((await noSource.ingestFromListing(CHAT)).ran, false)
  } finally { env.cleanup() }
})
