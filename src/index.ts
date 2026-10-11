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

export interface PluginConfig {
  stateDir: string
  groups: string[]
  bufferSize: number
  distillEveryMessages: number
  distillIntervalMin: number
  persona: string
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
  // WP2/WP3 在此扩展：bus / buffer / distiller / persona 接口。
}

export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger(name)
  const stateDir = resolveStateDir(config.stateDir ?? '')

  const store = new Store(stateDir, logger)
  // 初始化即建目录；失败只记日志，不阻断宿主。
  store.ensureDir('.')

  const api: GroupLurker = { stateDir, store }

  // 所有随插件生命周期回收的资源都挂在这里（dispose 无残留定时器/监听的保证点）。
  ctx.effect(() => {
    logger.info(`group-lurker ready, stateDir=${stateDir}, groups=${JSON.stringify(config.groups)}`)
    // WP2/WP3：事件监听（ctx.on 会随插件回收）、每群环形缓冲、
    // 定时提炼（setInterval 也必须包进 effect 的清理函数）在此注册。
    return () => {
      // 释放点：关闭任何在用句柄；store 无长驻句柄，无需额外动作。
      logger.info('group-lurker disposed')
    }
  }, 'group-lurker.serve')

  // 占位导出：供 WP2/WP3 模块挂载（bus/buffer/distiller/persona 后续在此接线）。
  ;(ctx as Context & { groupLurker?: GroupLurker }).groupLurker = api
}
