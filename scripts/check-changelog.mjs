#!/usr/bin/env node
/**
 * CHANGELOG 结构校验。
 *
 * 规则写在 CONTRIBUTING.md，但过去没人执行——于是 `[Unreleased]` 长出了
 * `Added×3` / `Changed×3` / `Fixed×2` 共 9 个同名小节，47 条里 23 条超过 200 字符。
 * 这个脚本只判「结构合法」，不评判措辞好坏。
 *
 * 校验分两档：
 *   - 结构档（全部版本段）：版本标题格式、`[Unreleased]` 存在、版本降序、
 *     小节名白名单且各出现一次、小节顺序符合 Keep a Changelog、空小节报错、
 *     每个版本段都有链接定义、子要点缩进为 2 空格
 *   - 质量档（仅 `[Unreleased]` 与最新版本段）：主句 ≤ 120 字符、
 *     不出现「合并方式 / 直推 / 本项经」这类过程性表述
 *
 * 用法：node scripts/check-changelog.mjs [path]（默认仓库根的 CHANGELOG.md）
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Keep a Changelog 的六个小节名，顺序即要求出现的顺序 */
export const KAC_SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']

/** 质量档：主句（`- ` 之后的正文）最大字符数 */
export const MAX_MAIN_CHARS = 120

/** 质量档：只描述提交过程的词，不属于「功能变更」 */
export const PROCESS_WORDS = ['合并方式', '直推', '本项经']

const UNRELEASED = '[Unreleased]'
const VERSION_RE = /^\[(\d+)\.(\d+)\.(\d+)\] - (\d{4})-(\d{2})-(\d{2})$/
const LINK_DEF_RE = /^\[([^\]]+)\]:\s*(\S+)\s*$/

/**
 * @param {string} text CHANGELOG 全文
 * @returns {{line: number, message: string}[]} 问题清单（空数组 = 通过）
 */
export function checkChangelog(text) {
  const problems = []
  const add = (line, message) => problems.push({ line, message })
  const lines = text.split(/\r?\n/)

  /** 代码围栏内的行不参与结构化校验（归档文件可能整块引用原文） */
  const inFence = new Array(lines.length).fill(false)
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence[i] = true
      fence = !fence
      continue
    }
    inFence[i] = fence
  }

  // —— 版本段切分 ——
  /** @type {{title: string, line: number, body: number}[]} */
  const versions = []
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue
    if (/^## /.test(lines[i])) versions.push({ title: lines[i].slice(3).trim(), line: i + 1, body: i })
  }

  if (versions.length === 0) {
    add(1, '找不到任何 `## ` 版本标题')
    return problems
  }
  if (versions[0].title !== UNRELEASED) {
    add(versions[0].line, `第一个版本标题必须是 \`${UNRELEASED}\`，实际是 \`${versions[0].title}\``)
  }

  const seen = new Set()
  const semverOf = (title) => {
    const m = VERSION_RE.exec(title)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }

  for (const v of versions) {
    if (v.title !== UNRELEASED && !semverOf(v.title)) {
      add(
        v.line,
        `版本标题格式非法：\`${v.title}\`；应为 \`${UNRELEASED}\` 或 \`[X.Y.Z] - YYYY-MM-DD\``,
      )
    }
    if (seen.has(v.title)) add(v.line, `版本标题重复：\`${v.title}\``)
    seen.add(v.title)
  }

  // 版本必须降序（Unreleased 在最前，其后是 0.3.0 > 0.2.0 > …）
  const released = versions.filter((v) => semverOf(v.title))
  for (let i = 1; i < released.length; i++) {
    const a = semverOf(released[i - 1].title)
    const b = semverOf(released[i].title)
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    if (cmp < 0) {
      add(released[i].line, `版本未按降序排列：\`${released[i].title}\` 出现在 \`${released[i - 1].title}\` 之后`)
    }
  }

  // —— 逐段校验小节与条目 ——
  const qualityTargets = new Set()
  if (released.length > 0) qualityTargets.add(released[0].title)
  qualityTargets.add(UNRELEASED)

  for (let vi = 0; vi < versions.length; vi++) {
    const start = versions[vi].body
    const end = vi + 1 < versions.length ? versions[vi + 1].body : lines.length
    /** @type {{name: string, line: number, count: number}[]} */
    const sections = []
    for (let i = start + 1; i < end; i++) {
      if (inFence[i]) continue
      if (!/^### /.test(lines[i])) continue
      const name = lines[i].slice(4).trim()
      const idx = KAC_SECTIONS.indexOf(name)
      if (idx === -1) {
        add(i + 1, `小节名不在 Keep a Changelog 六类之内：\`${name}\`（允许：${KAC_SECTIONS.join(' / ')}）`)
      }
      if (sections.some((s) => s.name === name)) {
        add(i + 1, `同一版本段内小节重复：\`${name}\`——请并回已有的 \`### ${name}\``)
      }
      if (idx !== -1 && sections.length > 0) {
        const prevIdx = KAC_SECTIONS.indexOf(sections[sections.length - 1].name)
        if (prevIdx !== -1 && idx < prevIdx) {
          add(
            i + 1,
            `小节顺序不符合 Keep a Changelog：\`${name}\` 不应排在 \`${sections[sections.length - 1].name}\` 之后`,
          )
        }
      }
      sections.push({ name, line: i + 1, count: 0 })
    }

    // 空小节
    for (const s of sections) {
      let n = 0
      for (let i = s.line; i < end; i++) {
        if (inFence[i]) continue
        if (/^### /.test(lines[i])) break
        if (/^- /.test(lines[i])) n++
      }
      s.count = n
      if (n === 0) add(s.line, `空小节：\`### ${s.name}\`——没有条目就删掉这个小节`)
    }

    // 版本段完全为空：只允许 Unreleased
    if (sections.length === 0 && versions[vi].title !== UNRELEASED) {
      add(versions[vi].line, `版本段 \`${versions[vi].title}\` 下没有任何小节`)
    }

    // —— 质量档 ——
    if (!qualityTargets.has(versions[vi].title)) continue
    let curSection = null
    for (let i = start + 1; i < end; i++) {
      if (inFence[i]) continue
      const line = lines[i]
      if (/^### /.test(line)) {
        curSection = line.slice(4).trim()
        continue
      }
      if (curSection === null) continue
      if (/^ +- /.test(line) && !/^ {2}- /.test(line)) {
        add(i + 1, '子要点缩进必须正好 2 个空格')
        continue
      }
      if (/^- /.test(line)) {
        const main = line.slice(2)
        const len = Array.from(main).length
        if (len > MAX_MAIN_CHARS) {
          add(i + 1, `主句 ${len} 字符，超过 ${MAX_MAIN_CHARS} 上限：把细节挪进子要点或 docs/CHANGELOG-DETAILS.md`)
        }
      }
      for (const word of PROCESS_WORDS) {
        if (line.includes(word)) {
          add(i + 1, `出现过程性表述「${word}」——CHANGELOG 只记功能变更，提交过程写进 PR 描述`)
        }
      }
    }
  }

  // —— 链接定义 ——
  const defs = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue
    const m = LINK_DEF_RE.exec(lines[i])
    if (m) defs.add(m[1])
  }
  for (const v of versions) {
    const num = VERSION_RE.exec(v.title)
    const key = v.title === UNRELEASED ? 'Unreleased' : num ? `${num[1]}.${num[2]}.${num[3]}` : v.title
    if (!defs.has(key)) {
      add(v.line, `缺少链接定义：\`[${key}]: <compare 或 release URL>\``)
    }
  }

  return problems.sort((a, b) => a.line - b.line)
}

/** CLI 入口 */
function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const path = process.argv[2] ?? join(here, '..', 'CHANGELOG.md')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`❌ 读不到 ${path}: ${err.message}`)
    process.exit(2)
  }
  const problems = checkChangelog(text)
  if (problems.length === 0) {
    console.log('✅ CHANGELOG 结构校验通过')
    return
  }
  for (const p of problems) console.error(`❌ ${path}:${p.line} ${p.message}`)
  console.error(`\n共 ${problems.length} 个问题`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
