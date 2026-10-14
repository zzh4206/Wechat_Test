// file-index.test.mjs —— M5-T5.3/T5.4：类型归类、重复合并保留出现记录、版本链折叠、
// 星标规则（deadline 语义 / 多人引用）、上下文摘要降级、wx_path 待下载占位、
// 水位续扫、日报「本期文件索引」真数据。全离线 mock（LLM mock + 临时目录 SQLite）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Store } from '../lib/store.js'
import { GroupStoreService } from '../lib/group-store.js'
import {
  FileIndexService,
  classifyExt,
  editDistance,
  nameSimilarity,
  isSameVersionChain,
  parseFileSummaries,
  FILE_EXT_MAP,
} from '../lib/file-index.js'
import { ReportService } from '../lib/report.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const CHAT = 'g@chatroom'
const NOW = new Date(2026, 2, 10, 10, 0, 0, 0).getTime()
const DAY = 86_400_000

function makeEnv() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'file-index-')))
  const store = new Store(base, silentLogger)
  const groupStore = new GroupStoreService(base, silentLogger)
  return { base, store, groupStore, cleanup: () => { groupStore.dispose(); rmSync(base, { recursive: true, force: true }) } }
}

async function seedMessages(groupStore, msgs) {
  await groupStore.appendMessages(CHAT, msgs.map((m, i) => ({
    msgId: m.msgId ?? `m${i + 1}`,
    ts: m.ts ?? NOW - 60_000,
    senderPid: m.senderPid ?? 'wxid_a',
    senderName: m.senderName ?? '甲',
    kind: m.kind ?? 'text',
    text: m.text ?? '',
    quoteOfMsgId: m.quoteOfMsgId,
  })))
}

function mockLlm(responses) {
  const calls = { n: 0, prompts: [] }
  return {
    calls,
    async complete(prompt) {
      calls.prompts.push(prompt)
      const r = responses[calls.n]
      calls.n++
      if (r instanceof Error) throw r
      if (r === undefined) throw new Error('mock 队列已空')
      return typeof r === 'string' ? r : JSON.stringify(r)
    },
  }
}

function svc(groupStore, llm, opts = {}) {
  const service = new FileIndexService({
    groupStore,
    llm,
    logger: silentLogger,
    enabled: opts.enabled ?? true,
    store: opts.store ?? undefined,
    locatePath: opts.locatePath,
    getSize: opts.getSize,
    now: () => opts.now?.() ?? NOW,
  })
  return service
}

// ———————————— 纯函数 ————————————

test('classifyExt：表驱动归类（文档/表格/压缩包/代码文本/图片/视频/其他）', () => {
  assert.equal(classifyExt('报告.pdf').category, '文档')
  assert.equal(classifyExt('方案 final.DOCX').category, '文档')
  assert.equal(classifyExt('数据.xlsx').category, '表格')
  assert.equal(classifyExt('数据.csv').category, '表格')
  assert.equal(classifyExt('打包.zip').category, '压缩包')
  assert.equal(classifyExt('main.ts').category, '代码文本')
  assert.equal(classifyExt('notes.md').category, '代码文本')
  assert.equal(classifyExt('照片.PNG').category, '图片')
  assert.equal(classifyExt('录像.mp4').category, '视频')
  assert.equal(classifyExt('未知.xyz').category, '其他')
  assert.equal(classifyExt('无扩展名').category, '其他')
  assert.equal(classifyExt('数据.xlsx').ext, 'xlsx')
  assert.ok(FILE_EXT_MAP.length >= 6, '表驱动：至少六大类')
})

test('editDistance / nameSimilarity / isSameVersionChain：自写编辑距离 + 版本链判定', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3)
  assert.equal(editDistance('', 'abc'), 3)
  assert.equal(editDistance('same', 'same'), 0)
  assert.ok(isSameVersionChain('方案初版.docx', NOW, '方案修改稿.docx', NOW - 2 * DAY), '中文迭代名（基名等价）同链')
  assert.ok(nameSimilarity('方案初版.docx', '完全不同的东西.zip') < 0.3)
  assert.ok(isSameVersionChain('方案初版.docx', NOW, '方案修改稿.docx', NOW - 2 * DAY), '相似 + 时间邻近 → 同链')
  assert.ok(!isSameVersionChain('方案初版.docx', NOW, '方案修改稿.docx', NOW - 8 * DAY), '超出时间窗 → 不同链')
  assert.ok(!isSameVersionChain('方案初版.docx', NOW, '会议纪要.pdf', NOW), '不相似 → 不同链')
})

test('parseFileSummaries：合法解析、越界/缺 summary 判非法、keywords 截断', () => {
  const ok = parseFileSummaries(JSON.stringify({ summaries: [{ f: 1, summary: '季度报表，老王要的', keywords: ['报表', 'q1'] }] }), 1)
  assert.equal(ok[0].summary, '季度报表，老王要的')
  assert.equal(parseFileSummaries(JSON.stringify({ summaries: [{ f: 2, summary: 'x' }] }), 1), null, 'f 越界')
  assert.equal(parseFileSummaries(JSON.stringify({ summaries: [{ f: 1 }] }), 1), null, '缺 summary')
  const cut = parseFileSummaries(JSON.stringify({ summaries: [{ f: 1, summary: 's', keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] }] }), 1)
  assert.equal(cut[0].keywords.length, 8, 'keywords 截到 8 个')
})

// ———————————— 索引主流程 ————————————

test('文件入库：类型归类 + wx_path 默认"待下载"占位 + 摘要/关键词/上下文', async () => {
  const env = makeEnv()
  try {
    await seedMessages(env.groupStore, [
      { msgId: 'c1', senderPid: 'wxid_boss', senderName: '老板', text: '下午开会要用' },
      { msgId: 'f1', kind: 'file', senderPid: 'wxid_a', senderName: '甲', text: '季度报表.xlsx', ts: NOW - 1000 },
      { msgId: 'c2', senderPid: 'wxid_boss', senderName: '老板', text: '发我一份，周五之前要' },
    ])
    const llm = mockLlm([{ summaries: [{ f: 1, summary: '季度数据表，老板开会要用', keywords: ['季度', '报表'] }] }])
    const service = svc(env.groupStore, llm)
    const res = await service.scanChat(CHAT)
    assert.equal(res.newFiles, 1)
    const files = env.groupStore.getFiles(CHAT)
    assert.equal(files.length, 1)
    const f = files[0]
    assert.equal(f.category, '表格')
    assert.equal(f.wxPath, '待下载', '定位不了记"待下载"占位（离线期媒体未下载的已知场景）')
    assert.equal(f.summary, '季度数据表，老板开会要用')
    assert.deepEqual(f.keywords, ['季度', '报表'])
    assert.ok(f.context.includes('周五之前要'), '上下文含文件后讨论')
    assert.ok(f.context.includes('下午开会要用'), '上下文含文件前讨论')
    assert.ok(!llm.calls.prompts[0].includes('f1'), 'msg_id 不进 prompt')
    assert.ok(f.appearances.some((a) => a.msgId === 'f1'), '首条出现记录')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('重复合并：同名+同大小+同发送者 → 一条索引 + appearances 保留多次出现；不同大小不合并', async () => {
  const env = makeEnv()
  try {
    await seedMessages(env.groupStore, [
      { msgId: 'f1', kind: 'file', text: '方案.docx', ts: NOW - 3000 },
      { msgId: 'f2', kind: 'file', text: '方案.docx', ts: NOW - 2000 },
      { msgId: 'f3', kind: 'file', text: '方案.docx', ts: NOW - 1000, senderPid: 'wxid_b' },
    ])
    const llm = mockLlm([{ summaries: [{ f: 1, summary: '方案文档', keywords: [] }] }])
    const service = svc(env.groupStore, llm, { getSize: (msg) => (msg.msgId === 'f3' ? 999 : 100) })
    const res = await service.scanChat(CHAT)
    assert.equal(res.newFiles, 2, '同名同发送者合并、不同大小/发送者不算重复')
    assert.equal(res.appearancesMerged, 1, 'f2 并入 f1 的出现记录')
    const files = env.groupStore.getFiles(CHAT)
    assert.equal(files.length, 2)
    const merged = files.find((f) => f.msgId === 'f1')
    assert.equal(merged.appearances.length, 2, '出现记录保留（不丢多次转发）')
    assert.ok(merged.appearances.some((a) => a.msgId === 'f2'))
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('版本链：初版→修改稿→最终版 串一条链（version_root_id 指向链根）；命名无关不成链', async () => {
  const env = makeEnv()
  try {
    await seedMessages(env.groupStore, [
      { msgId: 'f1', kind: 'file', text: '方案初版.docx', ts: NOW - 3 * DAY },
      { msgId: 'f2', kind: 'file', text: '方案修改稿.docx', ts: NOW - DAY },
      { msgId: 'f3', kind: 'file', text: '方案最终版.docx', ts: NOW - 500 },
      { msgId: 'f4', kind: 'file', text: '完全无关的图.png', ts: NOW - 1000 },
    ])
    const llm = mockLlm([{ summaries: [] }])
    const service = svc(env.groupStore, llm)
    await service.scanChat(CHAT)
    const files = env.groupStore.getFiles(CHAT)
    const byName = new Map(files.map((f) => [f.name, f]))
    const v1 = byName.get('方案初版.docx')
    const v2 = byName.get('方案修改稿.docx')
    const v3 = byName.get('方案最终版.docx')
    assert.equal(v1.versionRootId, null, '链根自身无指针')
    assert.equal(v2.versionRootId, v1.fileId, '修改稿串到链根')
    assert.equal(v3.versionRootId, v1.fileId, '最终版同样串到链根（三版一链）')
    assert.equal(byName.get('完全无关的图.png').versionRootId, null, '命名无关不成链')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('星标：上下文含 deadline 语义 → star=1；文件被 ≥2 人引用 → star=1；否则 0', async () => {
  const env = makeEnv()
  try {
    await seedMessages(env.groupStore, [
      { msgId: 'c1', senderPid: 'wxid_boss', senderName: '老板', text: '这份周五之前要交' },
      { msgId: 'f1', kind: 'file', text: '纪要.docx', ts: NOW - 4000 },
      { msgId: 'f2', kind: 'file', text: '随手拍.png', ts: NOW - 1000 },
      { msgId: 'q1', senderPid: 'wxid_b', text: '收到', quoteOfMsgId: 'f2', ts: NOW + 1000 },
      { msgId: 'q2', senderPid: 'wxid_c', text: '谢谢', quoteOfMsgId: 'f2', ts: NOW + 2000 },
      { msgId: 'f3', kind: 'file', text: '普通文件.txt', ts: NOW - 2 * DAY },
    ])
    const llm = mockLlm([{ summaries: [] }])
    const service = svc(env.groupStore, llm)
    await service.scanChat(CHAT)
    const files = env.groupStore.getFiles(CHAT)
    const byName = new Map(files.map((f) => [f.name, f]))
    assert.equal(byName.get('纪要.docx').star, 1, '上下文含 deadline 语义')
    assert.equal(byName.get('随手拍.png').star, 1, '被 2 个不同发送者引用')
    assert.equal(byName.get('普通文件.txt').star, 0, '无星标信号')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('上下文摘要降级：LLM 两次失败 → 条目保留、summary 置未摘要占位、degraded 标记', async () => {
  const env = makeEnv()
  try {
    await seedMessages(env.groupStore, [{ msgId: 'f1', kind: 'file', text: '年度总结.pdf', ts: NOW - 1000 }])
    const llm = mockLlm([new Error('down'), new Error('down')])
    const service = svc(env.groupStore, llm)
    const res = await service.scanChat(CHAT)
    assert.equal(res.degraded, true)
    assert.equal(res.newFiles, 1, '索引条目不缺')
    const f = env.groupStore.getFiles(CHAT)[0]
    assert.equal(f.summary, '（未摘要）年度总结.pdf')
    assert.deepEqual(f.keywords, [])
    assert.equal(llm.calls.n, 2, '重试一次')
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('locatePath 注入点：能定位则记路径；enabled=false 零活动', async () => {
  const env = makeEnv()
  try {
    await seedMessages(env.groupStore, [
      { msgId: 'f1', kind: 'file', text: '有路径.docx', ts: NOW - 2000 },
      { msgId: 'f2', kind: 'file', text: '没路径.docx', ts: NOW - 3000 },
    ])
    const llm = mockLlm([{ summaries: [] }])
    const service = svc(env.groupStore, llm, {
      locatePath: (msg) => (msg.msgId === 'f1' ? '/wechat/files/有路径.docx' : null),
    })
    await service.scanChat(CHAT)
    const files = env.groupStore.getFiles(CHAT)
    assert.equal(files.find((f) => f.name === '有路径.docx').wxPath, '/wechat/files/有路径.docx')
    assert.equal(files.find((f) => f.name === '没路径.docx').wxPath, '待下载')
    // 零活动
    const off = svc(env.groupStore, mockLlm([]), { enabled: false })
    const res = await off.scanChat(CHAT)
    assert.equal(res.ran, false)
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

test('水位续扫：重启后不重复索引同一批文件；新文件照常入索引', async () => {
  const env = makeEnv()
  try {
    await seedMessages(env.groupStore, [{ msgId: 'f1', kind: 'file', text: '旧文件.pdf', ts: NOW - DAY }])
    const llm = mockLlm([{ summaries: [] }])
    const service = svc(env.groupStore, llm, { store: env.store })
    await service.scanChat(CHAT)
    assert.equal(env.groupStore.getFiles(CHAT).length, 1)
    // 重启（新实例 + 同 store）：无新消息 → 零 LLM 调用、零重复条目
    const llm2 = mockLlm([])
    const service2 = svc(env.groupStore, llm2, { store: env.store })
    const res = await service2.scanChat(CHAT)
    assert.equal(res.ran, false)
    assert.equal(llm2.calls.n, 0)
    assert.equal(env.groupStore.getFiles(CHAT).length, 1)
    // 新文件：只扫水位之后
    await env.groupStore.appendMessages(CHAT, [{ msgId: 'f2', kind: 'file', senderPid: 'wxid_a', text: '新文件.pdf', ts: NOW - 1000 }])
    const llm3 = mockLlm([{ summaries: [] }])
    const service3 = svc(env.groupStore, llm3, { store: env.store })
    const r3 = await service3.scanChat(CHAT)
    assert.ok(r3.newFiles === 1)
    assert.ok(llm3.calls.prompts[0].includes('新文件.pdf'))
    assert.ok(!llm3.calls.prompts[0].includes('旧文件.pdf'))
    assert.equal(env.groupStore.getFiles(CHAT).length, 2)
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})

// ———————————— 报告联动：本期文件索引真数据 + 版本链折叠 ————————————

test('报告 L3 本期文件索引接真数据：星标/摘要 + 版本链折叠只突出最新版', async () => {
  const env = makeEnv()
  try {
    await env.groupStore.appendMessages(CHAT, [
      { msgId: 'f1', kind: 'file', text: '方案初版.docx', ts: NOW - 3 * DAY, senderPid: 'wxid_a' },
      { msgId: 'f2', kind: 'file', text: '方案最终版.docx', ts: NOW - 3_600_000, senderPid: 'wxid_a' },
      { msgId: 'c1', senderPid: 'wxid_boss', senderName: '老板', text: '明天要用这份' },
      { msgId: 'f3', kind: 'file', text: '纪要.docx', ts: NOW - 3_600_000, senderPid: 'wxid_a' },
    ])
    const llm = mockLlm([
      { summaries: [{ f: 1, summary: '方案初稿', keywords: [] }, { f: 2, summary: '方案定稿', keywords: [] }, { f: 3, summary: '会议纪要', keywords: [] }] },
    ])
    const service = svc(env.groupStore, llm, { now: () => NOW - 3_000_000 })
    await service.scanChat(CHAT, NOW - 3_000_000)
    // 纪要.docx 的上下文（±5 条）含"明天要用"→ deadline 语义 → 星标；补写 star
    await env.groupStore.updateFileMeta(CHAT, 'f_f3', { star: 1 })
    const report = new ReportService({
      groupStore: env.groupStore,
      store: env.store,
      stateDir: env.base,
      llm: mockLlm([]),
      logger: silentLogger,
      enabled: true,
      now: () => NOW,
    })
    const res = await report.generateReport(CHAT, 'daily', NOW)
    const md = env.store.readText(res.path)
    assert.ok(md.includes('本期文件索引'))
    assert.ok(md.includes('方案最终版.docx'), '最新版列出')
    assert.ok(md.includes('版本链 2 版，此为最新版'), '旧版折叠为一行版本链标注')
    assert.ok(!md.includes('方案初版.docx（'), '初版被折叠不单独成行')
    assert.ok(md.includes('★ 纪要.docx'), '星标前缀')
    assert.ok(md.includes('会议纪要'), '摘要进索引')
    report.dispose()
    env.groupStore.dispose()
  } finally {
    env.cleanup()
  }
})
