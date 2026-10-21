// markdown.mjs —— 报告/资料正文的安全渲染（前端设计 §6.1 R4）。
//
// 正文是 LLM 生成 + 消息摘录，一律当数据：这里**不产出 HTML 字符串**，只把 Markdown
// 子集解析成 JSON 块结构，前端用 createElement + textContent 逐节点搭 DOM——
// 整条链路没有任何地方把正文当标记解析，XSS 载荷原样显示为文字。
//
// 支持的子集：标题、段落、无序/有序列表（缩进层级）、引用、围栏代码、分隔线、管道表格；
// 行内：`代码`、**粗体**、*斜体*、[文字](链接)。链接只放行 http/https/mailto，
// 其余（javascript:、data:、相对路径……）降级为纯文字。

const SAFE_HREF_RE = /^(https?:\/\/|mailto:)/i

/** 链接地址是否可放行 */
export function safeHref(href) {
  const h = String(href).trim()
  return SAFE_HREF_RE.test(h) && !/[\u0000-\u001f\s]/.test(h) ? h : null
}

/** 行内解析：返回 [{t:'text'|'strong'|'em'|'code'|'link', v, href?}] */
export function parseInline(text) {
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush(); out.push({ t: 'code', v: m[1] }); i += m[0].length; continue
    }
    if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) {
      flush(); out.push({ t: 'strong', v: m[1] }); i += m[0].length; continue
    }
    if ((m = /^\*([^*\s][^*]*)\*/.exec(rest))) {
      flush(); out.push({ t: 'em', v: m[1] }); i += m[0].length; continue
    }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush()
      const href = safeHref(m[2])
      out.push(href ? { t: 'link', v: m[1], href } : { t: 'text', v: m[0] })
      i += m[0].length
      continue
    }
    buf += text[i]
    i++
  }
  flush()
  return out
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => parseInline(c.trim()))

/** 块级解析：返回 [{t:'h',level,inl} | {t:'p',inl} | {t:'li',ordered,depth,inl} | {t:'quote',inl} | {t:'code',v} | {t:'hr'} | {t:'table',head,rows}] */
export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = []
  const flushPara = () => {
    if (para.length) { blocks.push({ t: 'p', inl: parseInline(para.join(' ')) }); para = [] }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m
    if (/^\s*```/.test(line)) {
      flushPara()
      const code = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      blocks.push({ t: 'code', v: code.join('\n') })
      continue
    }
    if (!line.trim()) { flushPara(); continue }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara(); blocks.push({ t: 'h', level: m[1].length, inl: parseInline(m[2].trim()) }); continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); blocks.push({ t: 'hr' }); continue }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara()
      blocks.push({ t: 'li', ordered: /\d/.test(m[2]), depth: Math.min(Math.floor(m[1].length / 2), 4), inl: parseInline(m[3]) })
      continue
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flushPara(); blocks.push({ t: 'quote', inl: parseInline(m[1]) }); continue }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flushPara()
      const head = splitRow(line)
      const rows = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]))
      i--
      blocks.push({ t: 'table', head, rows })
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  return blocks
}
