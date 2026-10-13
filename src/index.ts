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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'
import type { StoreLogger } from './store.js'
import { PersonaService } from './persona.js'
import { TokenBucket } from './guard.js'
import { BufferPool } from './buffer.js'
import { MessageBus } from './bus.js'
import { Distiller, DefaultLlmClient } from './distiller.js'
import type { LlmClient, HostLlmService, Insight } from './distiller.js'
import { InsightsJournal } from './journal.js'
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

  const store = new Store(stateDir, logger)
  // 初始化即建目录；失败只记日志，不阻断宿主。
  store.ensureDir('.')

  const personas = new PersonaService({ stateDir, logger })

  // —— WP3 接线：限流 → 缓冲 → 提炼 → 事件总线 ——
  const bucket = new TokenBucket() // 默认 1 条/秒、突发 5（TECH-DESIGN §3）
  const buffer = new BufferPool({ bufferSize: config.bufferSize })

  // WP4 接线：提炼产出 → journal（二次校验 type + 截断引用 + jsonl/日报落盘）。
  const journal = new InsightsJournal({ store, logger: logger as unknown as StoreLogger })
  const onInsights = (chatId: string, insights: Insight[]): void => {
    journal.record(chatId, insights)
  }

  const llmClient: LlmClient = new DefaultLlmClient(
    (ctx as Context & { llm?: HostLlmService }).llm,
  )
  const distiller = new Distiller({
    buffer,
    llm: llmClient,
    personas,
    groupPersonas: config.groupPersonas ?? {},
    logger: logger as unknown as StoreLogger,
    distillEveryMessages: config.distillEveryMessages,
    distillIntervalMin: config.distillIntervalMin,
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
  let source: WechatDbSource | null = null
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
          for (const message of messages) bus.ingest(message)
        },
      })
    } catch (error) {
      logger.error(`wechat-db source refused to start (fail-closed): ${String(error)}`)
      source = null
    }
  }

  const api: GroupLurker = {
    stateDir,
    store,
    personas,
    buffer,
    bus,
    distiller,
    journal,
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
    return () => {
      stopTimer() // clearInterval：唯一 setInterval 的释放点
      stopSource?.() // clearInterval + 释放单实例锁
      distiller.dispose()
      journal.dispose() // 无定时器，清计数/日报内存引用
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
