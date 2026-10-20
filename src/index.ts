/**
 * dsh-group-lurker：只读旁听群聊的 DSH Cordis 插件（WP1 骨架）。
 *
 * 安全约定（TECH-DESIGN §3）：
 * - inject 仅声明 'llm'，不触碰 permissionPresets/sandbox/credentials；
 * - 本插件永远不持有任何消息发送通道，不 import 任何发送类接口；
 * - 所有定时器/监听/清理逻辑必须经 ctx.effect() 或 ctx.on 注册，dispose 自动回收；
 * - 文件写入只经 store.ts，路径先过 guard.assertInsideState。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { Store } from './store.js'
import { defaultDbPath } from './db/mirror.js'
import type { StoreLogger } from './store.js'
import { PersonaService } from './persona.js'
import { TokenBucket } from './guard.js'
import { BufferPool } from './buffer.js'
import { MessageBus } from './bus.js'
import { Distiller, DefaultLlmClient } from './distiller.js'
import type { LlmClient, HostLlmService, Insight } from './distiller.js'
import { InsightsJournal } from './journal.js'
import { Scheduler } from './scheduler.js'
import type { TickKind } from './scheduler.js'
import { SystemNotifier } from './notify.js'
import { GroupStoreService } from './group-store.js'
import { PersonaTrackService } from './persona-track.js'
import type { WatchListEntry } from './persona-track.js'
// M2-T2.3：人物增量摘要（新增行，不动他人行）
import { PersonDigestService } from './person-digest.js'
// M3：三层金字塔报告引擎 + 发件箱日志替身（新增行，不动他人行）
import { ReportService } from './report.js'
import { safeBatchRelPath } from './report.js'
import { LlmCallRecorder } from './llm-observe.js'
import type { ReportKind } from './report.js'
import { localDayKey } from './person-digest.js'
import { Outbox } from './outbox.js'
// 红线升级（2026-10-14 用户批准）：filehelper 发送 worker——outbox 消费 + 三重闸门 + 频控
import { SenderService, defaultSystemIdleSec } from './sender.js'
// M4：任务/事件识别 + 待确认闭环（新增行，不动他人行）
import { TaskRecognitionService } from './task-recognition.js'
import type { RecognitionEvent } from './task-recognition.js'
// M4：提醒计划器（时点表 + 每日速览）
import { ReminderService } from './reminder.js'
// M5：承诺追踪（F8）+ 催办草稿 + 文件索引（F7）（新增行，不动他人行）
import { PromiseRecognitionService, PromiseReminderService } from './promise-track.js'
import type { PromiseEvent } from './promise-track.js'
import { FileIndexService, linkFilesToEvents } from './file-index.js'
import { createAccountGate, listAccounts, sampleAccount, diffActivity, wxidFromDbRoot, XWECHAT_FILES_REL, type FsLike } from './account-probe.js'
import { RegenQueue, REGEN_QUEUE_REL } from './regen-queue.js'
import { processRegenHead } from './regen-processor.js'
import { ApprovalActions } from './approval-actions.js'
import { ActionInbox } from './action-inbox.js'
import { ReportRevisionService } from './report-revision.js'
import { homedir } from 'node:os'
// M6：保留期清理（T1.1 遗留）+ A/B 脚手架类型（新增行，不动他人行）
import { RetentionService } from './retention.js'
import { WechatDbSource } from './source/wechat-db.js'
import { NicknameResolver } from './source/nickname.js'
import type { WechatDbMessage } from './source/wechat-db.js'

export interface PluginConfig {
  stateDir: string
  groups: string[]
  bufferSize: number
  distillEveryMessages: number
  distillIntervalMin: number
  persona: string
  /** chatId → 人格名（按群覆盖）；未配置的群回退内置 default */
  groupPersonas: Record<string, string>
  /**
   * 消息源：'none'（默认，保守不读取）| 'wechat-db'（本地库白名单读取，W2）。
   * schema 声明为 string（schemastery 无 const 联合），apply 启动时运行时校验，
   * 未知值 fail-closed。
   */
  source: string
  /**
   * 外部工具目录（macos-wechat-export，含 wechat_db.py；只读复用，不修改）。
   * 无默认值（机器相关路径不进源码）；source='wechat-db' 时必须显式配置，apply 校验。
   */
  sourceToolDir?: string
  /** 外部工具 python 解释器（默认 'python3'；建议绝对路径） */
  sourcePython?: string
  /** 外部工具 --db-root（微信 db_storage 绝对路径）。无默认值；source='wechat-db' 时必须显式配置 */
  sourceDbRoot?: string
  /** 轮询间隔（秒），默认 10 */
  pollIntervalSec: number
  /** 每次 read 的 --limit，默认 50 */
  readLimit: number
  /** W4：启动回灌条数（默认 0 不回灌；>0 首轮可回灌最多该条数最近历史，受 readLimit 约束） */
  backfillOnStart: number
  /** M1-T1.3：调度器开关（默认 false；M3 报告生成接入后再开启） */
  schedulerEnabled: boolean
  /** 调度时点（本地时区 "HH:MM"）：日 / 周日 / 每月 1 日 */
  dailyReportTime: string
  /** 快速测试模式（默认 false）：true 且 testKindIntervalMin>0 时按间隔依次强制触发 weekly/monthly 完整链路 */
  scheduleTestMode: boolean
  /** 测试模式强制触发间隔分钟（默认 0 = 不触发） */
  testKindIntervalMin: number
  weeklyReportTime: string
  monthlyReportTime: string
  /** 按白名单顺序每群错峰分钟数（默认 5） */
  staggerMinutes: number
  /** M1-T1.4：系统通知 dry_run（默认 true = 只记日志不弹通知） */
  notifyDryRun: boolean
  /**
   * M2-T2.1：关注名单（配置文件唯一入口，默认空数组 = 无人被追踪，fail-closed 零活动）。
   * scope：'global'（全部白名单群）| { groups: [chatId] }（指定群）。
   */
  watchList?: WatchListEntry[]
  /** M2-T2.3：人物增量摘要开关（默认 false；M3 报告引擎接调度时再开） */
  personDigestEnabled: boolean
  /** M3：报告引擎开关（默认 false；M4 端到端联调时再开） */
  reportEnabled: boolean
  /** M3：跨群聚合群数上限（默认 8；超出按相关度+活跃度取前 N，其余一行带过） */
  aggregationMaxGroups: number
  /** M4-T4.1：任务/事件识别开关（默认 false = 零 LLM 调用、零落库） */
  taskRecognitionEnabled: boolean
  /** M4-T4.3：提醒计划器开关（默认 false = 零通知、零心跳） */
  reminderEnabled: boolean
  /** M4：本人 wxid（@我精确匹配）。空（默认）= 关闭精确匹配，降级 '@' 代理信号 */
  selfWxid: string
  /** M4-T4.2：模式学习（确认过的「派发人+句式」免确认，默认 true） */
  patternLearning: boolean
  /** M4-T4.3：截止前 1 小时提醒时点（功能文档 §6.3 默认关） */
  deadline1hRemind: boolean
  /** M5-T5.1：承诺识别开关（默认 false = 零 LLM 调用、零落库） */
  promiseRecognitionEnabled: boolean
  /** M5-T5.3：文件索引开关（默认 false = 零活动） */
  fileIndexEnabled: boolean
  /** files 子命令清单摄取周期（分钟；0=关）。修复"49≠链接"归档缺口的兜底数据源 */
  fileIndexListIntervalMin: number
  /** 单群 files 子命令摄取超时（毫秒）；超时/失败只 warn 不阻塞 */
  fileIndexListTimeoutMs: number
  /** 单群 files 子命令返回条数上限（1..200） */
  fileIndexListLimit: number
  /** M5-T5.2：逾期催办草稿落 outbox（默认 false；草稿绝不发送） */
  followupDraftEnabled: boolean
  /** M6-T1：messages 滚动保留天数（默认 90；长期表 events/tasks/promises/files 不动） */
  retentionDays: number
  /** v0.3 SQLite 知识库镜像路径；'' = 默认 ~/WeChat/1数据/knowledge.db，'off' = 关闭镜像 */
  sqlitePath: string
  /** M6-T5：提炼落地形式标签（'fused' | 'split'；仅作 A/B 对比脚手架的记录标签） */
  distillMode: string
  /** M6-T4：识别 confidence 门槛（默认 0 = 现行为全落库待确认；只作用于 events） */
  minTaskConfidence: number
  /** M6-T4：承诺兑现软关联 confidence 阈值（默认 0.5 = 现行为） */
  fulfilConfidence: number
  /** M6-T4：活跃度突变倍数（默认 3 = 现行为：今日 > 7 日均值 × N） */
  activitySpikeMultiplier: number
  /**
   * LLM 路由：默认模型（空 = 用注册默认 'glm-5.3'）。仅当宿主 llm 服务退化为
   * 注册表回退（openai 兼容 fetch）或 stream 路由时生效。
   */
  llmModel: string
  /** LLM 注册表回退的 openai 兼容 baseURL（空 = zai 默认端点；API key 走 ZAI_API_KEY 环境变量） */
  llmBaseUrl: string
  /**
   * T9 成本透明：价格表（模型名 → {input, output} 元/百万 tokens）。
   * 默认取智谱官方定价页 2026-10 抓取值；调价改配置即可，以供应商页面为准。
   */
  llmPricing: Record<string, { input: number; output: number }>
  /** 红线升级 2026-10-14：发送总闸（默认 false = 零发送活动） */
  senderEnabled: boolean
  /** 发送 dry_run（默认 true = keyboard 模式键序到第 8 步定位即停，不粘贴消息不回车） */
  sendDryRun: boolean
  /** 发送原语（默认 'keyboard' = 键盘模拟 + DB 回读验证；'wechat-ui' 可切回旧实现） */
  /** 发送 worker 扫描间隔（秒，默认 300） */
  sendIntervalSec: number
  /** DB 回读验证每次尝试前的等待秒数（默认 3；微信异步写本地库，需重试窗口消化竞态） */
  verifyDelaySec: number
  /** DB 回读验证尝试次数（默认 4；总窗口 ≈ verifyDelaySec × verifyRetries ≈ 12s） */
  verifyRetries: number
  /** 抢前台模式（默认 false = 微信非前台跳过本轮）。true = 自动激活微信前台发送，仍让路给正在打字的用户（空闲 <10s 跳过） */
  allowTakeFocus: boolean
  idleSkipBelowSec: number
  batchThreshold: number
  accountWhitelist: string[]
  allowAutoRekey: boolean
  sendTargetChat: string
  readbackChatId: string
  sendSearchViaClipboard: boolean
  webActionsEnabled: boolean
  webActionsPollSec: number
  /** T4：自适应批大小（默认 true：timeout 压缩 ×0.7 / 连续成功扩张 ×1.2，按群按 kind 持久化；false = 固定 batchThreshold 回退通道） */
  adaptiveBatch: boolean
  /** T7：报告归纳管线（'map-reduce' | 'refine' | 'ab'；默认 'map-reduce' 安全默认，BooookScore 修正案不预设 B 优） */
  reportPipeline: string
  /** T8：两段式生成实验开关（默认 false = 零变化；true 仅 report 生成路径生效） */
  schemaTwoStage: boolean
  /** 每日发送上限（默认 20） */
  maxSendsPerDay: number
}

export const name = 'dsh-group-lurker'

// 越少越安全：只声明真正需要的宿主服务。
export const inject = ['llm'] as const

/** 配置面板说明（DSH UI 渲染） */
export const usage = `微信本地库只读旁听插件（MVP 只读不发送）。

必读前提（source=wechat-db 时）：
1. 本机已安装 sqlcipher（brew install sqlcipher）
2. 已克隆 macos-wechat-export 并完成取钥（bootstrap_keys.py，产物 .wechat-local/keys.json）
3. 显式配置 sourceToolDir / sourceDbRoot / sourcePython——本插件不内置任何机器路径默认值

管控原则：groups 白名单为空即拒绝读取（fail-closed）；读取只经只读子进程；审计日志仅记元数据。`

export const Config: Schema<PluginConfig> = Schema.object({
  stateDir: Schema.string().default('').description('状态目录（绝对路径）。留空 = DSH_HOME/dsh-group-lurker'),
  groups: Schema.array(String).default([]).description('白名单：chatId 数组（xxx@chatroom）。空 = 拒绝读取（fail-closed）。用工具的 resolve 命令查群 chatId'),
  bufferSize: Schema.number().default(60).description('每群消息环形缓冲条数'),
  distillEveryMessages: Schema.number().default(25).description('每攒 N 条消息触发一次 LLM 提炼'),
  distillIntervalMin: Schema.number().default(15).description('定时提炼间隔（分钟）'),
  persona: Schema.string().default('default').description('默认人格（<stateDir>/personas/<name>.md）'),
  groupPersonas: Schema.dict(String).default({}).description('按群人格覆盖：chatId → 人格名'),
  source: Schema.string().default('none').description('消息源：none（默认，不读取）| wechat-db（本地库白名单读取）。选 wechat-db 必须显式配置 sourceToolDir/sourceDbRoot'),
  sourceToolDir: Schema.string().description('macos-wechat-export 工具目录（含 wechat_db.py 与 .wechat-local/keys.json）。无默认值——必须显式配置'),
  sourcePython: Schema.string().default('python3').description('运行工具的 python 解释器（绝对路径更稳，如 /opt/homebrew/bin/python3.14）'),
  sourceDbRoot: Schema.string().description('微信 db_storage 绝对路径（~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid_hash>/db_storage）。无默认值——必须显式配置'),
  pollIntervalSec: Schema.number().default(10).description('轮询间隔（秒）'),
  readLimit: Schema.number().default(50).description('每次读取的 --limit'),
  backfillOnStart: Schema.number().default(0).description('启动回灌条数（默认 0 不回灌；受监管原则）'),
  schedulerEnabled: Schema.boolean().default(false).description('定时触达调度器（日报 20:30/周报周日 20:40/月报 1 日 08:00，按群错峰）；M3 接报告生成后再开'),
  dailyReportTime: Schema.string().default('20:30').description('每日触达时点（HH:MM 本地时区）'),
  weeklyReportTime: Schema.string().default('20:40').description('每周触达时点（周日 HH:MM）'),
  monthlyReportTime: Schema.string().default('08:00').description('每月触达时点（1 日 HH:MM）'),
  staggerMinutes: Schema.number().default(5).description('按白名单顺序每群错峰分钟数'),
  notifyDryRun: Schema.boolean().default(true).description('系统通知 dry_run：true 只记日志不弹通知中心'),
  // schemastery 无 const 联合：条目结构运行时校验（persona-track 内 fail-closed 跳过非法项）
  watchList: Schema.array(Schema.any()).default([]).description('M2 关注名单：[{ wxid, remark?, scope: "global" | { groups: [chatId] } }]。空数组 = 无人被追踪（零活动）'),
  personDigestEnabled: Schema.boolean().default(false).description('M2-T2.3 人物按天增量摘要（默认关；generateDaily 手动可调，M3 接调度时再开）'),
  reportEnabled: Schema.boolean().default(false).description('M3 三层金字塔报告引擎（默认关；调度到点生成日/周/月报 + 跨群汇总，正文只落盘）'),
  aggregationMaxGroups: Schema.number().default(8).description('M3 跨群聚合群数上限（默认 8；超出按「与我相关度+活跃度」取前 N，其余一行带过）'),
  taskRecognitionEnabled: Schema.boolean().default(false).description('M4 任务/事件识别（默认关）：@我指派 → 待确认 → 确认入清单，识别结果只落库不发送'),
  reminderEnabled: Schema.boolean().default(false).description('M4 提醒计划器（默认关）：截止前 1 天/逾期时点 + 每日 7:50 待办速览（notify + outbox，零发送）'),
  selfWxid: Schema.string().default('').description('本人 wxid（@我精确匹配 + 确认语义归属）。留空 = 关闭精确匹配，降级为 "@" 代理信号'),
  patternLearning: Schema.boolean().default(true).description('M4 模式学习：确认过的「派发人+句式指纹」同类消息免确认直接入清单'),
  deadline1hRemind: Schema.boolean().default(false).description('M4 截止前 1 小时提醒（功能文档 §6.3 默认关）'),
  promiseRecognitionEnabled: Schema.boolean().default(false).description('M5 承诺识别（默认关）：指向我的他人承诺 → 待确认 → 等待中 → 兑现/跳票，只落库不发送'),
  fileIndexEnabled: Schema.boolean().default(false).description('M5 文件索引（默认关）：文件类消息入库 + 类型归类 + 上下文摘要 + 版本链 + 星标'),
  fileIndexListIntervalMin: Schema.number().default(30).description('files 子命令清单摄取周期（分钟；0=关）。修复"49≠链接"归档缺口：消息流侧文件消息被归为 link 且无文件名，靠清单补 name/path 进索引'),
  fileIndexListTimeoutMs: Schema.number().default(30_000).description('单群 files 子命令摄取超时（毫秒）；超时/失败只 warn 不阻塞主流程'),
  fileIndexListLimit: Schema.number().default(200).description('单群 files 子命令返回条数上限（1..200）'),
  followupDraftEnabled: Schema.boolean().default(false).description('M5 逾期催办草稿（默认关）：生成得体话术草稿落 outbox 供复制，绝不发送'),
  retentionDays: Schema.number().default(90).description('M6 messages 滚动保留天数（默认 90）：每日清理一次，长期表（事件/任务/承诺/文件）不动'),
  sqlitePath: Schema.string().default('').description("v0.3 SQLite 知识库镜像路径（JSONL 仍为事实源；镜像写失败只 warn 不影响主流程）。留空 = ~/WeChat/1数据/knowledge.db；'off' = 关闭镜像"),
  distillMode: Schema.string().default('fused').description("M6 提炼落地形式标签：fused | split（仅记录标签供 A/B 对比；切换决策待运行期定夺）"),
  minTaskConfidence: Schema.number().default(0).description('M6 识别 confidence 门槛（默认 0 = 现行为：全部落库待确认；低于门槛的事件识别丢弃）'),
  fulfilConfidence: Schema.number().default(0.5).description('M6 承诺兑现软关联 confidence 阈值（默认 0.5 = 现行为；低于只提示不自动置已兑现）'),
  activitySpikeMultiplier: Schema.number().default(3).description('M6 活跃度突变倍数（默认 3 = 现行为：今日 > 近 7 日均值 × N 标注异常）'),
  llmModel: Schema.string().default('').description("LLM 模型（空 = 注册默认 'glm-5.3'；provider=zai）"),
  llmBaseUrl: Schema.string().default('').description('LLM openai 兼容 baseURL（空 = zai 默认端点）。API key 从 ZAI_API_KEY 环境变量读，绝不落日志/落盘'),
  llmPricing: Schema.dict(Schema.object({
    input: Schema.number().default(0).description('输入价格（元/百万 tokens）'),
    output: Schema.number().default(0).description('输出价格（元/百万 tokens）'),
  })).default({ 'glm-5.3': { input: 8, output: 28 }, 'glm-5.3-flash': { input: 0.8, output: 2.8 } }).description('T9 价格表：模型名 → {input, output} 元/百万 tokens。默认取智谱官方定价页 2026-10 抓取值，以供应商页面为准（https://docs.bigmodel.cn/cn/guide/start/pricing）。未知模型费用记 0 并 warn 一次'),
  // —— 红线升级（2026-10-14 用户批准）：filehelper 发送 worker（全部默认保守 = 关/干跑）——
  senderEnabled: Schema.boolean().default(false).description('发送总闸（默认 false = 零发送活动）。开启前务必先完成 TCC"辅助功能"授权 + sendDryRun=true 干跑确认搜索定位'),
  sendDryRun: Schema.boolean().default(true).description('发送 dry_run（默认 true = keyboard 模式执行搜索键序到第 8 步定位会话即停，不粘贴消息不回车；人工确认定位正确后再关掉真发）'),
  sendIntervalSec: Schema.number().default(300).description('发送 worker 消费 outbox 的扫描间隔（秒）'),
  verifyDelaySec: Schema.number().default(3).description('DB 回读验证每次尝试前的等待秒数（默认 3；微信异步写本地库，需重试窗口消化竞态）'),
  batchThreshold: Schema.number().default(120).description('大窗口分批归纳阈值（默认 120；窗口消息数超过该值时日报/人物日摘自动切批归纳再合并，避免单次大调用超时。≤阈值路径零变化）'),
  adaptiveBatch: Schema.boolean().default(true).description('自适应批大小（默认 true）：批超时自动收缩 safeBatch（×0.7，下限 20）、连续 5 次又快又成功自动扩张（×1.2，上限 120），按群按报告类型持久化。false = 固定用 batchThreshold（回退通道，零行为差异）'),
  reportPipeline: Schema.string().default('map-reduce').description("T7 报告归纳管线：map-reduce（默认，方案 A，安全默认）| refine（方案 B 滚动流水线接管，实验）| ab（双跑：正式报告仍用 A，B 产出落 reports/<chatId>/<date>.refine.json 供人工三维度评审）。BooookScore 修正案：不预设 B 优，A/B 灰度实测定夺"),
  schemaTwoStage: Schema.boolean().default(false).description('T8 两段式生成实验开关（默认 false = 零变化）：true 时报告生成的每次 LLM 调用拆两步——先自由文本归纳（无 schema 约束）、再独立调用格式化为既有 schema，再走既有断言。依据 EMNLP 2024《Let Me Speak Freely?》：严格格式约束抑制推理。仅 report 路径（map/merge/refine）生效，distiller 不受影响；两步成本均入统计行，可对照观察'),
    verifyRetries: Schema.number().default(4).description('DB 回读验证尝试次数（默认 4；穷尽仍未命中才判 failed_wrong_target）'),
  allowTakeFocus: Schema.boolean().default(false).description('抢前台模式（默认 false = 微信非前台跳过本轮，人在电脑前模式）。true = 全自动无人值守：自动激活微信前台发送，但系统空闲 <10s（用户正在打字/操作）仍让路跳过'),
  accountWhitelist: Schema.array(Schema.string()).default([]).description('账号白名单 wxid 数组（账号生命周期自动化，fail-closed 同 groups 语义：白名单外账号活跃 → sender 全面挂起+取钥硬阻断）。空 = 仅允许 sourceDbRoot 派生的默认账号'),
    activeAccountWxid: Schema.string().default('').description('配置账号 wxid（账号生命周期自动化；空 = 从 sourceDbRoot 路径派生 wxid 段；派生不出且未显式配置 = 探针关闭零变化）'),
  allowAutoRekey: Schema.boolean().default(false).description('小号回归自动取钥（默认 false：只通知人工执行 bootstrap_keys.py）。true = 自动执行取钥+验证。开启前必须人工成功手跑一次取钥（两段式安全条件，见 RUNBOOK）'),
    sendTargetChat: Schema.string().default('').description('发送目标会话名（搜索词；真实值放运行配置。默认空 = fail-closed 不发送；搜索结果多条时 Enter 选第一个，异常由 DB 回读兜底报警）'),
  webActionsEnabled: Schema.boolean().default(false).description('前端动作收件箱（审批双通道 web 侧）：消费 web/actions.jsonl 调 ApprovalActions，写结果/审计文件。默认关'),
  webActionsPollSec: Schema.number().default(5).description('动作收件箱轮询周期秒（默认 5）'),
    readbackChatId: Schema.string().default('').description('DB 回读验证目标会话 wxid（P0 兜底闸目标；必填——缺失 fail-closed 不发送。真实值放 cordis.patch.yml）'),
  sendSearchViaClipboard: Schema.boolean().default(false).description('搜索词键入走剪贴板回退（默认 false = System Events 直接键入；CJK IME 拦截实测失败时开启）'),
    idleSkipBelowSec: Schema.number().default(10).description('用户空闲让路阈值秒（默认 10 = 系统空闲 <10s 视为正在操作→跳过本轮让路；0 = 不让路，空闲检测失效直接抢前台发送。日常单日报场景可设 0——每天一次的抢前台可接受；频繁发送建议保持 10）'),
  maxSendsPerDay: Schema.number().default(20).description('每日发送上限（默认 20；超限的当日 pending 标 skipped_quota 防风暴）'),
  scheduleTestMode: Schema.boolean().default(false).description('快速测试模式（默认关）：true 且 testKindIntervalMin>0 时，每间隔分钟依次强制触发 weekly/monthly 的完整生成链路（周/月报不再等日历闸门）。测试完务必关掉，避免频繁 LLM 调用'),
  testKindIntervalMin: Schema.number().default(0).description('测试模式强制触发间隔（分钟，默认 0 = 不触发）'),
})

/**
 * 解析 state 目录绝对路径。默认 ~/.dsh/dsh-group-lurker（尊重 DSH_HOME）。
 */
export function resolveStateDir(configured: string): string {
  if (configured !== '') return configured
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'dsh-group-lurker')
}

export interface GroupLurker {
  /** 解析后的状态目录（绝对路径） */
  readonly stateDir: string
  /** 项目内唯一 fs 写入点 */
  readonly store: Store
  /** 人格服务（WP2）：resolve(chatId, groupPersonas)，缓存随 dispose 清空 */
  readonly personas: PersonaService
  /** 每群环形缓冲（WP3） */
  readonly buffer: BufferPool
  /** 事件总线（WP3）：im-connect/message → 消毒 → 限流 → 缓冲 */
  readonly bus: MessageBus
  /** 提炼器（WP3） */
  readonly distiller: Distiller
  /** insights 落盘 + 每日日报（WP4） */
  readonly journal: InsightsJournal
  /** 每群 SQLite 数据桶（M1-T1.1）：messages 写入/查询 + schema 迁移；bus 接线在 T1.2 */
  readonly groupStore: GroupStoreService
  /** 关注名单 + 按人跨群检索（M2-T2.1/T2.4）；空名单 fail-closed 零活动 */
  readonly personaTrack: PersonaTrackService
  /** 人物按天增量摘要（M2-T2.3）；personDigestEnabled=false 时为 null（零活动） */
  readonly personDigest: PersonDigestService | null
  /** 三层金字塔报告引擎（M3）；reportEnabled=false 时为 null（零活动） */
  readonly report: ReportService | null
  /** 发件箱日志替身（M3 落地 M4-T4.4 最小版）：只落盘不发送 */
  readonly outbox: Outbox
  /** filehelper 发送 worker（红线升级 2026-10-14）：senderEnabled=false 时零活动 */
  readonly sender: SenderService
  /** 任务/事件识别 + 待确认闭环（M4-T4.1/T4.2）；taskRecognitionEnabled=false 时为 null（零活动） */
  readonly taskRecognition: TaskRecognitionService | null
  /** 提醒计划器（M4-T4.3）；reminderEnabled=false 时为 null（零活动） */
  readonly reminder: ReminderService | null
  /** 承诺识别（M5-T5.1）；promiseRecognitionEnabled=false 时为 null（零活动） */
  readonly promiseRecognition: PromiseRecognitionService | null
  /** 承诺提醒/跳票标记/催办草稿（M5-T5.2）；随 promiseRecognitionEnabled 启用 */
  readonly promiseReminder: PromiseReminderService | null
  /** 文件索引（M5-T5.3）；fileIndexEnabled=false 时为 null（零活动） */
  readonly fileIndex: FileIndexService | null
  /** 定时触达调度器（M1-T1.3）；schedulerEnabled=false 时为 null */
  readonly scheduler: Scheduler | null
  /** 系统通知通道（M1-T1.4）：notifyDryRun 控制是否真弹通知 */
  readonly notifier: SystemNotifier
  /** 本地库消息源（W2）；source='none' 或 fail-closed 拒启时为 null */
  readonly source: WechatDbSource | null
  /** 运行可见性（PRD F5）：各群缓冲水位 / 今日条数 / 最近提炼时间 */
  getStatus(): Record<
    string,
    {
      buffered: number
      dropped: number
      todayCount: number
      lastDistillAt: number | null
      source: { running: boolean; lastPollAt: number | null; consecutiveFailures: number }
    }
  >
}

export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger(name)
  const stateDir = resolveStateDir(config.stateDir ?? '')

  // v0.3 双写镜像：SQLite 是查询层、JSONL 仍是事实源；镜像写失败只 warn，绝不影响主流程。
  // 'off' 显式关闭；路径打开失败时 createSqliteMirror 自降级为 null（零镜像）。
  const mirrorPath = config.sqlitePath === 'off' ? undefined : (config.sqlitePath || defaultDbPath())
  const store = new Store(stateDir, logger, mirrorPath)
  // 初始化即建目录；失败只记日志，不阻断宿主。
  store.ensureDir('.')

  // —— T3：LLM 调用结构化观测（report/distiller 共用同一记录器；JSONL 落 groups/<chatId>/） ——
  // T9：模型名与价格表在 llmClient 就绪后注入（成本五字段进每行 llm_call）。
  // （声明移到 llmClient 之后——distiller 装配在其下游，无前向引用问题。）

  const personas = new PersonaService({ stateDir, logger })

  // —— WP3 接线：限流 → 缓冲 → 提炼 → 事件总线 ——
  const bucket = new TokenBucket() // 默认 1 条/秒、突发 5（TECH-DESIGN §3）
  const buffer = new BufferPool({ bufferSize: config.bufferSize })

  // WP4 接线：提炼产出 → journal（二次校验 type + 截断引用 + jsonl/日报落盘）。
  const journal = new InsightsJournal({ store, logger: logger as unknown as StoreLogger })

  // —— M1-T1.1：每群 SQLite 数据桶（惰性建库；bus.ingest 下游接线在 T1.2） ——
  const groupStore = new GroupStoreService(stateDir, logger)

  // —— M1-T1.4：系统通知通道（dry_run 默认开；审计只记元数据） ——
  const notifier = new SystemNotifier({
    store,
    logger,
    dryRun: config.notifyDryRun,
  })

  // —— M1-T1.3：调度骨架（onTick → M3 报告生成 → 短通知 + outbox 落盘） ——
  // —— M3：发件箱日志替身（只落盘零发送；报告正文不进通知，全文指针进 outbox） ——
  const outbox = new Outbox({ store })
  // —— 红线升级（2026-10-14）：filehelper 发送 worker（默认 senderEnabled=false 零活动；
  //    sendDryRun=true 只定位不发送；通道白名单在 sender.ts 代码级硬编码为 filehelper；
  //    sendMethod 默认 'keyboard'（wx-chatbot 式键盘模拟 + DB 回读验证，TCC 只需辅助功能）。 ——
  // 账号生命周期闸（白名单制，fail-closed 同 groups 语义）：
  // accountWhitelist 显式配置优先；空 = 仅允许 sourceDbRoot 派生的默认账号（向后兼容）。
  // 都派生不出 = 探针关闭零变化。红线：取钥 db-root 代码级锁定配置账号目录（∈ 白名单才建闸）。
  const defaultWxid = wxidFromDbRoot(config.sourceDbRoot ?? '')
  const accountWhitelist = config.accountWhitelist.length > 0 ? config.accountWhitelist : defaultWxid ? [defaultWxid] : []
  const rekeyWxid = defaultWxid ?? (accountWhitelist[0] ?? '')
  const accountGate = accountWhitelist.length > 0 && rekeyWxid !== ''
    ? createAccountGate({
        root: join(homedir(), XWECHAT_FILES_REL),
        whitelist: accountWhitelist,
        accountDir: join(homedir(), XWECHAT_FILES_REL, rekeyWxid),
        fs: { existsSync: fsExistsSync, readdirSync: fsReaddirSync, statSync: fsStatSync },
        allowAutoRekey: config.allowAutoRekey,
        windowMs: 2000,
        sleepMs: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
        notify: (message) => logger.warn(`notify: ${message}`),
        warn: (message) => logger.warn(message),
        error: (message) => logger.error(message),
        runRekey: (dbRoot) =>
          new Promise((resolve2, reject2) => {
            execFile(
              config.sourcePython ?? 'python3',
              [join(config.sourceToolDir ?? '', 'bootstrap_keys.py'), '--acknowledge-debug-copy', '--db-root', dbRoot],
              { timeout: 15 * 60_000 },
              (error: unknown, stdout: string, stderr: string) => {
                if (error && (error as { code?: number | string }).code === undefined) reject2(error)
                else resolve2({ code: Number((error as { code?: number })?.code ?? 0), stdout: String(stdout), stderr: String(stderr) })
              },
            )
          }),
        runVerify: (dbRoot) =>
          new Promise((resolve2, reject2) => {
            execFile(
              config.sourcePython ?? 'python3',
              [join(config.sourceToolDir ?? '', 'wechat_db.py'), '--db-root', dbRoot, '--key-file', join(config.sourceToolDir ?? '', '.wechat-local/keys.json'), 'verify'],
              { timeout: 60_000 },
              (error: unknown, stdout: string, stderr: string) => {
                if (error && (error as { code?: number | string }).code === undefined) reject2(error)
                else resolve2({ code: Number((error as { code?: number })?.code ?? 0), stdout: String(stdout), stderr: String(stderr) })
              },
            )
          }),
      })
    : null


  // 错号空报告补发队列（跨重启持久化 stateDir/regen-queue.json）
  const regenQueue = new RegenQueue({ store, logger: logger as unknown as StoreLogger })

  const sender = new SenderService({
    outbox,
    store,
    logger,
    enabled: config.senderEnabled,
    dryRun: config.sendDryRun,
    maxSendsPerDay: config.maxSendsPerDay,    sourceToolDir: config.sourceToolDir ?? '',
    sourceDbRoot: config.sourceDbRoot ?? '',
    sourcePython: config.sourcePython,
    systemIdleSec: defaultSystemIdleSec,
    allowTakeFocus: config.allowTakeFocus,
    idleSkipBelowSec: config.idleSkipBelowSec,
    sendTargetChat: config.sendTargetChat,
    readbackChatId: config.readbackChatId ?? '',
    sendSearchViaClipboard: config.sendSearchViaClipboard,
    accountGate: accountGate ?? undefined,
    intervalSec: config.sendIntervalSec,
    verifyDelaySec: config.verifyDelaySec,
    verifyRetries: config.verifyRetries,  })
  // report 依赖 llmClient（其下才定义），先占位、llmClient 就绪后赋值
  let report: ReportService | null = null

  let scheduler: Scheduler | null = null
  if (config.schedulerEnabled) {
    scheduler = new Scheduler({
      groups: config.groups,
      logger,
      store,
      dailyTime: config.dailyReportTime,
      weeklyTime: config.weeklyReportTime,
      monthlyTime: config.monthlyReportTime,
      staggerMinutes: config.staggerMinutes,
      testMode: config.scheduleTestMode,
      testKindIntervalMin: config.testKindIntervalMin,
      onTick: (kind: TickKind, chatId: string, meta) => {
        // M3 接线：tick → 报告生成（按 scheduledAt 所在自然周期切窗，补跑不错窗）
        // → 成功后短通知（正文不进通知）+ 正文/指针落 outbox（不发消息）。
        const kindName = kind === 'daily' ? '日报' : kind === 'weekly' ? '周报' : '月报'
        if (!report) {
          // reportEnabled=false：保持 M1 占位行为（只记日志 + dry_run 通知）
          void notifier
            .notify(kind, `群聊${kindName}（${chatId}）`, meta.catchup ? '（补跑）报告引擎未开启占位' : '报告引擎未开启占位')
            .catch(() => {})
          return
        }
        void (async () => {
          // 错号空报告补发队列（两段式 FIFO）：错号 → 空报告仅存档 + 入队（绝不进发送链路，
          // 提前 return）；白名单账号在线 → 每轮从队首 pop 一个元素补生成（end=处理时刻）：
          // 有内容 → outbox 条目进发送链路后出队；空 → 重试 ≤2 次；3 次全空 → 如实定稿发送；
          // 环境异常 → 放回队首不耗次数。详见 regen-processor.ts。
          const regenAudit = (result: string, chatId2: string, dateKey: string, extra?: Record<string, unknown>): void => {
            try {
              store.ensureDir('audit')
              store.appendJsonl('audit/regen-queue.jsonl', { ts: new Date(Date.now()).toISOString(), result, chat_id: chatId2, date_key: dateKey, ...(extra ?? {}) })
            } catch { /* 审计失败不阻塞 */ }
          }
          let misAccount = false
          if (accountGate && kind === 'daily') {
            const active = await accountGate.activeAccount()
            misAccount = active !== null && !accountGate.isAllowed(active)
          }
          if (misAccount) {
            // P0 语义：错号导致的空报告 = 未处理（等待正号回归重生成），绝不进发送链路——
            // 空骨架照常落盘存档 + 入 pending_regen 队列 + 提前 return（不 notify 不 outbox）。
            const dateKey = localDayKey(meta.scheduledAt)
            const res = await report.generateReport(chatId, 'daily', meta.scheduledAt)
            const qres = regenQueue.enqueue(chatId, dateKey, Date.now())
            regenAudit(qres === 'deduped' ? 'regen_deduped' : 'regen_queued', chatId, dateKey, { queue_len: regenQueue.list().length, status: res.status })
            logger.warn(`scheduler[daily]: 错号在线——空报告仅存档，入补发队列等待正号回归（${qres}） ${chatId}/${dateKey}（不发送）`)
            return
          }
          if (kind === 'daily' && accountGate) {
            // 白名单账号在线 → 每轮处理队首一个补发元素，再生成当期报告
            const outcome = await processRegenHead({
              queue: regenQueue,
              report,
              groupStore,
              outbox,
              store,
              logger: logger as unknown as StoreLogger,
              notify: async (title, body) => { await notifier.notify('daily', title, body) },
              audit: (entry) => regenAudit(String(entry.result), String(entry.chat_id), String(entry.date_key), entry),
              now: () => Date.now(),
            })
            if (outcome.action === 'regenerated') logger.info(`scheduler[daily]: 补发日报已生成并入发送队列`)
            else if (outcome.action !== 'empty') logger.warn(`scheduler[daily]: 补发队列处理结局=${outcome.action}`)
          }
          const res = await report.generateReport(chatId, kind as ReportKind, meta.scheduledAt)
          if (res.status === 'disabled') return
          const title = `${kindName}已生成（${chatId}${meta.catchup ? '，补跑' : ''}）`
          const body = res.status === 'empty'
            ? '本期窗口内无消息'
            : res.status === 'ok'
              ? `关键判断 ${res.judgmentCount} 条、话题 ${res.topicCount} 个，全文见 outbox 存档`
              : 'LLM 归纳不可用，已降级输出骨架（degraded）'
          await notifier.notify(kind, title, body)
          outbox.appendOutbox({ kind, title, body, evidence_ref: res.path ?? '' })
          // —— M3 遗留收口①：daily 全群出报告后，先对当日无报告的群补 generateReport，
          //    再生成跨群汇总（调度端行为，不改 report.ts 引擎；生成前逐群探测 report_meta）。
          if (kind === 'daily') await maybeSummarize(chatId, meta.scheduledAt)
        })().catch((error: unknown) => {
          logger.error(`scheduler[${kind}] report generation failed for ${chatId}: ${String(error)}`)
        })
      },
    })
  }

  /** M3 遗留收口①：daily occurrence 全群触发完 → 补缺报告群 → generateSummary */
  const dailyDone = new Map<string, Set<string>>() // dateKey → 已完成日报的群
  async function maybeSummarize(chatId: string, scheduledAt: number): Promise<void> {
    if (!report) return
    const dateKey = localDayKey(scheduledAt)
    const done = dailyDone.get(dateKey) ?? new Set<string>()
    dailyDone.set(dateKey, done)
    done.add(chatId)
    if (done.size < config.groups.length) return
    for (const chatId of config.groups) {
      // 逐群探测：当日无 daily 报告元数据 → 补生成（聚合不再缺报告）
      const metas = groupStore.getReportMetas(chatId, { kind: 'daily', limit: 10 })
      if (!metas.some((m) => m.date === dateKey && m.status !== 'empty')) {
        try {
          await report.generateReport(chatId, 'daily', scheduledAt)
        } catch (error) {
          logger.error(`summary-fill generateReport(${chatId}) failed: ${String(error)}`)
        }
      }
    }
    try {
      const s = await report.generateSummary(scheduledAt)
      logger.info(`summary generated: ${s.path ?? 'failed'} (groups=${s.groupsIncluded})`)
    } catch (error) {
      logger.error(`generateSummary failed: ${String(error)}`)
    }
  }

  const onInsights = (chatId: string, insights: Insight[]): void => {
    journal.record(chatId, insights)
  }

  const llmClient: LlmClient = new DefaultLlmClient(
    (ctx as Context & { llm?: HostLlmService }).llm,
    {
      provider: 'zai',
      model: config.llmModel,
      baseUrl: config.llmBaseUrl,
      apiKeyEnv: 'ZAI_API_KEY',
      logger: logger as unknown as { info?: (m: string) => void; warn?: (m: string) => void },
    },
  )

  // —— T3+T9：LLM 调用结构化观测记录器（distiller 用；report 每次 run 自建）——
  // 模型名取 llmClient.modelId()；价格表来自 Config.llmPricing（未知模型费用记 0 并 warn 一次）。
  const llmCallRecorder = new LlmCallRecorder(store, undefined, {
    model: llmClient.modelId?.() ?? 'unknown',
    pricing: config.llmPricing,
    logger: logger as unknown as { warn?: (m: string) => void },
  })

  // —— M3：报告引擎（reportEnabled 默认 false = 零活动；手动 generateReport 可调） ——
  if (config.reportEnabled) {
    report = new ReportService({
      groupStore,
      store,
      stateDir,
      llm: llmClient,
      logger: logger as unknown as StoreLogger,
      enabled: true,
      aggregationMaxGroups: config.aggregationMaxGroups,
      batchThreshold: config.batchThreshold,
      adaptiveBatch: config.adaptiveBatch, // T4：false = 固定 batchThreshold（回退通道）
      // T7：管线开关（非法值回退安全默认 'map-reduce'；默认不动 A 的任何行为）
      reportPipeline: (['refine', 'ab'].includes(config.reportPipeline) ? config.reportPipeline : 'map-reduce') as 'map-reduce' | 'refine' | 'ab',
      schemaTwoStage: config.schemaTwoStage, // T8：两段式生成实验开关（默认 false = 零变化）
      llmPricing: config.llmPricing, // T9：价格表（模型名 → 元/百万 tokens；缺省内置默认表）
      groups: config.groups,
      notifier, // T3：同群连续 2 个窗口 degraded → notify 告警（dry_run 语义在 SystemNotifier 内保持）
    })
  }

  // —— M4-T4.1/T4.2：任务/事件识别 + 待确认闭环（默认关 = 零 LLM 调用、零落库） ——
  // 待确认卡片：notify 只弹短句（不含正文），详情落 outbox（零发送）。
  let taskRecognition: TaskRecognitionService | null = null
  if (config.taskRecognitionEnabled) {
    taskRecognition = new TaskRecognitionService({
      groupStore,
      llm: llmClient,
      logger: logger as unknown as StoreLogger,
      enabled: true,
      selfWxid: config.selfWxid,
      patternLearning: config.patternLearning,
      minConfidence: config.minTaskConfidence, // M6-T4：识别 confidence 门槛
      onRecognitionEvent: (ev: RecognitionEvent) => {
        const isTask = ev.kind === 'task'
        const title = ev.type.endsWith('pending_confirm')
          ? (isTask ? '识别到疑似任务，待确认' : '识别到疑似关键事件，待确认')
          : (isTask ? '任务已入清单' : '关键事件已入库')
        void notifier.notify('task-recognition', title, `群 ${ev.chatId} · 1 项${ev.degraded ? '（降级）' : ''}`).catch(() => {})
        outbox.appendOutbox({
          kind: ev.type,
          title,
          body: `${isTask ? '任务' : '事件'}：${ev.statement}\n群：${ev.chatId}\n编号：${ev.id}${ev.degraded ? '\n（降级产出）' : ''}`,
          evidence_ref: `${ev.kind}:${ev.id}`,
        })
      },
    })
  }

  // —— M5-T5.1/T5.2：承诺识别 + 承诺提醒（默认关 = 零 LLM 调用、零落库、零心跳） ——
  // 待确认/兑现/跳票卡片：notify 只弹短句，详情落 outbox（零发送）。
  let promiseRecognition: PromiseRecognitionService | null = null
  let promiseReminder: PromiseReminderService | null = null
  if (config.promiseRecognitionEnabled) {
    const onPromiseEvent = (ev: PromiseEvent): void => {
      const title = ev.type === 'promise_pending_confirm'
        ? '识别到疑似承诺，待确认'
        : ev.type === 'promise_fulfilled'
          ? '承诺已兑现'
          : ev.type === 'promise_broken'
            ? '承诺已跳票'
            : '承诺已入追踪'
      void notifier.notify('promise-track', title, `群 ${ev.chatId} · 1 项`).catch(() => {})
      outbox.appendOutbox({
        kind: ev.type,
        title,
        body: `承诺：${ev.statement}\n群：${ev.chatId}\n编号：${ev.id}${ev.confidence > 0 ? `\n兑现关联置信度：${ev.confidence.toFixed(2)}` : ''}`,
        evidence_ref: `promise:${ev.id}`,
      })
    }
    promiseRecognition = new PromiseRecognitionService({
      groupStore,
      llm: llmClient,
      logger: logger as unknown as StoreLogger,
      enabled: true,
      selfWxid: config.selfWxid,
      patternLearning: config.patternLearning,
      fulfilConfidence: config.fulfilConfidence, // M6-T4：软关联阈值配置化
      store,
      onPromiseEvent,
    })
    promiseReminder = new PromiseReminderService({
      groupStore,
      notifier,
      outbox,
      logger: logger as unknown as StoreLogger,
      followupDraftEnabled: config.followupDraftEnabled,
      groups: config.groups,
      onPromiseEvent,
    })
  }

  // —— 审批双通道（confirm-loop C1/C2）+ 标记修订流（approval-marking M1/M2）接线 ——
  const reportRevision = new ReportRevisionService({
    store,
    logger: logger as unknown as StoreLogger,
    mirror: {
      mirrorMarking: (c, k, r, ts, o) => store.mirrorMarking(c, k, r, ts, o),
      mirrorReportRevision: (c, p2, ps, ts, t, o) => store.mirrorReport(c, p2, ps, ts, t, o),
    },
  })
  const approvalActions = taskRecognition && promiseRecognition
    ? new ApprovalActions({
        task: taskRecognition,
        promise: promiseRecognition,
        store: groupStore,
        notify: async (kind2, title, body) => { await notifier.notify(kind2, title, body) },
        logger: logger as unknown as StoreLogger,
        enqueueReportRegen: (chatId2, dateKey2, kind2) => regenQueue.enqueue(chatId2, dateKey2, Date.now(), kind2, 'manual') !== 'deduped',
      })
    : null
  const actionInbox = config.webActionsEnabled && approvalActions
    ? new ActionInbox({
        store,
        actions: approvalActions,
        marks: { markTarget: (chatId2, kind2, targetId2, status2, source2) => reportRevision.markTarget(chatId2, kind2, targetId2, status2, source2) },
        groups: config.groups,
        logger: logger as unknown as StoreLogger,
        pollSec: config.webActionsPollSec,
      })
    : null

  // —— M5-T5.3：文件索引（默认关 = 零活动）。 ——
  // —— M6-T2：wx_path 定位接线——工具 `files` 子命令按会话查路径，异步刷新进缓存，
  //    locatePath 只做同步读；未命中/不可用 → 保持"待下载"占位；每次定位记 audit 元数据。 ——
  const wxPathCache = new Map<string, Map<string, string>>() // chatId → msgId → path
  async function refreshWxPaths(chatId: string): Promise<void> {
    if (!source) return
    const entries = await source.locateFiles(chatId, 200)
    const map = new Map<string, string>()
    for (const e of entries) {
      if (e.available && e.path !== null) map.set(e.msg_id, e.path)
    }
    wxPathCache.set(chatId, map)
  }
  const fileIndex = config.fileIndexEnabled
    ? new FileIndexService({
        groupStore,
        llm: llmClient,
        logger: logger as unknown as StoreLogger,
        enabled: true,
        store,
        locatePath: (chatId, msg) => {
          const found = wxPathCache.get(chatId)?.get(msg.msgId) ?? null
          // 定位审计：只记元数据（msgId/是否命中），绝不记路径外的内容
          store.appendJsonl('audit/file-locate.jsonl', { ts: Date.now(), chatId, msgId: msg.msgId, found: found !== null })
          return found
        },
        refreshPaths: (chatId) => refreshWxPaths(chatId),
        // files 子命令数据源（修复"49≠链接"归档缺口）：复用 source.locateFiles 只读查询；
        // 源未就绪/闸门外返回 []（= 无数据，不报错）。
        listFiles: (chatId, limit) => (source ? source.locateFiles(chatId, limit) : Promise.resolve([])),
      })
    : null

  // —— M4-T4.3：提醒计划器（默认关 = 零心跳、零通知；时点表见 reminder.ts 头注） ——
  const reminder = config.reminderEnabled
    ? new ReminderService({
        groupStore,
        notifier,
        outbox,
        store,
        logger,
        enabled: true,
        deadline1hRemind: config.deadline1hRemind,
        groups: config.groups,
      })
    : null

  // —— M6-T1：保留期清理（messages 90 天滚动；长期表不动；审计只记条数） ——
  const retention = new RetentionService({
    groupStore,
    store,
    groups: config.groups,
    retentionDays: config.retentionDays,
    logger,
  })

  const distiller = new Distiller({
    buffer,
    llm: llmClient,
    personas,
    groupPersonas: config.groupPersonas ?? {},
    logger: logger as unknown as StoreLogger,
    distillEveryMessages: config.distillEveryMessages,
    distillIntervalMin: config.distillIntervalMin,
    llmCallRecorder, // T3：提炼调用也落 llm_call（phase='distill'）
    // T8：distiller 批上限读该群 safe-batch 状态（只读不写——不污染报告管线反馈环；
    // 取 daily 条目——日报是报告主路径，其收缩信号对 distiller 同样成立）；
    // 无状态回退 min(distillEveryMessages, batchThreshold) 静态上限
    batchThreshold: config.batchThreshold,
    readSafeBatch: (chatId: string): number | null => {
      const raw = store.readText(safeBatchRelPath(chatId))
      if (raw === null) return null
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const e = parsed?.daily as { safeBatch?: unknown } | null | undefined
        return typeof e?.safeBatch === 'number' && Number.isFinite(e.safeBatch) && (e.safeBatch as number) > 0
          ? Math.floor(e.safeBatch as number)
          : null
      } catch {
        return null
      }
    },
    onInsights,
  })

  const bus = new MessageBus({
    groups: config.groups,
    buffer,
    bucket,
    onAccepted: (chatId) => distiller.onNewMessage(chatId),
  })

  // —— W2 接线：可选本地库消息源（source='wechat-db' 时启用）——
  // 白名单为空 → WechatDbSource 构造即抛错（fail-closed），这里降级为“无源运行”并大声记日志。
  if (config.source !== 'none' && config.source !== 'wechat-db') {
    throw new Error(`unknown source "${config.source}" (expected "none" | "wechat-db") — refuse to start (fail-closed)`)
  }
  if (config.distillMode !== 'fused' && config.distillMode !== 'split') {
    throw new Error(`unknown distillMode "${config.distillMode}" (expected "fused" | "split") — refuse to start (fail-closed)`)
  }
  let source: WechatDbSource | null = null
  // M2-T2.1：昵称解析器引用（供 persona-track 复用 W3 映射链；source 未启用时为 null）
  let nicknameResolverRef: NicknameResolver | null = null
  if (config.source === 'wechat-db') {
    try {
      // 规范化（复用性）：机器相关路径无源码默认值——启用读取时必须显式配置，缺失即 fail-closed 拒读。
      if (!config.sourceToolDir || !config.sourceDbRoot) {
        throw new Error(
          'wechat-db source: sourceToolDir and sourceDbRoot are required when source="wechat-db" ' +
            '(no machine-specific defaults in plugin; set them explicitly in profile config)',
        )
      }
      const sourcePython = config.sourcePython && config.sourcePython !== '' ? config.sourcePython : 'python3'
      // W3：昵称解析器（密钥纪律见 nickname.ts 头注——经 stdin 传 PRAGMA，绝不进日志/argv/git）
      const nicknameResolver = new NicknameResolver({
        contactDbPath: join(config.sourceDbRoot, 'contact/contact.db'),
        keysJsonPath: join(config.sourceToolDir, '.wechat-local/keys.json'),
        logger: logger as unknown as import('./source/nickname.js').NicknameLogger,
      })
      source = new WechatDbSource({
        groups: config.groups,
        dbRoot: config.sourceDbRoot,
        toolDir: config.sourceToolDir,
        pythonPath: sourcePython,
        store,
        stateDir,
        logger: logger as unknown as import('./source/wechat-db.js').WechatDbSourceLogger,
        pollIntervalMs: config.pollIntervalSec * 1000,
        readLimit: config.readLimit,
        backfillOnStart: config.backfillOnStart,
        nicknameResolver,
        onMessages: (messages: WechatDbMessage[]) => {
          for (const message of messages) {
            const accepted = bus.ingest(message)
            // M2-T1.2 落库接线：消毒/限流通过后异步写每群 SQLite 桶；不阻塞提炼主流程，
            // appendMessages 失败只 warn（服务层已兜底，这里再兜一层）。
            // senderPid 暂存 wxid 原值（sender→P01 代号化是 M2 后续任务）。
            if (accepted && message.messageId) {
              const msgs: import('./group-store.js').StorableMessage[] = []
              // M2-T1.2：被引用原文不在库 → 先落 qref-* 占位行（满足 quote_of_msg_id 外键，
              // 原文保留在该行 text，链查询可沿链取到），再落回复行。
              if (message.quoteOfMsgId?.startsWith('qref-')) {
                msgs.push({
                  msgId: message.quoteOfMsgId,
                  ts: message.ts,
                  senderPid: 'unknown',
                  senderName: message.quoteRefName ?? '',
                  kind: 'text',
                  text: message.quoteRefText ?? '',
                  rawClass: 'quote-placeholder',
                })
              }
              msgs.push({
                msgId: message.messageId,
                ts: message.ts,
                senderPid: message.sender,
                senderName: message.senderName,
                kind: message.kind ?? 'text',
                text: message.text,
                quoteOfMsgId: message.quoteOfMsgId,
              })
              void groupStore
                .appendMessages(message.chatId, msgs)
                .then(() => {
                  // M4-T4.1 识别接线：落库成功后触发一次该群识别扫描（并发自动合并；
                  // taskRecognitionEnabled=false 时为 null，零开销）。
                  if (taskRecognition) {
                    void taskRecognition.scanChat(message.chatId).catch((error: unknown) =>
                      logger.warn(`task-recognition scan failed: ${String(error)}`),
                    )
                  }
                  // M5-T5.1/T5.3 接线：承诺识别 + 文件索引同样落库后扫描（默认关 = null 零开销）
                  if (promiseRecognition) {
                    void promiseRecognition.scanChat(message.chatId).catch((error: unknown) =>
                      logger.warn(`promise-recognition scan failed: ${String(error)}`),
                    )
                  }
                  if (fileIndex) {
                    void fileIndex
                      .scanChat(message.chatId)
                      .then(() => {
                        // v0.4 media 镜像：与既有镜像同一消息处理周期（无独立定时器）——
                        // file-index 入库后把 groupStore files 全量 upsert 进 knowledge.db.media
                        try {
                          store.mirrorMedia(message.chatId, groupStore.getFiles(message.chatId, { limit: 1000 }))
                        } catch (error: unknown) {
                          logger.warn(`media mirror failed: ${String(error)}`)
                        }
                      })
                      .catch((error: unknown) => logger.warn(`file-index scan failed: ${String(error)}`))
                  }
                  // M6-T3：事件↔文件自动关联（低风险：只写 events.file_ids 关联行，
                  // 不改事件本体；confidence 只进 audit 元数据）
                  if (fileIndex || taskRecognition) {
                    void linkFilesToEvents(message.chatId, {
                      groupStore,
                      logger: logger as unknown as StoreLogger,
                      auditAppend: (entry) => {
                        store.appendJsonl('audit/event-file-link.jsonl', entry)
                      },
                    }).catch((error: unknown) =>
                      logger.warn(`event-file link failed: ${String(error)}`),
                    )
                  }
                })
                .catch((error: unknown) =>
                  logger.warn(`group-store appendMessages failed: ${String(error)}`),
                )
            }
          }
        },
      })
      // M2-T2.1：把解析器交给 persona-track 复用（wxid → 群昵称映射链）
      nicknameResolverRef = nicknameResolver
    } catch (error) {
      logger.error(`wechat-db source refused to start (fail-closed): ${String(error)}`)
      source = null
    }
  }

  // —— M2-T2.1/T2.4：关注名单 + 按人跨群检索（配置文件唯一入口；空名单 fail-closed 零活动）——
  const personaTrack = new PersonaTrackService({ groupStore, logger })
  personaTrack.setNicknameSource(nicknameResolverRef)
  // TODO(M2+)：watchList 变更热同步；当前仅 apply 启动时同步一次（写入各群 identities）
  void personaTrack.syncWatchList(config.watchList ?? [], config.groups).catch((error) => {
    logger.error(`persona-track syncWatchList failed: ${String(error)}`)
  })

  // —— M2-T2.3：人物按天增量摘要（默认关；generateDaily 手动 API，M3 报告引擎统一接调度）——
  const personDigest = config.personDigestEnabled
    ? new PersonDigestService({
        groupStore,
        store,
        stateDir,
        llm: llmClient,
        logger: logger as unknown as StoreLogger,
        enabled: true,
        activitySpikeMultiplier: config.activitySpikeMultiplier, // M6-T4：突变倍数配置化
        batchThreshold: config.batchThreshold,
      })
    : null

  const api: GroupLurker = {
    stateDir,
    store,
    personas,
    buffer,
    bus,
    distiller,
    journal,
    groupStore,
    personaTrack,
    personDigest,
    report,
    outbox,
    sender,
    taskRecognition,
    reminder,
    promiseRecognition,
    promiseReminder,
    fileIndex,
    scheduler,
    notifier,
    source,
    getStatus: () => {
      const out: ReturnType<GroupLurker['getStatus']> = {}
      const chats = new Set<string>(config.groups)
      for (const chatId of chats) {
        const st = distiller.status(chatId)
        const jst = journal.status(chatId)
        out[chatId] = {
          buffered: buffer.size(chatId),
          dropped: bus.dropped(chatId),
          // 计数以 journal（本地自然日、已落盘条目）为准，distiller 作回退
          todayCount: jst.todayCount || st.todayCount,
          lastDistillAt: jst.lastDistillAt ?? st.lastDistillAt,
          source: source
            ? {
                running: source.status().running,
                lastPollAt: source.status().lastPollAt,
                consecutiveFailures: source.status().consecutiveFailures,
              }
            : { running: false, lastPollAt: null, consecutiveFailures: 0 },
        }
      }
      return out
    },
  }

  // 所有随插件生命周期回收的资源都挂在这里（dispose 无残留定时器/监听的保证点）。
  ctx.effect(() => {
    logger.info(`group-lurker ready, stateDir=${stateDir}, groups=${JSON.stringify(config.groups)}`)
    // 事件监听：ctx.on（bus.attach 内部）随插件 dispose 自动回收。
    bus.attach(ctx)
    // 定时提炼：start() 返回 clearInterval 清理函数，包进 effect 返回值 → dispose 无定时器残留。
    const stopTimer = distiller.start()
    // W2 消息源轮询：同样 start() → clearInterval 约定；锁被占（单实例冲突）时拒启并记日志。
    let stopSource: (() => void) | null = null
    if (source) {
      try {
        stopSource = source.start()
        logger.info(`wechat-db source started, poll=${config.pollIntervalSec}s`)
      } catch (error) {
        logger.error(`wechat-db source start refused: ${String(error)}`)
      }
    }
    // M1-T1.3 调度器：同样 start() → 清理函数约定；触发点持久化在 stateDir。
    let stopScheduler: (() => void) | null = null
    if (scheduler) {
      try {
        stopScheduler = scheduler.start()
        logger.info(`scheduler started (daily=${config.dailyReportTime}, weekly=${config.weeklyReportTime}, monthly=${config.monthlyReportTime}, stagger=${config.staggerMinutes}m${config.scheduleTestMode && config.testKindIntervalMin > 0 ? `, testMode=every ${config.testKindIntervalMin}min force weekly/monthly` : ''})`)
      } catch (error) {
        logger.error(`scheduler start refused: ${String(error)}`)
      }
    }
    // M4-T4.3 提醒计划器：同样 start() → 清理函数约定；disabled 时 start 返回 noop。
    let stopReminder: (() => void) | null = null
    if (reminder) {
      try {
        stopReminder = reminder.start()
        logger.info(`reminder started (1h=${config.deadline1hRemind}, digest=07:50)`)
      } catch (error) {
        logger.error(`reminder start refused: ${String(error)}`)
      }
    }
    // M5-T5.2 承诺提醒心跳：同样 start() → 清理函数约定（disabled 时为 null）。
    let stopPromiseReminder: (() => void) | null = null
    if (promiseReminder) {
      stopPromiseReminder = promiseReminder.start()
      logger.info('promise reminder started')
    }
    // M6-T1 保留期清理心跳：start() → clearInterval 约定（立即先跑一轮）。
    const stopRetention = retention.start()
    // 红线升级（2026-10-14）：filehelper 发送 worker 心跳（senderEnabled=false 时为 noop 零活动）。
    const stopSender = sender.start()
    // 前端动作收件箱心跳（webActionsEnabled=false 时为 null = 零活动）。
    const stopInbox = actionInbox?.start() ?? null
    // files 子命令清单摄取心跳（修复"49≠链接"归档缺口；fileIndex 关或周期 0 时零活动）。
    // 独立于消息流扫描的兜底路径：立即先跑一轮，此后按 fileIndexListIntervalMin 周期执行；
    // 单群超时/失败只 warn（safe 包裹，不阻塞主流程）；摄取后同消息流口径镜像 media 表。
    let stopFileList: (() => void) | null = null
    if (fileIndex && config.fileIndexListIntervalMin > 0) {
      const listTick = async (): Promise<void> => {
        for (const chatId of config.groups) {
          try {
            const result = await new Promise<Awaited<ReturnType<FileIndexService['ingestFromListing']>>>((resolve, reject) => {
              const t = setTimeout(() => reject(new Error(`timeout ${config.fileIndexListTimeoutMs}ms`)), Math.max(1_000, config.fileIndexListTimeoutMs))
              fileIndex
                .ingestFromListing(chatId, config.fileIndexListLimit)
                .then((r) => { clearTimeout(t); resolve(r) }, (e) => { clearTimeout(t); reject(e) })
            })
            if (result.newFiles > 0) {
              try {
                store.mirrorMedia(chatId, groupStore.getFiles(chatId, { limit: 1000 }))
              } catch (error) {
                logger.warn(`media mirror failed: ${String(error)}`)
              }
              logger.info(`file-index listing ingest ${chatId}: new=${result.newFiles} merged=${result.appearancesMerged}`)
            }
          } catch (error) {
            logger.warn(`file-index listing ingest failed for ${chatId}: ${String(error)}`)
          }
        }
      }
      void listTick() // 启动即先补一轮（水位/去重键保证幂等）
      const id = setInterval(() => void listTick(), Math.max(60_000, config.fileIndexListIntervalMin * 60_000))
      stopFileList = () => clearInterval(id)
      logger.info(`file-index listing ingest started (interval=${config.fileIndexListIntervalMin}min, timeout=${config.fileIndexListTimeoutMs}ms, limit=${config.fileIndexListLimit})`)
    }
    return () => {
      stopTimer() // clearInterval：主提炼定时器释放点（setInterval 另有各 start() 返回的清理函数）
      stopSource?.() // clearInterval + 释放单实例锁
      stopFileList?.() // files 清单摄取心跳唯一释放点
      stopScheduler?.() // clearInterval：调度器心跳唯一释放点
      stopReminder?.() // clearInterval：提醒心跳唯一释放点
      stopPromiseReminder?.() // M5：承诺提醒心跳唯一释放点
      stopRetention() // M6：保留期清理心跳唯一释放点
      stopSender()
      stopInbox?.() // 发送 worker 心跳唯一释放点（senderEnabled=false 时 noop）
      distiller.dispose()
      journal.dispose() // 无定时器，清计数/日报内存引用
      personDigest?.dispose() // M2-T2.3：无定时器，清并发去重表
      report?.dispose() // M3：无定时器，清并发去重表
      taskRecognition?.dispose() // M4：无定时器，清并发去重表
      promiseRecognition?.dispose() // M5：无定时器，清并发去重表
      fileIndex?.dispose() // M5：无定时器，清并发去重表
      reminder?.stop() // M4：clearInterval（双保险）+ 清速览内存态
      promiseReminder?.stop() // M5：clearInterval（双保险）
      groupStore.dispose() // 关闭全部 SQLite 句柄（WAL checkpoint 随 close 完成）
      buffer.clear()
      personas.clear()
      logger.info('group-lurker disposed')
    }
  }, 'group-lurker.serve')

  // 挂到宿主上下文，供其它模块只读访问。
  // cordis 的 Context 是 Proxy：必须先 provide 声明，才能在 ctx 上暴露属性（直接赋值会抛
  // "cannot set property without provide"）。provide 注册为服务，其它模块经 ctx.groupLurker
  // 或 ctx.get('groupLurker') 只读访问，随本插件 dispose 自动注销。
  ctx.provide('groupLurker', api)
}
