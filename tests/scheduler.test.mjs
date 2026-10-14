// scheduler.test.mjs —— M1-T1.3 调度器：离线 mock（注入时钟 + 手工 tick）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Store } from '../lib/store.js'
import { Scheduler, nextOccurrence, parseTimeOfDay } from '../lib/scheduler.js'

function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const groups = ['a@chatroom', 'b@chatroom', 'c@chatroom']

/** 驱动器：mock 时钟 + 手工 tick，模拟心跳逐分钟推进 */
function makeClock(start) {
  let t = start
  return {
    now: () => t,
    stepMin: (n = 1) => { t += n * 60_000 },
    set: (v) => { t = v },
    get: () => t,
  }
}

function collect() {
  const ticks = []
  return { ticks, onTick: (kind, chatId, meta) => ticks.push({ kind, chatId, ...meta }) }
}

test('parseTimeOfDay：合法与非法输入', () => {
  assert.deepEqual(parseTimeOfDay('20:30'), { h: 20, m: 30 })
  assert.deepEqual(parseTimeOfDay('0:05'), { h: 0, m: 5 })
  assert.throws(() => parseTimeOfDay('24:00'))
  assert.throws(() => parseTimeOfDay('abc'))
  assert.throws(() => parseTimeOfDay('20:5'))
})

test('nextOccurrence：daily / weekly(周日) / monthly(1日)', () => {
  // 2026-03-10 是周二
  const tuesday = at(2026, 3, 10, 21, 0)
  assert.equal(new Date(nextOccurrence('daily', tuesday, '20:30')).getDate(), 11)
  // 下一个周日 20:40 → 3-15
  const sunday = new Date(nextOccurrence('weekly', tuesday, '20:40'))
  assert.equal(sunday.getDay(), 0)
  assert.equal(sunday.getDate(), 15)
  // 下一个月 1 日 08:00 → 4-1（3 月 1 日已过）
  const monthly = new Date(nextOccurrence('monthly', tuesday, '08:00'))
  assert.equal(monthly.getDate(), 1)
  assert.equal(monthly.getMonth(), 3)
  // 当天未到点 → 今天
  const morning = at(2026, 3, 10, 8, 0)
  assert.equal(nextOccurrence('daily', at(2026, 3, 10, 7, 0), '08:00'), morning)
})

test('daily 20:30 到点：按白名单顺序错峰 5 分钟逐群触发', () => {
  const clock = makeClock(at(2026, 3, 10, 20, 0))
  const { ticks, onTick } = collect()
  const s = new Scheduler({ groups, logger: silentLogger, onTick, now: clock.now, tickMs: 60_000 })
  const stop = s.start()
  try {
    clock.stepMin(30) // 20:30
    s.tick()
    assert.deepEqual(ticks.map(t => t.chatId), ['a@chatroom'])
    assert.equal(ticks[0].kind, 'daily')
    assert.equal(ticks[0].catchup, false)
    clock.stepMin(5) // 20:35
    s.tick()
    clock.stepMin(5) // 20:40
    s.tick()
    assert.deepEqual(ticks.map(t => t.chatId), ['a@chatroom', 'b@chatroom', 'c@chatroom'])
    assert.equal(ticks.every(t => t.catchup === false), true)
    // 当日完成后再 tick 不重复触发
    clock.stepMin(5)
    s.tick()
    assert.equal(ticks.length, 3)
  } finally {
    stop()
  }
})

test('weekly 只在周日 20:40 触发；monthly 只在 1 日 08:00 触发', () => {
  // 2026-03-15 是周日
  const clock = makeClock(at(2026, 3, 15, 20, 0))
  const { ticks, onTick } = collect()
  const s = new Scheduler({ groups: ['a@chatroom'], logger: silentLogger, onTick, now: clock.now, tickMs: 60_000 })
  const stop = s.start()
  try {
    clock.stepMin(40) // 周日 20:40
    s.tick()
    assert.equal(ticks.filter(t => t.kind === 'weekly').length, 1)
    // 非周日到 20:40（3-16 周一）不触发 weekly
    clock.set(at(2026, 3, 16, 20, 40))
    s.tick()
    assert.equal(ticks.filter(t => t.kind === 'weekly').length, 1)
    // 4-1 08:00 触发 monthly；4-2 同点不触发
    clock.set(at(2026, 4, 1, 8, 0))
    s.tick()
    assert.equal(ticks.filter(t => t.kind === 'monthly').length, 1)
    clock.set(at(2026, 4, 2, 8, 0))
    s.tick()
    assert.equal(ticks.filter(t => t.kind === 'monthly').length, 1)
  } finally {
    stop()
  }
})

test('补跑：重启后窗口内恢复，剩余群 catchup=true', () => {
  const base = mkdtempSync(join(tmpdir(), 'sched-state-'))
  const dir = realpathSync(base)
  try {
    const store = new Store(dir, silentLogger)
    const clock = makeClock(at(2026, 3, 10, 20, 0))
    const { ticks, onTick } = collect()
    const s1 = new Scheduler({ groups, logger: silentLogger, store, onTick, now: clock.now, tickMs: 60_000 })
    const stop1 = s1.start()
    clock.stepMin(30)
    s1.tick() // a 触达（20:30）
    clock.stepMin(5)
    s1.tick() // b 触达（20:35）
    assert.equal(ticks.length, 2)
    stop1() // 在 c 触达前「重启」

    // 重启于 20:50：距 20:30 基准 20 分钟 ≤ 30 分钟窗口 → c 补跑 catchup=true
    const clock2 = makeClock(at(2026, 3, 10, 20, 50))
    const ticks2 = []
    const s2 = new Scheduler({
      groups, logger: silentLogger, store,
      onTick: (kind, chatId, meta) => ticks2.push({ kind, chatId, ...meta }),
      now: clock2.now, tickMs: 60_000,
    })
    const stop2 = s2.start()
    clock2.stepMin(1)
    s2.tick()
    assert.deepEqual(ticks2.map(t => t.chatId), ['c@chatroom'])
    assert.equal(ticks2[0].catchup, true)
    assert.ok(readFileSync(join(dir, 'scheduler/state.json'), 'utf8').includes('"base"'))
    stop2()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('超窗放弃：重启时错过 > 30 分钟 → 不补跑，直接排下一次', () => {
  const base = mkdtempSync(join(tmpdir(), 'sched-state-'))
  const dir = realpathSync(base)
  try {
    const store = new Store(dir, silentLogger)
    // 手写持久化状态：daily 基准 20:30，一个群都没触发
    store.ensureDir('scheduler')
    store.writeText('scheduler/state.json', JSON.stringify({
      daily: { base: at(2026, 3, 10, 20, 30), fired: [] },
    }))
    const clock2 = makeClock(at(2026, 3, 10, 21, 30)) // 距基准 60 分钟 > 30
    const ticks2 = []
    const warns = []
    const s2 = new Scheduler({
      groups, logger: { warn: (m) => warns.push(m), error: () => {} },
      store, onTick: (kind, chatId, meta) => ticks2.push({ kind, chatId, ...meta }),
      now: clock2.now, tickMs: 60_000,
    })
    const stop2 = s2.start()
    clock2.stepMin(1)
    s2.tick()
    assert.equal(ticks2.length, 0, '超窗 occurrence 不补跑')
    assert.ok(warns.some(w => w.includes('abandoned')))
    // 明天 20:30 恢复正常触发
    clock2.set(at(2026, 3, 11, 20, 30))
    s2.tick()
    assert.deepEqual(ticks2.map(t => t.chatId), ['a@chatroom'])
    assert.equal(ticks2[0].catchup, false)
    stop2()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('首次运行只安排未来时点，不把历史当错过补跑', () => {
  const clock = makeClock(at(2026, 3, 10, 23, 0)) // 已过当日 20:30
  const { ticks, onTick } = collect()
  const s = new Scheduler({ groups: ['a@chatroom'], logger: silentLogger, onTick, now: clock.now, tickMs: 60_000 })
  const stop = s.start()
  try {
    s.tick()
    assert.equal(ticks.length, 0)
    assert.equal(new Date(s.status().daily).getDate(), 11)
  } finally {
    stop()
  }
})

test('stop() 后 tick 不再触发（dispose 无残留）', () => {
  const clock = makeClock(at(2026, 3, 10, 20, 30))
  const { ticks, onTick } = collect()
  const s = new Scheduler({ groups: ['a@chatroom'], logger: silentLogger, onTick, now: clock.now, tickMs: 60_000 })
  const stop = s.start()
  s.tick()
  assert.equal(ticks.length, 1)
  stop()
  s.tick()
  clock.stepMin(30)
  s.tick()
  assert.equal(ticks.length, 1, 'stop 后不再触发')
  assert.equal(s.status().daily, null, 'stop 清空内存状态')
})

test('onTick 回调抛错不拖垮调度循环', () => {
  const clock = makeClock(at(2026, 3, 10, 20, 30))
  const ticks = []
  const errors = []
  const s = new Scheduler({
    groups: ['a@chatroom', 'b@chatroom'],
    staggerMinutes: 0, // 关掉错峰，专测异常隔离
    logger: { warn: () => {}, error: (m) => errors.push(m) },
    onTick: (kind, chatId) => {
      if (chatId === 'a@chatroom') throw new Error('boom')
      ticks.push(chatId)
    },
    now: clock.now, tickMs: 60_000,
  })
  const stop = s.start()
  try {
    s.tick()
    assert.deepEqual(ticks, ['b@chatroom'])
    assert.ok(errors.some(e => e.includes('boom')))
  } finally {
    stop()
  }
})

// ——— 快速测试模式（scheduleTestMode） ———

test('testMode：每 interval 依次强制触发 weekly/monthly，kind 照常传递', () => {
  const clock = makeClock(at(2026, 3, 10, 9, 0)) // 周二白天——日历闸门本不会触发周/月报
  const { ticks, onTick } = collect()
  const s = new Scheduler({
    groups: ['a@chatroom', 'b@chatroom'], logger: silentLogger, onTick,
    now: clock.now, tickMs: 60_000,
    testMode: true, testKindIntervalMin: 10,
  })
  const stop = s.start()
  try {
    clock.stepMin(10); s.tick() // +10min → weekly（全群）
    assert.deepEqual(ticks.map(t => `${t.kind}:${t.chatId}`), ['weekly:a@chatroom', 'weekly:b@chatroom'])
    assert.equal(ticks[0].catchup, false)
    clock.stepMin(10); s.tick() // +20min → monthly
    assert.deepEqual(ticks.map(t => t.kind), ['weekly', 'weekly', 'monthly', 'monthly'])
    clock.stepMin(10); s.tick() // +30min → 交替回 weekly
    assert.deepEqual(ticks.map(t => t.kind), ['weekly', 'weekly', 'monthly', 'monthly', 'weekly', 'weekly'])
    // 间隔未到不触发
    clock.stepMin(5); s.tick()
    assert.equal(ticks.length, 6)
  } finally {
    stop()
  }
})

test('testMode：间隔边界——interval<=0 或 testMode 缺省 = 零变化', () => {
  // testMode=true 但 interval=0：不触发
  const clock = makeClock(at(2026, 3, 10, 9, 0))
  const a = collect()
  const s1 = new Scheduler({ groups, logger: silentLogger, onTick: a.onTick, now: clock.now, tickMs: 60_000, testMode: true, testKindIntervalMin: 0 })
  const stop1 = s1.start()
  clock.stepMin(120); s1.tick()
  stop1()
  assert.equal(a.ticks.length, 0)
  // 不配 testMode（undefined）：行为与原版一致
  const clock2 = makeClock(at(2026, 3, 10, 9, 0))
  const b = collect()
  const s2 = new Scheduler({ groups: ['a@chatroom'], logger: silentLogger, onTick: b.onTick, now: clock2.now, tickMs: 60_000, testKindIntervalMin: 10 })
  const stop2 = s2.start()
  clock2.stepMin(60); s2.tick()
  stop2()
  assert.equal(b.ticks.length, 0)
  // 负数 interval 同样不触发
  const s3 = new Scheduler({ groups, logger: silentLogger, onTick: () => {}, now: clock.now, tickMs: 60_000, testMode: true, testKindIntervalMin: -5 })
  const stop3 = s3.start()
  clock.stepMin(10); s3.tick()
  stop3()
})

test('testMode：与日历触发并存，stop 后不再强制触发', () => {
  // 周日 20:30 启动，interval=10：日历 weekly 正常触发，test 链路独立交替
  const clock = makeClock(at(2026, 3, 15, 20, 30))
  const { ticks, onTick } = collect()
  const s = new Scheduler({
    groups: ['a@chatroom'], logger: silentLogger, onTick,
    now: clock.now, tickMs: 60_000,
    testMode: true, testKindIntervalMin: 10,
  })
  const stop = s.start()
  try {
    clock.stepMin(10); s.tick() // 20:40：日历 daily+weekly，test weekly，共 3 次
    const weekly = ticks.filter(t => t.kind === 'weekly')
    assert.equal(weekly.length, 2)
    assert.equal(ticks.filter(t => t.kind === 'monthly').length, 0)
    stop()
    clock.stepMin(10); s.tick()
    assert.equal(ticks.length, 3, 'stop 后 test 链路停止')
  } finally {
    stop()
  }
})
