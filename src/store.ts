/**
 * store.ts：项目内唯一 fs 写入点。
 * 规则（TECH-DESIGN §3）：
 * - ensureDir / appendJsonl / appendText 写入前都必须过 assertInsideState；
 * - 写失败只记 logger，绝不抛出致命错误（不能拖垮宿主）。
 */
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertInsideState } from './guard.js'
import { createSqliteMirror, type MediaSourceFile, type SqliteMirror } from './db/mirror.js'

export interface StoreLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

export class Store {
  /** 可选 SQLite 镜像（JSONL 仍是事实源；镜像写失败绝不影响主流程） */
  private readonly mirror: SqliteMirror | null

  constructor(
    private readonly baseDir: string,
    private readonly logger: StoreLogger,
    /** 传入路径即启用知识库镜像；undefined/初始化失败则不启用（行为与旧版一致） */
    sqlitePath?: string,
  ) {
    this.mirror = createSqliteMirror(sqlitePath, logger)
  }

  /** media 镜像透传（v0.4：file-index 扫描后由接线层调用；未启用镜像时零开销） */
  mirrorMedia(chatId: string, files: ReadonlyArray<MediaSourceFile>): void {
    this.mirror?.mirrorMedia(chatId, files)
  }

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
    const ok = this.appendText(rel, `${JSON.stringify(entry)}\n`)
    if (ok) this.mirror?.mirrorJsonl(rel, entry)
    return ok
  }

  /** 覆写文本文件（WP4 日报整文件重写用）；同样先过 assertInsideState */
  writeText(rel: string, text: string): boolean {
    const target = join(this.baseDir, rel)
    try {
      assertInsideState(this.baseDir, target)
      writeFileSync(target, text, 'utf8')
      this.mirror?.mirrorText(rel, text)
      return true
    } catch (error) {
      this.logger.warn(`store.writeText failed (${rel}): ${String(error)}`)
      return false
    }
  }

  /** 读文本文件；不存在或失败返回 null（只读，不写） */
  readText(rel: string): string | null {
    try {
      return readFileSync(join(this.baseDir, rel), 'utf8')
    } catch {
      return null
    }
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
