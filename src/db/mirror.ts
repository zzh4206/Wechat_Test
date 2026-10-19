/**
 * mirror.ts：Store → SQLite 可选镜像（JSONL 仍是事实源）。
 *
 * 原则：
 * - 镜像永远不影响主流程——任何异常只 warn/debug，绝不向上抛；
 * - 入口路径找不到映射规则 → debug 记录后跳过（大量状态文件如
 *   cursor.json / checkpoint / outbox 审计等与知识库 schema 无关）；
 * - 幂等：insight 用内容 hash8 作 source_key，报告用 (daily, 日期) upsert。
 *
 * JSONL/文件 → 表 映射规则（现有产出里可稳定识别的两类）：
 * 1) groups/<chatId>/insights.jsonl（journal.ts 落盘，type ∈ topic/viewpoint/quote/opportunity）
 *    - topic/viewpoint/quote → chat_digest（chat_topic=type:title，digest_md=summary/text，
 *      happened_on=条目 ts 的本地日，source_key='insight:<type>:<hash8(整行 JSON)>'）
 *    - opportunity → entry(kind='idea')（面向报告的原子素材语义）
 * 2) reports/<chatId>/YYYY-MM-DD.md（report.ts 日报，writeText 覆写）
 *    → report(daily, period_start=period_end=日期, chat_id=<chatId>，
 *      title='日报 <chatId> <日期>')，同键重复写走 upsertReport UPDATE（幂等）。
 * 其余（audit / llm-calls / outbox / person-digest / pipeline 记忆等）不映射。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { KnowledgeDao, hash8 } from './dao.js'
import type { DbLogger } from './db.js'

/** media 镜像源行：groupStore files 表（FileRow）所需子集，解耦避免依赖循环 */
export interface MediaSourceFile {
  fileId: string
  name: string
  ext: string
  size: number
  msgId: string | null
  wxPath: string
  hash: string
  category: string
  lastSeenTs: number
  appearances: ReadonlyArray<{ msgId: string; ts: number }>
}

/** files.category → knowledge media_type（v0.4 CHECK 四类；voice 未采集，兜底 file） */
function mediaKindOf(category: string): 'image' | 'video' | 'file' | 'voice' {
  if (category === '图片') return 'image'
  if (category === '视频') return 'video'
  return 'file'
}

/** 未显式传 sqlitePath 时导入器使用的默认库路径（真实数据目录，已 gitignore） */
export function defaultDbPath(): string {
  return join(homedir(), 'WeChat', '1数据', 'knowledge.db')
}

const INSIGHTS_RE = /^groups\/([^/]+)\/insights\.jsonl$/
const DAILY_REPORT_RE = /^reports\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.md$/

/** 条目本地日键 YYYY-MM-DD（ts 缺失/非法 → null） */
function dayKeyOf(ts: unknown): string | null {
  const ms = typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : NaN
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface SqliteMirror {
  /** appendJsonl 成功后调用；按入口路径分发，未映射跳过 */
  mirrorJsonl(rel: string, entry: unknown): void
  /** writeText 成功后调用；按入口路径分发，未映射跳过 */
  mirrorText(rel: string, text: string): void
  /**
   * media 镜像（v0.4）：groupStore files 表 → knowledge.db media。
   * 由接线层在 file-index 扫描完成后调用（与既有镜像同一消息处理周期，无独立定时器）。
   * source_key = `<chatId>:<fileId>`（file_id 稳定派生键，重扫幂等）。
   */
  mirrorMedia(chatId: string, files: ReadonlyArray<MediaSourceFile>): void
  close(): void
}

/**
 * 创建镜像；初始化失败返回 null（调用方静默降级为无镜像）。
 * sqlitePath 传 undefined 时返回 null（不启用镜像，保持既有行为零变化）。
 */
export function createSqliteMirror(sqlitePath: string | undefined, logger: DbLogger): SqliteMirror | null {
  if (!sqlitePath) return null
  const db = openDb(sqlitePath, { logger })
  if (!db) return null
  const dao = new KnowledgeDao(db, logger)

  const safe = (fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      logger.warn(`mirror: unexpected failure: ${String(error)}`)
    }
  }

  const mirrorInsight = (raw: unknown): void => {
    const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const type = typeof entry.type === 'string' ? entry.type : ''
    const text =
      typeof entry.summary === 'string'
        ? entry.summary
        : typeof entry.text === 'string'
          ? entry.text
          : typeof entry.quote === 'string'
            ? entry.quote
            : typeof entry.angle === 'string'
              ? entry.angle // opportunity 类条目的正文在 angle 字段
              : typeof entry.title === 'string'
                ? entry.title
                : ''
    if (!type || !text) {
      logger.debug?.(`mirror: insight missing type/text, skipped`)
      return
    }
    const title = typeof entry.title === 'string' ? entry.title : ''
    const topic = typeof entry.topic === 'string' && entry.topic ? entry.topic : title
    const day = dayKeyOf(entry.ts)
    if (type === 'opportunity') {
      // 面向报告的原子素材 → entry
      const ms = typeof entry.ts === 'number' ? entry.ts : typeof entry.ts === 'string' ? Date.parse(entry.ts) : Date.now()
      safe(() => dao.insertEntry({ ts: Number.isFinite(ms) ? ms : Date.now(), kind: 'idea', contentMd: text }))
      return
    }
    // topic / viewpoint / quote → chat_digest（source_key 内容级幂等）
    const sourceKey = `insight:${type}:${hash8(JSON.stringify(entry))}`
    safe(() =>
      dao.insertChatDigest({
        chatTopic: topic ? `${type}:${topic}` : type,
        digestMd: text,
        happenedOn: day,
        sourceKey,
        createdBy: '2水群',
      }),
    )
  }

  return {
    mirrorJsonl(rel, entry) {
      if (INSIGHTS_RE.test(rel)) safe(() => mirrorInsight(entry))
      else logger.debug?.(`mirror: no mapping for jsonl ${rel}, skipped`)
    },

    mirrorMedia(chatId, files) {
      for (const f of files) {
        if (!f || typeof f.fileId !== 'string' || f.fileId === '') continue
        const hasPath = typeof f.wxPath === 'string' && f.wxPath !== '' && f.wxPath !== '待下载'
        const sourceTs =
          f.lastSeenTs > 0
            ? f.lastSeenTs
            : (f.appearances?.[0]?.ts ?? null)
        safe(() =>
          dao.upsertMedia({
            chatId,
            mediaType: mediaKindOf(f.category),
            sourceKey: `${chatId}:${f.fileId}`,
            status: hasPath ? 'available' : 'pending',
            fileName: f.name,
            ext: f.ext,
            size: typeof f.size === 'number' && f.size > 0 ? f.size : null,
            md5: f.hash || null,
            path: hasPath ? f.wxPath : null,
            pathKind: hasPath ? 'local' : null,
            sourceTs: typeof sourceTs === 'number' && sourceTs > 0 ? sourceTs : null,
            createdAt: sourceTs ?? undefined,
          }),
        )
      }
    },

    mirrorText(rel, text) {
      const m = DAILY_REPORT_RE.exec(rel)
      if (!m) {
        logger.debug?.(`mirror: no mapping for text ${rel}, skipped`)
        return
      }
      const [, chatId, day] = m
      // v0.4：report 镜像带真实 chat_id（rel 路径 reports/<chatId>/ 已含群 ID；解析不出时上面正则已不匹配）
      safe(() =>
        dao.upsertReport({
          periodType: 'daily',
          periodStart: day,
          periodEnd: day,
          title: `日报 ${chatId} ${day}`,
          contentMd: text,
          status: 'draft',
          chatId,
          docIdsHint: null,
        }),
      )
    },

    close() {
      dao.close()
    },
  }
}
