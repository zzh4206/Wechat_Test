/**
 * llm-observe.ts：LLM 调用结构化观测（任务卡 T3 + T9 成本透明化，技术文档 §7）。
 *
 * 职责：
 * - errKindOf 错误分类（自 report.ts 迁入，report.ts 向后兼容再导出）；
 * - LlmCallRecorder：包装每次 `llm.complete` 调用点，落一行结构化 JSON 到
 *   `<stateDir>/groups/<chatId>/llm-calls.jsonl`（复用 Store.appendJsonl 审计机制，
 *   与 journal 的 insights.jsonl 同目录同风格——最小侵入，不新增落盘通道）；
 * - T9 成本透明：每行追加 model / inTokens / outTokens / costCny / tokensEst——
 *   宿主回传 usage 则用真实值（tokensEst=false），否则按官方换算估算
 *   （GLM token:汉字≈1:1.6，即 tokens ≈ chars/1.6，tokensEst=true）；
 * - BatchStats：本次生成的批统计形状 + 报告尾统计行渲染（report 与 distiller 共用本模块，
 *   不在两个文件各抄一份）；T9 起统计行扩展含模型名、token 消耗（估算带 ~）与费用（≈）。
 *
 * 红线：写失败只记 logger 不抛错（Store 内部消化）；不记 prompt 内容只记字符数；
 * 不引入新依赖；durMs 恒为正数（单调时钟 + 下限 1ms）。
 */
import type { Store } from './store.js'

/**
 * 错误分类（T1，技术文档 §3.3）：timeout 类故障对半切分重试（改变参数重试），
 * 非 timeout（断言/解析失败、其他异常）保持"重试一次"。
 * 匹配 distiller 抛出的 `llm stream finished with error: Request timed out.`
 * 用 `/timed?\s?out|timeout/i` 容错匹配（覆盖 timeout / timed out / timedout 等变体）。
 */
export function errKindOf(error: unknown): 'timeout' | 'other' {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  return /timed?\s?out|timeout/i.test(msg) ? 'timeout' : 'other'
}

/** llm_call 阶段：map=分批/单次归纳、merge=批摘要合并、distill=提炼器（WP3） */
export type LlmCallPhase = 'map' | 'merge' | 'distill'

// —————————————— T9：token 估算与价格表（成本透明化） ——————————————

/**
 * GLM 官方口径：1 token ≈ 1.6 汉字（智谱 GLM 系列；用于无真实 usage 时的估算）。
 * 估算值一律带 tokensEst=true 标记，与真实 usage 区分。
 */
export const TOKENS_PER_HANZI = 1.6

/** 字符数 → token 估算（四舍五入；官方口径 1.6 汉字/token） */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / TOKENS_PER_HANZI))
}

/** 单模型价格：元 / 百万 tokens */
export interface ModelPricing {
  /** 输入价格（元/百万 tokens） */
  input: number
  /** 输出价格（元/百万 tokens） */
  output: number
}

/** 价格表：模型名 → 价格（Config.llmPricing 的形状） */
export type LlmPricingTable = Record<string, ModelPricing>

/**
 * 默认价格表（智谱官方定价页 2026-10 抓取：GLM-5.3 输入 ¥8 / 输出 ¥28 每百万 tokens，
 * GLM-5.3-flash 输入 ¥0.8 / 输出 ¥2.8）。**以供应商页面为准**：
 * https://docs.bigmodel.cn/cn/guide/start/pricing —— 调价改 llmPricing 配置即可，无需改代码。
 */
export const DEFAULT_LLM_PRICING: LlmPricingTable = {
  'glm-5.3': { input: 8, output: 28 },
  'glm-5.3-flash': { input: 0.8, output: 2.8 },
}

/**
 * 费用计算（纯函数）：(in/1M)×input + (out/1M)×output，四舍五入到 1e-6 元
 * （防浮点噪声进 JSONL；日级费用常在分厘级）。未知模型（价格表未命中）→ 0。
 */
export function computeCostCny(model: string, inTokens: number, outTokens: number, pricing: LlmPricingTable): number {
  const p = pricing?.[model]
  if (!p || typeof p.input !== 'number' || typeof p.output !== 'number') return 0
  const cny = (inTokens / 1_000_000) * p.input + (outTokens / 1_000_000) * p.output
  return Math.round(cny * 1_000_000) / 1_000_000
}

/** llm_call 结构化日志单行（技术文档 §7 字段口径；T9 追加成本五字段） */
export interface LlmCallEntry {
  ev: 'llm_call'
  chat: string
  /** 业务种类：daily/weekly/monthly（report）或 distill（提炼器） */
  kind: string
  phase: LlmCallPhase
  /** 批号（1 起始；0 = 合并调用；distill 固定 1） */
  batch: number
  /** 本次调用输入覆盖的消息条数 */
  msgs: number
  /** prompt 字符数（只记长度，绝不记内容） */
  promptChars: number
  durMs: number
  ok: boolean
  /** 失败分类（复用 errKindOf；成功为空串） */
  errKind: 'timeout' | 'other' | ''
  ts: number
  /** T9：模型名（来源 LlmClient.modelId()；缺省 'unknown'） */
  model: string
  /** T9：输入 tokens（真实 usage 或 chars/1.6 估算） */
  inTokens: number
  /** T9：输出 tokens（真实 usage 或输出字符数/1.6 估算；失败调用 = 0） */
  outTokens: number
  /** T9：费用（元；价格表按 llmPricing，未知模型 = 0） */
  costCny: number
  /** T9：token 是否为估算值（true = 估算，报告尾带 ~；false = 宿主回传真实 usage） */
  tokensEst: boolean
}

/** 单调时钟（performance.now 优先；测试环境无 performance 时退回 Date.now） */
export function monotonicMs(): number {
  const p = globalThis.performance
  return typeof p?.now === 'function' ? p.now() : Date.now()
}

/** 自 t0 起的耗时（毫秒，四舍五入，下限 1——保证观测字段恒为正数） */
export function sinceMs(t0: number): number {
  return Math.max(1, Math.round(monotonicMs() - t0))
}

/** llm_call JSONL 落盘相对路径：groups/<chatId>/llm-calls.jsonl（与 journal 同风格） */
export function llmCallRelPath(chatId: string): string {
  return ['groups', chatId, 'llm-calls.jsonl'].join('/')
}

/** 单次报告生成过程的 LLM 调用累计（ReportService 组装 batch_stats 用；T9 追加成本累计） */
export interface LlmRunStats {
  calls: number
  okCalls: number
  failCalls: number
  totalMs: number
  /** T9：模型名（Recorder 构造时注入；缺省 'unknown'） */
  model: string
  /** T9：累计输入 tokens */
  inTokens: number
  /** T9：累计输出 tokens */
  outTokens: number
  /** T9：累计费用（元，与逐行 costCny 同口径四舍五入到 1e-6） */
  costCny: number
  /** T9：本次累计里是否含估算值（任一行估算即 true；报告尾 ~ 标记来源） */
  tokensEst: boolean
}

/** Recorder 可选注入（T9 成本观测）：模型名 / 价格表 / warn 通道 */
export interface LlmCallRecorderOptions {
  /** 模型名（优先取 LlmClient.modelId()；缺省 'unknown' → 价格表不命中、费用记 0） */
  model?: string
  /** 价格表（缺省 DEFAULT_LLM_PRICING；未知模型费用记 0 并 warn 一次） */
  pricing?: LlmPricingTable
  logger?: { warn?: (m: string) => void }
}

/**
 * 轻量 usage 探测（T9）：complete 契约是返回纯文本 string，宿主三条路径
 * （complete/chat → stream → fetch）均不回传 usage——但若调用方注入的客户端
 * 返回了带 usage 字段的对象（如 openai 兼容完整响应），则取真实 token 数。
 * 返回 { text, usage }：usage 非空 = 真实值；text 取不到时为 ''（走既有解析失败路径）。
 */
function probeCallResult(raw: unknown): { text: string; usage: { inTok: number; outTok: number } | null } {
  if (typeof raw === 'string') return { text: raw, usage: null }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    let text = ''
    if (typeof o.text === 'string') text = o.text
    else if (typeof o.content === 'string') text = o.content
    else if (Array.isArray(o.choices)) {
      const c = (o.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
      if (typeof c === 'string') text = c
    }
    const u = o.usage
    if (u && typeof u === 'object') {
      const un = u as Record<string, unknown>
      // 兼容 openai（prompt_tokens/completion_tokens）与 anthropic（input_tokens/output_tokens）两种字段名
      const pick = (keys: string[]): number => {
        for (const k of keys) {
          const v = un[k]
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
        }
        return 0
      }
      const inTok = pick(['prompt_tokens', 'input_tokens'])
      const outTok = pick(['completion_tokens', 'output_tokens'])
      if (inTok > 0 || outTok > 0) return { text, usage: { inTok, outTok } }
    }
    return { text, usage: null }
  }
  return { text: '', usage: null }
}

/**
 * LLM 调用记录器：report 与 distiller 共用。包装 `complete` 调用点——
 * 正常返回 / 抛错都落一行 JSONL（ok/errKind/durMs + T9 成本五字段），抛错时原样重抛给上层
 * 走既有降级路径（观测零侵入，不改变任何控制流）。
 */
export class LlmCallRecorder {
  private readonly now: () => number
  private readonly model: string
  private readonly pricing: LlmPricingTable
  private readonly log?: { warn?: (m: string) => void }
  /** 未知模型"未配置价格"只 warn 一次（本实例生命周期内） */
  private warnedNoPricing = false
  private readonly stats: LlmRunStats

  constructor(
    private readonly store: Store,
    now?: () => number,
    options?: LlmCallRecorderOptions,
  ) {
    this.now = now ?? (() => Date.now())
    this.model = options?.model && options.model !== '' ? options.model : 'unknown'
    this.pricing = options?.pricing ?? DEFAULT_LLM_PRICING
    this.log = options?.logger
    this.stats = { calls: 0, okCalls: 0, failCalls: 0, totalMs: 0, model: this.model, inTokens: 0, outTokens: 0, costCny: 0, tokensEst: false }
  }

  /** 本次实例累计调用统计（ReportService 每次 run 新建一个实例即得单次生成统计） */
  getStats(): Readonly<LlmRunStats> {
    return { ...this.stats }
  }

  /**
   * 包装一次 LLM 调用并记录：fn 为真正的调用 thunk（prompt 已由调用方构建，
   * 这里只记字符数不记内容）。成功返回文本；失败落 ok=false 行后原样重抛。
   * T9：fn 返回带 usage 字段的对象时取真实 token 数（tokensEst=false），
   * 否则按 chars/1.6 估算（tokensEst=true）；费用按价格表计算，未知模型记 0 并 warn 一次。
   */
  async call(
    chatId: string,
    kind: string,
    phase: LlmCallPhase,
    batch: number,
    msgs: number,
    prompt: string,
    fn: () => Promise<unknown>,
  ): Promise<string> {
    const t0 = monotonicMs()
    try {
      const { text, usage } = probeCallResult(await fn())
      this.record(chatId, kind, phase, batch, msgs, prompt.length, sinceMs(t0), true, '', text.length, usage)
      return text
    } catch (error) {
      this.record(chatId, kind, phase, batch, msgs, prompt.length, sinceMs(t0), false, errKindOf(error), 0, null)
      throw error
    }
  }

  /** 落一行 JSONL + 更新累计（appendJsonl 内部先过 assertInsideState，失败只记日志） */
  private record(
    chatId: string,
    kind: string,
    phase: LlmCallPhase,
    batch: number,
    msgs: number,
    promptChars: number,
    durMs: number,
    ok: boolean,
    errKind: 'timeout' | 'other' | '',
    /** T9：输出字符数（估算 outTokens 用；失败调用传 0） */
    outChars: number,
    /** T9：宿主回传的真实 usage（无则 null → 走估算） */
    usage: { inTok: number; outTok: number } | null,
  ): void {
    this.stats.calls++
    if (ok) this.stats.okCalls++
    else this.stats.failCalls++
    this.stats.totalMs += durMs
    // T9 token 计量：真实 usage 优先；否则官方口径估算（1.6 汉字/token）
    const inTokens = usage ? usage.inTok : estimateTokens(promptChars)
    const outTokens = usage ? usage.outTok : ok ? estimateTokens(outChars) : 0
    const tokensEst = usage === null
    const costCny = computeCostCny(this.model, inTokens, outTokens, this.pricing)
    // 未知模型：费用记 0 并 warn 一次（本实例只提示一次，防刷屏）
    if (costCny === 0 && !(this.model in this.pricing) && !this.warnedNoPricing) {
      this.warnedNoPricing = true
      this.log?.warn?.(`llm cost: 模型 "${this.model}" 未配置价格（llmPricing），本次费用记 0；请按官方定价页补配置`)
    }
    this.stats.inTokens += inTokens
    this.stats.outTokens += outTokens
    this.stats.costCny = Math.round((this.stats.costCny + costCny) * 1_000_000) / 1_000_000
    if (tokensEst) this.stats.tokensEst = true
    const entry: LlmCallEntry = { ev: 'llm_call', chat: chatId, kind, phase, batch, msgs, promptChars, durMs, ok, errKind, ts: this.now(), model: this.model, inTokens, outTokens, costCny, tokensEst }
    this.store.ensureDir(['groups', chatId].join('/'))
    this.store.appendJsonl(llmCallRelPath(chatId), entry)
  }
}

/** 本次生成的批统计（写入报告 meta.batch_stats；向后兼容：新增字段不删旧字段） */
export interface BatchStats {
  /** 批数（单次调用路径 = 1；empty = 0） */
  batches: number
  /** 完全失败的批数（单次调用路径最终 degraded = 1） */
  failedBatches: number
  /** 最大单批耗时（毫秒，含该批全部重试/对半切分；不含批间退避 sleep） */
  maxBatchMs: number
  /** 检查点缓存命中批数 */
  ckptHits: number
  /** LLM 总调用数（含重试/对半子批/合并） */
  totalCalls: number
  /** LLM 总耗时（毫秒） */
  totalMs: number
  /** T4：本次实际批大小（自适应开 = safeBatch；单次调用路径缺省不写）。只在 meta 落盘，不进报告尾统计行 */
  batchSize?: number
  /** T9：模型名（Recorder 注入；提供时统计行追加成本段） */
  model?: string
  /** T9：累计输入 tokens（估算带 ~ 标注） */
  inTokens?: number
  /** T9：累计输出 tokens */
  outTokens?: number
  /** T9：累计费用（元，保留 4 位小数展示） */
  costCny?: number
  /** T9：token 是否估算值（true = 报告尾带 ~；false = 宿主回传真实 usage） */
  tokensEst?: boolean
}

/** token 数展示（≥1000 缩写为 x.xk，如 12300 → 12.3k） */
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * 报告尾统计行（技术文档 §7 + T9 成本透明）：
 * `> 统计：批 x（失败 y）· 最大批耗时 z s · 缓存命中 n · LLM 调用 c 次 / t s · 模型 m · 输入 ~12.3k / 输出 ~4.5k tok · ≈¥0.0223`
 * —— 估算 token 带 `~`、费用带 `≈`（保留 4 位小数，日级费用常在分厘级）；
 * 真实 usage（tokensEst=false）时去掉 `~`；model 未提供（如 empty 路径）省略成本段（向后兼容）。
 */
export function renderBatchStatsLine(s: Readonly<BatchStats>): string {
  const sec = (ms: number) => (ms / 1000).toFixed(1)
  let line = `> 统计：批 ${s.batches}（失败 ${s.failedBatches}）· 最大批耗时 ${sec(s.maxBatchMs)} s · 缓存命中 ${s.ckptHits} · LLM 调用 ${s.totalCalls} 次 / ${sec(s.totalMs)} s`
  if (s.model !== undefined) {
    const tilde = s.tokensEst === false ? '' : '~'
    line += ` · 模型 ${s.model} · 输入 ${tilde}${fmtTok(s.inTokens ?? 0)} / 输出 ${tilde}${fmtTok(s.outTokens ?? 0)} tok · ≈¥${(s.costCny ?? 0).toFixed(4)}`
  }
  return line
}
