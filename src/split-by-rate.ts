// split-by-rate.ts —— T6：`splitByRate` 节奏分段纯函数（方案 B §4.1）。
//
// 设计要点（技术文档 TECH-DESIGN §4.1「burst 切分 + 冗余带」）：
//   1. 速率低谷切点：以 gapWindowMs 为窗宽，统计跨过每个候选位置的窗口消息密度，
//      在局部极小（含"整窗静默"这一最强低谷）处设候选切点（Kleinberg burst 模型的工程简化版）；
//   2. 段长钳制：段内消息数 ∈ [minSeg, maxSeg]，超长段在区间内次优低谷强制再切，不足 minSeg 的尾段并入前段；
//   3. 重叠带：相邻段共享 overlap 条消息（后段 overlapStart 向前延伸），重叠仅用于 prompt 上下文，
//      调用方按「非重叠区」[start, end) 去重——拼接所有段的非重叠区 = 全量索引，不重不漏；
//   4. 关联边保护：quoteOfMsgId 引用对的两端不得被切点拆散（同段，或被重叠带完整覆盖）；
//   5. 确定性：纯函数、不读盘不读钟，同输入同输出（tie-break 全部显式）。
//
// 输入消息只需最小结构 {ts, msgId?, quoteOfMsgId?}——StoredMessage（group-store.ts）
// 与 golden fixture 的 {ts, msgId} 均可直接传入（结构子类型兼容）。

/** 分段输入的最小消息结构（StoredMessage / golden fixture 消息均结构兼容） */
export interface RateSplitMessage {
  /** 毫秒时间戳（要求调用方按时间序传入） */
  ts: number
  /** 消息唯一 id（关联边保护时解析 quoteOfMsgId 指向；缺省按数组下标） */
  msgId?: string
  /** 引用链：被引用消息的 msg_id（group-store 真实字段名，SQL 侧 quote_of_msg_id） */
  quoteOfMsgId?: string | null
}

/** 分段选项 */
export interface SplitByRateOptions {
  /** 段内消息数下限（相邻短段合并阈值），默认 20 */
  minSeg?: number
  /** 段内消息数上限（超长段强制再切），缺省对齐 report.ts 的 BATCH_THRESHOLD_DEFAULT=120（即 safeBatch 量级） */
  maxSeg?: number
  /** 相邻段重叠条数（仅 prompt 上下文，去重按非重叠区），默认 8（技术文档 §4.1 取 5–10） */
  overlap?: number
  /** 速率统计滑动窗口宽度（毫秒），默认 10 分钟 */
  gapWindowMs?: number
}

/**
 * 分段结果：索引区间（左闭右开），指向输入 messages 的下标。
 *
 * 去重契约（重要）：[start, end) 是本段的「非重叠归属区」——所有段按序拼接
 * [start, end) 区间恰为 [0, n) 不重不漏，出稿阶段据此去重；[overlapStart, start)
 * 是与上一段共享的重叠带（首段 overlapStart === start，即空带），仅供 prompt
 * 注入上下文使用，不参与去重后的拼接。
 */
export interface RateSegment {
  /** 本段非重叠归属区起点（= 上一段 end） */
  start: number
  /** 本段非重叠归属区终点（= 下一段 start；末段 = n） */
  end: number
  /** 重叠带起点：[overlapStart, start) 为与上一段共享的上下文；首段 === start */
  overlapStart: number
}

/** 段长缺省上限：对齐 report.ts 的 safeBatch 缺省（BATCH_THRESHOLD_DEFAULT = 120） */
export const SPLIT_MAX_SEG_DEFAULT = 120

/**
 * 速率低谷节奏分段。输入须按 ts 升序；总消息数 < minSeg 时返回单段。
 * 纯函数：不读盘、不读钟，同输入同输出。
 */
export function splitByRate(
  messages: readonly RateSplitMessage[],
  opts: SplitByRateOptions = {},
): RateSegment[] {
  const n = messages.length
  const minSeg = Math.max(1, opts.minSeg ?? 20)
  const maxSeg = Math.max(minSeg, opts.maxSeg ?? SPLIT_MAX_SEG_DEFAULT)
  const overlap = Math.max(0, opts.overlap ?? 8)
  const gapWindowMs = opts.gapWindowMs ?? 10 * 60 * 1000

  if (n === 0) return []
  // 规则 5：总量不足 minSeg → 单段（无切点）
  if (n <= minSeg) return [{ start: 0, end: n, overlapStart: 0 }]

  // —— 规则 1：速率低谷候选切点 ——
  // 对每个候选位置 i（i 作为新段首条消息的下标，1 <= i <= n-1）：
  // 以相邻消息间隔中点为中心、gapWindowMs 为窗宽统计窗口内消息数 cnt(i)。
  // 相邻间隔 >= gapWindowMs 时窗口内只剩这对消息（cnt=2，理论最小），即"整窗静默"。
  // 局部极小（cnt(i) <= 左右邻居）才成为候选；连续并列极小取区间最靠中者，保证确定性。
  const cnt = new Array<number>(n).fill(0) // cnt[i] 对应候选位置 i
  const gapAt = new Array<number>(n).fill(0) // gapAt[i] = ts[i]-ts[i-1]，作次要排序键
  for (let i = 1; i < n; i++) {
    gapAt[i] = messages[i]!.ts - messages[i - 1]!.ts
    const mid = (messages[i - 1]!.ts + messages[i]!.ts) / 2
    let c = 0
    for (let j = 0; j < n; j++) {
      if (Math.abs(messages[j]!.ts - mid) <= gapWindowMs / 2) c++
    }
    cnt[i] = c
  }
  const candidates: number[] = []
  for (let i = 1; i < n; i++) {
    const leftCnt = i - 1 >= 1 ? cnt[i - 1]! : Number.MAX_SAFE_INTEGER
    const rightCnt = i + 1 < n ? cnt[i + 1]! : Number.MAX_SAFE_INTEGER
    if (cnt[i]! <= leftCnt && cnt[i]! <= rightCnt) candidates.push(i)
  }

  // —— 规则 4：关联边保护（预过滤） ——
  // quoteOfMsgId 指向的消息若也在本窗口内，构成引用对 (a, b)（a 为被引，b 为引用，a < b）。
  // 切点 c 落在 (a, b]（即 a < c <= b）且 a 不在后段重叠带内时禁止。
  // 解析不到目标（跨窗口引用）的边不构成约束。
  const idxOf = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const id = messages[i]!.msgId
    if (id !== undefined) idxOf.set(id, i)
  }
  const quotePairs: Array<[number, number]> = [] // [被引下标, 引用下标]，按引用方出现顺序
  for (let i = 0; i < n; i++) {
    const q = messages[i]!.quoteOfMsgId
    if (!q) continue
    const a = idxOf.get(q)
    if (a === undefined || a === i) continue
    quotePairs.push([Math.min(a, i), Math.max(a, i)])
  }
  // 切点 c 是否被保护禁止（考虑重叠带预覆盖：a >= c - overlap 即被带覆盖，允许）
  const forbidden = (c: number): boolean =>
    quotePairs.some(([a, b]) => a < c && c <= b && a < c - overlap)

  // —— 规则 2：贪心选点 + 段长钳制 ——
  // 从左到右，每段在 [pos+minSeg, pos+maxSeg] 内选最优低谷（cnt 升序 → 间隔降序 →
  // 距区间中点升序 → 下标升序，全显式 tie-break 保证确定性）；无候选则强制切在
  // pos+maxSeg（仍避开被保护的引用边）。尾段不足 minSeg 时并入前段（不超 maxSeg 前提）。
  const cuts: number[] = []
  let pos = 0
  while (pos < n) {
    const remaining = n - pos
    if (remaining <= maxSeg) {
      // 剩余虽可一段收尾，但若存在「整窗静默」强低谷（间隔 >= gapWindowMs，burst 语义上的
      // 明确话题断层），且两段都 >= minSeg，仍在此再切一刀——密集群聊里长静默是高置信切点
      let hard = -1
      for (const c of candidates) {
        if (c < pos + minSeg || c > n - minSeg) continue
        if (forbidden(c)) continue
        if (gapAt[c]! >= gapWindowMs) {
          // 强静默取「间隔最大」者（burst 断层最显著），并列取最早（确定性）
          if (hard < 0 || gapAt[c]! > gapAt[hard]!) hard = c
        }
      }
      if (hard >= 0) {
        cuts.push(hard)
        pos = hard
        continue
      }
      // 无强低谷：尾段不足 minSeg 且能并前段（前段不超 maxSeg）则并入
      const lastCut = cuts.length > 0 ? cuts[cuts.length - 1]! : 0
      if (remaining < minSeg && cuts.length > 0 && pos - lastCut + remaining <= maxSeg) {
        cuts.pop() // 撤销上一刀，尾部并入前段
      }
      break
    }
    const lo = pos + minSeg
    const hi = Math.min(pos + maxSeg, n - 1) // 新段至少留 1 条给再后段？不必——只保证 <=maxSeg
    const mid = (lo + hi) / 2
    let best = -1
    let bestKey: [number, number, number, number] | null = null
    for (const c of candidates) {
      // 范围钳制：候选新段长度 ∈ [minSeg, maxSeg]
      if (c < lo || c > pos + maxSeg || c >= n) continue
      if (forbidden(c)) continue
      const key: [number, number, number, number] = [cnt[c]!, -gapAt[c]!, Math.abs(c - mid), c]
      if (!bestKey || key < bestKey!) {
        bestKey = key
        best = c
      }
    }
    if (best < 0) {
      // 区间内无可用低谷：在 maxSeg 处强制再切，仍尽量避开引用边（向左微移）
      let c = Math.min(pos + maxSeg, n)
      while (c > lo && forbidden(c)) c--
      if (c <= lo) {
        // 向左避无可避（引用边密集）：向右越过引用对再切
        c = Math.min(pos + maxSeg, n)
        while (c < n && forbidden(c)) c++
      }
      best = Math.min(c, n)
    }
    cuts.push(best)
    pos = best
  }

  // —— 组装段 + 规则 3 重叠带 ——
  const bounds = [0, ...cuts, n]
  const segments: RateSegment[] = []
  for (let s = 0; s < bounds.length - 1; s++) {
    const start = bounds[s]!
    const end = bounds[s + 1]!
    let overlapStart = start
    if (s > 0) {
      // 重叠带 = 向前延伸 overlap 条，但不越过上一段起点
      overlapStart = Math.max(start - overlap, bounds[s - 1]!)
      for (const [a, b] of quotePairs) {
        if (a < start && start <= b && a < overlapStart && a >= bounds[s - 1]!) {
          overlapStart = a // 跨切引用对的被引端必须进带（保证关联对同段或带内覆盖）
        }
      }
    }
    segments.push({ start, end, overlapStart })
  }
  return segments
}
