// watchlist.test.mjs —— M2-T2.1 关注名单 + M2-T2.4 按人检索（全离线 mock，node:sqlite 临时目录）。
// 覆盖：名单写入 identities、scope 映射（global/group/off 降级）、跨群归一检索（同名不同 wxid
//       视为不同人、同一 wxid 不同群昵称归一）、空名单 fail-closed 零活动、关键词/时间窗组合查询。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { PersonaTrackService, derivePid, normalizeWxid } = await import('../lib/persona-track.js')

const stateDir = resolve(mkdtempSync(join(tmpdir(), 'lurker-watch-')))
const logger = { warn() {}, error() {} }
const errors = []
const errLogger = { warn() {}, error(msg) { errors.push(msg) } }
test.after(() => rmSync(stateDir, { recursive: true, force: true }))

const CHAT_A = '111@chatroom'
const CHAT_B = '222@chatroom'
const CHAT_C = '333@chatroom'
const WXID_ZHANG = 'wxid_zhang111'
const WXID_LI = 'wxid_li222'
const WXID_TWIN = 'wxid_twin999' // 与 zhang 同昵称「小张」但不同人

function makeTracker() {
  const groupStore = new GroupStoreService(stateDir, logger)
  const track = new PersonaTrackService({ groupStore, logger })
  return { groupStore, track }
}

/** mock W3 昵称映射链：只实现 resolveGroup，群昵称各不相同但 wxid 相同 → 检索须归一 */
function fakeResolver() {
  return {
    resolveGroup: async (chatId) =>
      new Map(
        chatId === CHAT_A
          ? [[WXID_ZHANG, '小张A群名'], [WXID_TWIN, '小张']]
          : [[WXID_ZHANG, '老张B群名'], [WXID_LI, '小李']],
      ),
  }
}

async function seedMessages(groupStore) {
  await groupStore.appendMessages(CHAT_A, [
    { msgId: 'a1', ts: 1000, senderPid: WXID_ZHANG, senderName: '小张A群名', text: '今晚一起吃饭吗' },
    { msgId: 'a2', ts: 2000, senderPid: WXID_TWIN, senderName: '小张', text: '吃饭 +1' },
    { msgId: 'a3', ts: 3000, senderPid: 'wxid_other', senderName: '路人', text: '吃饭安排上了' },
  ])
  await groupStore.appendMessages(CHAT_B, [
    // 已代号化：sender_pid 为派生 pid（模拟上层映射链）
    { msgId: 'b1', ts: 4000, senderPid: derivePid(WXID_ZHANG), senderName: '老张B群名', text: '明天开会记得带材料' },
    { msgId: 'b2', ts: 5000, senderPid: derivePid(WXID_LI), senderName: '小李', text: '收到' },
    // 未代号化：sender_pid 直接是 wxid
    { msgId: 'b3', ts: 6000, senderPid: WXID_LI, senderName: '小李', text: '材料我这里有' },
  ])
}

test('normalizeWxid / derivePid：归一与确定性派生', () => {
  assert.equal(normalizeWxid('  wxid_x  '), 'wxid_x')
  assert.equal(normalizeWxid(''), '')
  assert.equal(derivePid(WXID_ZHANG), derivePid(WXID_ZHANG), 'same wxid → same pid')
  assert.notEqual(derivePid(WXID_ZHANG), derivePid(WXID_LI), 'different wxid → different pid')
  assert.ok(derivePid(WXID_ZHANG).startsWith('wx_'))
})

test('空名单 fail-closed：零活动（不开库、不写 identities、searchByPerson 恒 []）', async () => {
  const { groupStore, track } = makeTracker()
  const res = await track.syncWatchList([], [CHAT_A, CHAT_B])
  assert.deepEqual(res, { rows: 0, chats: [] })
  assert.equal(groupStore.openedChats().length, 0, 'no store should be opened')
  assert.deepEqual(track.watchedWxids(), [])
  assert.deepEqual(await track.searchByPerson('all', WXID_ZHANG, '吃饭'), [], 'empty list → no hits')
  assert.deepEqual(await track.searchByPerson(CHAT_A, WXID_ZHANG), [])
  assert.equal(track.isWatched(WXID_ZHANG), false)
})

test('名单写入 identities + scope 映射：global 全群 / {groups} 命中 group 其余 off', async () => {
  const { groupStore, track } = makeTracker()
  track.setNicknameSource(fakeResolver())
  const res = await track.syncWatchList(
    [
      { wxid: WXID_ZHANG, remark: '张三', scope: 'global' },
      { wxid: WXID_LI, scope: { groups: [CHAT_B] } },
    ],
    [CHAT_A, CHAT_B, CHAT_C],
  )
  assert.equal(res.rows, 6) // 2 人 × 3 群
  assert.deepEqual(res.chats.sort(), [CHAT_A, CHAT_B, CHAT_C].sort())

  const a = groupStore.open(CHAT_A).getIdentities()
  const b = groupStore.open(CHAT_B).getIdentities()
  const c = groupStore.open(CHAT_C).getIdentities()
  assert.deepEqual(a.find((r) => r.wxid === WXID_ZHANG).watchLevel, 'global')
  assert.equal(a.find((r) => r.wxid === WXID_ZHANG).groupNick, '小张A群名', 'group_nick from W3 chain')
  assert.equal(a.find((r) => r.wxid === WXID_ZHANG).remark, '张三')
  assert.equal(a.find((r) => r.wxid === WXID_LI).watchLevel, 'off', 'scoped out → off（不留幽灵追踪）')
  assert.deepEqual(b.find((r) => r.wxid === WXID_ZHANG).watchLevel, 'global')
  assert.deepEqual(b.find((r) => r.wxid === WXID_LI).watchLevel, 'group')
  assert.deepEqual(b.find((r) => r.wxid === WXID_LI).groupNick, '小李')
  assert.deepEqual(c.find((r) => r.wxid === WXID_LI).watchLevel, 'off')
  // pid 由 wxid 确定性派生，wxid 唯一约束 upsert 幂等
  assert.equal(b.find((r) => r.wxid === WXID_ZHANG).pid, derivePid(WXID_ZHANG))
})

test('重复同步幂等：同 wxid upsert 不产生重复行', async () => {
  const CHAT_IDEM = '888@chatroom'
  const { groupStore, track } = makeTracker()
  track.setNicknameSource(fakeResolver())
  const list = [{ wxid: WXID_ZHANG, scope: 'global' }]
  await track.syncWatchList(list, [CHAT_IDEM])
  await track.syncWatchList(list, [CHAT_IDEM])
  const rows = groupStore.open(CHAT_IDEM).getIdentities()
  assert.equal(rows.length, 1)
})

test('跨群归一检索：同一 wxid 两种 sender_pid（wxid 与派生 pid）都命中', async () => {
  const { groupStore, track } = makeTracker()
  track.setNicknameSource(fakeResolver())
  await seedMessages(groupStore)
  await track.syncWatchList([{ wxid: WXID_ZHANG, scope: 'global' }], [CHAT_A, CHAT_B])
  const hits = await track.searchByPerson('all', WXID_ZHANG)
  assert.deepEqual(hits.map((h) => `${h.chatId}:${h.msgId}`).sort(), ['111@chatroom:a1', '222@chatroom:b1'].sort())
  // 出处三要素齐全：群 / 时间 / 原文
  const b1 = hits.find((h) => h.msgId === 'b1')
  assert.equal(b1.chatId, CHAT_B)
  assert.equal(b1.ts, 4000)
  assert.equal(b1.text, '明天开会记得带材料')
  assert.equal(b1.senderName, '老张B群名')
})

test('同名不同 wxid 视为不同人：搜 zhang 不带出 twin 的消息', async () => {
  const { groupStore, track } = makeTracker()
  track.setNicknameSource(fakeResolver())
  await seedMessages(groupStore)
  await track.syncWatchList(
    [{ wxid: WXID_ZHANG, scope: 'global' }, { wxid: WXID_TWIN, scope: 'global' }],
    [CHAT_A],
  )
  const zhang = await track.searchByPerson('all', WXID_ZHANG)
  assert.ok(zhang.every((h) => h.msgId !== 'a2'), 'twin (same nick) must not leak into zhang hits')
  const twin = await track.searchByPerson('all', WXID_TWIN)
  assert.deepEqual(twin.map((h) => h.msgId), ['a2'])
})

test('未关注的人检索返回空（只检索被关注者）', async () => {
  const { groupStore, track } = makeTracker()
  track.setNicknameSource(fakeResolver())
  await seedMessages(groupStore)
  await track.syncWatchList([{ wxid: WXID_ZHANG, scope: 'global' }], [CHAT_A])
  assert.deepEqual(await track.searchByPerson('all', 'wxid_stranger', '吃饭'), [])
  assert.deepEqual(await track.searchByPerson('all', ''), [])
})

test('关键词 + 时间窗 + limit 组合查询', async () => {
  const { groupStore, track } = makeTracker()
  track.setNicknameSource(fakeResolver())
  await seedMessages(groupStore)
  await track.syncWatchList(
    [{ wxid: WXID_ZHANG, scope: 'global' }, { wxid: WXID_LI, scope: 'global' }],
    [CHAT_A, CHAT_B],
  )
  // 关键词：只回含「材料」的
  const kw = await track.searchByPerson('all', WXID_ZHANG, '材料')
  assert.deepEqual(kw.map((h) => h.msgId), ['b1'])
  // 关键词对跨群两人生效（li 的 b2 无关键词、b3 有）
  const li = await track.searchByPerson('all', WXID_LI, '材料')
  assert.deepEqual(li.map((h) => h.msgId), ['b3'])
  // afterTs / beforeTs
  const win = await track.searchByPerson('all', WXID_ZHANG, undefined, { afterTs: 3000 })
  assert.deepEqual(win.map((h) => h.msgId), ['b1'])
  const win2 = await track.searchByPerson('all', WXID_ZHANG, undefined, { beforeTs: 4000 })
  assert.deepEqual(win2.map((h) => h.msgId), ['a1'])
  // limit 取最近
  const lim = await track.searchByPerson('all', WXID_LI, undefined, { limit: 1 })
  assert.equal(lim.length, 1)
  assert.equal(lim[0].msgId, 'b3')
  // 单群检索不串群
  const onlyA = await track.searchByPerson(CHAT_A, WXID_ZHANG)
  assert.deepEqual(onlyA.map((h) => h.msgId), ['a1'])
})

test('searchByPerson 不为未打开的群建库（all 只遍历已打开群库）', async () => {
  const CHAT_ISO = '666@chatroom'
  const CHAT_ISO2 = '777@chatroom'
  const errLogger2 = { warn() {}, error(msg) { errors.push(msg) } }
  const svc2 = new GroupStoreService(stateDir, errLogger2)
  const track2 = new PersonaTrackService({ groupStore: svc2, logger: errLogger2 })
  track2.setNicknameSource(fakeResolver())
  // 只同步一个群 → 只开一个库；检索 'all' 不得为另一个群开库
  await track2.syncWatchList([{ wxid: WXID_ZHANG, scope: 'global' }], [CHAT_ISO])
  await svc2.appendMessages(CHAT_ISO, [{ msgId: 'x1', ts: 100, senderPid: WXID_ZHANG, text: 'hi' }])
  const hits = await track2.searchByPerson('all', WXID_ZHANG)
  assert.deepEqual(hits.map((h) => h.msgId), ['x1'])
  assert.ok(!svc2.isOpen(CHAT_ISO2), 'search must not open other group stores')
})

test('昵称解析失败降级：group_nick 落空但不阻断同步与检索', async () => {
  const groupStore = new GroupStoreService(stateDir, errLogger)
  const track = new PersonaTrackService({ groupStore, logger: errLogger })
  track.setNicknameSource({
    resolveGroup: async () => {
      throw new Error('sqlcipher unavailable')
    },
  })
  const res = await track.syncWatchList([{ wxid: WXID_ZHANG, scope: 'global' }], [CHAT_A])
  assert.equal(res.rows, 1)
  const row = groupStore.open(CHAT_A).getIdentities()[0]
  assert.equal(row.groupNick, '')
  assert.equal(row.watchLevel, 'global')
})

test('insertEvent 为 M4 占位：返回 null 不写库不抛错', async () => {
  const { groupStore, track } = makeTracker()
  const hit = { chatId: CHAT_A, msgId: 'a1', ts: 1, senderPid: WXID_ZHANG, senderName: 'x', kind: 'text', text: 't' }
  assert.equal(await track.insertEvent(CHAT_A, hit, '备忘'), null)
  // events 表存在但未被写入（无库活动路径则跳过开库检查）
  if (groupStore.isOpen(CHAT_A)) {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(stateDir, 'groups', CHAT_A, 'store.db'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0)
    } finally {
      db.close()
    }
  }
})
