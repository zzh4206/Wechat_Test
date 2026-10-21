// app.js —— FE-1 只读回溯页面：报告日历/详情、资料库、媒体、会话要点、人员关注。
// 数据只经 /api/*（同源相对路径）取得；正文块交给 render.js 用 textContent 搭 DOM。
import { h, renderBlocks } from './render.js'

const TOKEN_KEY = 'lurker-web-token'
const PERIOD_LABEL = { daily: '日', weekly: '周', monthly: '月' }
const PERIOD_NAME = { daily: '日报', weekly: '周报', monthly: '月报' }
const AGGREGATE = 'aggregate'

// —— token：首次从 #token= 读入 sessionStorage 后立即从地址栏抹掉 ——
function readToken() {
  const m = /^#token=(.+)$/.exec(location.hash)
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1])) } catch { /* 隐私模式：只在内存里用 */ }
    history.replaceState(null, '', location.pathname)
    return decodeURIComponent(m[1])
  }
  try { return sessionStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' }
}

const state = { token: readToken(), chats: [], chat: '', tab: 'reports', month: '', period: '' }

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
  const res = await fetch(`/api/${path}${qs.size ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${state.token}` } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error')
  return body
}

const ERROR_TEXT = {
  unauthorized: 'token 无效或缺失：请用服务启动时打印的地址（带 #token=）重新打开。',
  no_allowlist: '插件尚未写入白名单（web/allowed-chats.json）：先启动一次插件。',
  knowledge_db_unavailable: 'knowledge.db 不可用（sqlitePath 为 off 或文件不存在）：回溯功能暂不可用。',
  chat_not_allowed: '该群不在白名单内。',
  not_found: '没有找到。',
}

const view = () => document.getElementById('view')

function showError(err, into = view()) {
  into.replaceChildren(h('p', { class: 'error' }, ERROR_TEXT[err.code] ?? `出错了（${err.code ?? err.message}）`))
}

// 插件写毫秒、0数据格式的 Python CLI 写秒：小于 1e12 的按秒处理
const fmtTime = (t) => (t ? new Date(t < 1e12 ? t * 1000 : t).toLocaleString('zh-CN', { hour12: false }) : '')
const chatLabel = (id) => (id === AGGREGATE ? '跨群聚合' : id)
const today = () => new Date().toISOString().slice(0, 10)

// —— 顶栏 ——

const TABS = [
  ['reports', '报告'],
  ['docs', '资料'],
  ['media', '媒体'],
  ['digests', '会话要点'],
  ['persons', '人员关注'],
]

function renderTabs() {
  document.getElementById('tabs').replaceChildren(...TABS.map(([key, label]) =>
    h('button', { type: 'button', class: key === state.tab ? 'tab active' : 'tab', 'aria-pressed': String(key === state.tab), onclick: () => { state.tab = key; renderTabs(); load() } }, label)))
}

function renderChatPicker() {
  const sel = document.getElementById('chat')
  sel.replaceChildren(...state.chats.map(c => h('option', { value: c.chatId, selected: c.chatId === state.chat }, chatLabel(c.chatId))))
  sel.onchange = () => { state.chat = sel.value; state.month = ''; load() }
}

// —— 报告：月历 + 当月列表 + 详情 ——

function monthOf(dateStr) { return dateStr.slice(0, 7) }
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return d.toISOString().slice(0, 7)
}

async function loadReports() {
  const chat = state.chats.find(c => c.chatId === state.chat)
  if (!state.month) state.month = monthOf(chat?.latestReport ?? today())
  const [y, m] = state.month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const [cal, list] = await Promise.all([
    api('calendar', { chat: state.chat, month: state.month }),
    api('reports', { chat: state.chat, from: `${state.month}-01`, to: `${state.month}-${String(lastDay).padStart(2, '0')}`, period: state.period }),
  ])
  const detail = h('section', { class: 'detail' }, h('p', { class: 'muted' }, '在日历或列表中选一期报告。'))

  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay() // 0=周日
  const lead = (first + 6) % 7 // 周一起
  const cells = []
  for (let i = 0; i < lead; i++) cells.push(h('div', { class: 'cell empty' }))
  for (let d = 1; d <= lastDay; d++) {
    const key = `${state.month}-${String(d).padStart(2, '0')}`
    const items = cal.days[key] ?? []
    cells.push(h('div', { class: items.length ? 'cell has' : 'cell' },
      h('span', { class: 'day' }, String(d)),
      h('span', { class: 'badges' }, items.map(it =>
        h('button', { type: 'button', class: `badge ${it.periodType}`, title: PERIOD_NAME[it.periodType], onclick: () => openReport(it.id, detail) }, PERIOD_LABEL[it.periodType])))))
  }

  const periodSel = h('select', { onchange: (e) => { state.period = e.target.value; load() } },
    h('option', { value: '', selected: !state.period }, '全部周期'),
    ...Object.entries(PERIOD_NAME).map(([k, v]) => h('option', { value: k, selected: state.period === k }, v)))

  view().replaceChildren(h('div', { class: 'split' },
    h('section', { class: 'side' },
      h('div', { class: 'month-nav' },
        h('button', { type: 'button', onclick: () => { state.month = shiftMonth(state.month, -1); load() } }, '‹'),
        h('strong', {}, state.month),
        h('button', { type: 'button', onclick: () => { state.month = shiftMonth(state.month, 1); load() } }, '›')),
      h('div', { class: 'calendar' }, ['一', '二', '三', '四', '五', '六', '日'].map(w => h('div', { class: 'wd' }, w)), cells),
      h('div', { class: 'list-head' }, h('span', {}, `本月 ${list.length} 期`), periodSel),
      h('ul', { class: 'list' }, list.map(r => h('li', {},
        h('button', { type: 'button', class: 'row', onclick: () => openReport(r.id, detail) },
          h('span', { class: `badge ${r.periodType}` }, PERIOD_LABEL[r.periodType]),
          h('span', { class: 'grow' }, r.title),
          r.revisionCount ? h('span', { class: 'pill' }, `修订 ${r.revisionCount}`) : null,
          h('span', { class: `pill ${r.status}` }, r.status === 'final' ? '定稿' : '草稿')))))),
    detail))
  if (list[0]) openReport(list[0].id, detail)
}

async function openReport(id, into) {
  try {
    const r = await api(`reports/${id}`)
    into.replaceChildren(
      h('div', { class: 'detail-head' },
        h('button', { type: 'button', disabled: !r.prev, onclick: () => r.prev && openReport(r.prev.id, into) }, r.prev ? `‹ ${r.prev.periodStart}` : '‹'),
        h('div', { class: 'grow' },
          h('h2', {}, r.title),
          h('p', { class: 'muted' }, `${chatLabel(r.chatId)} · ${PERIOD_NAME[r.periodType]} ${r.periodStart}${r.periodEnd !== r.periodStart ? ` – ${r.periodEnd}` : ''} · ${r.status === 'final' ? '定稿' : '草稿'} · 更新于 ${fmtTime(r.updatedAt)}`)),
        h('button', { type: 'button', disabled: !r.next, onclick: () => r.next && openReport(r.next.id, into) }, r.next ? `${r.next.periodStart} ›` : '›')),
      h('article', { class: 'md' }, renderBlocks(r.blocks)),
      r.revisions.length
        ? h('section', { class: 'revisions' }, h('h3', {}, `修订历史（${r.revisions.length}）`),
          h('ul', {}, r.revisions.map(v => h('li', {}, `${fmtTime(v.ts)} · ${v.type} · ${v.summary ?? ''}（来源：${v.source === 'web' ? '前端' : '对话框'}）`))))
        : null)
  } catch (err) {
    showError(err, into)
  }
}

// —— 资料库 ——

async function loadDocs(filters = {}) {
  const data = await api('docs', filters)
  const detail = h('section', { class: 'detail' }, h('p', { class: 'muted' }, '选一份资料查看正文。'))
  const search = h('input', { type: 'search', placeholder: '标题搜索', value: filters.q ?? '' })
  const tagSel = h('select', {}, h('option', { value: '' }, '全部标签'), data.tags.map(t => h('option', { value: t, selected: filters.tag === t }, t)))
  const catSel = h('select', {}, h('option', { value: '' }, '全部分类'), data.categories.map(c => h('option', { value: c, selected: filters.category === c }, c)))
  const apply = () => loadDocs({ q: search.value.trim(), tag: tagSel.value, category: catSel.value }).catch(e => showError(e))
  search.addEventListener('keydown', e => { if (e.key === 'Enter') apply() })
  tagSel.onchange = apply
  catSel.onchange = apply
  view().replaceChildren(h('div', { class: 'split' },
    h('section', { class: 'side' },
      h('div', { class: 'filters' }, search, tagSel, catSel),
      h('ul', { class: 'list' }, data.docs.map(d => h('li', {},
        h('button', { type: 'button', class: 'row', onclick: () => openDoc(d.id, detail) },
          h('span', { class: 'grow' }, d.title),
          d.tags.map(t => h('span', { class: 'pill' }, t))))))),
    detail))
}

async function openDoc(id, into) {
  try {
    const d = await api(`docs/${id}`)
    into.replaceChildren(
      h('h2', {}, d.title),
      h('p', { class: 'muted' }, [d.category, d.sourceType, d.sourceRef, d.filePath ? `文件：${d.filePath}` : null].filter(Boolean).join(' · ')),
      h('article', { class: 'md' }, d.blocks.length ? renderBlocks(d.blocks) : h('p', { class: 'muted' }, '（无正文摘录）')))
  } catch (err) {
    showError(err, into)
  }
}

// —— 媒体清单 ——

const MEDIA_NAME = { image: '图片', video: '视频', file: '文件', voice: '语音' }
const STATUS_NAME = { available: '可用', pending: '待取', missing: '缺失' }

async function loadMedia(filters = {}) {
  const rows = await api('media', { chat: state.chat, ...filters })
  const typeSel = h('select', {}, h('option', { value: '' }, '全部类型'), Object.entries(MEDIA_NAME).map(([k, v]) => h('option', { value: k, selected: filters.type === k }, v)))
  const statusSel = h('select', {}, h('option', { value: '' }, '全部状态'), Object.entries(STATUS_NAME).map(([k, v]) => h('option', { value: k, selected: filters.status === k }, v)))
  const apply = () => loadMedia({ type: typeSel.value, status: statusSel.value }).catch(e => showError(e))
  typeSel.onchange = apply
  statusSel.onchange = apply
  view().replaceChildren(
    h('div', { class: 'filters' }, typeSel, statusSel, h('span', { class: 'muted' }, `${rows.length} 条（只列元数据，不提供下载）`)),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['时间', '类型', '文件名', '大小', '状态', '地址'].map(c => h('th', {}, c)))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', {}, fmtTime(r.sourceTs)),
        h('td', {}, MEDIA_NAME[r.mediaType] ?? r.mediaType),
        h('td', {}, r.fileName ?? ''),
        h('td', {}, r.size === null ? '' : `${Math.ceil(r.size / 1024)} KB`),
        h('td', {}, STATUS_NAME[r.status] ?? r.status),
        h('td', { class: 'mono' }, r.path ?? '')))))))
}

// —— 会话要点 ——

async function loadDigests(day = '') {
  const data = await api('digests', { day })
  const picker = h('input', { type: 'date', value: day, onchange: (e) => loadDigests(e.target.value).catch(err => showError(err)) })
  view().replaceChildren(
    h('div', { class: 'filters' }, picker, h('span', { class: 'muted' }, day ? `${data.digests.length} 条` : '最近的会话要点')),
    ...data.digests.map(d => h('section', { class: 'card' },
      h('h3', {}, d.chatTopic), h('p', { class: 'muted' }, d.happenedOn ?? ''),
      h('div', { class: 'md' }, renderBlocks(d.blocks)))))
}

// —— 人员关注 ——

const WATCH_NAME = { global: '全局关注', group: '本群关注', off: '未关注' }

async function loadPersons() {
  if (state.chat === AGGREGATE) {
    view().replaceChildren(h('p', { class: 'muted' }, '人员关注按群查看：请在右上角选择一个具体的群。'))
    return
  }
  const persons = await api('persons', { chat: state.chat })
  const detail = h('section', { class: 'detail' }, h('p', { class: 'muted' }, '选一位成员与日期。'))
  view().replaceChildren(h('div', { class: 'split' },
    h('section', { class: 'side' },
      persons.length ? null : h('p', { class: 'muted' }, '本群暂无关注成员或个人摘要。'),
      ...persons.map(p => h('div', { class: 'card' },
        h('strong', {}, p.remark || p.groupNick || p.pid), ' ',
        h('span', { class: 'pill' }, WATCH_NAME[p.watchLevel] ?? p.watchLevel),
        h('div', { class: 'days' }, p.days.length
          ? p.days.map(day => h('button', { type: 'button', class: 'chip', onclick: () => openPersonDigest(p, day, detail) }, day))
          : h('span', { class: 'muted' }, '暂无摘要'))))),
    detail))
}

async function openPersonDigest(p, day, into) {
  try {
    const d = await api(`persons/${encodeURIComponent(p.pid)}/digests`, { chat: state.chat, day })
    into.replaceChildren(h('h2', {}, `${p.remark || p.groupNick || p.pid} · ${day}`), h('article', { class: 'md' }, renderBlocks(d.blocks)))
  } catch (err) {
    showError(err, into)
  }
}

// —— 入口 ——

const LOADERS = { reports: loadReports, docs: () => loadDocs(), media: () => loadMedia(), digests: () => loadDigests(), persons: loadPersons }

async function load() {
  view().replaceChildren(h('p', { class: 'muted' }, '加载中…'))
  try {
    await LOADERS[state.tab]()
  } catch (err) {
    showError(err)
  }
}

async function boot() {
  renderTabs()
  try {
    const data = await api('chats')
    state.chats = data.chats
    state.chat = data.chats.find(c => c.latestReport)?.chatId ?? data.chats[0]?.chatId ?? ''
    renderChatPicker()
    await load()
  } catch (err) {
    showError(err)
  }
}

boot()
