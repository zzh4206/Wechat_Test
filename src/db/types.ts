/**
 * types.ts：src/db 数据层共享类型（字段名与冻结 schema 一一对应）。
 */

export type DocSourceType = 'manual' | 'chat_digest' | 'web' | 'file_import'
export type DocStatus = 'active' | 'archived'
export type ReportKind = 'daily' | 'weekly' | 'monthly'
export type ReportStatus = 'draft' | 'final'
export type EntryKind = 'note' | 'todo' | 'done' | 'idea' | 'issue'

export interface DocInput {
  title: string
  category?: string | null
  sourceType?: DocSourceType
  sourceRef?: string | null
  filePath?: string | null
  /** 正文；为空时 content_hash 必须为空（schema CHECK） */
  contentMd?: string | null
  status?: DocStatus
  /** 缺省取当前毫秒时间戳 */
  createdAt?: number
}

export interface EntryInput {
  /** 记录时间戳（毫秒） */
  ts: number
  kind?: EntryKind
  contentMd: string
  reportId?: number | null
  docId?: number | null
  createdAt?: number
}

export interface ReportInput {
  periodType: ReportKind
  /** YYYY-MM-DD */
  periodStart: string
  /** YYYY-MM-DD；缺省按周期规则由调用方保证一致（daily 同日等） */
  periodEnd: string
  title: string
  contentMd: string
  status?: ReportStatus
  docIdsHint?: string | null
  createdAt?: number
}

export interface ChatDigestInput {
  chatTopic: string
  digestMd: string
  /** YYYY-MM-DD 或 null */
  happenedOn?: string | null
  docId?: number | null
  /** 幂等键；冲突时 UPDATE（schema UNIQUE） */
  sourceKey?: string | null
  createdBy?: string
  createdAt?: number
}

export interface ReportRow {
  id: number
  period_type: string
  period_start: string
  period_end: string
  title: string
  content_md: string
  status: string
  doc_ids_hint: string | null
  created_at: number
  updated_at: number
}

export interface ReportFullRow extends ReportRow {
  entry_count: number
}

export interface EntryRow {
  id: number
  ts: number
  kind: string
  content_md: string
  report_id: number | null
  doc_id: number | null
  created_at: number
}

export interface DocRow {
  id: number
  title: string
  category: string | null
  source_type: string
  source_ref: string | null
  file_path: string | null
  content_md: string | null
  content_hash: string | null
  status: string
  created_at: number
  updated_at: number
}

export interface ChatDigestRow {
  id: number
  chat_topic: string
  digest_md: string
  happened_on: string | null
  doc_id: number | null
  source_key: string | null
  created_by: string
  created_at: number
}
