// 热修单测：ts 映射（parseCreateTime）+ 类型码占位（decodePackedType/mapRawType/normalizeRowText）
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  parseCreateTime,
  decodePackedType,
  mapRawType,
  normalizeRowText,
} = await import('../lib/source/wechat-db.js')

test('parseCreateTime：字符串秒 → 毫秒（统一 Date.now() 口径）', () => {
  assert.equal(parseCreateTime('1791946486'), 1791946486000)
  assert.equal(parseCreateTime(' 1791946486 '), 1791946486000)
})

test('parseCreateTime：number 秒 ×1000；已是毫秒原值保留（自动兼容）', () => {
  assert.equal(parseCreateTime(1791946486), 1791946486000)
  assert.equal(parseCreateTime(1791946486000), 1791946486000)
  assert.equal(parseCreateTime('1791946486000'), 1791946486000)
  const nowMs = Date.now()
  assert.equal(parseCreateTime(String(nowMs)), nowMs, '已是毫秒 → 原值保留')
})

test('parseCreateTime：无法解析一律 null（调用方兜底，不落 0）', () => {
  for (const v of [undefined, null, '', 'abc', '12x34', 0, -5, NaN, {}, [], '1e9']) {
    assert.equal(parseCreateTime(v), null, String(v))
  }
})

test('decodePackedType：打包值取低 32 位', () => {
  assert.equal(decodePackedType(25769803825), 49) // (6<<32)|49 实测值
  assert.equal(decodePackedType(3), 3)
  assert.equal(decodePackedType(-1), -1)
})

test('mapRawType：常见类型码 → 友好占位 + kind 归类', () => {
  assert.deepEqual(mapRawType(25769803825), { label: '[链接]', kind: 'link' }) // 打包 49
  assert.deepEqual(mapRawType(3), { label: '[图片]', kind: 'image' })
  assert.deepEqual(mapRawType(34), { label: '[语音]', kind: 'voice' })
  assert.deepEqual(mapRawType(43), { label: '[视频]', kind: 'video' })
  assert.deepEqual(mapRawType(2 ** 32 + 34), { label: '[语音]', kind: 'voice' })
  assert.deepEqual(mapRawType(49), { label: '[链接]', kind: 'link' })
})

test('mapRawType：未知类型码保持可调试', () => {
  assert.deepEqual(mapRawType(99999), { label: '[消息:99999]', kind: 'other' })
  assert.deepEqual(mapRawType(25769803900), { label: `[消息:${25769803900 % 2 ** 32}]`, kind: 'other' })
})

test('normalizeRowText：非文本占位走映射表；文本/系统行为不变', () => {
  assert.equal(normalizeRowText('', 25769803825, 'wxid_x'), '[链接]')
  assert.equal(normalizeRowText('你好', 1, 'wxid_x'), '你好')
  assert.equal(normalizeRowText('你好', undefined, 'wxid_x'), '你好')
  assert.equal(normalizeRowText('x', 10000, 'wxid_x'), null)
  assert.equal(normalizeRowText('', 999999, 'wxid_x'), '[消息:999999]')
})
