// path-guard.test.mjs —— assertInsideState：../、绝对路径逃逸、符号链接形态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertInsideState } from '../lib/guard.js'

// macOS 上 /var 是 /private/var 的 symlink，先 realpath 再断言
const base = realpathSync(mkdtempSync(join(tmpdir(), 'lurker-state-')))
test.after(() => rmSync(base, { recursive: true, force: true }))

test('允许 base 内部相对路径', () => {
  assert.doesNotThrow(() => assertInsideState(base, join(base, 'groups/abc/insights.jsonl')))
  assert.doesNotThrow(() => assertInsideState(base, base))
})

test('阻止 ../ 目录穿越', () => {
  assert.throws(() => assertInsideState(base, '../escape.txt'))
  assert.throws(() => assertInsideState(base, 'groups/../../escape.txt'))
  assert.throws(() => assertInsideState(base, 'a/../../../x'))
})

test('阻止绝对路径逃逸', () => {
  assert.throws(() => assertInsideState(base, '/etc/passwd'))
  assert.throws(() => assertInsideState(base, resolve(base, '..', 'elsewhere')))
  // 同名前缀但不同目录（baseFoo ≠ base）也必须拦截
  assert.throws(() => assertInsideState(base, base + '-sibling/x'))
})

test('符号链接形态：先 realpath 再校验可拦截', () => {
  const outside = mkdtempSync(join(tmpdir(), 'lurker-outside-'))
  try {
    const link = join(base, 'innocent')
    symlinkSync(outside, link)
    // resolve 不追踪 symlink：纯路径校验会误放行
    assert.doesNotThrow(() => assertInsideState(base, link))
    // 因此写入点必须对已存在路径先 realpath 再校验（store 层纵深防御约定）
    const real = realpathSync(link)
    assert.throws(() => assertInsideState(base, real))
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})
