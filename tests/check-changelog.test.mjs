// check-changelog.test.mjs —— CHANGELOG 结构校验的离线测试。
//
// 覆盖：
// ① 合规文件通过（空 [Unreleased] 合法）；
// ② [Unreleased] 缺失 / 不是第一个版本标题 → 报错；
// ③ 同一版本段小节重复 → 报错（历史上 Added×3 / Changed×3 就是这么长出来的）；
// ④ 小节顺序不符合 Keep a Changelog → 报错；
// ⑤ 空小节 → 报错；
// ⑥ 版本标题格式非法、版本未降序、缺链接定义 → 报错；
// ⑦ 质量档只作用于 [Unreleased] 与最新版本段：主句超长 / 过程词在旧段不报；
// ⑧ 子要点缩进不是 2 空格 → 报错；
// ⑨ 代码围栏内的内容不参与校验（归档文件可能整块引用原文）。
//
// 全离线：只用内存字符串，不读仓库文件、不联网。

import test from 'node:test'
import assert from 'node:assert/strict'

import { checkChangelog, MAX_MAIN_CHARS, KAC_SECTIONS } from '../scripts/check-changelog.mjs'

const LINKS = `[Unreleased]: https://example.test/compare/v0.3.0...HEAD
[0.3.0]: https://example.test/compare/v0.2.0...v0.3.0
[0.2.0]: https://example.test/releases/tag/v0.2.0
`

/** 拼一份 CHANGELOG：head 之后接 bodies（原样），最后加链接定义 */
function doc(...bodies) {
  return `# 更新日志\n\n## [Unreleased]\n\n${bodies.join('\n')}\n${LINKS}`
}

const V030 = `## [0.3.0] - 2026-11-11

### Added

- 新功能 A
`
const V020 = `## [0.2.0] - 2026-10-14

### Added

- 旧功能 B
  - 细节
`

const messages = (problems) => problems.map((p) => p.message).join('\n')

test('合规文件通过：空 [Unreleased] + 两个版本段 + 链接定义', () => {
  assert.deepEqual(checkChangelog(doc(V030, V020)), [])
})

test('[Unreleased] 缺失时报错', () => {
  const text = `# 更新日志\n\n${V030}\n${LINKS}`
  const problems = checkChangelog(text)
  assert.ok(problems.length > 0)
  assert.match(messages(problems), /第一个版本标题必须是 `\[Unreleased\]`/)
})

test('同一版本段内小节重复时报错（Added×2）', () => {
  const text = doc(
    `## [0.3.0] - 2026-11-11

### Added

- 第一条
- 第二条

### Added

- 第三条
`,
    V020,
  )
  assert.match(messages(checkChangelog(text)), /小节重复：`Added`/)
})

test('小节顺序违反 Keep a Changelog 时报错（Fixed 后再 Added）', () => {
  const text = doc(
    `## [0.3.0] - 2026-11-11

### Fixed

- 修了一处

### Added

- 加了一处
`,
    V020,
  )
  assert.match(messages(checkChangelog(text)), /小节顺序不符合 Keep a Changelog：`Added`/)
})

test('空小节报错', () => {
  const text = doc(
    `## [0.3.0] - 2026-11-11

### Added

- 有内容

### Security
`,
    V020,
  )
  assert.match(messages(checkChangelog(text)), /空小节：`### Security`/)
})

test('版本标题格式非法时报错', () => {
  const text = doc(`## 0.3.0 - 2026-11-11\n\n### Added\n\n- x\n`, V020)
  assert.match(messages(checkChangelog(text)), /版本标题格式非法/)
})

test('版本未按降序排列时报错', () => {
  const text = `# 更新日志\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-14\n\n### Added\n\n- 旧\n\n## [0.3.0] - 2026-11-11\n\n### Added\n\n- 新\n${LINKS}`
  assert.match(messages(checkChangelog(text)), /版本未按降序排列/)
})

test('缺少链接定义时报错', () => {
  const text = doc(V030, V020).replace(/\[0\.3\.0\]: .*\n/, '')
  assert.match(messages(checkChangelog(text)), /缺少链接定义：`\[0\.3\.0\]:/)
})

test('质量档：最新段主句超长报错，旧段超长不报', () => {
  const long = '一'.repeat(MAX_MAIN_CHARS + 1)
  const bad = doc(`## [0.3.0] - 2026-11-11\n\n### Added\n\n- ${long}\n`, V020)
  assert.match(messages(checkChangelog(bad)), /超过 120 上限/)

  const oldOnly = doc(V030, `## [0.2.0] - 2026-10-14\n\n### Added\n\n- ${long}\n`)
  assert.deepEqual(checkChangelog(oldOnly), [], '历史段不追溯长度')
})

test('质量档：过程词在最新段报错，在旧段不报', () => {
  const bad = doc(`## [0.3.0] - 2026-11-11\n\n### Changed\n\n- 本项经分支合入，合并方式见 PR\n`, V020)
  assert.match(messages(checkChangelog(bad)), /过程性表述「合并方式」/)

  const oldOnly = doc(V030, `## [0.2.0] - 2026-10-14\n\n### Changed\n\n- 直推 main（历史记录）\n`)
  assert.deepEqual(checkChangelog(oldOnly), [], '历史段不追溯过程词')
})

test('子要点缩进必须正好 2 个空格', () => {
  const text = doc(
    `## [0.3.0] - 2026-11-11

### Added

- 主句
   - 缩进了 3 个空格
`,
    V020,
  )
  assert.match(messages(checkChangelog(text)), /子要点缩进必须正好 2 个空格/)
})

test('代码围栏内的伪标题不参与校验', () => {
  const text = doc(
    `## [0.3.0] - 2026-11-11

### Added

- 主句

\`\`\`markdown
### Added
### Added
- ${'长'.repeat(MAX_MAIN_CHARS + 50)}
\`\`\`
`,
    V020,
  )
  assert.deepEqual(checkChangelog(text), [])
})

test('KAC 六类顺序与白名单仍是 Keep a Changelog 的定义', () => {
  assert.deepEqual(KAC_SECTIONS, ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'])
})
