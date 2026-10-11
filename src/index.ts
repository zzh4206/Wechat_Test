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

export interface PluginConfig {
  stateDir: string
  groups: string[]
  bufferSize: number
  distillEveryMessages: number
  distillIntervalMin: number
  persona: string
  /** chatId → 人格名（按群覆盖）；未配置的群回退内置 default */
  groupPersonas: Record<string, string>
}

export const name = 'dsh-group-lurker'

// 越少越安全：只声明真正需要的宿主服务。
export const inject = ['llm'] as const

export const Config: Schema<PluginConfig> = Schema.object({
  stateDir: Schema.string().default(''),
  groups: Schema.array(String).default([]),
  bufferSize: Schema.number().default(60),
  distillEveryMessages: Schema.number().default(25),
  distillIntervalMin: Schema.number().default(15),
  persona: Schema.string().default('default'),
  groupPersonas: Schema.dict(String).default({}),
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
  /** 运行可见性（PRD F5）：各群缓冲水位 / 今日条数 / 最近提炼时间 */
  getStatus(): Record<
    string,
    { buffered: number; dropped: number; todayCount: number; lastDistillAt: number | null }
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

  const api: GroupLurker = {
    stateDir,
    store,
    personas,
    buffer,
    bus,
    distiller,
    journal,
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
    return () => {
      stopTimer() // clearInterval：唯一 setInterval 的释放点
      distiller.dispose()
      journal.dispose() // 无定时器，清计数/日报内存引用
      buffer.clear()
      personas.clear()
      logger.info('group-lurker disposed')
    }
  }, 'group-lurker.serve')

  // 挂到宿主上下文，供其它模块只读访问。
  ;(ctx as Context & { groupLurker?: GroupLurker }).groupLurker = api
}
