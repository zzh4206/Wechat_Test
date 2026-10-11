// persona.test.mjs —— WP2 人格加载器测试。
// 用临时目录 + 注入读文件计数器验证：默认回退、命名加载、按群覆盖、缺失回退、缓存。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonaService, loadBundledDefault, DEFAULT_PERSONA } from '../lib/persona.js'

function makeLogger() {
  const warnings = []
  return { warnings, warn(msg) { warnings.push(msg) } }
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lurker-persona-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 注入的读文件函数：真实读盘并计数（验证缓存只读一次） */
function countingRead(counter) {
  return (path) => {
    counter.set(path, (counter.get(path) ?? 0) + 1)
    return readUtf8(path)
  }
}

import { readFileSync } from 'node:fs'
function readUtf8(path) {
  return readFileSync(path, 'utf8')
}

test('内置 default 人格可用且非空', () => {
  const text = loadBundledDefault()
  assert.ok(text.includes('旁观者'), '内置人格应含旁观者描述')
  assert.equal(DEFAULT_PERSONA, 'default')
})

test('未配置 groupPersonas 时 resolve 回退内置 default', () => {
  const logger = makeLogger()
  const svc = new PersonaService({ stateDir: join(tmpdir(), 'nonexistent'), logger })
  const a = svc.resolve('chatA', undefined)
  const b = svc.resolve('chatB', {})
  assert.equal(a, b)
  assert.ok(a.includes('旁观者'))
  assert.equal(logger.warnings.length, 0)
})

test('命名人格从 <stateDir>/personas/<name>.md 加载', () =>
  withTemp((dir) => {
    mkdirSync(join(dir, 'personas'))
    writeFileSync(join(dir, 'personas', 'grumpy.md'), '# 老干部人格\n说话一板一眼。')
    const svc = new PersonaService({ stateDir: dir, logger: makeLogger() })
    const text = svc.load('grumpy')
    assert.ok(text.includes('老干部'))
  }))

test('两个群配置不同人格时互不串扰；按群覆盖优先于 default', () =>
  withTemp((dir) => {
    mkdirSync(join(dir, 'personas'))
    writeFileSync(join(dir, 'personas', 'tech.md'), '# 技术群人格\n只聊技术。')
    writeFileSync(join(dir, 'personas', 'food.md'), '# 美食群人格\n只聊吃的。')
    const svc = new PersonaService({ stateDir: dir, logger: makeLogger() })
    const groupPersonas = { 'chat-tech': 'tech', 'chat-food': 'food' }
    const tech = svc.resolve('chat-tech', groupPersonas)
    const food = svc.resolve('chat-food', groupPersonas)
    const plain = svc.resolve('chat-other', groupPersonas)
    assert.ok(tech.includes('技术群'))
    assert.ok(food.includes('美食群'))
    assert.ok(!tech.includes('美食群') && !food.includes('技术群'))
    assert.ok(plain.includes('旁观者'), '未配置群回退 default')
    assert.notEqual(tech, food)
  }))

test('文件缺失/读失败回退内置 default 并记警告', () => {
  const logger = makeLogger()
  const svc = new PersonaService({ stateDir: join(tmpdir(), 'no-such-dir'), logger })
  const text = svc.load('missing')
  assert.ok(text.includes('旁观者'))
  assert.equal(logger.warnings.length, 1)
})

test('缓存生效：同一 name 只读一次盘；clear 后重新读', () =>
  withTemp((dir) => {
    mkdirSync(join(dir, 'personas'))
    writeFileSync(join(dir, 'personas', 'cached.md'), '# 缓存人格')
    const counter = new Map()
    const svc = new PersonaService({ stateDir: dir, logger: makeLogger(), read: countingRead(counter) })
    const file = join(dir, 'personas', 'cached.md')
    svc.load('cached')
    svc.load('cached')
    svc.resolve('chat1', { chat1: 'cached' })
    assert.equal(counter.get(file), 1, '同一 name 应只读一次盘')
    svc.clear()
    svc.load('cached')
    assert.equal(counter.get(file), 2, 'clear 后应重新读盘')
  }))
