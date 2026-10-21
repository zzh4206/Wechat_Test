// render.js —— 把服务端的正文块结构搭成 DOM（R4：只用 createElement + textContent）。
// 本目录禁止 innerHTML / outerHTML / insertAdjacentHTML / document.write（web-boundary 哨兵钉死）。

/** 轻量 DOM 构造：字符串子节点一律走 textContent 语义（createTextNode） */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

/** 替换子节点；与 h() 同样跳过 null/undefined/false（原生 replaceChildren 会把 null 渲染成文字「null」） */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter(c => c !== undefined && c !== null && c !== false))
}

const SAFE_HREF_RE = /^(https?:\/\/|mailto:)/i

function inline(spans) {
  return spans.map((s) => {
    switch (s.t) {
      case 'strong': return h('strong', {}, s.v)
      case 'em': return h('em', {}, s.v)
      case 'code': return h('code', {}, s.v)
      case 'link':
        // 服务端已过滤；前端再查一遍协议（纵深防御），外链不带 Referer、不给 opener
        return SAFE_HREF_RE.test(s.href)
          ? h('a', { href: s.href, rel: 'noopener noreferrer', target: '_blank' }, s.v)
          : document.createTextNode(s.v)
      default: return document.createTextNode(s.v)
    }
  })
}

/** 块数组 → DocumentFragment */
export function renderBlocks(blocks) {
  const frag = document.createDocumentFragment()
  let list = null
  for (const b of blocks) {
    if (b.t !== 'li') list = null
    switch (b.t) {
      case 'h': frag.append(h(`h${Math.min(Math.max(b.level, 1), 6)}`, {}, inline(b.inl))); break
      case 'p': frag.append(h('p', {}, inline(b.inl))); break
      case 'quote': frag.append(h('blockquote', {}, inline(b.inl))); break
      case 'code': frag.append(h('pre', {}, h('code', {}, b.v))); break
      case 'hr': frag.append(h('hr')); break
      case 'li': {
        const tag = b.ordered ? 'ol' : 'ul'
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = h(tag)
          frag.append(list)
        }
        list.append(h('li', { class: `depth-${b.depth}` }, inline(b.inl)))
        break
      }
      case 'table':
        frag.append(h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, b.head.map(c => h('th', {}, inline(c))))),
          h('tbody', {}, b.rows.map(r => h('tr', {}, r.map(c => h('td', {}, inline(c)))))))))
        break
      default: break
    }
  }
  return frag
}
