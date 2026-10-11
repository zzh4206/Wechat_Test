/**
 * persona.ts：人格加载器（WP2）。
 *
 * 约定（PRD F3 / TECH-DESIGN §2）：
 * - 人格是 Markdown 文本（语气、风格、关注话题、禁忌），用作系统提示式描述；
 * - 内置默认人格 default 随包发布（lib/personas/default.md，构建脚本从 src/personas 复制）；
 * - 命名人格位于 <stateDir>/personas/<name>.md；
 * - 按群覆盖：groupPersonas[chatId] 指定人格名，未配置回退 default；
 * - 文件缺失/读失败：回退内置 default 并记 logger 警告，绝不抛出致命错误。
 *
 * 安全约定：只读，无任何写入与网络调用；缓存随 ctx.effect dispose 清空。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoreLogger } from './store.js'

export const DEFAULT_PERSONA = 'default'

/** 内置人格文件随包发布在 lib/personas/ 下（构建时由 scripts 复制） */
const bundledDir = fileURLToPath(new URL('./personas/', import.meta.url))

export interface PersonaReader {
  /** 同步读文件；失败抛错由调用方处理 */
  (path: string): string
}

export interface PersonaLogger {
  warn(message: string): unknown
}

export interface PersonaServiceOptions {
  stateDir: string
  logger: PersonaLogger
  /** 测试注入用读文件函数；缺省用 node:fs readFileSync utf8 */
  read?: PersonaReader
}

/** 默认读文件（utf8）。readFileSync 重载签名过多，包一层满足 PersonaReader */
function defaultRead(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * 读内置默认人格。读失败返回最小兜底文本（不应发生：随包发布）。
 */
export function loadBundledDefault(read: PersonaReader = defaultRead): string {
  try {
    return read(join(bundledDir, `${DEFAULT_PERSONA}.md`))
  } catch {
    return `你是中文群聊的旁观者分析引擎：冷静、简洁、只归纳观点，不记录隐私，不编造内容。`
  }
}

/** 一次性加载：命名人格缺失时回退内置 default（不缓存，适合低频调用） */
export function loadPersona(stateDir: string, name: string, read: PersonaReader = defaultRead): string {
  if (name === DEFAULT_PERSONA) return loadBundledDefault(read)
  return read(join(stateDir, 'personas', `${name}.md`))
}

/**
 * 带缓存的人格服务：同一 name 只读一次盘；resolve 按群覆盖选人格，
 * 任何读失败都回退内置 default 并告警。
 */
export class PersonaService {
  private readonly cache = new Map<string, string>()
  private readonly stateDir: string
  private readonly logger: PersonaLogger
  private readonly read: PersonaReader

  constructor(options: PersonaServiceOptions) {
    this.stateDir = options.stateDir
    this.logger = options.logger
    this.read = options.read ?? defaultRead
  }

  /** 加载人格（带缓存）。缺失/读失败回退内置 default 并告警，返回值永非空。 */
  load(name: string): string {
    const cached = this.cache.get(name)
    if (cached !== undefined) return cached
    let text: string
    if (name === DEFAULT_PERSONA) {
      text = loadBundledDefault(this.read)
    } else {
      try {
        text = this.read(join(this.stateDir, 'personas', `${name}.md`))
      } catch (error) {
        this.logger.warn(`persona "${name}" not loaded, fallback to default: ${String(error)}`)
        text = loadBundledDefault(this.read)
      }
    }
    this.cache.set(name, text)
    return text
  }

  /**
   * 按群解析人格：先查 groupPersonas[chatId]，未配置/空则 default。
   * 每个群各自 resolve，互不串扰（缓存按 name 隔离）。
   */
  resolve(chatId: string, groupPersonas: Record<string, string> | undefined): string {
    const name = groupPersonas?.[chatId] || DEFAULT_PERSONA
    return this.load(name)
  }

  /** 清空缓存（dispose 时调用） */
  clear(): void {
    this.cache.clear()
  }
}
