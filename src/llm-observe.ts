/**
 * llm-observe.ts：LLM 调用结构化观测（任务卡 T3，技术文档 §7）。
 *
 * 职责：
 * - errKindOf 错误分类（自 report.ts 迁入，report.ts 向后兼容再导出）；
 * - LlmCallRecorder：包装每次 `llm.complete` 调用点，落一行结构化 JSON 到
 *   `<stateDir>/groups/<chatId>/llm-calls.jsonl`（复用 Store.appendJsonl 审计机制，
 *   与 journal 的 insights.jsonl 同目录同风格——最小侵入，不新增落盘通道）；
 * - BatchStats：本次生成的批统计形状 + 报告尾统计行渲染（report 与 distiller 共用本模块，
 *   不在两个文件各抄一份）。
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

/** llm_call 结构化日志单行（技术文档 §7 字段口径） */
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

/** 单次报告生成过程的 LLM 调用累计（ReportService 组装 batch_stats 用） */
export interface LlmRunStats {
  calls: number
  okCalls: number
  failCalls: number
  totalMs: number
}

/**
 * LLM 调用记录器：report 与 distiller 共用。包装 `complete` 调用点——
 * 正常返回 / 抛错都落一行 JSONL（ok/errKind/durMs），抛错时原样重抛给上层
 * 走既有降级路径（观测零侵入，不改变任何控制流）。
 */
export class LlmCallRecorder {
  private readonly now: () => number
  private readonly stats: LlmRunStats = { calls: 0, okCalls: 0, failCalls: 0, totalMs: 0 }

  constructor(
    private readonly store: Store,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now())
  }

  /** 本次实例累计调用统计（ReportService 每次 run 新建一个实例即得单次生成统计） */
  getStats(): Readonly<LlmRunStats> {
    return { ...this.stats }
  }

  /**
   * 包装一次 LLM 调用并记录：fn 为真正的调用 thunk（prompt 已由调用方构建，
   * 这里只记字符数不记内容）。成功返回原文；失败落 ok=false 行后原样重抛。
   */
  async call(
    chatId: string,
    kind: string,
    phase: LlmCallPhase,
    batch: number,
    msgs: number,
    prompt: string,
    fn: () => Promise<string>,
  ): Promise<string> {
    const t0 = monotonicMs()
    try {
      const raw = await fn()
      this.record(chatId, kind, phase, batch, msgs, prompt.length, sinceMs(t0), true, '')
      return raw
    } catch (error) {
      this.record(chatId, kind, phase, batch, msgs, prompt.length, sinceMs(t0), false, errKindOf(error))
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
  ): void {
    this.stats.calls++
    if (ok) this.stats.okCalls++
    else this.stats.failCalls++
    this.stats.totalMs += durMs
    const entry: LlmCallEntry = { ev: 'llm_call', chat: chatId, kind, phase, batch, msgs, promptChars, durMs, ok, errKind, ts: this.now() }
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
}

/** 报告尾统计行（技术文档 §7：日报含 batch_stats） */
export function renderBatchStatsLine(s: Readonly<BatchStats>): string {
  const sec = (ms: number) => (ms / 1000).toFixed(1)
  return `> 统计：批 ${s.batches}（失败 ${s.failedBatches}）· 最大批耗时 ${sec(s.maxBatchMs)} s · 缓存命中 ${s.ckptHits} · LLM 调用 ${s.totalCalls} 次 / ${sec(s.totalMs)} s`
}
