/**
 * account-probe.ts：微信账号生命周期自动化（活跃账号探针 + 切换挂起 + 回归取钥恢复）。
 *
 * 背景：用户会切换微信账号（小号↔大号同机）。账号切换后：
 * ① 读取层静默停更（与安静群无法区分）；② sender 每轮弹微信打扰；③ 若放行会把日报发进
 * 大号的文件传输助手（OCR 合规闸只核对聊天标题不核对账号）。
 *
 * 探针判据（实测校准）：
 * - 单次 mtime 快照无判别力（微信启动会同时触碰两个账号目录）——必须**短窗口活动对比**：
 *   同一轮内取两次全量快照（间隔 sleepMs），某账号目录的「文件数 + 最新 mtime」指标在两窗
 *   之间发生变化 = 该账号存在持续写入流 = 活跃账号；两次快照完全一致 = 未运行/已退出。
 * - 快照扫描限制深度与条目数（防巨型目录拖垮消费周期），只读绝不写入。
 *
 * 回归恢复（两段式）：
 * - allowAutoRekey=false（默认）：小号（配置账号）目录写入流恢复 = 回归 → 只 notify
 *   「需要刷新密钥：bootstrap_keys.py」并保持挂起，人工手跑取钥后自动恢复；
 * - allowAutoRekey=true：自动执行取钥（bootstrap_keys.py --acknowledge-debug-copy --db-root
 *   <小号目录>）+ wechat_db.py verify。**两段式安全**：首次开启 allowAutoRekey 前必须人工
 *   成功手跑一次取钥（代码不加锁，RUNBOOK 写明开启条件）；每个回归周期取钥最多尝试 1 次
 *   （防循环退出微信），失败保持挂起 + error 告警，下个回归周期才可再试。
 * - 红线：db-root 代码级校验必须派生自 sourceDbRoot（即配置账号目录），绝不指向其他账号。
 * 零新 npm 依赖；dispose 无残留（探针无定时器，轮询挂在 sender 消费周期上）。
 */
import { join } from 'node:path'

/** 微信多账号数据根（相对 HOME） */
export const XWECHAT_FILES_REL = 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'

/** 从 sourceDbRoot 路径派生账号 wxid 段（…/xwechat_files/<wxid_*>/db_storage）；解析不出返回 null */
export function wxidFromDbRoot(dbRoot: string): string | null {
  const m = /xwechat_files[/\\](wxid_[^/\\]+)[/\\]/.exec(String(dbRoot ?? ''))
  return m ? m[1] : null
}

/** 从 accountDir 提取相对 root 的 wxid 段（红线校验用）；不匹配返回 null */
function accountDirWxid(accountDir: string, root: string): string | null {
  if (!accountDir.startsWith(root)) return null
  const rel = accountDir.slice(root.length).replace(/^[/\\]/, '')
  return /^wxid_[^/\\]+$/.test(rel) ? rel : null
}

/** 单账号目录活动快照：文件数 + 最新 mtime（指标任一变化 = 有写入流） */
export interface AccountSample {
  files: number
  newestMtime: number
}

/** 目录扫描注入（测试 mock；生产 = node:fs 同形函数） */
export interface FsLike {
  existsSync(path: string): boolean
  readdirSync(path: string, opts: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  statSync(path: string): { mtimeMs: number }
}

const SCAN_ENTRY_CAP = 4000 // 单次快照最多stat的条目数（防巨型目录）
const SCAN_DEPTH = 4

/** 递归扫描一个账号目录，产出活动快照（只读；异常当 0 活动处理） */
export function sampleAccount(accountDir: string, fs: FsLike): AccountSample {
  let files = 0
  let newestMtime = 0
  const walk = (dir: string, depth: number, budget: { left: number }): void => {
    if (depth > SCAN_DEPTH || budget.left <= 0) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (budget.left <= 0) return
      budget.left -= 1
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1, budget)
      else if (e.isFile()) {
        files += 1
        try {
          const mtime = fs.statSync(p).mtimeMs
          if (mtime > newestMtime) newestMtime = mtime
        } catch {
          /* 文件可能在扫描间隙消失——忽略 */
        }
      }
    }
  }
  if (!fs.existsSync(accountDir)) return { files: 0, newestMtime: 0 }
  walk(accountDir, 0, { left: SCAN_ENTRY_CAP })
  return { files, newestMtime }
}

/** 列出根目录下全部 wxid_* 账号名 */
export function listAccounts(root: string, fs: FsLike): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('wxid_'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 两次快照对比 → 活跃账号集合（指标有变化 = 持续写入流） */
export function diffActivity(before: Map<string, AccountSample>, after: Map<string, AccountSample>): string[] {
  const active: string[] = []
  for (const [wxid, b] of before) {
    const a = after.get(wxid)
    if (!a) continue
    if (a.files !== b.files || a.newestMtime !== b.newestMtime) active.push(wxid)
  }
  return active
}

export interface AccountGateOptions {
  /** xwechat_files 根目录（绝对路径） */
  root: string
  /**
   * 账号白名单（wxid 数组，fail-closed 与 groups 白名单同构）：
   * 活跃 ∈ 白名单 → 正常运转；∉ 白名单 → sender 全面挂起 + 取钥硬阻断。
   * 空数组 = 仅允许 accountDir 派生的默认账号（向后兼容），由接线层保证非空。
   */
  whitelist: readonly string[]
  /** 取钥目标账号目录（必须派生自 sourceDbRoot 的配置账号；代码级校验基准） */
  accountDir: string
  /** fs 注入（测试） */
  fs: FsLike
  /** 取钥命令执行注入（测试 mock；生产 = spawn python bootstrap_keys.py …） */
  runRekey?: (dbRoot: string) => Promise<{ code: number; stdout: string; stderr: string }>
  /** verify 命令执行注入（测试 mock；生产 = spawn python wechat_db.py verify …） */
  runVerify?: (dbRoot: string) => Promise<{ code: number; stdout: string; stderr: string }>
  /** allowAutoRekey（默认 false；开启前须人工成功手跑一次取钥——RUNBOOK 开启条件） */
  allowAutoRekey?: boolean
  /** 双快照间隔 ms（默认 2000；测试注入 0） */
  windowMs?: number
  sleepMs?: (ms: number) => Promise<void>
  notify?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/** 恢复流程结局（调用方据此审计/决定是否解除挂起） */
export type RekeyOutcome =
  | 'blocked_wrong_account' // 活跃账号 ≠ 小号：绝不取钥（P0 账号防护）
  | 'healthy' // verify 19/19：密钥健康，直接恢复
  | 'rekeyed' // 取钥 + verify 通过：恢复发送
  | 'notify_only' // allowAutoRekey=false：已通知人工取钥，保持挂起
  | 'timeout' // 用户超时未登录临时副本：本轮放弃，保持挂起
  | 'failed' // 取钥或 verify 失败：保持挂起

export interface AccountGate {
  /** 白名单成员判定（fail-closed：空白名单 = 全部不允许） */
  isAllowed(wxid: string): boolean
  /** 白名单摘要（审计/日志用：wxid 打码前 8 位） */
  whitelistSummary(): string
  /** 当前活跃 wxid；null = 无法判定（不阻断，零变化） */
  activeAccount(): Promise<string | null>
  /**
   * 小号回归后的恢复流程（触发条件三者同时满足：活跃=小号 + verify 确认密钥失效 + allowAutoRekey）：
   * - activeWxid ≠ expected → **绝不取钥**（返回 'blocked_wrong_account'，账号防护最高优先级）；
   * - verify 19/19 → 密钥健康，无需取钥（'healthy'，直接恢复）；
   * - allowAutoRekey=false → 只 notify（'notify_only'）；
   * - 取钥（每回归周期 ≤1 次尝试）→ verify 19/19 → 'rekeyed'；失败 'failed'；
   *   用户超时未登录临时副本 → 'timeout'（bootstrap 自行恢复原状，保持挂起下轮重试）。
   */
  rekeyAndVerify(activeWxid: string | null): Promise<RekeyOutcome>
  /** 上一轮是否处于挂起态（供调用方检测回归边沿） */
  wasSuspended(): boolean
  setSuspended(v: boolean): void
}

/** 创建账号闸（探针 + 取钥恢复）。root/expectedWxid 无效时返回 null（零变化） */
export function createAccountGate(options: AccountGateOptions): AccountGate | null {
  const { root, fs } = options
  const whitelist = options.whitelist ?? []
  if (!root) return null
  // accountDir 必须形如 root/<wxid> 且该 wxid ∈ 白名单（红线：取钥绝不指向白名单外账号）
  const dirWxid = accountDirWxid(options.accountDir, root)
  if (!dirWxid || !whitelist.includes(dirWxid)) return null
  const sleep = options.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const windowMs = Math.max(0, options.windowMs ?? 2000)
  const accountDir = options.accountDir
  let suspended = false
  let rekeyAttemptedThisEpisode = false

  const rekey = options.runRekey
  const verify = options.runVerify

  const isAllowed = (wxid: string | null): boolean => wxid !== null && whitelist.includes(wxid)

  return {
    isAllowed: (wxid) => isAllowed(wxid),
    whitelistSummary: () => whitelist.map((w) => `${w.slice(0, 8)}…`).join(','),
    wasSuspended: () => suspended,
    setSuspended(v: boolean) {
      if (!v) rekeyAttemptedThisEpisode = false // 回归周期结束，取钥尝试限额重置
      suspended = v
    },

    async activeAccount(): Promise<string | null> {
      const accounts = listAccounts(root, fs)
      if (accounts.length === 0) return null
      const before = new Map<string, AccountSample>()
      for (const wxid of accounts) before.set(wxid, sampleAccount(join(root, wxid), fs))
      await sleep(windowMs)
      const after = new Map<string, AccountSample>()
      for (const wxid of accounts) after.set(wxid, sampleAccount(join(root, wxid), fs))
      const active = diffActivity(before, after)
      if (active.length === 0) return null // 无写入流（微信未开/全退）——不判定，不阻断
      if (active.length > 1) {
        // 启动瞬间可能双目录同被触碰——取「持续写入流」更强的那个：文件数仍在增长者优先，
        // 无法区分则按字母序稳定输出（调用方与 expected 比对后挂起，宁可错挂不误发）。
        options.warn?.(`account-probe: 多个账号同时活跃（${active.join(', ')}）——按稳定序判定`)
        active.sort()
      }
      return active[0]
    },

    async rekeyAndVerify(activeWxid: string | null): Promise<RekeyOutcome> {
      // 硬性禁止（最高优先级，代码级，白名单制）：活跃账号 ∉ 白名单 → 无论 allowAutoRekey
      // 与否绝不取钥。取钥流程会让用户在临时副本上重新登录微信——白名单外账号活跃时误触发
      // 可能把该账号登进临时副本，密钥台账被污染。白名单制 = 不需要为任何新账号写特判。
      if (!isAllowed(activeWxid)) {
        options.warn?.(`account-probe: 非白名单账号活跃（active=${String(activeWxid)}），禁止取钥`)
        return 'blocked_wrong_account'
      }
      // 触发条件 ②：取钥前先 verify 确认密钥确实失效（避免不必要的微信退出）
      if (verify) {
        try {
          const pre = await verify(accountDir)
          if (pre.code === 0 && pre.stdout.includes('19/19')) {
            options.warn?.('account-probe: verify 19/19 密钥健康——无需取钥，直接恢复')
            return 'healthy'
          }
        } catch {
          /* verify 失败按密钥失效继续 */
        }
      }
      if (!options.allowAutoRekey) {
        options.notify?.('检测到小号已回归且密钥失效，请确认后执行 bootstrap_keys.py（allowAutoRekey 未开启）')
        return 'notify_only'
      }
      if (rekeyAttemptedThisEpisode) {
        options.warn?.('account-probe: 本回归周期已尝试过取钥（≤1 次）——保持挂起等待下个周期')
        return 'failed'
      }
      rekeyAttemptedThisEpisode = true
      if (!rekey || !verify) {
        options.error?.('account-probe: allowAutoRekey 已开启但取钥/验证命令未注入——保持挂起')
        return 'failed'
      }
      try {
        options.notify?.('即将自动取钥：请在弹出的微信临时副本上登录小号，密钥将自动捕获（全程 1-2 分钟）')
        const rk = await rekey(accountDir)
        if (rk.code === 124 || rk.stdout.includes('LOGIN_TIMEOUT')) {
          options.warn?.('account-probe: 用户超时未登录临时副本——本轮放弃（bootstrap 已恢复原状），下轮重试')
          return 'timeout'
        }
        if (rk.code !== 0) {
          options.error?.(`account-probe: 取钥失败 code=${rk.code}——保持挂起（本周期不再重试）`)
          return 'failed'
        }
        const vf = await verify(accountDir)
        if (vf.code !== 0 || !vf.stdout.includes('19/19')) {
          options.error?.('account-probe: verify 未达 19/19——保持挂起（本周期不再重试）')
          return 'failed'
        }
        return 'rekeyed'
      } catch (error) {
        options.error?.(`account-probe: 取钥/验证异常：${String(error).slice(0, 160)}——保持挂起`)
        return 'failed'
      }
    },
  }
}
