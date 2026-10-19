// account-probe.test.mjs —— 账号生命周期自动化（白名单制：活跃探针 + 切换挂起 + 回归自动取钥）。
// 覆盖：双快照活动判据、白名单挂起（零微信交互/attempts 不耗/审计节流/摘要打码）、
//       回归通知（allowAutoRekey=false）、自动取钥成功/失败、verify 健康不取钥、
//       白名单外账号取钥硬阻断、超时未登录放弃、取钥 ≤1 次/回归周期、默认（无 gate）零变化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { createAccountGate, wxidFromDbRoot, sampleAccount, diffActivity, listAccounts } = await import('../lib/account-probe.js')
const { SenderService, SENDER_AUDIT_REL } = await import('../lib/sender.js')
const { Outbox, OUTBOX_REL } = await import('../lib/outbox.js')
const { Store } = await import('../lib/store.js')

const SMALL = 'wxid_small' // 配置账号（sourceDbRoot 派生）
const BIG = 'wxid_big' // 白名单外账号
const NEWACCT = 'wxid_new' // 未来任何新账号（白名单制无需特判）

/** 内存 fs：目录树 { path: {isDir, mtimeMs} }，带 touch 修改活动指标 */
function memFs(tree) {
  const touch = (p, mtimeMs) => {
    if (tree[p]) tree[p].mtimeMs = mtimeMs
    else tree[p] = { isDir: false, mtimeMs }
  }
  const fs = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(tree, p),
    readdirSync: (p) => {
      const out = []
      for (const [path, meta] of Object.entries(tree)) {
        const parent = path.slice(0, path.lastIndexOf('/')) || '/'
        if (parent === p || (parent === '' && p === '/')) {
          out.push({ name: path.slice(path.lastIndexOf('/') + 1), isDirectory: () => !!meta.isDir, isFile: () => !meta.isDir })
        }
      }
      for (const d of Object.keys(tree).filter((k) => tree[k].isDir)) {
        const parent = d.slice(0, d.lastIndexOf('/')) || '/'
        if (parent === p && !out.some((o) => o.name === d.slice(d.lastIndexOf('/') + 1))) {
          out.push({ name: d.slice(d.lastIndexOf('/') + 1), isDirectory: () => true, isFile: () => false })
        }
      }
      return out
    },
    statSync: (p) => ({ mtimeMs: tree[p]?.mtimeMs ?? 0 }),
  }
  return { ...fs, touch }
}

function fsTouch(tree, p, mtimeMs) {
  if (tree[p]) tree[p].mtimeMs = mtimeMs
  else tree[p] = { isDir: false, mtimeMs }
}

function makeTree(root) {
  const tree = { [root]: { isDir: true, mtimeMs: 1 } }
  for (const wxid of [SMALL, BIG]) {
    tree[`${root}/${wxid}`] = { isDir: true, mtimeMs: 1 }
    tree[`${root}/${wxid}/db_storage`] = { isDir: true, mtimeMs: 1 }
    tree[`${root}/${wxid}/db_storage/message.db`] = { isDir: false, mtimeMs: 100 }
  }
  return tree
}

function makeGate(tree, root, { whitelist = [SMALL], overrides = {} } = {}) {
  const fs = overrides.fs ?? memFs(tree)
  const gate = createAccountGate({
    root,
    whitelist,
    accountDir: `${root}/${SMALL}`,
    fs,
    windowMs: 0,
    sleepMs: () => Promise.resolve(),
    notify: (m) => overrides.notifies?.push(m),
    warn: (m) => overrides.warns?.push(m),
    error: (m) => overrides.errors?.push(m),
    ...overrides,
  })
  return { gate, fs }
}

test('wxidFromDbRoot：从 sourceDbRoot 派生 wxid 段；解析不出返回 null', () => {
  assert.equal(wxidFromDbRoot('$HOME/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_abc123/db_storage'), 'wxid_abc123')
  assert.equal(wxidFromDbRoot('/some/other/path'), null)
})

test('探针判据：窗口内有持续写入流 = 活跃；窗口内无写入 = null（单次快照无判别力）', async () => {
  const root = '/x'
  const tree = makeTree(root)
  // 无写入：两次快照一致 → null（不判定不阻断）
  const idle = makeGate(tree, root)
  assert.equal(await idle.gate.activeAccount(), null)
  // 配置账号在双快照窗口内持续写入 → active = 该账号
  const g1 = makeGate(tree, root, {
    overrides: { sleepMs: async () => { fsTouch(tree, root + '/' + SMALL + '/db_storage/message.db', 999); fsTouch(tree, root + '/' + SMALL + '/db_storage/new.msg', 1000) } },
  }).gate
  assert.equal(await g1.activeAccount(), SMALL)
  // 白名单外账号写入流 → active = 该账号（挂起判定交给 isAllowed）
  const g2 = makeGate(tree, root, {
    overrides: { sleepMs: async () => fsTouch(tree, root + '/' + BIG + '/db_storage/message.db', 555) },
  }).gate
  assert.equal(await g2.activeAccount(), BIG)
})

test('pure helpers：sampleAccount/listAccounts/diffActivity', () => {
  const root = '/x'
  const tree = makeTree(root)
  const fs = memFs(tree)
  assert.deepEqual(listAccounts(root, fs).sort(), [BIG, SMALL].sort())
  const before = new Map([[SMALL, sampleAccount(`${root}/${SMALL}`, fs)]])
  fs.touch(`${root}/${SMALL}/db_storage/message.db`, 777)
  const after = new Map([[SMALL, sampleAccount(`${root}/${SMALL}`, fs)]])
  assert.deepEqual(diffActivity(before, after), [SMALL])
})

// —— SenderService 集成 ——

function makeSenderEnv({ gate } = {}) {
  const dir = resolve(mkdtempSync(join(tmpdir(), 'acct-gate-')))
  const store = new Store(dir, { warn() {}, error() {} })
  store.ensureDir('.')
  const outbox = new Outbox({ store, now: () => new Date(2026, 9, 15, 12, 0).getTime() })
  const steps = []
  const logs = { warn: [], error: [], info: [] }
  const sender = new SenderService({
    outbox, store,
    logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
    enabled: true, dryRun: false, sendMethod: 'keyboard',
    maxSendsPerDay: 20,
    sourceToolDir: '/fake/macos-wechat-export',
    sourceDbRoot: '/fake/wechat-db-storage',
    sourcePython: 'python3',
    now: () => new Date(2026, 9, 15, 12, 0).getTime(),
    accountGate: gate ?? undefined,
    runCommand: (file, args) => {
      if (file === 'osascript') {
        const script = args[args.indexOf('-e') + 1] ?? ''
        steps.push(script.includes('activate') ? 'activate' : 'other-osascript')
        return Promise.resolve({ code: 0, stdout: '«class UTF8»"saved"', stderr: '' })
      }
      steps.push(`spawn:${args.join(' ')}`)
      return Promise.resolve({ code: 0, stdout: '{"messages":[{"content":"x"}]}', stderr: '' })
    },
    isFrontmost: () => Promise.resolve(true),
    systemIdleSec: () => Promise.resolve(999),
    sleepMs: () => Promise.resolve(),
  })
  return { dir, store, outbox, steps, logs, sender }
}

const readAudit = (dir) => {
  const p = join(dir, SENDER_AUDIT_REL)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('白名单外账号活跃 → 全面挂起（零键序零 attempts），审计 non_whitelisted 节流（首轮+每10轮）+ 缓存语义 warn', async () => {
  const root = '/x'
  const tree = makeTree(root)
  const pokeBig = async () => fsTouch(tree, root + '/' + BIG + '/db_storage/message.db', 555 + Math.random())
  const { gate } = makeGate(tree, root, { overrides: { sleepMs: pokeBig } })
  const env = makeSenderEnv({ gate })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  for (let i = 1; i <= 12; i++) {
    const r = await env.sender.processOnce()
    assert.equal(r.action, 'wrong_account_suspended')
  }
  assert.equal(env.steps.length, 0, '零微信交互（不 activate 不 OCR 不敲键）')
  const raw = readFileSync(join(env.dir, OUTBOX_REL), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))[0]
  assert.equal(raw.status, 'pending', 'pending 不耗 attempts')
  assert.equal(raw.attempts ?? 0, 0)
  const audit = readAudit(env.dir)
  const suspended = audit.filter((a) => a.result === 'non_whitelisted_account_suspended')
  assert.equal(suspended.length, 2, '首轮 + 第 10 轮（防刷屏）')
  assert.ok(String(suspended[0].activeDigest).startsWith('wxid_big'), '审计附活跃 wxid 摘要')
  assert.ok(env.logs.warn.some((m) => m.includes('缓存数据')), '读取层缓存语义提醒')
  rmSync(env.dir, { recursive: true, force: true })
})

test('白名单双账号（活跃 = 第二个）→ 正常运转（挂起不触发）', async () => {
  const root = '/x'
  const tree = makeTree(root)
  tree[`${root}/${NEWACCT}`] = { isDir: true, mtimeMs: 1 }
  tree[`${root}/${NEWACCT}/db_storage`] = { isDir: true, mtimeMs: 1 }
  tree[`${root}/${NEWACCT}/db_storage/message.db`] = { isDir: false, mtimeMs: 100 }
  const { gate } = makeGate(tree, root, {
    whitelist: [SMALL, NEWACCT],
    overrides: { sleepMs: async () => fsTouch(tree, root + '/' + NEWACCT + '/db_storage/message.db', 555) },
  })
  const env = makeSenderEnv({ gate })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.ok(['sent', 'failed'].includes(r.action), '白名单内 → 正常走发送链路，不挂起')
  assert.ok(!readAudit(env.dir).some((a) => a.result === 'non_whitelisted_account_suspended'))
  rmSync(env.dir, { recursive: true, force: true })
})

test('空白名单（默认派生语义）：gate 只允许 accountDir 派生账号；白名单外全挂起', () => {
  const root = '/x'
  const tree = makeTree(root)
  const { gate } = makeGate(tree, root, { whitelist: [SMALL] })
  assert.equal(gate.isAllowed(SMALL), true)
  assert.equal(gate.isAllowed(BIG), false)
  assert.equal(gate.isAllowed(NEWACCT), false, '新账号也无需特判——不在白名单即挂起')
})

test('回归 + 密钥健康（verify 19/19）→ 不取钥直接恢复', async () => {
  const root = '/x'
  const tree = makeTree(root)
  let rekeyCalls = 0
  let pokeSmall = false
  const { gate } = makeGate(tree, root, {
    overrides: {
      sleepMs: async () => {
        if (pokeSmall) fsTouch(tree, root + '/' + SMALL + '/db_storage/message.db', 777)
        else fsTouch(tree, root + '/' + BIG + '/db_storage/message.db', 555)
      },
      runVerify: () => Promise.resolve({ code: 0, stdout: 'verify 19/19 ok', stderr: '' }),
      runRekey: () => { rekeyCalls += 1; return Promise.resolve({ code: 0, stdout: '', stderr: '' }) },
    },
  })
  const env = makeSenderEnv({ gate })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  await env.sender.processOnce() // 挂起（poke 白名单外账号）
  pokeSmall = true
  await env.sender.processOnce() // 回归（poke 配置账号）
  assert.equal(rekeyCalls, 0, '密钥健康绝不取钥')
  const audit = readAudit(env.dir)
  assert.ok(audit.some((a) => a.result === 'account_recovered' && a.outcome === 'healthy'))
  rmSync(env.dir, { recursive: true, force: true })
})

test('回归 + 密钥失效 + allowAutoRekey=false → notify_only 保持挂起', async () => {
  const root = '/x'
  const tree = makeTree(root)
  const notifies = []
  let pokeSmall = false
  const { gate } = makeGate(tree, root, {
    overrides: {
      sleepMs: async () => {
        if (pokeSmall) fsTouch(tree, root + '/' + SMALL + '/db_storage/message.db', 777)
        else fsTouch(tree, root + '/' + BIG + '/db_storage/message.db', 555)
      },
      notifies,
      allowAutoRekey: false,
      runVerify: () => Promise.resolve({ code: 15, stdout: 'code 15', stderr: '' }),
    },
  })
  const env = makeSenderEnv({ gate })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  await env.sender.processOnce() // 挂起
  pokeSmall = true
  const r = await env.sender.processOnce() // 回归
  assert.equal(r.action, 'wrong_account_suspended', '保持挂起')
  assert.ok(notifies.some((m) => m.includes('bootstrap_keys.py')), '通知人工取钥')
  assert.ok(readAudit(env.dir).some((a) => a.result === 'rekey_notify_only'))
  rmSync(env.dir, { recursive: true, force: true })
})

test('白名单内回归+密钥失效+allowAutoRekey → 自动取钥成功 + verify 19/19 → 恢复；db-root 锁定配置账号目录', async () => {
  const root = '/x'
  const tree = makeTree(root)
  let healthy = false
  const rekeyArgs = []
  let pokeSmall = false
  const { gate } = makeGate(tree, root, {
    overrides: {
      sleepMs: async () => {
        if (pokeSmall) fsTouch(tree, root + '/' + SMALL + '/db_storage/message.db', 777)
        else fsTouch(tree, root + '/' + BIG + '/db_storage/message.db', 555)
      },
      allowAutoRekey: true,
      runVerify: () => Promise.resolve(healthy ? { code: 0, stdout: 'verify 19/19 ok', stderr: '' } : { code: 15, stdout: 'code 15', stderr: '' }),
      runRekey: (dbRoot) => {
        rekeyArgs.push(dbRoot)
        healthy = true
        return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' })
      },
    },
  })
  const env = makeSenderEnv({ gate })
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  await env.sender.processOnce() // 挂起
  pokeSmall = true
  await env.sender.processOnce() // 回归
  assert.deepEqual(rekeyArgs, [`${root}/${SMALL}`], 'db-root 代码级锁定配置账号目录')
  assert.ok(readAudit(env.dir).some((a) => a.result === 'account_recovered' && a.outcome === 'rekeyed'))
  rmSync(env.dir, { recursive: true, force: true })
})

test('白名单外账号活跃 → 取钥硬阻断（无论 allowAutoRekey），绝不 spawn 取钥', async () => {
  const root = '/x'
  const tree = makeTree(root)
  let rekeyCalls = 0
  const warns = []
  const { gate } = makeGate(tree, root, {
    overrides: {
      allowAutoRekey: true,
      warns,
      runVerify: () => Promise.resolve({ code: 15, stdout: '', stderr: '' }),
      runRekey: () => { rekeyCalls += 1; return Promise.resolve({ code: 0, stdout: '', stderr: '' }) },
    },
  })
  const outcome = await gate.rekeyAndVerify(BIG)
  assert.equal(outcome, 'blocked_wrong_account')
  const outcome2 = await gate.rekeyAndVerify(NEWACCT)
  assert.equal(outcome2, 'blocked_wrong_account', '新账号同样阻断——白名单制无需特判')
  assert.equal(rekeyCalls, 0, '白名单外绝不取钥')
  assert.ok(warns.some((m) => m.includes('禁止取钥')))
})

test('取钥失败 → 保持挂起；本回归周期只尝试 1 次（防循环退出微信）', async () => {
  const root = '/x'
  const tree = makeTree(root)
  let rekeyCalls = 0
  const { gate } = makeGate(tree, root, {
    overrides: {
      allowAutoRekey: true,
      runVerify: () => Promise.resolve({ code: 15, stdout: '', stderr: '' }),
      runRekey: () => { rekeyCalls += 1; return Promise.resolve({ code: 1, stdout: '', stderr: 'boom' }) },
    },
  })
  assert.equal(await gate.rekeyAndVerify(SMALL), 'failed')
  assert.equal(await gate.rekeyAndVerify(SMALL), 'failed')
  assert.equal(rekeyCalls, 1, '取钥 ≤1 次/回归周期')
  gate.setSuspended(false)
  await gate.rekeyAndVerify(SMALL)
  assert.equal(rekeyCalls, 2, '新周期（解除挂起）才可再试')
})

test('超时未登录临时副本 → timeout 放弃本轮保持挂起；取钥后 verify 不过 → failed', async () => {
  const root = '/x'
  const tree = makeTree(root)
  const timeoutGate = makeGate(tree, root, {
    overrides: {
      allowAutoRekey: true,
      runVerify: () => Promise.resolve({ code: 15, stdout: '', stderr: '' }),
      runRekey: () => Promise.resolve({ code: 124, stdout: 'LOGIN_TIMEOUT', stderr: '' }),
    },
  }).gate
  assert.equal(await timeoutGate.rekeyAndVerify(SMALL), 'timeout')
  const failGate = makeGate(tree, root, {
    overrides: {
      allowAutoRekey: true,
      runVerify: () => Promise.resolve({ code: 15, stdout: '', stderr: '' }),
      runRekey: () => Promise.resolve({ code: 0, stdout: 'ok', stderr: '' }),
    },
  }).gate
  assert.equal(await failGate.rekeyAndVerify(SMALL), 'failed')
})

test('默认（未注入 accountGate）零变化：既有链路原样', async () => {
  const env = makeSenderEnv()
  env.outbox.appendOutbox({ kind: 'daily', title: 't', body: 'b', evidence_ref: 'x' })
  const r = await env.sender.processOnce()
  assert.ok(['sent', 'failed'].includes(r.action), '无账号闸 = 行为与旧版一致')
  assert.equal(env.steps.filter((s) => s === 'activate').length, 1, '照常 activate')
  rmSync(env.dir, { recursive: true, force: true })
})
