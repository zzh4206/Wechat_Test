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
import { MIGRATE_V3_TO_V4_SQL, MIGRATE_V4_TO_V5_SQL, MIGRATE_V5_TO_V6_SQL, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

export interface DbLogger {
  warn(message: string): unknown
  debug?(message: string): unknown
}

export interface OpenOptions {
  logger: DbLogger
  /**
   * true（默认）时执行 schema 校准：v6 库跳过、v5 单事务迁移到 v6（entry.chat_id 回填
   * 'aggregate' + 重建 v_marking_latest）、v4 先升 5 再 6、v3 先升 4 再 5 再 6、
   * user_version=0（全新库）执行全量 DDL、>6 报错拒开。
   */
  initSchema?: boolean
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

/**
 * schema 校准（幂等、自动；TECH-v0.6 §2 + 工单 D-3/D-4）：
 * - =6：跳过；>6：抛错（调用方拒开）；0（全新库）：执行 v6 全量 DDL；
 * - =5：单事务执行 v5→6（entry ALTER ADD chat_id 回填 'aggregate' + 重建
 *   v_marking_latest；report_revision/marking 零改动），user_version 最后置 6；
 * - =4：先 4→5（纯新增两表两视图），再 5→6，各在独立单事务内；
 * - =3：先 3→4（report 重建 + media），再 4→5→6，链式独立单事务，
 *   任何一步失败整体回滚该步（重入安全：失败后停留在原版本，下次打开重试）；
 * - 其余 <4（如 1/2）：抛错拒开。
 */
function ensureSchema(db: DatabaseSync, logger: DbLogger): void {
  const version = getUserVersion(db)
  if (version === SCHEMA_VERSION) return
  if (version > SCHEMA_VERSION) {
    throw new Error(`schema version ${version} > supported ${SCHEMA_VERSION}, refusing to open`)
  }
  if (version !== 0 && version !== 3 && version !== 4 && version !== 5) {
    throw new Error(`unsupported schema version ${version} (supported: 0/3/4/5/${SCHEMA_VERSION}), refusing to open`)
  }
  if (version === 0) {
    // 全新库：直接执行 v6 全量 DDL（脚本自带 user_version=6）
    db.exec(SCHEMA_SQL)
    return
  }
  // DROP report 前须关外键（SQLite 迁移规约），否则 entry 子行引用会阻断 DROP；
  // PRAGMA foreign_keys 不参与事务回滚，故在事务外先 OFF、成功后再 ON。
  const migrations: Array<{ from: number; sql: string }> = []
  if (version === 3) migrations.push({ from: 3, sql: MIGRATE_V3_TO_V4_SQL })
  if (version <= 4) migrations.push({ from: 4, sql: MIGRATE_V4_TO_V5_SQL })
  migrations.push({ from: 5, sql: MIGRATE_V5_TO_V6_SQL })
  db.exec('PRAGMA foreign_keys = OFF;')
  try {
    for (const m of migrations) {
      try {
        db.exec('BEGIN;')
        db.exec(m.sql)
        db.exec(`PRAGMA user_version = ${m.from + 1};`)
        db.exec('COMMIT;')
        logger.debug?.(`db.ensureSchema: migrated user_version ${m.from} -> ${m.from + 1}`)
      } catch (error) {
        try {
          db.exec('ROLLBACK;')
        } catch {
          /* 事务已不存在（BEGIN 本身失败），忽略 */
        }
        throw error
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;')
  }
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
