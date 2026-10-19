/**
 * db.ts：node:sqlite（DatabaseSync，Node 24 内置）连接封装。
 *
 * 遵循 store.ts 的失败纪律：写失败只 logger.warn 并返回 false，
 * 绝不向宿主抛致命错误（open 阶段的错误同样吞掉返回 null，由调用方判空）。
 * 写入规约（DESIGN.md 修订4）：foreign_keys=ON、busy_timeout=5000、WAL、
 * BEGIN IMMEDIATE 短事务、单写者。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

export interface DbLogger {
  warn(message: string): unknown
  debug?(message: string): unknown
}

export interface OpenOptions {
  logger: DbLogger
  /** true（默认）时执行内嵌 DDL（幂等，IF NOT EXISTS）；已建库可传 false 跳过 */
  initSchema?: boolean
}

/** 打开（必要时创建）知识库；失败返回 null 并 warn */
export function openDb(path: string, options: OpenOptions): DatabaseSync | null {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec('PRAGMA journal_mode = WAL;')
    if (options.initSchema !== false) {
      db.exec(SCHEMA_SQL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    }
    return db
  } catch (error) {
    options.logger.warn(`db.openDb failed (${path}): ${String(error)}`)
    return null
  }
}

/** 校验库的 schema 版本（供导入器等一次性工具使用） */
export function checkSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    return row?.user_version ?? null
  } catch {
    return null
  }
}

/**
 * BEGIN IMMEDIATE 短事务封装：fn 抛错即 ROLLBACK 并 warn 返回 false，
 * 正常则 COMMIT 返回 true。遵循「写失败不致命」纪律。
 */
export function withTransaction(db: DatabaseSync, logger: DbLogger, fn: () => void): boolean {
  try {
    db.exec('BEGIN IMMEDIATE;')
    fn()
    db.exec('COMMIT;')
    return true
  } catch (error) {
    try {
      db.exec('ROLLBACK;')
    } catch {
      /* 事务已不存在（如 BEGIN 本身失败），忽略 */
    }
    logger.warn(`db.withTransaction failed: ${String(error)}`)
    return false
  }
}

/** 归一化文本：去 BOM、CRLF→LF、strip 首尾空白（DESIGN.md 修订2 口径） */
export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}
