// ts-ms-regression.test.mjs —— 热修回归：时间戳统一毫秒口径后，今日消息必须落在
// reportWindow('daily') 毫秒窗口内被 getMessages 命中（真实量级 Date.now() 窗口）。
// 杜绝回归：若落库 ts 退回秒级（或 parseCreateTime 再换算错向），窗口比较恒为空 → 本测必红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { GroupStoreService } = await import('../lib/group-store.js')
const { reportWindow } = await import('../lib/report.js')

const CHAT = '1234567890@chatroom'

test('热修回归：今日消息（毫秒 ts）在 daily 窗口内被 getMessages 命中', async () => {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'ts-ms-')))
  try {
    const gs = new GroupStoreService(dir, { warn() {}, error() {} })
    const now = Date.now()
    // 真实量级毫秒窗口：今日自然日（本地时区 00:00 → 明日 00:00），与 report.ts 同口径
    const win = reportWindow('daily', now)
    assert.ok(now >= win.start && now < win.end, 'now 必须落在 daily 窗口内')

    await gs.appendMessages(CHAT, [
      { chatId: CHAT, senderPid: 'wxid_a', senderName: '甲', text: '今天下午开组会', msgId: 'm1', ts: now - 60_000, kind: 'text' },
      { chatId: CHAT, senderPid: 'wxid_b', senderName: '乙', text: '收到', msgId: 'm2', ts: now, kind: 'text' },
    ])

    const hit = gs.getMessages(CHAT, { afterTs: win.start - 1, beforeTs: win.end, limit: 2000 })
    assert.equal(hit.length, 2, '两条今日消息必须全命中（秒级 ts 时为 0）')
    assert.ok(hit.every((m) => m.ts > 1e12), '落库 ts 必须是毫秒量级')

    // person-digest 日窗计数同口径
    const counted = gs.countMessages(CHAT, undefined, { afterTs: win.start - 1, beforeTs: win.end })
    assert.equal(counted, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
