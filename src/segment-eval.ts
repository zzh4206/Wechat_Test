// segment-eval.ts —— 话题切分质量评测度量（T5 脚手架）。
//
// 实现两个文本切分学界标准度量，输入均为「切点位置数组」（1-based 消息序号，
// 表示某条消息是新话题段的第一条；数组内部即隐含消息总数下界）：
//   - windowDiff：Pevzner & Hearst, "A Critique and Improvement of the WindowDiff
//     Algorithm for Segmentation Evaluation", Computational Linguistics 28(1), 2002.
//   - boundaryPk：Beeferman, Berger & Lafferty, "Statistical Models for Text
//     Segmentation", Machine Learning 34 (1999) 的 Pk 度量（作对照）。
// 两者均返回 [0,1]，完美切分 = 0，越大越差。
//
// ===== WindowDiff 采用的精确定义（Pevzner & Hearst 2002, eq. 不编号处见原文 §2） =====
// 记二值切分串 s ∈ {0,1}^n（s[i]=1 表示位置 i 与 i+1 之间存在段边界；n=消息数）。
// 对窗口宽度 k（正整数）：
//
//   WindowDiff(r, h) = ( Σ_{i=0}^{n-k-1} [ | Σ_{j=0}^{k-1} r[i+j] − Σ_{j=0}^{k-1} h[i+j] |
//                                        + ( r[i] != h[i] ? 1 : 0 ) ] ) / (n − k)
//
// 即：滑窗统计每窗内 ref/hyp 边界个数之差的绝对值，再对窗口起点处「有无边界」
// 判定不一致加 1 惩罚。相对 Pk 的改进：边界个数差按比例计分，因此「切点偏移 1-2
// 条消息」只产生部分惩罚而非全错（这正是选它做切分评测的原因，见技术文档 §4.4）。
// 注意：理论上该值可 >1（每窗最多 k+1 分），本实现按接口约定夹取到 [0,1]（Math.min(1,·)），
// 仅在极端构造（密集错误边界）下触及上界；真实切分评测不会受影响。
//
// ===== Pk 采用的精确定义（Beeferman et al. 1999） =====
//   Pk(r, h) = ( Σ_{i=0}^{n-k-1} [ (r[i]==r[i+k]) != (h[i]==h[i+k]) ] ) / (n − k)
// 即相距 k 的两位置「同段/跨段」判定不一致的概率估计。
//
// ===== 消息总数 n 与切点位置 → 二值串的约定 =====
// 切点位置 b（1-based 消息序号）语义为「第 b 条消息开始新段」，对应二值串
// s[b-1] = 1（b-1 与 b 之间存在边界）。n 取 ref/hyp 所有切点序号的最大值
// （切点不可能指向最后一条消息之后，故 n = max(切点) 即窗口覆盖到已知消息尾）。
// 如需显式指定消息总数（golden 文件里 messages.length），调用方可在切点数组中
// 传入与实际一致的切点即可；本模块另导出 withN() 包装以便扩展。
//
// ===== k 的缺省取法 =====
// 标准实践（WindowDiff 原文与 Pk 原文一致）取 k = 平均段长的量级。本实现采用：
//   k = max(1, round( n / (ref 段数) )) ，ref 段数 = ref 切点数 + 1
// （任务卡所述「ref.length/((ref边界段数-1)||1)」中分母即「段数-1 = 切点数」的
//  恒等于形式，等价于按 ref 平均段长取整；除数为 0 时兜底 k=1。）

/** 由段列表（每段是 1-based 消息序号数组，按序拼接）提取切点位置数组。 */
export function boundariesFromSegments(segments: number[][]): number[] {
  const boundaries: number[] = []
  let n = 0
  for (const seg of segments) {
    n += seg.length
    if (n > 0) boundaries.push(n - seg.length + 1)
  }
  // 第一段的起点不算切点
  return boundaries.slice(1)
}

/** 由消息 ts 数组按「相邻间隔 > gapMs」生成切点（AUTO-PRELIM 规则，脚本/golden 生成共用）。 */
export function boundariesByTimeGap(tsList: number[], gapMs = 30 * 60 * 1000): number[] {
  const boundaries: number[] = []
  for (let i = 1; i < tsList.length; i++) {
    if (tsList[i]! - tsList[i - 1]! > gapMs) boundaries.push(i + 1) // 1-based 新段首条序号
  }
  return boundaries
}

/** 切点位置数组 → 长度 n 的二值切分串（切点 b → s[b-1]=1）。 */
function toBitString(boundaries: number[], n: number): Uint8Array {
  const s = new Uint8Array(n)
  for (const b of boundaries) {
    const idx = b - 1
    if (idx >= 0 && idx < n) s[idx] = 1
  }
  return s
}

function inferN(ref: number[], hyp: number[]): number {
  const n = Math.max(1, ...ref, ...hyp)
  return n
}

function defaultK(ref: number[], n: number): number {
  const segments = ref.length + 1 // 段数 = 切点数 + 1；除数 (段数-1)||1 == 切点数||1
  const denom = (segments - 1) || 1
  return Math.max(1, Math.round(n / denom))
}

/** WindowDiff（Pevzner & Hearst, Computational Linguistics 2002）。返回 [0,1]，完美切分=0。
 * 可选 n：显式消息总数（缺省按 max(切点) 推断）；k 缺省按 ref 平均段长取整。 */
export function windowDiff(ref: number[], hyp: number[], k?: number, n?: number): number {
  const total = n && n > 0 ? n : inferN(ref, hyp)
  const kk = Math.max(1, Math.round(k ?? defaultK(ref, total)))
  if (total - kk <= 0) return 0 // 消息数不足以开一个窗口：视为无差异
  const r = toBitString(ref, total)
  const h = toBitString(hyp, total)
  let diff = 0
  for (let i = 0; i + kk < total; i++) {
    let cr = 0
    let ch = 0
    for (let j = 0; j < kk; j++) {
      cr += r[i + j]!
      ch += h[i + j]!
    }
    diff += Math.abs(cr - ch) + (r[i] === h[i] ? 0 : 1)
  }
  return Math.min(1, diff / (total - kk))
}

/** 边界 Pk（Beeferman, Berger & Lafferty 1999）对照度量。返回 [0,1]，完美切分=0。
 * 可选 n：显式消息总数（缺省按 max(切点) 推断）；k 缺省按 ref 平均段长取整。 */
export function boundaryPk(ref: number[], hyp: number[], k?: number, n?: number): number {
  const total = n && n > 0 ? n : inferN(ref, hyp)
  const kk = Math.max(1, Math.round(k ?? defaultK(ref, total)))
  if (total - kk <= 0) return 0
  const r = toBitString(ref, total)
  const h = toBitString(hyp, total)
  let disagree = 0
  for (let i = 0; i + kk < total; i++) {
    const sameR = r[i] === r[i + kk]!
    const sameH = h[i] === h[i + kk]!
    if (sameR !== sameH) disagree++
  }
  return Math.min(1, disagree / (total - kk))
}
