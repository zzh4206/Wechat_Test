// db-mirror-media.test.mjs —— v0.4 media 镜像（groupStore files → knowledge.db media）。
// 覆盖：字段映射（含 path / 无 path 两种）、幂等重扫行数不变、source_key 格式、category→media_type。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { createSqliteMirror } = await import('../lib/db/mirror.js')
const { KnowledgeDao } = await import('../lib/db/dao.js')
const { openDb } = await import('../lib/db/db.js')

function makeMirror() {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'mirror-media-')))
  const dbPath = join(dir, 'knowledge.db')
  const mirror = createSqliteMirror(dbPath, { warn() {}, error() {}, debug() {} })
  const db = openDb(dbPath, { logger: { warn() {}, error() {} } })
  const dao = new KnowledgeDao(db, { warn() {}, error() {} })
  return { dir, mirror, dao, db }
}

const row = (over = {}) => ({
  fileId: 'f1',
  name: '设计稿.pdf',
  ext: 'pdf',
  size: 12345,
  msgId: 'm100',
  wxPath: '/tmp/设计稿.pdf',
  hash: 'a'.repeat(32),
  category: '文档',
  lastSeenTs: new Date(2026, 9, 15, 12, 0).getTime(),
  appearances: [{ msgId: 'm100', ts: new Date(2026, 9, 15, 12, 0).getTime() }],
  ...over,
})

test('media 镜像：字段映射（有 path → available/local；无 path → pending/null）', () => {
  const { dir, mirror, dao } = makeMirror()
  mirror.mirrorMedia('888@chatroom', [
    row({ fileId: 'f1' }),
    row({ fileId: 'f2', name: '视频.mp4', category: '视频', wxPath: '待下载', size: 0, hash: '' }),
  ])
  const rows = dao.listMediaByChat('888@chatroom')
  assert.equal(rows.length, 2)
  const f1 = rows.find((r) => r.source_key === '888@chatroom:f1')
  assert.ok(f1, 'source_key 格式 = chatId:fileId')
  assert.equal(f1.media_type, 'file', '文档 → file')
  assert.equal(f1.file_name, '设计稿.pdf')
  assert.equal(f1.status, 'available')
  assert.equal(f1.path, '/tmp/设计稿.pdf')
  assert.equal(f1.path_kind, 'local')
  assert.equal(f1.md5, 'a'.repeat(32))
  assert.equal(f1.size, 12345)
  assert.ok(f1.source_ts > 0, 'source_ts = 消息 ts')
  const f2 = rows.find((r) => r.source_key === '888@chatroom:f2')
  assert.equal(f2.media_type, 'video', '视频 → video')
  assert.equal(f2.status, 'pending', '无 path = pending')
  assert.equal(f2.path, null)
  assert.equal(f2.size, null, 'size 0 → 置空')
  assert.equal(f2.md5, null, 'hash 空 → 置空')
  mirror.close()
  dao.close()
  rmSync(dir, { recursive: true, force: true })
})

test('media 镜像幂等：重扫（同 source_key）行数不变、updated_at 刷新不重复', () => {
  const { dir, mirror, dao } = makeMirror()
  const files = [
    row({ fileId: 'f1' }),
    row({ fileId: 'f2', wxPath: '待下载', category: '图片' }),
  ]
  mirror.mirrorMedia('888@chatroom', files)
  mirror.mirrorMedia('888@chatroom', files.map((f) => ({ ...f, wxPath: '/new/path' })))
  const rows = dao.listMediaByChat('888@chatroom')
  assert.equal(rows.length, 2, '重扫不重复')
  const f1 = rows.find((r) => r.source_key === '888@chatroom:f1')
  assert.equal(f1.path, '/new/path', 'upsert UPDATE 覆盖 path')
  const f2 = rows.find((r) => r.source_key === '888@chatroom:f2')
  assert.equal(f2.media_type, 'image', '图片 → image')
  mirror.close()
  dao.close()
  rmSync(dir, { recursive: true, force: true })
})

test('media 镜像健壮性：空 fileId 行跳过；异常不影响主流程（safe 包裹）', () => {
  const { dir, mirror, dao } = makeMirror()
  assert.doesNotThrow(() => {
    mirror.mirrorMedia('888@chatroom', [
      row({ fileId: '' }),
      null,
      row({ fileId: 'f-ok' }),
    ])
  })
  assert.equal(dao.listMediaByChat('888@chatroom').length, 1)
  mirror.close()
  dao.close()
  rmSync(dir, { recursive: true, force: true })
})
