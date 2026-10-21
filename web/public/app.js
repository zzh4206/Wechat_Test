// app.js —— FE-1 只读回溯（报告日历/详情、资料库、媒体、会话要点、人员关注）+ FE-2 审批收件箱。
// 数据只经 /api/*（同源相对路径）取得；正文块交给 render.js 用 textContent 搭 DOM。
// 审批提交 = POST /api/actions 追加一行，插件轮询执行后写回执；页面轮询回执展示「已提交 → 已生效/失败」。
import { fill, h, renderBlocks } from './render.js'

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

const state = { token: readToken(), chats: [], chat: '', tab: 'reports', month: '', period: '', actions: { enabled: false, reason: null } }

class ApiError extends Error {
  constructor(status, code, reason) { super(code); this.status = status; this.code = code; this.reason = reason }
}

async function api(path, params = {}, post = undefined) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
  const init = { headers: { Authorization: `Bearer ${state.token}` } }
  if (post !== undefined) {
    init.method = 'POST'
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(post)
  }
  const res = await fetch(`/api/${path}${qs.size ? `?${qs}` : ''}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.reason)
  return body
}

const ERROR_TEXT = {
  unauthorized: 'token 无效或缺失：请用服务启动时打印的地址（带 #token=）重新打开。',
  no_allowlist: '插件尚未写入白名单（web/allowed-chats.json）：先启动一次插件。',
  knowledge_db_unavailable: 'knowledge.db 不可用（sqlitePath 为 off 或文件不存在）：回溯功能暂不可用。',
  chat_not_allowed: '该群不在白名单内。',
  not_found: '没有找到。',
  actions_disabled: '审批动作不可用。',
}

// 插件回执码（RUNBOOK §13.2）→ 页面文案
const RESULT_TEXT = {
  ok: '已生效',
  duplicate: '重复提交，已忽略',
  not_found: '目标不存在',
  status_conflict: '状态已变化（可能已在别处处理），刷新看看',
  chat_not_allowed: '该群不在插件白名单内',
  type_not_allowed: '插件不支持该动作',
  unsupported: '插件未接通该动作',
  bad_request: '参数不合法',
  operator_mismatch: '插件拒绝：提交方 token 与插件 webActionsToken 不一致',
  error: '插件执行出错，查看插件日志',
}

const ACTIONS_OFF_TEXT = {
  no_shared_token: '只读模式：web 进程未用 LURKER_WEB_TOKEN 启动，审批动作不可用（见 RUNBOOK §14）。',
  inbox_disabled: '只读模式：插件未开启前端收件箱（webActionsEnabled=false 或依赖缺失），审批动作不可用。',
  plugin_token_unset: '只读模式：插件未配置 webActionsToken，审计无法对应到操作者，审批动作不可用（见 RUNBOOK §14.2）。',
  token_mismatch: '只读模式：web 进程的 LURKER_WEB_TOKEN 与插件 webActionsToken 不一致，审批动作不可用（见 RUNBOOK §14.2）。',
}

const view = () => document.getElementById('view')

function showError(err, into = view()) {
  fill(into, h('p', { class: 'error' }, ERROR_TEXT[err.code] ?? `出错了（${err.code ?? err.message}）`))
}

// 插件写毫秒、0数据格式的 Python CLI 写秒：小于 1e12 的按秒处理
const fmtTime = (t) => (t ? new Date(t < 1e12 ? t * 1000 : t).toLocaleString('zh-CN', { hour12: false }) : '')
const chatLabel = (id) => (id === AGGREGATE ? '跨群聚合' : id)
const today = () => new Date().toISOString().slice(0, 10)

// —— 顶栏 ——

const TABS = [
  ['reports', '报告'],
  ['inbox', '审批'],
  ['docs', '资料'],
  ['media', '媒体'],
  ['digests', '会话要点'],
  ['persons', '人员关注'],
]

function renderTabs() {
  fill(document.getElementById('tabs'), ...TABS.map(([key, label]) =>
    h('button', { type: 'button', class: key === state.tab ? 'tab active' : 'tab', 'aria-pressed': String(key === state.tab), onclick: () => { state.tab = key; renderTabs(); load() } }, label)))
}

function renderChatPicker() {
  const sel = document.getElementById('chat')
  fill(sel, ...state.chats.map(c => h('option', { value: c.chatId, selected: c.chatId === state.chat }, chatLabel(c.chatId))))
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

  fill(view(), h('div', { class: 'split' },
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
    fill(into, 
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

// —— 审批收件箱（FE-2） ——

const KIND_NAME = { task: '任务', promise: '承诺', event: '事件' }
const RESULT_POLL_MS = 2000
const RESULT_WAIT_MS = 60000

const sleep = (ms) => new Promise(ok => setTimeout(ok, ms))

/**
 * 提交一条动作并等回执：status 元素依次显示「已提交…」→ 结果。
 * 插件按 webActionsPollSec（默认 5s）轮询，超过 60s 没回执多半是插件没在跑。
 */
async function submitAction(action, statusEl, buttons) {
  for (const b of buttons) b.disabled = true
  statusEl.className = 'status'
  statusEl.textContent = '已提交，等待插件处理…'
  try {
    const { actionId } = await api('actions', {}, action)
    const deadline = Date.now() + RESULT_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(RESULT_POLL_MS)
      const r = await api(`actions/${actionId}`)
      if (r.status === 'done') {
        statusEl.className = r.ok ? 'status ok' : 'status error'
        statusEl.textContent = RESULT_TEXT[r.code] ?? r.code
        if (!r.ok) for (const b of buttons) b.disabled = false
        return r.ok
      }
    }
    statusEl.className = 'status error'
    statusEl.textContent = '60 秒内插件未处理：确认插件在运行且 webActionsEnabled=true。动作已入队，插件恢复后仍会执行。'
  } catch (err) {
    statusEl.className = 'status error'
    statusEl.textContent = err.code === 'actions_disabled' ? (ACTIONS_OFF_TEXT[err.reason] ?? ERROR_TEXT.actions_disabled) : `提交失败（${err.reason ?? err.code}）`
    for (const b of buttons) b.disabled = false
  }
  return false
}

function deadlineText(it) {
  if (!it.deadline) return null
  return `时限 ${fmtTime(it.deadline)}${it.deadlineConfidence < 1 ? `（识别置信度 ${Math.round(it.deadlineConfidence * 100)}%）` : '（人工指定）'}`
}

/** datetime-local 的值（本地时区）→ 毫秒 */
const localInputToMs = (v) => (v ? new Date(v).getTime() : NaN)
const msToLocalInput = (ms) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

function inboxCard(it, onDone) {
  const status = h('span', { class: 'status' })
  const buttons = []
  const btn = (label, type, extra = {}, cls = '') => {
    const b = h('button', { type: 'button', class: cls, disabled: !state.actions.enabled, onclick: async () => {
      const ok = await submitAction({ type, chatId: it.chatId, targetId: it.id, ...extra() }, status, buttons)
      if (ok) onDone()
    } }, label)
    buttons.push(b)
    return b
  }
  const none = () => ({})
  const pending = it.status === 'pending_confirm'
  const actionsRow = []
  let deadlineInput = null
  if (it.kind === 'task') {
    if (pending) actionsRow.push(btn('确认', 'task.confirm', none, 'primary'), btn('取消（误报）', 'task.cancel', none))
    else actionsRow.push(btn('完成', 'task.complete', none, 'primary'), btn('取消', 'task.cancel', none))
    deadlineInput = h('input', { type: 'datetime-local', value: it.deadline ? msToLocalInput(it.deadline) : '', disabled: !state.actions.enabled })
    buttons.push(deadlineInput)
    actionsRow.push(h('span', { class: 'deadline-set' }, deadlineInput,
      btn(it.deadline ? '改时间' : '定时间', 'task.set_deadline', () => ({ params: { deadline: localInputToMs(deadlineInput.value) } }))))
  } else if (it.kind === 'promise') {
    if (pending) actionsRow.push(btn('确认', 'promise.confirm', none, 'primary'), btn('取消（误报）', 'promise.cancel', none))
    else actionsRow.push(btn('已兑现', 'promise.fulfilled', none, 'primary'), btn('关闭不再追踪', 'promise.close', none))
  } else if (it.kind === 'event') {
    actionsRow.push(btn('确认', 'event.confirm', none, 'primary'))
  }

  const evidenceBox = h('div', { class: 'evidence' })
  const ev = it.evidence
  const meta = [
    KIND_NAME[it.kind],
    pending ? '待确认' : '进行中',
    it.assigner ? `指派：${it.assigner}` : null,
    it.category || null,
    it.confidence ? `置信度 ${Math.round(it.confidence * 100)}%` : null,
    it.kind === 'task' ? deadlineText(it) : null,
  ].filter(Boolean).join(' · ')
  return h('div', { class: it.kind === 'task' && !it.deadline ? 'card inbox-card no-deadline' : 'card inbox-card' },
    h('div', { class: 'inbox-head' },
      h('strong', { class: 'grow' }, it.statement),
      it.kind === 'task' && !it.deadline ? h('span', { class: 'pill warn' }, '待定时间') : null),
    h('p', { class: 'muted' }, meta),
    ev ? h('div', { class: 'evidence-line' },
      h('span', { class: 'muted' }, `证据${ev.ts ? `（${fmtTime(ev.ts)}${ev.sender ? ` ${ev.sender}` : ''}）` : ''}：`),
      h('span', {}, ev.preview || '（消息已不在库内）'),
      ev.ts ? h('button', { type: 'button', class: 'link', onclick: () => toggleEvidence(it.chatId, ev.msgId, evidenceBox) }, '上下文') : null) : null,
    evidenceBox,
    h('div', { class: 'actions' }, actionsRow, status))
}

async function toggleEvidence(chatId, msgId, box) {
  if (box.childElementCount) { fill(box); return }
  try {
    const r = await api('evidence', { chat: chatId, msg: msgId, around: 5 })
    fill(box, h('ol', { class: 'context' }, r.messages.map(m =>
      h('li', { class: m.isEvidence ? 'is-evidence' : '' },
        h('span', { class: 'muted' }, `${fmtTime(m.ts)} ${m.sender}：`), m.kind === 'text' || m.kind === 'quote' ? m.text : `[${m.kind}] ${m.text}`))))
  } catch (err) {
    showError(err, box)
  }
}

async function loadInbox() {
  const chat = state.chat === AGGREGATE ? undefined : state.chat
  const items = await api('inbox', { chat })
  const reload = () => { setTimeout(() => { if (state.tab === 'inbox') load() }, 1500) }
  const section = (title, list) => list.length
    ? h('section', {}, h('h2', { class: 'section-title' }, `${title}（${list.length}）`), list.map(it => inboxCard(it, reload)))
    : null
  const pending = items.filter(it => it.status === 'pending_confirm')
  const undated = items.filter(it => it.status === 'active' && it.kind === 'task' && !it.deadline)
  const active = items.filter(it => it.status === 'active' && !(it.kind === 'task' && !it.deadline))
  fill(view(), 
    state.actions.enabled ? null : h('p', { class: 'banner' }, ACTIONS_OFF_TEXT[state.actions.reason] ?? ERROR_TEXT.actions_disabled),
    h('p', { class: 'muted' }, chat ? `群 ${chat}` : '全部白名单群（选「跨群聚合」时显示所有群）'),
    items.length ? null : h('p', { class: 'muted' }, '没有待处理的任务、承诺或事件。'),
    section('待确认', pending),
    section('待定时间的任务', undated),
    section('进行中', active))
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
  fill(view(), h('div', { class: 'split' },
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
    fill(into, 
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
  fill(view(), 
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
  fill(view(), 
    h('div', { class: 'filters' }, picker, h('span', { class: 'muted' }, day ? `${data.digests.length} 条` : '最近的会话要点')),
    ...data.digests.map(d => h('section', { class: 'card' },
      h('h3', {}, d.chatTopic), h('p', { class: 'muted' }, d.happenedOn ?? ''),
      h('div', { class: 'md' }, renderBlocks(d.blocks)))))
}

// —— 人员关注 ——

const WATCH_NAME = { global: '全局关注', group: '本群关注', off: '未关注' }

async function loadPersons() {
  if (state.chat === AGGREGATE) {
    fill(view(), h('p', { class: 'muted' }, '人员关注按群查看：请在右上角选择一个具体的群。'))
    return
  }
  const persons = await api('persons', { chat: state.chat })
  const detail = h('section', { class: 'detail' }, h('p', { class: 'muted' }, '选一位成员与日期。'))
  fill(view(), h('div', { class: 'split' },
    h('section', { class: 'side' },
      persons.length ? null : h('p', { class: 'muted' }, '本群暂无关注成员或个人摘要。'),
      ...persons.map(p => h('div', { class: 'card' },
        h('strong', {}, p.remark || p.groupNick || p.pid), ' ',
        h('span', { class: 'pill' }, WATCH_NAME[p.watchLevel] ?? p.watchLevel), ' ',
        followButton(p),
        h('div', { class: 'days' }, p.days.length
          ? p.days.map(day => h('button', { type: 'button', class: 'chip', onclick: () => openPersonDigest(p, day, detail) }, day))
          : h('span', { class: 'muted' }, '暂无摘要'))))),
    detail))
}

function followButton(p) {
  const status = h('span', { class: 'status' })
  const following = p.watchLevel === 'group' || p.watchLevel === 'global'
  // 全局关注来自配置 watchList，前端不改；只切换本群关注
  if (p.watchLevel === 'global') return null
  const b = h('button', { type: 'button', class: 'chip', disabled: !state.actions.enabled, onclick: async () => {
    const ok = await submitAction({ type: following ? 'person.unfollow' : 'person.follow', chatId: state.chat, params: { pid: p.pid } }, status, [b])
    if (ok) setTimeout(() => { if (state.tab === 'persons') load() }, 1500)
  } }, following ? '取消关注' : '关注')
  return h('span', {}, b, ' ', status)
}

async function openPersonDigest(p, day, into) {
  try {
    const d = await api(`persons/${encodeURIComponent(p.pid)}/digests`, { chat: state.chat, day })
    fill(into, h('h2', {}, `${p.remark || p.groupNick || p.pid} · ${day}`), h('article', { class: 'md' }, renderBlocks(d.blocks)))
  } catch (err) {
    showError(err, into)
  }
}

// —— 入口 ——

const LOADERS = { reports: loadReports, inbox: loadInbox, docs: () => loadDocs(), media: () => loadMedia(), digests: () => loadDigests(), persons: loadPersons }

async function load() {
  fill(view(), h('p', { class: 'muted' }, '加载中…'))
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
    state.actions = data.actions ?? state.actions
    state.chat = data.chats.find(c => c.latestReport)?.chatId ?? data.chats[0]?.chatId ?? ''
    renderChatPicker()
    await load()
  } catch (err) {
    showError(err)
  }
}

boot()
