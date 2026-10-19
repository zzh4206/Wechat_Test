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
import { MIGRATE_V3_TO_V4_SQL, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

export interface DbLogger {
  warn(message: string): unknown
  debug?(message: string): unknown
}

export interface OpenOptions {
  logger: DbLogger
  /**
   * true（默认）时执行 schema 校准：v4 库跳过、v3 库单事务迁移到 v4、
   * user_version=0（全新库）执行全量 DDL、>4 报错拒开。
   */
  initSchema?: boolean
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

/**
 * schema 校准（幂等、自动；TECH-v0.4 §2）：
 * - =4：跳过；>4：抛错（调用方拒开）；0（全新库）：执行 v0.4 全量 DDL；
 * - =3：单事务执行 report 重建 + media 建表，user_version 最后置 4，
 *   任何一步失败整体回滚（重入安全：失败后仍为 v3，下次打开重试）。
 */
function ensureSchema(db: DatabaseSync, logger: DbLogger): void {
  const version = getUserVersion(db)
  if (version === SCHEMA_VERSION) return
  if (version > SCHEMA_VERSION) {
    throw new Error(`schema version ${version} > supported ${SCHEMA_VERSION}, refusing to open`)
  }
  if (version === 3) {
    // DROP report 前须关外键（SQLite 迁移规约），否则 entry 子行引用会阻断 DROP；
    // PRAGMA foreign_keys 不参与事务回滚，故在事务外先 OFF、成功后再 ON。
    db.exec('PRAGMA foreign_keys = OFF;')
    try {
      db.exec('BEGIN;')
      db.exec(MIGRATE_V3_TO_V4_SQL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
      db.exec('COMMIT;')
    } catch (error) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        /* 事务已不存在（BEGIN 本身失败），忽略 */
      }
      throw error
    } finally {
      db.exec('PRAGMA foreign_keys = ON;')
    }
    logger.debug?.(`db.ensureSchema: migrated user_version 3 -> ${SCHEMA_VERSION}`)
    return
  }
  // version === 0：全新库，直接执行 v0.4 全量 DDL（脚本自带 user_version=4）
  db.exec(SCHEMA_SQL)
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
      ensureSchema(db, options.logger)
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
