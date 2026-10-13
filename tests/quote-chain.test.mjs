// quote-chain.test.mjs —— M2-T1.2/T2.2：引用消息（refermsg XML）解析 + 落库 + 多级引用链查询。
// 全部离线：纯函数直测 + node:sqlite 临时目录，不发消息、不读任何真实微信库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { parseReferMsgXml, isQuoteMessage, normalizeQuoteRow, quotePlaceholderId, quotePrefix } =
  await import('../lib/source/wechat-db.js')
const { GroupStoreService } = await import('../lib/group-store.js')

// macOS /var symlink：先 realpath 保证与围栏断言一致
const stateDir = resolve(mkdtempSync(join(tmpdir(), 'lurker-quote-')))
const logger = { warn() {}, error() {} }
test.after(() => rmSync(stateDir, { recursive: true, force: true }))

const CHAT = '99@chatroom'
const svc = new GroupStoreService(stateDir, logger)

/** 构造标准 appmsg 引用消息 XML（微信 4.x 常见形态） */
function quoteXml({ title, svrid, displayname, content }) {
  return (
    `<appmsg appid="" sdkver="0"><title>${title}</title><des></des><type>57</type>` +
    `<refermsg><type>1</type><svrid>${svrid}</svrid><fromusr>wxid_a</fromusr>` +
    `<chatusr>wxid_b</chatusr><displayname>${displayname}</displayname>` +
    `<content>${content}</content></refermsg></appmsg>`
  )
}

// ---------- T1.2：refermsg XML 拆解 ----------

test('isQuoteMessage：识别 refermsg，不误判普通文本/系统 XML', () => {
  assert.ok(isQuoteMessage(quoteXml({ title: '回', svrid: '1', displayname: '甲', content: '原' })))
  assert.ok(isQuoteMessage('<refermsg>\n<svrid>5</svrid></refermsg>'))
  assert.ok(!isQuoteMessage('普通聊天文本'))
  assert.ok(!isQuoteMessage('<sysmsg type="revokemsg"></sysmsg>'))
  assert.ok(!isQuoteMessage('<emoji/>'))
})

test('parseReferMsgXml：提取 svrid/显示名/原文/回复', () => {
  const p = parseReferMsgXml(
    quoteXml({ title: '说得好', svrid: '10086', displayname: '小甲', content: '今天天气不错' }),
  )
  assert.ok(p)
  assert.equal(p.refMsgId, '10086')
  assert.equal(p.refDisplayName, '小甲')
  assert.equal(p.refContent, '今天天气不错')
  assert.equal(p.selfText, '说得好')
})

test('parseReferMsgXml：CDATA 与 XML 实体解码', () => {
  const xml =
    '<appmsg><title>A &amp; B &lt;ok&gt;</title><refermsg>' +
    '<svrid>42</svrid><displayname><![CDATA[昵称"X"]]></displayname>' +
    '<content><![CDATA[1 < 2 & 3 > 2]]></content></refermsg></appmsg>'
  const p = parseReferMsgXml(xml)
  assert.ok(p)
  assert.equal(p.selfText, 'A & B <ok>')
  assert.equal(p.refDisplayName, '昵称"X"')
  assert.equal(p.refContent, '1 < 2 & 3 > 2')
})

test('parseReferMsgXml：缺 svrid / 非 refermsg → null（触发降级）', () => {
  assert.equal(parseReferMsgXml('<appmsg><title>x</title><refermsg><type>1</type></refermsg></appmsg>'), null)
  assert.equal(parseReferMsgXml('<appmsg><title>普通链接</title><type>5</type></appmsg>'), null)
  assert.equal(parseReferMsgXml('不是 XML'), null)
  // 非数字 svrid 同样不可靠 → null
  assert.equal(
    parseReferMsgXml('<appmsg><title>t</title><refermsg><svrid>abc</svrid></refermsg></appmsg>'),
    null,
  )
})

// ---------- T1.2：占位 id / normalizeQuoteRow ----------

test('normalizeQuoteRow：原文在已读集合 → 指向真实 server_id，正文只留回复', () => {
  const xml = quoteXml({ title: '同意', svrid: '777', displayname: '甲', content: '改天再议' })
  const r = normalizeQuoteRow(xml, new Set(['777']))
  assert.ok(r)
  assert.equal(r.kind, 'quote')
  assert.equal(r.quoteOfMsgId, '777')
  assert.equal(r.text, '同意')
})

test('normalizeQuoteRow：原文不在库 → qref-* 占位 id + [引用|名|原文] 前缀', () => {
  const xml = quoteXml({ title: '赞同', svrid: '999999999999', displayname: '乙', content: '周五交' })
  const r = normalizeQuoteRow(xml, new Set())
  assert.ok(r)
  assert.equal(r.kind, 'quote')
  assert.match(r.quoteOfMsgId, /^qref-[0-9a-f]{8}$/)
  assert.equal(r.text, `${quotePrefix('乙', '周五交')}赞同`)
  // 确定性：同输入同占位 id（可测试/幂等）
  assert.equal(r.quoteOfMsgId, quotePlaceholderId('乙', '周五交'))
  assert.equal(quotePlaceholderId('乙', '周五交'), quotePlaceholderId('乙', '周五交'))
})

test('normalizeQuoteRow：解析失败 → null（调用方降级纯文本）', () => {
  assert.equal(normalizeQuoteRow('<refermsg><svrid>x</svrid></refermsg>', new Set()), null)
})

test('解析隔离：畸形/超怪 XML 不抛错，一律折返 null 或安全字段', () => {
  for (const weird of ['', '<', '<<<<>>>', '<refermsg', '<refermsg><svrid>', '</refermsg>>']) {
    assert.doesNotThrow(() => parseReferMsgXml(weird))
    assert.doesNotThrow(() => normalizeQuoteRow(weird, new Set()))
    assert.equal(parseReferMsgXml(weird) === null || typeof parseReferMsgXml(weird) === 'object', true)
  }
})

// ---------- 落库 + T2.2：多级链 A→B→C + getQuoteChain ----------

test('多级引用链：A→B→C 落库后 getQuoteChain 三级展开', async () => {
  const xmlOf = (svrid, name, content, title) =>
    quoteXml({ title, svrid, displayname: name, content })
  const a = normalizeQuoteRow(xmlOf('0', '甲', '原始提案A', '无关'), new Set())
  // A 是被引用的原始消息（自身不是 quote）：直接以文本落库
  await svc.appendMessages(CHAT, [
    { msgId: '100', ts: 1000, senderPid: 'wxid_a', senderName: '甲', kind: 'text', text: '原始提案A' },
  ])
  // B 引用 A(100)，C 引用 B(200)——各自相对 normalize 时已知上游 id
  const b = normalizeQuoteRow(xmlOf('100', '甲', '原始提案A', '我补充B'), new Set(['100']))
  assert.equal(b.quoteOfMsgId, '100')
  const c = normalizeQuoteRow(xmlOf('200', '乙', '我补充B', '同意C'), new Set(['100', '200']))
  assert.equal(c.quoteOfMsgId, '200')
  await svc.appendMessages(CHAT, [
    { msgId: '200', ts: 2000, senderPid: 'wxid_b', senderName: '乙', kind: b.kind, text: b.text, quoteOfMsgId: b.quoteOfMsgId },
    { msgId: '300', ts: 3000, senderPid: 'wxid_c', senderName: '丙', kind: c.kind, text: c.text, quoteOfMsgId: c.quoteOfMsgId },
  ])
  const chain = svc.getQuoteChain(CHAT, '300')
  assert.deepEqual(
    chain.map((m) => m.msgId),
    ['300', '200', '100'],
  )
  assert.equal(chain[2].text, '原始提案A')
  // maxDepth 截断
  assert.deepEqual(svc.getQuoteChain(CHAT, '300', 2).map((m) => m.msgId), ['300', '200'])
  assert.deepEqual(svc.getQuoteChain(CHAT, '300', 1).map((m) => m.msgId), ['300'])
  assert.deepEqual(svc.getQuoteChain(CHAT, '300', 0), [])
})

test('断链/占位：原文不在库 → qref-* 占位行落库后链可展开到原文', async () => {
  const orphan = normalizeQuoteRow(
    quoteXml({ title: '路过', svrid: '555000111', displayname: '丁', content: '（已过期）' }),
    new Set(),
  )
  assert.ok(orphan)
  assert.match(orphan.quoteOfMsgId, /^qref-[0-9a-f]{8}$/)
  assert.match(orphan.text, /^\[引用\|丁\|（已过期）\]路过$/)
  // 落库接线（index.ts 同款顺序）：占位行在前满足 FK，回复行在后
  await svc.appendMessages(CHAT, [
    { msgId: orphan.quoteOfMsgId, ts: 3999, senderPid: 'unknown', senderName: orphan.quoteRefName, kind: 'text', text: orphan.quoteRefText, rawClass: 'quote-placeholder' },
    { msgId: '400', ts: 4000, senderPid: 'wxid_d', senderName: '丁', kind: orphan.kind, text: orphan.text, quoteOfMsgId: orphan.quoteOfMsgId },
  ])
  const chain = svc.getQuoteChain(CHAT, '400')
  assert.equal(chain.length, 2)
  assert.equal(chain[0].msgId, '400')
  assert.equal(chain[1].text, '（已过期）') // 沿链取到被引用原文
  assert.equal(chain[1].rawClass, 'quote-placeholder')
  // 存储层防御：占位行不存在时 FK 直接拒绝悬空引用（appendMessages 返回 0，不产生坏行）
  const n = await svc.appendMessages(CHAT, [
    { msgId: '401', ts: 4100, senderPid: 'wxid_d', kind: 'quote', text: 'x', quoteOfMsgId: 'qref-deadbeef' },
  ])
  assert.equal(n, 0)
  assert.deepEqual(svc.getQuoteChain(CHAT, 'no-such-id'), [])
  // 未开库的群：不建库、返回 []
  assert.deepEqual(svc.getQuoteChain('ghost@chatroom', 'x'), [])
  assert.ok(!svc.isOpen('ghost@chatroom'))
})

test('环引用：FK（quote_of_msg_id→messages）在写入侧即拒绝环，链查询不会死循环', async () => {
  const LOOP = 'loop@chatroom'
  // 环引用两行互相指向：外键约束使事务回滚，环数据根本进不了库
  const n = await svc.appendMessages(LOOP, [
    { msgId: 'p', ts: 1, senderPid: 'x', text: 'p', quoteOfMsgId: 'q' },
    { msgId: 'q', ts: 2, senderPid: 'x', text: 'q', quoteOfMsgId: 'p' },
  ])
  assert.equal(n, 0)
  assert.deepEqual(svc.getQuoteChain(LOOP, 'p'), [])
  // 防御性：即使未来出现环数据（seen 集保护），maxDepth 也保证查询有界
  const bounded = svc.getQuoteChain(CHAT, '300', 5)
  assert.ok(bounded.length <= 5)
})

test('落库幂等：同 msgId 重复 append 不产生重复行', async () => {
  const st = svc.open(CHAT)
  const before = st.countMessages()
  const n = await svc.appendMessages(CHAT, [
    { msgId: '100', ts: 1000, senderPid: 'wxid_a', senderName: '甲', kind: 'text', text: '原始提案A' },
    { msgId: '100', ts: 1000, senderPid: 'wxid_a', senderName: '甲', kind: 'text', text: '原始提案A' },
  ])
  assert.equal(n, 0) // INSERT OR IGNORE 全部被忽略
  assert.equal(st.countMessages(), before)
})

test('解析失败降级不阻塞管线：畸形 quote 文本仍可按纯文本落库', async () => {
  const DEG = 'degraded@chatroom'
  const xml = '<refermsg><svrid>bad</svrid><displayname>甲' // 畸形：svrid 非数字 + 未闭合
  assert.equal(isQuoteMessage(xml), true)
  assert.equal(normalizeQuoteRow(xml, new Set()), null) // 解析层拒绝
  // 调用方（mapRows/接线层）降级为纯文本继续走管线 → 可正常落库
  const n = await svc.appendMessages(DEG, [
    { msgId: 'd1', ts: 10, senderPid: 'wxid_x', kind: 'text', text: xml },
  ])
  assert.equal(n, 1)
  const row = svc.getQuoteChain(DEG, 'd1')
  assert.equal(row.length, 1)
  assert.equal(row[0].kind, 'text')
})
