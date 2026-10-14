/**
 * guard.ts：注入防护、路径校验、每群限流。
 * 纯逻辑模块，不接触 fs / 网络，便于独立测试。
 */
import { resolve, sep } from 'node:path'

/** 消息消毒后的纯数据封装 */
export interface SanitizedMessage {
  /** JSON 字符串化的原文（指令区永不出现原文，见 TECH-DESIGN §3） */
  readonly data: string
  /** 是否发生了截断 */
  readonly truncated: boolean
}

/**
 * 把消息原文封装为纯数据字段：
 * JSON.stringify 后拼接，注入文本（"忽略之前指令"等）永远只是数据，不是指令。
 * 超过 maxChars 截断。
 */
export function sanitize(raw: string, maxChars = 2000): SanitizedMessage {
  let text = raw
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  return { data: JSON.stringify(text), truncated }
}

/**
 * 密钥形态脱敏（ERR-SRC-009）：把 ≥32 位连续 hex 串（sqlcipher enc_key 等密钥
 * 的典型形态）替换为 `[redacted:N]`（N=原长度）。纯函数、无副作用。
 * 用途：外部 CLI 的 stderr / 异常文本回显进 logger 前统一过一遍，
 * 防止崩溃现场（如 traceback 中的 PRAGMA key）把密钥带进宿主日志。
 */
export function redactHexRuns(s: string): string {
  return s.replace(/[0-9a-fA-F]{32,}/g, (m) => `[redacted:${m.length}]`)
}

/**
 * 断言 target（任意形态路径）解析后位于 base 目录内部，否则抛错。
 * - 两边都先 path.resolve 成绝对路径，杜绝 `..` 与绝对路径逃逸；
 * - 要求 target 位于 base 下（允许 target === base 本身，如 ensureDir('.')）。
 * 注意：符号链接的最终目标由操作系统决定，resolve 不追踪 symlink——
 * 这是已知限制；真实写入以 store.ts 为唯一 fs 入口，攻击者需先能在 state 目录外
 * 建立符号链接才可能绕过，纵深防御由 no-send 测试与目录权限共同兜底。
 */
export function assertInsideState(base: string, target: string): void {
  const baseAbs = resolve(base)
  const targetAbs = resolve(target)
  if (targetAbs === baseAbs) return
  const prefix = baseAbs.endsWith(sep) ? baseAbs : baseAbs + sep
  if (!targetAbs.startsWith(prefix)) {
    throw new Error(`path escape blocked: ${target} resolves outside ${base}`)
  }
}

/** 令牌桶选项 */
export interface TokenBucketOptions {
  /** 每秒补充令牌数 */
  ratePerSec?: number
  /** 桶容量（突发上限） */
  burst?: number
  /** 计时器（测试注入用），返回毫秒时间戳 */
  now?: () => number
}

/**
 * 每群一个令牌桶：默认 1 条/秒、突发 5。
 * 超限丢弃并计数（dropped）。
 */
export class TokenBucket {
  private readonly rate: number
  private readonly capacity: number
  private readonly now: () => number
  private readonly buckets = new Map<string, { tokens: number; lastMs: number }>()
  private readonly _dropped = new Map<string, number>()

  constructor(options: TokenBucketOptions = {}) {
    this.rate = options.ratePerSec ?? 1
    this.capacity = options.burst ?? 5
    this.now = options.now ?? (() => Date.now())
  }

  /** 尝试取一个令牌；true=放行，false=超限丢弃 */
  take(groupId: string): boolean {
    const t = this.now()
    let b = this.buckets.get(groupId)
    if (!b) {
      b = { tokens: this.capacity, lastMs: t }
      this.buckets.set(groupId, b)
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.lastMs) / 1000) * this.rate)
    b.lastMs = t
    if (b.tokens >= 1) {
      b.tokens -= 1
      return true
    }
    this._dropped.set(groupId, (this._dropped.get(groupId) ?? 0) + 1)
    return false
  }

  /** 某群累计被丢弃的条数 */
  dropped(groupId: string): number {
    return this._dropped.get(groupId) ?? 0
  }
}
