/**
 * journal.ts：insights 落盘 + 每日 Markdown 日报（WP4）。
 *
 * 为什么独立成文件而不扩展 store.ts：store 是与业务无关的 fs 原语层
 * （唯一写入点、路径校验、失败只记日志），journal 是领域逻辑
 * （类型校验、引用截断、计数器、日报排版）——职责分开，测试也各自独立。
 * journal 自身不碰 fs，全部写入经 store（appendJsonl / writeText）。
 *
 * 安全约定（TECH-DESIGN §3/§4 / PRD F4）：
 * - type 仅 topic/viewpoint/quote/opportunity，写入前二次校验（纵深防御，
 *   不信任 distiller 上游）；非法 type 丢弃并 warn，绝不落盘；
 * - 引用句字段（quote / text）截断到 ≤50 字，不落任何原始消息全文；
 * - 所有路径形如 groups/<chatId>/insights.jsonl、reports/YYYY-MM-DD.md，
 *   最终由 store 内 assertInsideState 兜底，只写 stateDir 内。
 */
import type { Store, StoreLogger } from './store.js'
import { INSIGHT_TYPES } from './distiller.js'
import type { Insight, InsightType } from './distiller.js'

/** 引用句最大长度（TECH-DESIGN §4：保持最短必要引用） */
export const MAX_QUOTE_CHARS = 50

/** 报告文件内的群分节标题前缀（chatId 直接用作标题，后续可映射群名） */
const SECTION_PREFIX = '## '

export interface JournalOptions {
  store: Store
  logger: StoreLogger
  /** 时钟注入（测试 mock 时间跨天）；返回毫秒时间戳 */
  now?: () => number
}

/** 本地时区自然日键 YYYY-MM-DD（日报文件名 / 计数器切日基准） */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 引用类字段截断：超长取前 50 字并加省略号语义（不带尾随空白） */
export function clampQuote(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.length > MAX_QUOTE_CHARS ? value.slice(0, MAX_QUOTE_CHARS) : value
}

/** 对单条 insight 做落盘前消毒：引用截断 + 群号回填 */
function sanitizeEntry(chatId: string, insight: Insight): Insight {
  const out: Record<string, unknown> = { ...insight, group: chatId }
  for (const field of ['quote', 'text']) {
    if (field in out) out[field] = clampQuote(out[field])
  }
  return out as Insight
}

interface GroupCounters {
  day: string
  todayCount: number
  lastDistillAt: number | null
}

export class InsightsJournal {
  private readonly counters = new Map<string, GroupCounters>()
  /** day → (chatId → 当日已落盘的消毒条目)（日报重建用，内存态） */
  private readonly dayEntries = new Map<string, Map<string, Insight[]>>()
  private readonly now: () => number

  constructor(private readonly options: JournalOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 消费 distiller.onInsights：逐条二次校验 type，合法条目落 jsonl，
   * 更新每群计数器，并增量重写当日日报中该群小节。
   */
  record(chatId: string, insights: readonly Insight[]): void {
    const valid: Insight[] = []
    for (const raw of insights) {
      const type = (raw as { type?: unknown } | null | undefined)?.type
      if (typeof type !== 'string' || !INSIGHT_TYPES.includes(type as InsightType)) {
        // 纵深防御：四类之外的条目（含 type:'junk'）绝不落盘
        this.options.logger.warn(`journal[${chatId}]: rejected insight with illegal type=${JSON.stringify(type ?? null)}`)
        continue
      }
      valid.push(sanitizeEntry(chatId, raw))
    }
    if (valid.length === 0) return

    const rel = `groups/${chatId}/insights.jsonl`
    this.options.store.ensureDir(`groups/${chatId}`)
    for (const entry of valid) {
      this.options.store.appendJsonl(rel, entry)
    }

    const day = localDayKey(this.now())
    const counter = this.counters.get(chatId)
    if (counter?.day === day) {
      counter.todayCount += valid.length
      counter.lastDistillAt = this.now()
    } else {
      this.counters.set(chatId, { day, todayCount: valid.length, lastDistillAt: this.now() })
    }

    this.rememberEntries(day, chatId, valid)
    this.writeReport(day)
  }

  /** 每群内存计数器（getStatus 用）；跨自然日自动归零 */
  status(chatId: string): { todayCount: number; lastDistillAt: number | null } {
    const day = localDayKey(this.now())
    const counter = this.counters.get(chatId)
    if (!counter || counter.day !== day) return { todayCount: 0, lastDistillAt: null }
    return { todayCount: counter.todayCount, lastDistillAt: counter.lastDistillAt }
  }

  /** dispose：无定时器，只需清引用 */
  dispose(): void {
    this.counters.clear()
    this.dayEntries.clear()
  }

  // —————————————————— 日报 ——————————————————

  private rememberEntries(day: string, chatId: string, entries: Insight[]): void {
    let byChat = this.dayEntries.get(day)
    if (!byChat) {
      byChat = new Map()
      this.dayEntries.set(day, byChat)
    }
    const existing = byChat.get(chatId) ?? []
    byChat.set(chatId, [...existing, ...entries])
  }

  /**
   * 增量重写当日报告：内存里各群小节全量重排（本群小节被整节替换，
   * 其余群小节保持）；若进程重启导致内存丢失，先从既有文件按群标题
   * 解析回填（本群仍以内存为准，避免 markdown 反解析歧义）。
   */
  private writeReport(day: string): void {
    const rel = `reports/${day}.md`
    const byChat = this.dayEntries.get(day)
    if (!byChat) return

    // 重启恢复：把文件里已有、内存中没有的群小节原样保留
    const restored = this.parseExistingReport(day)
    const chatIds = new Set<string>([...restored.keys(), ...byChat.keys()])

    const sections: string[] = [`# 群聊日报 ${day}`, '']
    for (const chatId of chatIds) {
      const entries = byChat.get(chatId)
      sections.push(
        entries === undefined
          ? restored.get(chatId) as string // 既有小节（内存缺失，原样保留）
          : this.renderSection(chatId, entries),
      )
    }
    this.options.store.ensureDir('reports')
    this.options.store.writeText(rel, sections.join('\n').replace(/\n*$/, '\n'))
  }

  /** 从既有日报文件解析群小节（仅用于重启恢复其它群小节） */
  private parseExistingReport(day: string): Map<string, string> {
    const out = new Map<string, string>()
    const text = this.options.store.readText(`reports/${day}.md`)
    if (text === null) return out
    let current: { chatId: string; lines: string[] } | null = null
    for (const line of text.split('\n')) {
      if (line.startsWith(SECTION_PREFIX)) {
        if (current) out.set(current.chatId, current.lines.join('\n').replace(/\n*$/, '\n'))
        current = { chatId: line.slice(SECTION_PREFIX.length).trim(), lines: [line] }
      } else if (current) {
        current.lines.push(line)
      }
    }
    if (current) out.set(current.chatId, current.lines.join('\n').replace(/\n*$/, '\n'))
    return out
  }

  /** 渲染一个群的小节：全部 topic + 其余三类各取一条代表 */
  private renderSection(chatId: string, entries: readonly Insight[]): string {
    const topics = entries.filter((e) => e.type === 'topic')
    const reps = (['viewpoint', 'quote', 'opportunity'] as const)
      .map((type) => entries.find((e) => e.type === type))
      .filter((e): e is Insight => e !== undefined)

    const lines: string[] = [`${SECTION_PREFIX}${chatId}`, '']
    if (entries.length === 0) return `${lines.join('\n')}\n`

    lines.push('### 今日话题')
    if (topics.length === 0) lines.push('- （无）')
    for (const t of topics) {
      const actors = Array.isArray(t.actors) && t.actors.length > 0 ? `（参与者：${t.actors.join('、')}）` : ''
      lines.push(`- **${String(t.title ?? '(无标题)')}**：${String(t.summary ?? '')}${actors}`)
    }
    if (reps.length > 0) {
      lines.push('', '### 代表观点 / 引用 / 机会')
      for (const r of reps) lines.push(`- \`${r.type}\` ${this.renderRep(r)}`)
    }
    lines.push('', `> 共 ${entries.length} 条`, '')
    return lines.join('\n')
  }

  private renderRep(r: Insight): string {
    switch (r.type) {
      case 'viewpoint':
        return `${String(r.who ?? '?')} 关于「${String(r.about ?? '')}」：${String(r.stance ?? '')}${r.quote ? `（“${String(r.quote)}”）` : ''}`
      case 'quote':
        return `“${String(r.text ?? '')}” — ${String(r.reason ?? '')}`
      case 'opportunity':
        return `话题「${String(r.topic ?? '')}」可从：${String(r.angle ?? '')}（紧急度 ${String(r.urgency ?? 'low')}）`
      default:
        return JSON.stringify(r)
    }
  }
}
