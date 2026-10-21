#!/usr/bin/env node
/**
 * bench-quality.mjs —— 植入真值（planted ground truth）质量评测。
 *
 * 合成流里预先埋好话题（manifest.topics）、任务（manifest.tasks）与引用
 * （manifest.quotes）。本脚本解析一份真实 LLM 产出的报告 Markdown，度量报告对
 * 这些埋点的召回，以及是否编造了原文里不存在的引用：
 * - 话题召回：manifest.topics[].title 的关键词命中报告「关键判断 / 话题」区；
 * - 任务召回：manifest.tasks[].statement 的关键词命中比例；
 * - 引用召回：manifest.quotes 的引用文本是否出现在报告「原文引用」区（精确子串，
 *   报告侧引用被截断到 50 字，故按子串匹配）；
 * - 编造引用：报告引用区的文本是否能在源文本（--stream 消息 / manifest 引用 /
 *   manifest.messages）里逐字找到。
 *
 * 用法：
 *   node scripts/bench-quality.mjs --report <report.md> --manifest <manifest.json>
 *                                  [--stream <stream.jsonl>] [--json]
 *
 * 说明：
 * - 该脚本需要真实 LLM 产出的报告，**不进入离线 CI**；离线测试只测解析/召回算法
 *   （tests/bench-harness.test.mjs 用构造的 md + manifest）；
 * - 未提供 --stream 且 manifest 里也没有源文本时，引用无法逐字核验：输出
 *   `details.quoteVerifiable=false`，不把报告引用误判为编造；
 * - 退出码：PASS=0，FAIL=1（误用/文件缺失=2）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 召回阈值（方法论 §2：植入真值召回 ≥80% 且不编造） */
export const RECALL_MIN = 0.8
export const HALLUCINATION_MAX = 0

/** 中文虚词/套话二元组：参与关键词匹配会把召回虚高，先剔除 */
const STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '这样', '那样',
  '一下', '一些', '一个', '两个', '就是', '不是', '可以', '因为', '所以', '如果',
  '但是', '然后', '现在', '今天', '明天', '已经', '正在', '需要', '应该', '可能',
  '还是', '什么', '怎么', '没有', '以及', '或者', '而且', '不过', '虽然', '由于',
  '关于', '对于', '通过', '进行', '出现', '目前', '相关', '问题', '情况', '内容',
  '方面', '时候', '这里', '那里', '其中', '之后', '之前', '同时', '一下', '一直',
])

function isCjk(ch) {
  return /[\u4e00-\u9fff]/.test(ch)
}

/** 规范化：小写、标点转空格、折叠空白（保留空格供英文词切分） */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]{}<>《》…—\-–·|/\\~`]+/g, ' ')
    .trim()
}

/** 紧凑化：去掉全部空白（中文二元组/整句中文字串匹配用） */
export function compactText(value) {
  return normalizeText(value).replace(/\s+/g, '')
}

/** 关键词集：中文相邻二元组（去虚词）+ 英文/数字词（≥2 字符） */
export function keywordsOf(value) {
  const compact = compactText(value)
  const set = new Set()
  for (let i = 0; i + 1 < compact.length; i++) {
    const a = compact[i]
    const b = compact[i + 1]
    if (isCjk(a) && isCjk(b)) {
      const gram = a + b
      if (!STOP_BIGRAMS.has(gram)) set.add(gram)
    }
  }
  for (const token of normalizeText(value).split(/[^a-z0-9_]+/)) {
    if (token.length >= 2) set.add(token)
  }
  return [...set]
}

/**
 * 埋点文本是否被报告语料命中。
 * - 整句（紧凑化后）是报告语料的子串 → 直接命中；
 * - 否则按关键词覆盖：≤2 个关键词时命中任意一个即可；否则要求 ≥2 个命中且
 *   覆盖率 ≥0.3（或命中 ≥4 个，容忍长句的改写）。
 */
export function hitText(target, corpus) {
  const targetCompact = compactText(target)
  const corpusCompact = compactText(corpus)
  if (targetCompact === '') return { hit: false, mode: 'empty', matched: [], keywords: [], ratio: 0 }
  if (corpusCompact.includes(targetCompact)) {
    return { hit: true, mode: 'exact', matched: [targetCompact], keywords: [targetCompact], ratio: 1 }
  }
  const keywords = keywordsOf(target)
  const matched = keywords.filter((k) => corpusCompact.includes(k))
  const ratio = keywords.length === 0 ? 0 : matched.length / keywords.length
  const hit =
    keywords.length === 0
      ? false
      : keywords.length <= 2
        ? matched.length >= 1
        : matched.length >= 2 && (ratio >= 0.3 || matched.length >= 4)
  return { hit, mode: 'keywords', matched, keywords, ratio: Math.round(ratio * 1000) / 1000 }
}

/**
 * 解析 renderReport 产出的报告 Markdown：
 * - 关键判断：L1 下 `N. 文本 [evidence: m1, m2]`；
 * - 话题：L2 下 `### 话题 N：标题`（保留该话题的正文行用于召回语料）；
 * - 引用：L3「原文引用」下 `N. [msgId] ... 「原文」`。
 * 对 degraded/empty 骨架安全（无对应内容时返回空数组）。
 */
export function parseReportMd(markdown) {
  const text = String(markdown ?? '')
  const out = {
    kind: null,
    chatId: null,
    dateKey: null,
    title: '',
    lead: '',
    judgments: [],
    topics: [],
    quotes: [],
  }
  let section = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const head = /^#\s+(日报|周报|月报)\s*·\s*(\S+)\s*·\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(line)
    if (head) {
      out.kind = head[1]
      out.chatId = head[2]
      out.dateKey = head[3]
      continue
    }
    if (line.startsWith('## ')) {
      section = null
      continue
    }
    if (line.startsWith('### ')) {
      if (line.includes('关键判断')) {
        section = 'judgments'
      } else if (line.includes('原文引用')) {
        section = 'quotes'
      } else if (/^###\s+话题\s+\d+\s*[：:]/.test(line)) {
        section = 'topics'
        const m = /^###\s+话题\s+\d+\s*[：:]\s*(.*)$/.exec(line)
        if (m && m[1].trim() !== '') out.topics.push({ title: m[1].trim(), body: [] })
      } else {
        section = null
      }
      continue
    }
    if (section === 'judgments') {
      const m = /^\d+\.\s+(.*?)\s*\[evidence:\s*([^\]]*)\]\s*$/.exec(line)
      if (m) {
        out.judgments.push({
          text: m[1].trim(),
          evidence: m[2].split(',').map((s) => s.trim()).filter(Boolean),
        })
      }
    } else if (section === 'topics') {
      if (out.topics.length > 0) out.topics[out.topics.length - 1].body.push(line)
    } else if (section === 'quotes') {
      // `N. [msgId] 2026-10-20 09:00 成员（群）：「原文」`
      const m = /^\d+\.\s+\[([^\]]+)\]\s+(.*?)「(.*)」\s*$/.exec(line)
      if (m) out.quotes.push({ msgId: m[1].trim(), context: m[2].trim(), text: m[3] })
    }
  }
  const lead = /^\*\*(.+?)[:：]\*\*\s*(.*)$/m.exec(text)
  if (lead) {
    out.title = lead[1].trim()
    out.lead = lead[2].trim()
  }
  return out
}

function readMessageText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return ''
}

/**
 * 解析 manifest 里一条引用对应的原文：
 * 优先显式 text/sample/quote/content；否则用 pair 序号回查 manifest.messages
 * 或 stream（同时容忍 0 基/1 基序号）。
 */
export function resolveQuoteText(quote, manifest, stream = null) {
  if (typeof quote === 'string') return quote
  if (!quote || typeof quote !== 'object') return ''
  for (const key of ['text', 'sample', 'quote', 'content']) {
    if (typeof quote[key] === 'string' && quote[key].trim() !== '') return quote[key]
  }
  const pair = Array.isArray(quote.pair) ? quote.pair : null
  if (pair !== null && pair.length > 0) {
    const idx = Number(pair[0])
    const sources = [Array.isArray(manifest?.messages) ? manifest.messages : null, stream].filter(Boolean)
    if (Number.isInteger(idx)) {
      for (const arr of sources) {
        for (const i of [idx, idx - 1]) {
          if (i >= 0 && i < arr.length) {
            const t = readMessageText(arr[i])
            if (t.trim() !== '') return t
          }
        }
      }
    }
  }
  return ''
}

/** 报告语料：标题/导语/关键判断/话题标题与正文（不含引用区，避免引用自证） */
function reportCorpus(report) {
  const parts = [report.title, report.lead]
  for (const j of report.judgments) parts.push(j.text)
  for (const t of report.topics) {
    parts.push(t.title)
    parts.push(...(t.body ?? []))
  }
  return parts.filter((s) => typeof s === 'string' && s.trim() !== '').join('\n')
}

/** 可逐字核验的源文本集合 */
function sourceTexts(manifest, stream) {
  const out = []
  if (Array.isArray(stream)) {
    for (const m of stream) {
      const t = readMessageText(m)
      if (t !== '') out.push(t)
    }
  }
  if (Array.isArray(manifest?.messages)) {
    for (const m of manifest.messages) {
      const t = readMessageText(m)
      if (t !== '') out.push(t)
    }
  }
  for (const q of Array.isArray(manifest?.quotes) ? manifest.quotes : []) {
    const t = resolveQuoteText(q, manifest, stream)
    if (t.trim() !== '') out.push(t)
  }
  return out
}

/**
 * 纯函数评测入口（测试直接调用，不读文件）。
 * @param {{reportMd:string, manifest:object, stream?:Array}} input
 */
export function evaluateQuality({ reportMd, manifest, stream = null }) {
  const report = parseReportMd(reportMd)
  const corpus = reportCorpus(report)
  const topics = Array.isArray(manifest?.topics) ? manifest.topics : []
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : []
  const quotes = Array.isArray(manifest?.quotes) ? manifest.quotes : []

  const topicDetails = topics.map((t) => {
    const title = typeof t?.title === 'string' ? t.title : ''
    const h = hitText(title, corpus)
    return { id: t?.id ?? null, title, hit: h.hit, mode: h.mode, matched: h.matched, ratio: h.ratio }
  })
  const taskDetails = tasks.map((t) => {
    const statement = typeof t?.statement === 'string' ? t.statement : ''
    const h = hitText(statement, corpus)
    return { id: t?.id ?? null, statement, hit: h.hit, mode: h.mode, matched: h.matched, ratio: h.ratio }
  })

  const reportQuotes = report.quotes.map((q) => ({ ...q, compact: compactText(q.text) }))
  const quoteDetails = quotes.map((q, i) => {
    const resolved = resolveQuoteText(q, manifest, stream)
    const target = compactText(resolved)
    const hit = target !== ''
      ? reportQuotes.some((rq) => rq.compact !== '' && target.includes(rq.compact))
      : false
    return { index: i, text: resolved, hit, unresolved: target === '' }
  })

  // 逐字核验需要「消息级」源文本：--stream 或 manifest.messages。
  // 只有 manifest.quotes[].text 时不足以判断报告里的兜底引用是否编造（会误伤），
  // 此时关闭编造判据并在输出里显式标注 quoteVerifiable=false。
  const hasMessageSources =
    (Array.isArray(stream) && stream.length > 0) ||
    (Array.isArray(manifest?.messages) && manifest.messages.length > 0)
  const sources = sourceTexts(manifest, stream)
  const quoteVerifiable = hasMessageSources && sources.length > 0
  const sourceCompacts = sources.map((s) => compactText(s)).filter((s) => s !== '')
  const hallucinatedQuotes = []
  if (quoteVerifiable) {
    for (const rq of reportQuotes) {
      if (rq.compact === '') continue
      const found = sourceCompacts.some((s) => s.includes(rq.compact))
      if (!found) hallucinatedQuotes.push({ msgId: rq.msgId, text: rq.text })
    }
  }

  const ratio = (hitCount, total) => (total === 0 ? 1 : Math.round((hitCount / total) * 1000) / 1000)
  const topicRecall = ratio(topicDetails.filter((t) => t.hit).length, topicDetails.length)
  const taskRecall = ratio(taskDetails.filter((t) => t.hit).length, taskDetails.length)
  const quoteRecall = ratio(quoteDetails.filter((q) => q.hit).length, quoteDetails.length)

  const pass = {
    topicRecall: topicRecall >= RECALL_MIN - 1e-9,
    taskRecall: taskRecall >= RECALL_MIN - 1e-9,
    quoteRecall: quoteRecall >= RECALL_MIN - 1e-9,
    hallucinated: hallucinatedQuotes.length <= HALLUCINATION_MAX,
  }

  return {
    topicRecall,
    taskRecall,
    quoteRecall,
    hallucinatedQuotes,
    pass,
    overall: Object.values(pass).every(Boolean) ? 'PASS' : 'FAIL',
    thresholds: { recallMin: RECALL_MIN, hallucinatedMax: HALLUCINATION_MAX },
    counts: {
      topics: { hit: topicDetails.filter((t) => t.hit).length, total: topicDetails.length },
      tasks: { hit: taskDetails.filter((t) => t.hit).length, total: taskDetails.length },
      quotes: { hit: quoteDetails.filter((q) => q.hit).length, total: quoteDetails.length },
      reportQuotes: reportQuotes.length,
      hallucinated: hallucinatedQuotes.length,
      verifiableSources: sourceCompacts.length,
    },
    details: {
      topics: topicDetails,
      tasks: taskDetails,
      quotes: quoteDetails,
      quoteVerifiable,
      unresolvedQuotes: quoteDetails.filter((q) => q.unresolved).length,
      report,
    },
  }
}

// —————————————————— CLI ——————————————————

function usage() {
  return [
    '用法: node scripts/bench-quality.mjs --report <report.md> --manifest <manifest.json> [--stream <stream.jsonl>] [--json]',
    '',
    '  --report    报告 Markdown（renderReport 格式）',
    '  --manifest  合成清单（topics[].title / tasks[].statement / quotes[].pair 或 text）',
    '  --stream    可选：合成消息流（校验引用是否逐字存在于原文）',
    '  --json      只输出机器可读 JSON',
  ].join('\n')
}

function parseArgs(argv) {
  const out = { report: null, manifest: null, stream: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--report' || arg === '--manifest' || arg === '--stream') {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} 需要一个文件路径`)
      out[arg.slice(2)] = value
    } else if (arg === '--json') {
      out.json = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return out
}

function readJsonl(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
  return lines.map((line, i) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`stream 第 ${i + 1} 行不是合法 JSON: ${error.message}`)
    }
  })
}

function printHuman(result, reportPath) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`
  const c = result.counts
  const row = (label, value, detail, ok) =>
    console.log(`${label}  ${value.padStart(7)}  (${detail})  ${ok ? 'PASS' : 'FAIL'}`)
  console.log('植入真值质量评测')
  console.log(`报告: ${reportPath}`)
  console.log('')
  row('话题召回', pct(result.topicRecall), `${c.topics.hit}/${c.topics.total}`, result.pass.topicRecall)
  row('任务召回', pct(result.taskRecall), `${c.tasks.hit}/${c.tasks.total}`, result.pass.taskRecall)
  row('引用召回', pct(result.quoteRecall), `${c.quotes.hit}/${c.quotes.total}`, result.pass.quoteRecall)
  row('编造引用', String(c.hallucinated), `报告引用 ${c.reportQuotes} 条`, result.pass.hallucinated)
  if (!result.details.quoteVerifiable) {
    console.log('  ⚠ 未提供 --stream 且 manifest 无源文本：编造引用判据未启用（quoteVerifiable=false）')
  }
  if (result.details.unresolvedQuotes > 0) {
    console.log(`  ⚠ ${result.details.unresolvedQuotes} 条 manifest 引用无法解析出原文（metadata 缺 text 且 pair 越界）`)
  }
  for (const h of result.hallucinatedQuotes) {
    console.log(`  - 编造: [${h.msgId}] ${h.text}`)
  }
  console.log('')
  console.log(`总判定: ${result.overall}`)
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error.message))
    console.error(usage())
    process.exit(2)
  }
  if (args.report === null || args.manifest === null) {
    console.error('缺少 --report 或 --manifest')
    console.error(usage())
    process.exit(2)
  }
  let manifest
  let reportMd
  let stream = null
  try {
    manifest = JSON.parse(readFileSync(resolve(args.manifest), 'utf8'))
    reportMd = readFileSync(resolve(args.report), 'utf8')
    if (args.stream !== null) stream = readJsonl(resolve(args.stream))
  } catch (error) {
    console.error(`文件读取失败: ${error.message}`)
    process.exit(2)
  }
  const result = evaluateQuality({ reportMd, manifest, stream })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else printHuman(result, args.report)
  process.exit(result.overall === 'PASS' ? 0 : 1)
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entry !== null && import.meta.url === entry) main()
