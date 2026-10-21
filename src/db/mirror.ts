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
import { KnowledgeDao, hash8, contentHash } from './dao.js'
import type { DbLogger } from './db.js'

/** 报告类型（与 report.ts 的 ReportKind 同名集；此处独立定义避免依赖循环） */
export type ReportKindName = 'daily' | 'weekly' | 'monthly'

export interface ReportPeriod {
  periodStart: string
  periodEnd: string
}

/**
 * kind → period 起止（单一实现，镜像/导入器两处引用——杜绝口径漂移，缺口 G1/G4）：
 * - daily = (dateKey, dateKey)；
 * - weekly = (该周周一, 周一+6 天)——dateKey 是周报触发的周一；
 * - monthly = (当月 1 号, 当月月末)——dateKey 是 1 号；
 * - dateKey 非法（非 YYYY-MM-DD 或解析不出）→ null（调用方跳过并 warn）。
 */
export function reportPeriodOf(kind: ReportKindName, dateKey: string): ReportPeriod | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3]) || d.getMonth() !== Number(m[2]) - 1) return null
  const p = (x: Date): string => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  if (kind === 'daily') return { periodStart: dateKey, periodEnd: dateKey }
  if (kind === 'weekly') {
    const dowMon = (d.getDay() + 6) % 7 // 周一=0
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dowMon)
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
    return { periodStart: p(monday), periodEnd: p(sunday) }
  }
  // monthly：1 号 → 月末
  if (d.getDate() !== 1) return null // 月报 dateKey 约定为 1 号；否则视为非法跳过
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { periodStart: p(d), periodEnd: p(last) }
}

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

// ==================== 报告 → doc 提取（与 Python extract_docs_from_reports.py 同口径） ====================

export const TAG_FROM_REPORT = '来自报告'
export const TAG_GITHUB = 'github'

/** URL 截断：中文引号 / 空白 / 右括号 / 常见中文标点（= Python URL_RE） */
const URL_RE = /https?:\/\/[^\s\)）」』】"'，。；、！？：]+/g
/** 去尾部标点（= Python URL_TRAIL_RE） */
const URL_TRAIL_RE = /[.,;:!?）)」』\]〉»]+$/

/** 报告文本中的全部唯一 URL（尾部标点剥离后去重，顺序保持出现序） */
export function extractUrls(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(URL_TRAIL_RE, '')
    if (u && !seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
}

/** URL 域名（= Python host_of） */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/]+)/.exec(url)
  return m ? m[1] : url
}

/** URL 所在行原文（保留行内引用格式，= Python line_context） */
export function lineContext(md: string, url: string): string {
  for (const line of md.split('\n')) {
    if (line.includes(url)) return line.trim()
  }
  return ''
}

/**
 * 从 URL 所在引用行取可读描述（GitHub 仓库名优先；否则取「…」内除 URL 外的可读文字；
 * 都没有 → null，由调用方用域名兜底）。= Python descriptive_title。
 */
export function descriptiveTitle(md: string, url: string): string | null {
  const ctx = lineContext(md, url)
  if (!ctx) return null
  if (url.includes('github.com')) {
    const m = /github\.com\/([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)/.exec(url)
    if (m) {
      const [, owner, name] = m
      if (ctx.includes(name)) return name
      return `${owner}/${name}`
    }
  }
  const q = /「([^」]+)」/.exec(ctx)
  if (q) {
    const text = q[1]
      .replace(url, '')
      .replace(/^[\s。，,.:：]+|[\s。，,.:：]+$/g, '')
    if (text) return text.slice(0, 30)
  }
  return null
}

/**
 * 「### 本期文件索引」区段下的非占位行（跳过空行与「本期无新文件」）。
 * = Python file_index_entries。
 */
export function fileIndexEntries(md: string): string[] {
  if (!md.includes('### 本期文件索引')) return []
  const sec = md.split('### 本期文件索引', 2)[1].split('\n### ', 2)[0]
  const out: string[] = []
  for (const raw of sec.split('\n')) {
    const line = raw.trim()
    if (!line || line.includes('本期无新文件')) continue
    out.push(line)
  }
  return out
}

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
  /**
   * 报告类型显式通道（缺口 G1/G2 修复）：writeReport 落盘后调用——kind 由代码给出而非
   * 从路径猜测；period 起止由 reportPeriodOf 推导（dateKey 非法 → warn 跳过）。
   * chatId='aggregate' 为跨群汇总（schema report.chat_id='aggregate'）。
   * 内部随后调用 mirrorDocsFromReport 做非对话资料（URL/文件索引）提取入 doc 表。
   */
  mirrorReport(kind: ReportKindName, chatId: string, dateKey: string, md: string): void
  /**
   * 报告落盘时并行提取非对话资料入 doc 表（与日报镜像同一模式：SQLite 只是
   * 查询层镜像，逐条 safe 包裹，失败只 warn 不影响主流程）。
   * 口径与 0数据格式/extract_docs_from_reports.py 逐条对齐（见各 helper 注释）：
   * URL 查重命中（findDocIdByUrl）即跳过——保持首建 source_ref 不覆盖，与
   * Python「命中即跳过」一致，因此两边先后跑不会产生重复 doc。
   */
  mirrorDocsFromReport(kind: ReportKindName, chatId: string, dateKey: string, md: string): void
  /**
   * 修订事件镜像（v0.6，TECH §3.1）：插件侧修订事件显式通道（接线由插件侧 P3 完成）。
   * insertReportRevision 幂等（source_key 冲突返回已有 id、不更新——修订不可变事实）。
   */
  mirrorReportRevision(chatId: string, periodType: ReportKindName, periodStart: string, ts: number, type: string, opts?: { targetRef?: string | null; summary?: string | null; source?: 'chat' | 'web'; sourceKey?: string }): boolean
  /**
   * 完成情况标记镜像（v0.6）：kind 三态 done/undone/deleted；同一 target_ref 的状态
   * 演变 = 追加新行（不可变事实），最新态由 v_marking_latest 承载。
   */
  mirrorMarking(chatId: string, kind: 'done' | 'undone' | 'deleted', targetRef: string, ts: number, opts?: { source?: 'chat' | 'web'; sourceKey?: string }): boolean
  /** 报告定稿（draft → final 单向；knowledge.db 是 status 的唯一存放处） */
  finalizeReport(chatId: string, periodType: ReportKindName, periodStart: string): 'ok' | 'not_found' | 'already_final' | 'error'
  /** 修订读侧（报告渲染的修订段；单一查询副本 = knowledge.db） */
  listRevisions(chatId: string, periodType: string, periodStart: string): Array<{ ts: number; type: string; summary: string | null; source: string }>
  /** marking 最新态读侧（完成情况段；v_marking_latest） */
  listMarkingsLatest(kind?: 'done' | 'undone' | 'deleted'): Array<{ chat_id: string; kind: string; target_ref: string; ts: number; source: string }>
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

  const mirrorInsight = (chatId: string, raw: unknown): void => {
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
      // 面向报告的原子素材 → entry（v6：带群归属 chatId，report gen --chat-id 只归档本群）
      const ms = typeof entry.ts === 'number' ? entry.ts : typeof entry.ts === 'string' ? Date.parse(entry.ts) : Date.now()
      safe(() => dao.insertEntry({ ts: Number.isFinite(ms) ? ms : Date.now(), kind: 'idea', contentMd: text, chatId }))
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

  /**
   * mirrorDocsFromReport：单份报告的非对话资料提取（URL + 文件索引行 → doc 表）。
   * 逐条 safe 包裹：单条失败只 warn，不影响其余条目与主流程。
   */
  const mirrorDocsFromReport = (kind: ReportKindName, chatId: string, dateKey: string, md: string): void => {
    if (!md || !dateKey) return
    const sourceRef = `报告 ${dateKey} · ${chatId}`

    // ---- URL → doc(category='web') ----
    for (const url of extractUrls(md)) {
      safe(() => {
        // 与 Python 查重 2 同口径：全库任一 content_md 已含该 URL → 命中即跳过，
        // 保持首建 source_ref 不覆盖（两边先后跑不会产生重复 doc）
        if (dao.findDocIdByUrl(url)) return
        const desc = descriptiveTitle(md, url) ?? hostOf(url)
        const ctx = lineContext(md, url)
        const contentMd = `- URL：${url}\n` + (ctx ? `- 语境：${ctx}\n` : '') + `- 提及：${sourceRef}\n`
        const docId = dao.upsertDoc({
          title: `资源：${desc}`,
          category: 'web',
          sourceType: 'web',
          sourceRef,
          contentMd,
        })
        if (docId) {
          const tagId = dao.ensureTag(TAG_FROM_REPORT)
          if (tagId) dao.tagDoc(docId, TAG_FROM_REPORT)
          if (url.includes('github.com')) {
            dao.tagDoc(docId, TAG_GITHUB) // tagDoc 内部已按 name 幂等建 tag
          }
        }
      })
    }

    // ---- 「### 本期文件索引」行 → doc(category='file') ----
    for (const line of fileIndexEntries(md)) {
      safe(() => {
        // 与 Python 同口径双重查重：行原文指纹（含提及行的 content_hash）+ 全库子串兜底
        const name = line.replace(/^[-*]+\s*/, '').trim()
        if (!name) return
        const contentMd = `${line}\n（${dateKey} · ${chatId}）\n`
        const hash = contentHash(contentMd)
        const hitByHash = dao.findDocByHash(hash)
        const hitByText = dao.findDocIdByUrl(line)
        if (hitByHash || hitByText) return
        const docId = dao.upsertDoc({
          title: name.slice(0, 80),
          category: 'file',
          sourceType: 'file_import',
          sourceRef,
          contentMd,
        })
        if (docId) {
          dao.tagDoc(docId, TAG_FROM_REPORT)
        }
      })
    }
    void kind // kind 不影响提取口径（URL/文件索引与周期类型无关），保留参数以对齐 mirrorReport
  }

  return {
    mirrorJsonl(rel, entry) {
      const chat = INSIGHTS_RE.exec(rel)
      if (chat) safe(() => mirrorInsight(chat[1], entry))
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

    mirrorReport(kind, chatId, dateKey, md) {
      const period = reportPeriodOf(kind, dateKey)
      if (!period) {
        logger.warn(`mirror: report dateKey 非法（${kind} ${dateKey}）——跳过镜像（不猜测类型）`)
        return
      }
      const titleKind = kind === 'daily' ? '日报' : kind === 'weekly' ? '周报' : '月报'
      safe(() =>
        dao.upsertReport({
          periodType: kind,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          title: `${titleKind} ${chatId} ${dateKey}`,
          contentMd: md,
          status: 'draft',
          chatId,
          docIdsHint: null,
        }),
      )
      // 报告落盘并行提取非对话资料入 doc 表（独立 safe，资料提取失败不影响报告镜像）
      safe(() => mirrorDocsFromReport(kind, chatId, dateKey, md))
    },

    mirrorDocsFromReport(kind, chatId, dateKey, md) {
      safe(() => mirrorDocsFromReport(kind, chatId, dateKey, md))
    },

    // v0.6：修订/标记镜像（接线由插件侧 P3 完成；此处只交付方法与幂等语义）
    mirrorReportRevision(chatId, periodType, periodStart, ts, type, opts) {
      const period = reportPeriodOf(periodType, periodStart)
      if (!period || period.periodStart !== periodStart) {
        logger.warn(`mirror: revision periodStart 非法（${periodType} ${periodStart}）——跳过镜像`)
        return false
      }
      const sourceKey =
        opts?.sourceKey ?? `rev:${chatId}:${periodType}:${periodStart}:${ts}:${type}`
      try {
        return dao.insertReportRevision({
          chatId,
          periodType,
          periodStart,
          ts,
          type,
          targetRef: opts?.targetRef ?? null,
          summary: opts?.summary ?? null,
          source: opts?.source ?? 'chat',
          sourceKey,
        }) !== null
      } catch (error) {
        logger.warn(`mirror: reportRevision 写入失败：${String(error).slice(0, 120)}`)
        return false
      }
    },

    finalizeReport(chatId, periodType, periodStart) {
      return dao.finalizeReport(periodType, periodStart, chatId)
    },

    mirrorMarking(chatId, kind, targetRef, ts, opts) {
      if (!targetRef) return false
      const sourceKey = opts?.sourceKey ?? `mark:${chatId}:${targetRef}:${ts}`
      try {
        return dao.insertMarking({
          chatId,
          kind,
          targetRef,
          ts,
          source: opts?.source ?? 'chat',
          sourceKey,
        }) !== null
      } catch (error) {
        logger.warn(`mirror: marking 写入失败：${String(error).slice(0, 120)}`)
        return false
      }
    },

    listMarkingsLatest(kind) {
      try {
        return (kind
          ? dao.listMarkingsLatest(kind)
          : dao.listMarkingsLatest()) as Array<{ chat_id: string; kind: string; target_ref: string; ts: number; source: string }>
      } catch {
        return []
      }
    },

    listRevisions(chatId, periodType, periodStart) {
      try {
        return dao
          .listRevisions(chatId, periodType)
          .filter((r) => r.period_start === periodStart)
          .map((r) => ({ ts: Number(r.ts), type: String(r.type), summary: r.summary === null ? null : String(r.summary), source: String(r.source) }))
      } catch {
        return []
      }
    },

    mirrorText(rel, text) {
      // 报告已改走 writeReport → mirrorReport（kind 显式通道，缺口 G1）。
      // 路径侧不再猜测类型（旧正则会把周/月报错标为 daily）——遇到报告路径直接跳过。
      if (DAILY_REPORT_RE.test(rel) || /^reports\/summary\//.test(rel)) {
        logger.debug?.(`mirror: report ${rel} 应经 writeReport 显式通道入镜像，路径侧跳过`)
        return
      }
      logger.debug?.(`mirror: no mapping for text ${rel}, skipped`)
    },

    close() {
      dao.close()
    },
  }
}
