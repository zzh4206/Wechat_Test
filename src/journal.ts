/**
 * journal.ts：insights 落盘（WP4）。
 *
 * 历史注记：本文件曾同时负责"根目录每日 Markdown 日报"（reports/<date>.md，
 * 第一代四类格式、含 wxid 明文）。该日报职责已由 M3 report.ts 的三层金字塔
 * 报告正式接棒（reports/<chatId>/<date>.md，代号化 + ≤50 字引用，隐私口径更强），
 * 根目录日报写入已退役并整体移除——insights.jsonl 的提炼产出写入保持不变。
 *
 * 为什么独立成文件而不扩展 store.ts：store 是与业务无关的 fs 原语层
 * （唯一写入点、路径校验、失败只记日志），journal 是领域逻辑
 * （类型校验、引用截断、计数器、日报排版）——职责分开，测试也各自独立。
 * journal 自身不碰 fs，全部写入经 store（appendJsonl / writeText）。
 *
 * 安全约定（TECH-DESIGN §3/§4 / PRD F4）：
 * - type 仅 topic/viewpoint/quote/opportunity，写入前二次校验（纵深防御，
 *   不信任 distiller 上游）；非法 type 丢弃并 warn，绝不落盘；
 * - 引用句及一切自由文本字段截断到 ≤50 字（ERR-JRN-001），不落任何原始消息全文；
 * - 所有路径形如 groups/<chatId>/insights.jsonl，
 *   最终由 store 内 assertInsideState 兜底，只写 stateDir 内。
 */
import type { Store, StoreLogger } from './store.js'
import { INSIGHT_TYPES } from './distiller.js'
import type { Insight, InsightType } from './distiller.js'

/** 引用句最大长度（TECH-DESIGN §4：保持最短必要引用） */
export const MAX_QUOTE_CHARS = 50

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

/** 对单条 insight 做落盘前消毒：全字符串字段统一钳制 + 群号回填。
 *
 * ERR-JRN-001 修复：不再只钳制 quote/text——entry 的**全部字符串字段**
 * （title/summary/about/stance/angle/reason/who/topic…含未来新增字段）统一
 * 按 MAX_QUOTE_CHARS（50 字）口径截断，保证"原始消息全文不落盘"的纪律
 * 不因字段漏配而失守。50 而非 200 的理由：安全报告绊网的 canary 全串
 * 仅 76 字，≤200 的钳制无法阻断其落盘；报告本身亦给出"沿用 quote 的
 * 50 字口径"这一保守选项。提炼期的语义上限（title≤100/其余≤200）由
 * distiller.parseInsights 的 schema 校验承担（超长 → 整批拒绝走降级），
 * 这里是最短必要的兜底钳制。 */
function sanitizeEntry(chatId: string, insight: Insight): Insight {
  const out: Record<string, unknown> = { ...insight, group: chatId }
  for (const key of Object.keys(out)) {
    out[key] = clampQuote(out[key])
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
  private readonly now: () => number

  constructor(private readonly options: JournalOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 消费 distiller.onInsights：逐条二次校验 type，合法条目落 jsonl，
   * 更新每群计数器。（根目录日报写入已退役——日报由 M3 report.ts 接棒。）
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
  }
}
