/**
 * store.ts：项目内唯一 fs 写入点。
 * 规则（TECH-DESIGN §3）：
 * - ensureDir / appendJsonl / appendText 写入前都必须过 assertInsideState；
 * - 写失败只记 logger，绝不抛出致命错误（不能拖垮宿主）。
 */
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertInsideState } from './guard.js'

export interface StoreLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

export class Store {
  constructor(
    private readonly baseDir: string,
    private readonly logger: StoreLogger,
  ) {}

  /** 相对 baseDir 创建目录（rel 传 '.' 即 baseDir 本身） */
  ensureDir(rel: string): boolean {
    try {
      assertInsideState(this.baseDir, join(this.baseDir, rel))
      mkdirSync(join(this.baseDir, rel), { recursive: true })
      return true
    } catch (error) {
      this.logger.error(`store.ensureDir failed: ${String(error)}`)
      return false
    }
  }

  /** 追加一行 JSON 到 .jsonl 文件 */
  appendJsonl(rel: string, entry: unknown): boolean {
    return this.appendText(rel, `${JSON.stringify(entry)}\n`)
  }

  /** 追加文本（自管换行） */
  appendText(rel: string, text: string): boolean {
    const target = join(this.baseDir, rel)
    try {
      assertInsideState(this.baseDir, target)
      appendFileSync(target, text, 'utf8')
      return true
    } catch (error) {
      this.logger.warn(`store.appendText failed (${rel}): ${String(error)}`)
      return false
    }
  }
}
