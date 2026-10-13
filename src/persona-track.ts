/**
 * persona-track.ts（M2-T2.1 关注名单 + M2-T2.4 按人检索）。
 *
 * 设计约定（docs/技术报告-D2分析与提醒助手实施计划.md §4-M2；功能文档 §3.1 §3.3）：
 * - 配置文件是关注名单的唯一入口：watchList 进，identities 表落；面板/指令入口留 M6；
 * - fail-closed：watchList 为空 ⇒ 本模块零活动（不建库、不写 identities、searchByPerson 恒 []）；
 * - 归一键是 **wxid**：同名不同 wxid 视为不同人；同一 wxid 在不同群的昵称差异被归一
 *   （检索只按 wxid/派生 pid 关联 messages.sender_pid，绝不按昵称匹配）；
 * - wxid → 群内昵称解析复用 W3 的 NicknameResolver 映射链（本模块只读其导出接口，
 *   不重复实现 sqlcipher 查询；解析失败降级为空昵称，不阻断）；
 * - identities.pid 由 wxid 确定性派生（derivePid：wx_ + sha256 前 12 位），
 *   跨群稳定、可重放；未代号化消息的 sender_pid 本就是 wxid，两条键都参与匹配；
 * - "一键收藏到事件库"只留 insertEvent 占位（M4 填实现）；
 * - 不发送任何消息、零第三方依赖、只读小号库（经 NicknameResolver 的只读通道）。
 */
import { createHash } from 'node:crypto'
import type { GroupStoreService, StoredMessage } from './group-store.js'
import type { StoreLogger } from './store.js'

/** wxid → 群内显示名映射（NicknameResolver 的结构子集，测试可注入 mock） */
export interface NicknameMapSource {
  resolveGroup(chatId: string): Promise<Map<string, string>>
}

/** 关注名单条目（Config 唯一入口，M6 前不经面板/指令修改） */
export interface WatchListEntry {
  /** 微信 wxid（归一键；同名不同 wxid = 不同人） */
  wxid: string
  /** 备注（写 identities.remark，便于人工核对） */
  remark?: string
  /** 生效范围：'global'（默认，全部白名单群）| { groups: [chatId] }（指定群） */
  scope?: 'global' | { groups: string[] }
}

/** watch_level 取值（= identities.watch_level CHECK 约束） */
export type WatchLevel = 'global' | 'group' | 'off'

/** 单条按人检索命中：发言 + 出处（群 / 时间 / 原文） */
export interface PersonHit {
  chatId: string
  msgId: string
  ts: number
  /** 实际命中键：wxid 或其派生 pid */
  senderPid: string
  /** 群内显示名快照（原文出处的一部分） */
  senderName: string
  kind: string
  /** 原文全文（截断不做——出处完整性优先，展示层自行截断） */
  text: string
}

export interface SearchByPersonOptions {
  afterTs?: number
  beforeTs?: number
  /** 返回条数上限（默认 100，按 ts 降序取最近） */
  limit?: number
}

export interface SyncResult {
  /** 本次写入/更新 identities 行数（跨群累计；空名单 = 0 且未开任何库） */
  rows: number
  /** 实际同步到的群 */
  chats: string[]
}

/** 由 wxid 确定性派生 identities.pid（跨群稳定；sha256 前 12 位防枚举原文） */
export function derivePid(wxid: string): string {
  return `wx_${createHash('sha256').update(wxid, 'utf8').digest('hex').slice(0, 12)}`
}

/** wxid 归一：trim；空串拒绝（fail-closed：空 wxid 不是人） */
export function normalizeWxid(raw: string): string {
  return String(raw ?? '').trim()
}

export interface PersonaTrackOptions {
  groupStore: GroupStoreService
  logger: StoreLogger
}

export class PersonaTrackService {
  private readonly groupStore: GroupStoreService
  private readonly logger: StoreLogger
  /** W3 昵称映射链（可选注入；未配置 wechat-db 源时为 null → group_nick 落 remark 兜底） */
  private nicknameSource: NicknameMapSource | null = null
  /** 当前生效名单（归一后 wxid → entry）；空 Map = 零追踪 */
  private watched = new Map<string, WatchListEntry>()

  constructor(options: PersonaTrackOptions) {
    this.groupStore = options.groupStore
    this.logger = options.logger
  }

  /** 注入昵称映射源（NicknameResolver）；可多次覆盖（apply 启动时接线） */
  setNicknameSource(source: NicknameMapSource | null): void {
    this.nicknameSource = source
  }

  /** 当前被追踪的 wxid 列表（观测用；空数组 = 零追踪） */
  watchedWxids(): string[] {
    return [...this.watched.keys()]
  }

  /** 某人是否被追踪 */
  isWatched(wxid: string): boolean {
    return this.watched.has(normalizeWxid(wxid))
  }

  /**
   * 把 watchList 同步进各群 store.db 的 identities 表（M2-T2.1）。
   * - 空名单：直接返回，**不开任何库、不写任何行**（fail-closed 零活动）；
   * - scope 映射：'global' → 白名单所有群 'global'；{groups} → 命中群 'group'、其余群 'off'
   *   （上次同步过 global 本次收窄为 off：降级写回，绝不留幽灵追踪）；
   * - 昵称解析失败只 warn 降级，不阻断同步。
   */
  async syncWatchList(watchList: readonly WatchListEntry[], groupChatIds: readonly string[]): Promise<SyncResult> {
    // fail-closed：空名单 = 零追踪零活动
    if (!Array.isArray(watchList) || watchList.length === 0) {
      this.watched = new Map()
      return { rows: 0, chats: [] }
    }
    const next = new Map<string, WatchListEntry>()
    for (const entry of watchList) {
      const wxid = normalizeWxid(entry?.wxid ?? '')
      if (wxid === '') {
        this.logger.warn(`persona-track: watchList entry with empty wxid skipped`)
        continue
      }
      next.set(wxid, entry)
    }
    this.watched = next
    if (next.size === 0) return { rows: 0, chats: [] }

    const chats = [...new Set(groupChatIds)]
    let rows = 0
    for (const chatId of chats) {
      // 预取该群 wxid → 显示名映射（一次一群；失败降级空映射）
      let nameMap = new Map<string, string>()
      if (this.nicknameSource) {
        try {
          nameMap = await this.nicknameSource.resolveGroup(chatId)
        } catch (error) {
          this.logger.warn(`persona-track: nickname map unavailable for ${chatId}, degrade to remark: ${String(error).slice(0, 160)}`)
        }
      }
      for (const [wxid, entry] of next) {
        const level = watchLevelFor(entry, chatId)
        const groupNick = nameMap.get(wxid) ?? ''
        const ok = await this.groupStore.appendIdentity(chatId, {
          pid: derivePid(wxid),
          wxid,
          groupNick,
          remark: entry.remark ?? '',
          watchLevel: level,
        })
        if (ok) rows += 1
      }
    }
    return { rows, chats }
  }

  /**
   * 按人检索（M2-T2.4）：跨群（chatId='all' 时遍历**已打开**的群库，不为此新开库——
   * 不建全量索引）返回该人含关键词的发言及出处。
   * fail-closed：空名单 → []；目标 wxid 不在名单 → []（只检索被关注者）。
   */
  async searchByPerson(
    chatId: string | 'all',
    wxid: string,
    keyword?: string,
    opts: SearchByPersonOptions = {},
  ): Promise<PersonHit[]> {
    const id = normalizeWxid(wxid)
    if (id === '' || this.watched.size === 0 || !this.watched.has(id)) return []
    // 归一匹配键：未代号化消息 sender_pid=wxid；已代号化的 sender_pid=派生 pid。两条都试。
    const keys = [id, derivePid(id)]
    const chats = chatId === 'all' ? this.groupStore.openedChats() : [chatId]
    const hits: PersonHit[] = []
    for (const c of chats) {
      const msgs = this.groupStore.searchByPerson(c, keys, keyword, opts)
      for (const m of msgs) hits.push(toHit(c, m))
    }
    const limit = Math.max(0, Math.floor(opts.limit ?? 100))
    hits.sort((a, b) => b.ts - a.ts)
    return hits.slice(0, limit)
  }

  /**
   * 一键收藏到事件库——**占位 stub，M4 填实现**（对接 F5：events 表写入 + 证据链）。
   * 现在只记日志并返回 null，不写库，不抛错打断调用方。
   */
  async insertEvent(chatId: string, hit: PersonHit, statement?: string): Promise<null> {
      this.logger.warn(
        `persona-track: insertEvent TODO(M4) chatId=${chatId} msgId=${hit.msgId}` +
          (statement ? ` statement=${statement.slice(0, 40)}` : ''),
      )
    return null
  }
}

/** scope → 该群的 watch_level 映射 */
function watchLevelFor(entry: WatchListEntry, chatId: string): WatchLevel {
  const scope = entry.scope ?? 'global'
  if (scope === 'global') return 'global'
  const groups = Array.isArray(scope?.groups) ? scope.groups : []
  return groups.includes(chatId) ? 'group' : 'off'
}

function toHit(chatId: string, m: StoredMessage): PersonHit {
  return {
    chatId,
    msgId: m.msgId,
    ts: m.ts,
    senderPid: m.senderPid,
    senderName: m.senderName,
    kind: m.kind,
    text: m.text,
  }
}
