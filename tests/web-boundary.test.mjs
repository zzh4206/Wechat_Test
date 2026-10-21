// web-boundary.test.mjs —— web 进程边界哨兵（前端设计 §6.3；与 no-send/wiring 同级，只加强不修改既有哨兵）。
// 静态断言钉死「监听端口的进程与发送出口物理隔离」：
// - web/ 只 import node: 内置模块或 web/ 内相对路径（不碰 src/、插件 lib/、npm 包），无动态 import/require；
// - 无 child_process / worker_threads / 出网原语；服务端零 fetch；
// - fs 写原语只允许出现在动作写入模块（FE-2 起的 web/lib/actions.mjs；FE-1 不存在 = 全禁）；
// - listen 地址字面量必须为 127.0.0.1；
// - public/ 的 fetch 只打同源 /api/，且不出现 innerHTML 类 HTML 注入原语。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const webDir = resolve(import.meta.dirname, '..', 'web')
const WRITE_ALLOWED = new Set([join('lib', 'actions.mjs')])

const files = readdirSync(webDir, { recursive: true })
  .filter(f => /\.(mjs|js|cjs|ts)$/.test(f))
  .map(f => ({ rel: f, abs: join(webDir, f), code: stripComments(readFileSync(join(webDir, f), 'utf8')) }))
const serverSide = files.filter(f => !f.rel.startsWith(`public${sep}`))
const browserSide = files.filter(f => f.rel.startsWith(`public${sep}`))

/** 去掉 // 行注释与块注释（注释里可以讨论禁用词） */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n')
}

function hits(list, re) {
  const out = []
  for (const f of list) {
    f.code.split('\n').forEach((line, i) => { if (re.test(line)) out.push(`web/${f.rel}:${i + 1}: ${line.trim()}`) })
  }
  return out
}

test('web/ 存在且有服务端与页面代码（防哨兵空转）', () => {
  assert.ok(serverSide.some(f => f.rel === 'server.mjs'))
  assert.ok(browserSide.length > 0)
})

test('import 只允许 node: 内置或 web/ 内相对路径', () => {
  const bad = []
  for (const f of files) {
    for (const m of f.code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2]
      if (spec.startsWith('node:')) continue
      if (f.rel.startsWith(`public${sep}`) ? /^\.\/[\w.-]+\.js$/.test(spec) : spec.startsWith('.')) {
        const target = resolve(dirname(f.abs), spec)
        if (relative(webDir, target).startsWith('..')) bad.push(`web/${f.rel}: import 越出 web/：${spec}`)
        continue
      }
      bad.push(`web/${f.rel}: 非法 import：${spec}`)
    }
  }
  bad.push(...hits(files, /\bimport\s*\(|\brequire\s*\(/))
  assert.deepEqual(bad, [])
})

test('无子进程、线程与出网原语', () => {
  const bad = hits(serverSide, /child_process|worker_threads|node:(net|tls|https|dgram|http2|dns)\b|\bhttp\.(request|get)\b|\b(request|get)\s*\(\s*\{|\bfetch\s*\(|WebSocket|EventSource/)
  // node:http 只许取 createServer（服务端），不许取 request/get（客户端）
  for (const f of serverSide) {
    for (const m of f.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:http['"]/g)) {
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
      if (names.some(n => n !== 'createServer')) bad.push(`web/${f.rel}: node:http 只许 import createServer（实际：${names.join(', ')}）`)
    }
  }
  assert.deepEqual(bad, [])
})

test('fs 写原语只在动作写入模块（FE-1 = 全禁）', () => {
  const others = serverSide.filter(f => !WRITE_ALLOWED.has(f.rel))
  const bad = hits(others, /\b(writeFile|appendFile|createWriteStream|mkdir|rm|rmdir|unlink|rename|copyFile|cp|truncate|symlink|link|chmod|chown|utimes|open)(Sync)?\s*\(/)
  assert.deepEqual(bad, [])
})

test('listen 地址字面量必须为 127.0.0.1', () => {
  const calls = serverSide.flatMap(f => [...f.code.matchAll(/\.listen\(([^)]*)\)/g)].map(m => [f.rel, m[1]]))
  assert.ok(calls.length > 0, '未找到 listen 调用')
  for (const [rel, args] of calls) assert.match(args, /,\s*'127\.0\.0\.1'\s*(,|$)/, `web/${rel}: listen(${args})`)
  assert.deepEqual(hits(serverSide, /0\.0\.0\.0|['"]::['"]/), [])
})

test('public/：fetch 只打同源 /api/，无 HTML 注入原语', () => {
  const bad = []
  for (const f of browserSide) {
    for (const m of f.code.matchAll(/\bfetch\s*\(\s*(.)/g)) {
      const after = f.code.slice(m.index + m[0].length - 1, m.index + m[0].length + 6)
      if (!/^[`'"]\/api\//.test(after)) bad.push(`web/${f.rel}: fetch 目标须为字面量 /api/ 开头`)
    }
  }
  bad.push(...hits(browserSide, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b|srcdoc/))
  const html = readFileSync(join(webDir, 'public', 'index.html'), 'utf8')
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) bad.push('index.html 含内联脚本')
  if (/\son\w+\s*=/i.test(html)) bad.push('index.html 含内联事件处理器')
  if (/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html)) bad.push('index.html 引用外部资源')
  assert.deepEqual(bad, [])
})
