#!/usr/bin/env node
// synth-gen.mjs —— 合成基准输入侧 L2：按代理画像生成确定性合成会话 + 植入真值。
//
// 设计要点（见 docs 中的合成基准方法论）：
// - 只用画像里的统计量（条数/分时/间隔/长度/类型占比/参与者）采样，**不读任何真实语料**；
// - 文本来自本文件内的原创模板池（作业/比赛/聚餐/课程/技术讨论 + 问候/表情/闲聊/长公告/引用），
//   不复制、不读取真实聊天记录；
// - 发送者一律假名 `u1..uN`，时间戳从固定合成纪元起算（与真实 ts 无关）；
// - 生成时**刻意植入**话题/任务/引用三类真值，写进 manifest.json 供质量评测算召回；
// - 自实现 mulberry32：同 seed + 同 profile + 同 days → 逐字节相同输出。
//
// 用法：
//   node scripts/synth-gen.mjs --demo --seed 42 --days 3 --out <dir>
//   node scripts/synth-gen.mjs --profile profile.json --seed 42 --days 3 --out <dir>
//
// 行号口径：stream.jsonl 的行号 = 0-based 下标（manifest 的 msgIdx / pair 同口径）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEMO_PROFILE } from './synth-profile.mjs'

export const GEN_VERSION = 1
// 固定合成纪元：2026-10-21T00:00:00Z。与真实数据无关，保证跨机器、跨时间一致。
export const GEN_BASE_TS = Date.UTC(2026, 9, 21, 0, 0, 0)

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MAX_DAYS = 90

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

// —————————————— 确定性 PRNG（mulberry32） ——————————————

/** mulberry32：32 位种子 → [0,1) 均匀流；无外部依赖，跨平台一致 */
export function mulberry32(seed) {
  let a = Number(seed) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function randInt(rng, min, max) {
  if (max <= min) return min
  return min + Math.floor(rng() * (max - min + 1))
}

function pick(rng, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]
}

function weightedIndex(rng, weights) {
  let total = 0
  for (const w of weights) total += Number.isFinite(w) && w > 0 ? w : 0
  if (!(total > 0)) return 0
  let r = rng() * total
  for (let i = 0; i < weights.length; i++) {
    const w = Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0
    r -= w
    if (r < 0) return i
  }
  return weights.length - 1
}

/** 标准正态（Box–Muller）；拒绝 0 以避免 log(0) */
function gauss(rng) {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// —————————————— 模板池（全部为原创合成文本） ——————————————

export const TOPIC_LIBRARY = [
  {
    title: '期中考试安排',
    keywords: ['期中考试', '考场', '复习'],
    messages: [
      '通知一下，期中考试安排已经发到群里：下周三上午在二教考高数。',
      '期中考试的考场按学号分，复习范围是前六章，大家把错题再过一遍。',
      '收到，我把期中考试的复习提纲整理成两页，晚上发群里。',
    ],
  },
  {
    title: '周末聚餐报名',
    keywords: ['聚餐', '报名', '周六'],
    messages: [
      '这周六晚上聚餐，地点还是东门那家小馆，想来的在下面接龙。',
      '聚餐报名截止到周五中午，人均预算六十，忌口的提前说。',
      '我先报名，周六聚餐可以带一位朋友吗？',
    ],
  },
  {
    title: '编程比赛组队',
    keywords: ['比赛', '组队', '报名'],
    messages: [
      '下个月的编程比赛开始报名了，想组队的在群里说一声。',
      '比赛是三人一队，我这边还差一个写前端的，有意向的私聊。',
      '组队报名表我做好了，比赛截止前大家把队名填上。',
    ],
  },
  {
    title: '课程作业截止',
    keywords: ['作业', '截止', '提交'],
    messages: [
      '提醒一下，课程作业的截止时间改到周日晚上十二点。',
      '作业提交在课程平台，文件名按学号命名，别交错了。',
      '这次作业有两道附加题，做不完也不影响及格。',
    ],
  },
  {
    title: '实验室设备借用',
    keywords: ['实验室', '设备', '借用'],
    messages: [
      '实验室新到两台示波器，需要借用的填一下登记表。',
      '设备借用只能当天归还，实验室晚上十点关门。',
      '我周三下午去实验室借设备，有一起的吗？',
    ],
  },
  {
    title: '技术分享会',
    keywords: ['分享会', '技术', '周四'],
    messages: [
      '周四晚上有技术分享会，主题是数据库索引优化。',
      '技术分享会的地点在三楼会议室，线上同步开个会议链接。',
      '分享会讲稿我整理好了，技术细节可以在群里继续问。',
    ],
  },
]

export const TASK_LIBRARY = [
  {
    statement: '周日前交实验报告',
    keywords: ['实验报告', '周日'],
    messages: [
      '周日前交实验报告：提交到课程平台，报告里附上数据表。',
      '再说一次，周日前交实验报告，迟交的这周找时间补。',
    ],
  },
  {
    statement: '周五前把报名表填好',
    keywords: ['报名表', '周五'],
    messages: [
      '周五前把报名表填好，队名和学号都要写清楚。',
      '提醒：周五前把报名表填好，我统一交到办公室。',
    ],
  },
  {
    statement: '下周一带电脑做展示',
    keywords: ['下周一', '电脑', '展示'],
    messages: [
      '下周一带电脑做展示，每人五分钟，提前把幻灯片拷到公用机。',
      '展示顺序抽签决定，下周一带电脑别迟到。',
    ],
  },
  {
    statement: '周六上午十点集合',
    keywords: ['周六', '十点', '集合'],
    messages: [
      '周六上午十点集合，地点在南门，别迟到。',
      '再确认一下：周六上午十点集合，带好水和外套。',
    ],
  },
  {
    statement: '周三前归还借的设备',
    keywords: ['周三', '归还', '设备'],
    messages: [
      '周三前归还借的设备，登记表上签个字。',
      '借设备的同学注意，周三前归还借的设备。',
    ],
  },
  {
    statement: '月底前提交项目总结',
    keywords: ['月底', '项目总结'],
    messages: [
      '月底前提交项目总结，两页以内，写清楚分工。',
      '项目总结月底前提交，模板我发到群文件。',
    ],
  },
]

const SENTENCE_POOLS = {
  greeting: [
    '大家早上好，今天有早课吗？',
    '晚上好，群里还有人吗？',
    '好久不见，最近都在忙什么？',
    '早上好，今天记得带伞。',
  ],
  emoji: ['[赞]', '[捂脸]', '[笑哭]', '[OK]', '[加油]', '[吃瓜]'],
  chat: [
    '我刚看到消息，等我确认一下再回复。',
    '这个我同意，不过时间还得再排一排。',
    '有人知道明天几点开始吗？',
    '我先去吃饭，回来再说。',
    '收到，我晚点把东西发群里。',
    '刚才那条消息我没看全，能再说一遍吗？',
    '今天人好多，排队排了二十分钟。',
    '这个周末大家有空吗？',
    '我把文件放到群共享了，需要的自取。',
    '不好意思，刚才在地铁里没信号。',
  ],
  homework: [
    '第三章的习题有人做了吗？我对一下答案。',
    '作业要求写多少字？我记成两千了。',
    '老师说这次作业算平时分，别忘交。',
    '我把解题思路拍下来了，晚点发群里。',
  ],
  contest: [
    '比赛报名还差两个人，有兴趣的可以一起。',
    '去年的比赛题目挺难的，今年不知道怎么样。',
    '组队的话建议一个写代码一个写文档。',
    '比赛结果好像下周才公布。',
  ],
  dinner: [
    '聚餐的店我订好了，六人桌。',
    '有人不吃辣吗？点菜的时候注意一下。',
    '吃完饭要不要去附近走走？',
    '这次聚餐就按人头平摊吧。',
  ],
  course: [
    '课程群里的通知大家看到了吗？',
    '下周的课调到下午了，别记错时间。',
    '老师说要带计算器，考场不提供。',
    '课件我下载了，放在群文件里。',
  ],
  tech: [
    '这个接口的返回格式又变了，文档还没更新。',
    '本地跑没问题，部署之后就报超时。',
    '我建议先把日志加上，再定位是哪一步慢。',
    '依赖版本锁一下，不然下次装又不一样。',
    '这段逻辑可以拆成两个函数，读起来清楚些。',
  ],
}

const ANNOUNCEMENTS = [
  '统一通知一下：本周的课程安排有调整，周三下午的课改到周四上午，地点不变。请大家提前查看课程平台上的最新课表，有冲突的及时在群里说。另外，实验课的分组名单已经发到群文件，每组三个人，组长负责收齐实验报告，周五之前交给助教。',
  '关于下周活动的安排：周六上午九点半在南门集合，统一坐车过去，中午在附近吃饭，下午三点左右返回。报名截止到周四晚上，费用先按人头收，多退少补。需要带的东西：学生证、水杯、一件外套。有特殊情况来不了的提前请假。',
  '提醒几件事：第一，作业提交截止时间改到周日晚上，逾期系统关闭；第二，下周的课调到下午两点，教室不变；第三，实验报告需要附上原始数据表，纸质版交给班长；第四，有问题的在群里问，看到会回复。',
]

const FILLERS = [
  '细节我晚点再补充。',
  '有不同意见的可以直接说。',
  '我先记下来了。',
  '具体安排以群里的通知为准。',
  '大家互相转告一下。',
  '有问题随时在群里问。',
]

const SHORT_LINES = ['收到', '好的', '我看看', '稍等', '可以', '没问题', '在的', '嗯嗯', '马上到', '我同意']

const QUOTE_REPLIES = [
  '引用上一条：我同意这个安排，时间上我这边没问题。',
  '回复一下，刚才提到的那个时间我也可以。',
  '引用之后补充一句：地点如果变了记得再说一声。',
  '看到引用了，我这边按原计划准备。',
  '同意上一条，不过最好再确认一下人数。',
]

const KIND_TEXT = {
  image: '[图片]',
  file: '[文件]',
  voice: '[语音]',
  system: '系统：一位成员加入了群聊',
}

const CATEGORY_NAMES = ['greeting', 'emoji', 'chat', 'homework', 'contest', 'dinner', 'course', 'tech']
const ALL_SENTENCES = Object.values(SENTENCE_POOLS).flat()
const CATEGORY_WEIGHTS = [0.07, 0.05, 0.3, 0.12, 0.1, 0.1, 0.14, 0.12]

// —————————————— 画像校验与采样 ——————————————

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('画像必须是 JSON 对象')
  const required = [
    'version',
    'days',
    'msgsPerDay',
    'hourlyCurve',
    'gapMsLogBuckets',
    'textLen',
    'ratios',
    'participants',
    'selfReplyRate',
  ]
  for (const key of required) {
    if (profile[key] === undefined || profile[key] === null) throw new Error(`画像缺少字段: ${key}`)
  }
  if (!Array.isArray(profile.hourlyCurve) || profile.hourlyCurve.length !== 24) {
    throw new Error('画像 hourlyCurve 必须是长度 24 的数组')
  }
  if (!Array.isArray(profile.gapMsLogBuckets) || profile.gapMsLogBuckets.length === 0) {
    throw new Error('画像 gapMsLogBuckets 必须是非空数组')
  }
  if (!(Number(profile.msgsPerDay?.mean) > 0)) throw new Error('画像 msgsPerDay.mean 必须为正数')
  return profile
}

/** 每日条数：以 mean 为中心、用 p50/p95 推标准差，再钳制到 mean±15%（保证总带宽） */
function sampleDayCount(msgsPerDay, rng) {
  const mean = Number(msgsPerDay.mean)
  const p50 = Number(msgsPerDay.p50 ?? mean)
  const p95 = Number(msgsPerDay.p95 ?? mean)
  const sigma = Math.max(1, Math.min((Math.max(p95, mean) - Math.min(p50, mean)) / 1.645, mean * 0.08))
  const n = Math.round(mean + sigma * gauss(rng))
  const lo = Math.max(1, Math.floor(mean * 0.85))
  const hi = Math.max(lo, Math.ceil(mean * 1.15))
  return clamp(n, lo, hi)
}

/** 文本目标长度：95% 落在 [2,p95]，5% 尾巴落在 (p95,maxChars]，形状由 zipfAlpha 控制 */
function sampleTextLength(textLen, rng) {
  const maxChars = clamp(Math.round(Number(textLen.maxChars ?? 400)), 8, 4000)
  const p95 = clamp(Math.round(Number(textLen.p95 ?? 120)), 4, maxChars)
  const alpha = clamp(Number(textLen.zipfAlpha ?? 1.4), 1.05, 3)
  const min = 2
  const u = rng()
  if (u < 0.95) return Math.round(min + (p95 - min) * Math.pow(u / 0.95, 1 / alpha))
  return Math.round(p95 + (maxChars - p95) * ((u - 0.95) / 0.05))
}

// —————————————— 时间戳采样 ——————————————

/** 小时内偏移：按画像间隔分桶采样 gap，再缩放进当前小时（保持相对间隔形状） */
function buildHourOffsets(count, gapBuckets, rng) {
  if (count <= 1) return [Math.floor(rng() * HOUR_MS)]
  const ps = gapBuckets.map((b) => Number(b.p))
  const gaps = []
  for (let i = 0; i < count - 1; i++) {
    const b = weightedIndex(rng, ps)
    const prevMax = b === 0 ? 1 : Number(gapBuckets[b - 1]?.max ?? 1)
    const bucketMax = Number(gapBuckets[b]?.max ?? HOUR_MS)
    const lo = clamp(prevMax, 1, HOUR_MS - 1)
    const hi = clamp(Math.max(bucketMax, lo + 1), lo + 1, HOUR_MS)
    const g = Math.exp(Math.log(lo) + rng() * (Math.log(hi) - Math.log(lo)))
    gaps.push(Math.max(1, Math.round(g)))
  }
  const total = gaps.reduce((s, g) => s + g, 0)
  const span = HOUR_MS * 0.9
  const scale = total > span ? span / total : 1
  let acc = Math.floor(rng() * Math.max(1, HOUR_MS - span))
  const offsets = [Math.round(acc)]
  for (const g of gaps) {
    acc += g * scale
    offsets.push(Math.round(acc))
  }
  offsets.sort((a, b) => a - b)
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] <= offsets[i - 1]) offsets[i] = offsets[i - 1] + 1
  }
  if (offsets[offsets.length - 1] >= HOUR_MS) {
    // 极端密集中小时内偏移溢出：线性重排回小时内（确定性）
    for (let i = 0; i < offsets.length; i++) {
      offsets[i] = Math.floor((i * (HOUR_MS - 1)) / Math.max(1, offsets.length - 1))
    }
  }
  return offsets
}

/** 一天的 ts：先按 hourlyCurve 给每条消息分小时，再在小时内按 gap 分桶布点 */
function buildDayTimes(dayStart, count, hourlyCurve, gapBuckets, rng) {
  const perHour = new Array(24).fill(0)
  for (let i = 0; i < count; i++) perHour[weightedIndex(rng, hourlyCurve)]++
  const times = []
  for (let h = 0; h < 24; h++) {
    if (perHour[h] === 0) continue
    for (const off of buildHourOffsets(perHour[h], gapBuckets, rng)) {
      times.push(dayStart + h * HOUR_MS + off)
    }
  }
  return times
}

// —————————————— 文本生成 ——————————————

function buildGenericText(profile, rng) {
  const textLen = profile.textLen ?? DEMO_PROFILE.textLen
  const maxChars = clamp(Math.round(Number(textLen.maxChars ?? 400)), 8, 4000)
  const target = clamp(sampleTextLength(textLen, rng), 2, maxChars)
  const category = CATEGORY_NAMES[weightedIndex(rng, CATEGORY_WEIGHTS)]

  if (target <= 12) return pick(rng, SHORT_LINES)
  if (category === 'emoji') return pick(rng, SENTENCE_POOLS.emoji)

  if (target > 160 && rng() < 0.7) {
    let out = pick(rng, ANNOUNCEMENTS)
    let guard = 0
    while (out.length < target && guard++ < 8) {
      const f = pick(rng, FILLERS)
      if (out.length + f.length > maxChars) break
      out += f
    }
    return out.length > maxChars ? out.slice(0, maxChars) : out
  }

  const categoryPool = SENTENCE_POOLS[category] ?? SENTENCE_POOLS.chat
  const pool = target > 80 ? [...ALL_SENTENCES, ...FILLERS] : [...categoryPool, ...FILLERS]
  const used = new Set()
  let out = ''
  let guard = 0
  while (out.length < target && guard++ < 32) {
    // 首句优先用话题句（避免消息以连接性套话开头），之后优先用本条未出现过的句子；
    // 长消息可跨话题取句，降低同一句在一条消息里反复出现的机械感。
    const base = out === '' ? categoryPool : pool
    const fresh = base.filter((s) => !used.has(s))
    const sentence = fresh.length > 0 ? pick(rng, fresh) : pick(rng, pool)
    if (out.length + sentence.length > maxChars) break
    out += sentence
    used.add(sentence)
  }
  if (!out) out = '收到'
  return out.length > maxChars ? out.slice(0, maxChars) : out
}

// —————————————— 植入真值 ——————————————

function makeReserver(n, used, rng) {
  return function reserve(span, minAnchor = 0) {
    const maxAnchor = n - span
    if (maxAnchor < minAnchor) return -1
    for (let tries = 0; tries < n * 2; tries++) {
      const a = randInt(rng, minAnchor, maxAnchor)
      let ok = true
      for (let k = 0; k < span; k++) {
        if (used[a + k]) {
          ok = false
          break
        }
      }
      if (ok) {
        for (let k = 0; k < span; k++) used[a + k] = 1
        return a
      }
    }
    for (let a = minAnchor; a <= maxAnchor; a++) {
      let ok = true
      for (let k = 0; k < span; k++) {
        if (used[a + k]) {
          ok = false
          break
        }
      }
      if (ok) {
        for (let k = 0; k < span; k++) used[a + k] = 1
        return a
      }
    }
    return -1
  }
}

function planGroundTruth(n, days, rng) {
  const used = new Uint8Array(n)
  const role = new Array(n).fill(null)
  const reserve = makeReserver(n, used, rng)

  const topicCount = days * 2
  const taskCount = Math.max(1, Math.round((days * 4) / 3))
  const quoteCount = Math.max(2, Math.round((days * 8) / 3))

  const topics = []
  for (let i = 0; i < topicCount; i++) {
    const entry = TOPIC_LIBRARY[i % TOPIC_LIBRARY.length]
    const a = reserve(3)
    if (a < 0) throw new Error('消息条数不足以植入话题真值（可减少 --days 或增大画像 mean）')
    for (let k = 0; k < 3; k++) role[a + k] = { type: 'topic', entry, slot: k }
    topics.push({ id: `t${i + 1}`, title: entry.title, msgIdx: [a, a + 1, a + 2] })
  }

  const tasks = []
  for (let i = 0; i < taskCount; i++) {
    const entry = TASK_LIBRARY[i % TASK_LIBRARY.length]
    const a = reserve(1)
    if (a < 0) throw new Error('消息条数不足以植入任务真值（可减少 --days 或增大画像 mean）')
    role[a] = { type: 'task', entry }
    tasks.push({ id: `k${i + 1}`, statement: entry.statement, evidenceIdx: a })
  }

  const quotes = []
  for (let i = 0; i < quoteCount; i++) {
    // 引用必须指向更早的行，故锚点至少为 1
    const j = reserve(1, 1)
    if (j < 0) throw new Error('消息条数不足以植入引用真值（可减少 --days 或增大画像 mean）')
    const target = randInt(rng, Math.max(0, j - 80), j - 1)
    role[j] = { type: 'quote', target }
    quotes.push({ pair: [target, j] })
  }

  return { role, topics, tasks, quotes }
}

// —————————————— 主生成器 ——————————————

/**
 * 生成合成会话。
 * @param {object} profile  画像（schema 见 synth-profile.mjs）
 * @param {number} [seed]   PRNG 种子（默认取 profile.seed ?? 42）
 * @param {number} [days]   天数（默认取 profile.days ?? 3）
 * @returns {{stream: string, manifest: object}} stream 为 JSONL 文本，manifest 为植入真值
 */
export function generate(profile, seed, days) {
  validateProfile(profile)
  const seedNum = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : Number(profile.seed ?? 42) >>> 0
  const daysNum = Number.isFinite(Number(days)) ? Math.round(Number(days)) : Number(profile.days ?? 3)
  if (!(daysNum >= 1 && daysNum <= MAX_DAYS)) {
    throw new Error(`days 必须在 1..${MAX_DAYS} 之间`)
  }

  const rng = mulberry32(seedNum)

  // 1) 每日条数 → 总条数
  const dayCounts = []
  for (let d = 0; d < daysNum; d++) dayCounts.push(sampleDayCount(profile.msgsPerDay, rng))
  const n = dayCounts.reduce((s, c) => s + c, 0)

  // 2) 时间戳（先按天生成再全局排序；同 ts 时用下标稳定兜底）
  const tsRaw = []
  for (let d = 0; d < daysNum; d++) {
    tsRaw.push(
      ...buildDayTimes(
        GEN_BASE_TS + d * DAY_MS,
        dayCounts[d],
        profile.hourlyCurve,
        profile.gapMsLogBuckets,
        rng,
      ),
    )
  }
  const order = tsRaw.map((_, i) => i).sort((a, b) => tsRaw[a] - tsRaw[b] || a - b)
  const ts = order.map((i) => tsRaw[i])
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] <= ts[i - 1]) ts[i] = ts[i - 1] + 1
  }

  // 3) 发送者（假名 u1..uN；连续同一发送者率按 selfReplyRate 精确控制）
  const participantCount = Math.max(1, Math.round(Number(profile.participants?.count ?? 12)))
  const topShare = clamp(Number(profile.participants?.topShare ?? 0.35), 0, 1)
  const others = Math.max(1, participantCount - 1)
  const senderWeights = [
    participantCount === 1 ? 1 : topShare,
    ...new Array(others).fill(participantCount === 1 ? 0 : (1 - topShare) / others),
  ]
  const selfRate = clamp(Number(profile.selfReplyRate ?? 0.18), 0, 1)
  // 独立加权采样本身的「自然连续率」q=Σw²。要让最终连续同发送者率精确等于
  // selfRate，又尽量不扭曲 topShare：
  //   selfRate ≥ q：以 s=(selfRate-q)/(1-q) 的概率强制沿用上一位，其余按原权重抽；
  //   selfRate < q：不加 s，抽到上一位时以 keep=selfRate/q 的概率保留，否则排除重抽。
  const naturalSame = senderWeights.reduce((sum, w) => sum + w * w, 0)
  const forceSameProb =
    selfRate >= naturalSame ? (naturalSame >= 1 ? 0 : (selfRate - naturalSame) / (1 - naturalSame)) : 0
  const keepOnCollision = naturalSame > 0 ? Math.min(1, selfRate / naturalSame) : 0
  const maskCollisions = selfRate < naturalSame
  const senderIdx = new Array(n).fill(0)
  let prevSender = -1
  for (let i = 0; i < n; i++) {
    let idx
    if (prevSender >= 0 && rng() < forceSameProb) {
      idx = prevSender
    } else {
      idx = weightedIndex(rng, senderWeights)
      if (maskCollisions && prevSender >= 0 && idx === prevSender && participantCount > 1) {
        if (rng() >= keepOnCollision) {
          const masked = senderWeights.map((w, k) => (k === prevSender ? 0 : w))
          idx = weightedIndex(rng, masked)
        }
      }
    }
    senderIdx[i] = idx
    prevSender = idx
  }

  // 4) 植入真值占位
  const { role, topics, tasks, quotes } = planGroundTruth(n, daysNum, rng)

  // 5) 类型：植入位一律 text；其余按画像 ratios 采样
  const ratios = profile.ratios ?? DEMO_PROFILE.ratios
  const nonText = [
    ['image', Number(ratios.image ?? 0)],
    ['file', Number(ratios.file ?? 0)],
    ['voice', Number(ratios.voice ?? 0)],
    ['system', Number(ratios.system ?? 0)],
  ]
  const nonTextSum = nonText.reduce((s, [, w]) => s + Math.max(0, w), 0)
  const kindWeights = [...nonText.map(([, w]) => Math.max(0, w)), Math.max(0, 1 - nonTextSum)]
  const kindNames = [...nonText.map(([k]) => k), 'text']
  // 被引用的一侧必须是可读文本（否则「引用一张图」在结构上不自然）
  const quoteTargets = new Set(quotes.map((q) => q.pair[0]))
  const kinds = role.map((r, i) =>
    r || quoteTargets.has(i) ? 'text' : kindNames[weightedIndex(rng, kindWeights)],
  )

  // 6) 引用：植入对优先；其余按 ratios.quote 在 text 上随机回指更早的 text 行
  const quoteOf = new Array(n).fill(null)
  const quoteRatio = clamp(Number(ratios.quote ?? 0), 0, 1)
  for (let i = 0; i < n; i++) {
    const r = role[i]
    if (r?.type === 'quote') {
      quoteOf[i] = r.target
      continue
    }
    if (r) continue
    if (kinds[i] === 'text' && i > 0 && rng() < quoteRatio) {
      const lo = Math.max(0, i - 60)
      const candidates = []
      for (let j = lo; j < i; j++) if (kinds[j] === 'text') candidates.push(j)
      if (candidates.length > 0) quoteOf[i] = pick(rng, candidates)
    }
  }

  // 7) 文本
  const messages = []
  for (let i = 0; i < n; i++) {
    const r = role[i]
    let text
    if (r?.type === 'topic') text = r.entry.messages[r.slot]
    else if (r?.type === 'task') text = r.entry.messages[0]
    else if (r?.type === 'quote') text = pick(rng, QUOTE_REPLIES)
    else if (quoteOf[i] !== null) text = pick(rng, QUOTE_REPLIES)
    else if (kinds[i] === 'text') text = buildGenericText(profile, rng)
    else text = KIND_TEXT[kinds[i]]
    messages.push({
      ts: ts[i],
      sender: `u${senderIdx[i] + 1}`,
      kind: kinds[i],
      text,
      quoteOf: quoteOf[i],
    })
  }

  const stream = `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`
  const manifest = {
    version: GEN_VERSION,
    seed: seedNum,
    topics,
    tasks,
    quotes,
    expected: {
      topicCount: topics.length,
      taskCount: tasks.length,
      quoteCount: quotes.length,
    },
  }
  return { stream, manifest }
}

// —————————————— CLI ——————————————

function parseArgs(argv) {
  const args = [...argv]
  const flag = (name) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  return {
    demo: args.includes('--demo'),
    profile: flag('profile'),
    seed: flag('seed'),
    days: flag('days'),
    out: flag('out'),
  }
}

function main(argv) {
  const { demo, profile: profilePath, seed, days, out } = parseArgs(argv)
  if (!demo && !profilePath) {
    throw new Error('需要 --profile <profile.json> 或 --demo')
  }
  if (!out) throw new Error('需要 --out <dir>')

  let profile
  if (demo) {
    profile = DEMO_PROFILE
  } else {
    try {
      profile = JSON.parse(readFileSync(resolve(profilePath), 'utf8'))
    } catch {
      // 不回显路径与文件内容
      throw new Error('无法读取 --profile 文件（需为合法 JSON）')
    }
  }

  const seedNum = seed === undefined ? Number(profile.seed ?? 42) : Number(seed)
  if (!Number.isFinite(seedNum)) throw new Error('--seed 必须是数字')
  const daysNum = days === undefined ? Number(profile.days ?? 3) : Number(days)
  if (!Number.isInteger(daysNum) || daysNum < 1) throw new Error('--days 必须是正整数')

  const { stream, manifest } = generate(profile, seedNum, daysNum)

  const outDir = resolve(out)
  try {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'stream.jsonl'), stream)
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  } catch {
    throw new Error('无法写入 --out 目录')
  }

  const lineCount = stream.trim().split('\n').length
  process.stdout.write(
    `合成流: ${lineCount} 条 · ${daysNum} 天 · seed=${seedNum}\n` +
      `植入真值: 话题 ${manifest.expected.topicCount} / 任务 ${manifest.expected.taskCount} / 引用 ${manifest.expected.quoteCount}\n`,
  )
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : '生成失败'}`)
    process.exitCode = 1
  }
}
