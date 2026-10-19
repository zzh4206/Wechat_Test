# @zzh4206/dsh-group-lurker

[简体中文](README.md) ｜ **English**

[![CI](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml/badge.svg)](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)

A read-only [DSH](https://github.com/deepseek-ai) Cordis plugin that silently follows WeChat group chats: **it keeps a separate persona per group, distills topics / people / quotes, and produces structured logs plus a daily Markdown report.**

**macOS + WeChat 4.x only** (it reads the local SQLCipher database).

**[30-second overview](#30-second-overview)** ｜ [Quick start](#quick-start) ｜ [Configuration](#configuration) ｜ [Output](#what-you-get) ｜ [Security model](#security-model-five-red-lines) ｜ [Knowledge-base template](#knowledge-base-template-and-local-data) ｜ [Docs](#documentation)

---

## 30-second overview

| | |
|---|---|
| **What it does** | Reads the WeChat database **already logged in on your own machine** → distills per group → `insights.jsonl` + a daily Markdown report |
| **What it never does** | Never writes WeChat data, never touches the WeChat process, never reverses the wire protocol, never reads key files, sends nothing by default |
| **Default posture** | Empty allow-list = **refuses to start** (fail-closed); all four send gates closed |
| **You need** | macOS, WeChat 4.x, `sqlcipher`, a key-extraction tool, DSH ≥ 0.2.0-rc.2 |
| **Where output goes** | `$DSH_HOME/dsh-group-lurker/` (see [Output](#what-you-get)) |

## Design principles

1. **Deny by default** — an empty `groups` allow-list refuses startup; groups outside it cause **zero subprocess calls** at the adapter layer (enforced by tests)
2. **Read-only** — reading goes through a read-only subprocess; WeChat data is never written and the WeChat process is never touched
3. **Per-group isolation** — separate message buffer and separate persona (`personas/<name>.md`, overridable per group)
4. **Fully auditable** — `audit.log` records metadata only (time, group, count, success/failure), **never message content**

## Prerequisites

| Dependency | Notes |
|---|---|
| DSH ≥ `0.2.0-rc.2` | Host runtime |
| WeChat 4.x on macOS | The client must stay logged in as the target account (that database is what gets read) |
| `sqlcipher` | `brew install sqlcipher` |
| Key-extraction tool | [macos-wechat-export](https://github.com/DaneelOlivaw1/macos-wechat-export) — its key-extraction and read CLI is reused read-only. After cloning, run `bootstrap_keys.py` once; it produces `.wechat-local/keys.json` (mode `0600`) |

## Quick start

**1 · Install the dependency**

```bash
brew install sqlcipher
```

**2 · Extract the local database key** (produces `.wechat-local/keys.json`, mode `0600`)

```bash
git clone https://github.com/DaneelOlivaw1/macos-wechat-export.git
cd macos-wechat-export && python3 bootstrap_keys.py
```

**3 · Install the plugin** — inside your DSH profile directory (e.g. `~/.dsh/profiles/desktop`):

```bash
pnpm add --config.auto-install-peers=false file:/path/to/dsh-group-lurker
# or straight from git:
pnpm add --config.auto-install-peers=false git+https://github.com/zzh4206/Wechat_Test.git
```

**4 · Add config, restart DSH** — append to the profile's `cordis.patch.yml`:

```yaml
- id: group-lurker
  name: "@zzh4206/dsh-group-lurker"
  config:
    groups:
      - "12345678@chatroom"          # allow-list: group chatId (look it up with the tool's `resolve <group name>`)
    source: wechat-db
    sourceToolDir: /path/to/macos-wechat-export                        # required, no default
    sourceDbRoot: ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid_hash>/db_storage  # required, no default
    sourcePython: /opt/homebrew/bin/python3                # absolute path recommended
```

Restart DSH (or wait for the patch hot-reload) and it takes effect.

> **What `source` means**: `none` (the default — reads nothing) or `wechat-db` (read the local database). The latter requires `sourceToolDir`, `sourceDbRoot` and `sourcePython` to be set explicitly — **there are deliberately no implicit defaults; a missing one fails startup.**

## Configuration

| Field | Default | Description |
|---|---|---|
| `groups` | `[]` | **Allow-list.** Empty = refuse to read (fail-closed) |
| `source` | `none` | `none` (read nothing) ｜ `wechat-db` (read the local database) |
| `sourceToolDir` | — (required) | Key-extraction tool directory |
| `sourceDbRoot` | — (required) | Absolute path to WeChat's `db_storage` |
| `sourcePython` | `python3` | Python interpreter |
| `pollIntervalSec` | `10` | Poll interval (seconds) |
| `readLimit` | `50` | Messages read per poll |
| `backfillOnStart` | `0` | Messages backfilled on startup (supervision principle: no historical backfill by default) |
| `bufferSize` | `60` | Per-group ring buffer |
| `distillEveryMessages` | `25` | Trigger one LLM distillation every N messages |
| `distillIntervalMin` | `15` | Periodic distillation interval (minutes) |
| `retentionDays` | `90` | **Message retention in days**: rows in `store.db`'s `messages` table with `ts` older than this are rolled off (`events` / `tasks` / `promises` / `files` are unaffected). **The data-minimisation knob** — what is stored locally is real chat history; lower it if 90 days is more than you need |
| `persona` | `default` | Default persona name |
| `groupPersonas` | `{}` | Per-group persona override: `chatId → persona name` |
| `stateDir` | `DSH_HOME/dsh-group-lurker` | State directory |

## What you get

State directory (default `$DSH_HOME/dsh-group-lurker/`):

```text
├── audit.log                      Read audit: time / group / count / outcome (no message content)
├── cursor.json                    Incremental cursor: no re-delivery, no gaps across restarts
├── groups/<chatId>/
│   ├── insights.jsonl             Distilled results (topics / people / quotes)
│   ├── llm-calls.jsonl            Per-call cost records
│   └── store.db                   Message store (rolled off per retentionDays)
├── reports/<chatId>/YYYY-MM-DD.md Daily report (ends with a cost summary line)
├── outbox.jsonl                   Outbound queue: drafts and notifications land here; all send gates
│                                  are closed by default, so entries are queued but never sent
├── notify/ retention/ scheduler/  Notification audit / retention audit / scheduler state
└── wechat-db.lock                 Read mutex
```

Every report ends with a cost summary line, so model, tokens and spend are visible at a glance:

```text
> 统计：窗口 2026-10-16 至 2026-10-16，消息 2 条，话题 0 个，引用 2 条。
> 统计：批 1（失败 0）· 最大批耗时 0.0 s · 缓存命中 0 · LLM 调用 1 次 / 5.6 s · 模型 glm-5.3 · 输入 ~618 / 输出 ~178 tok · ≈¥0.0099
```

- **Token accounting**: real usage is used whenever the host returns it; otherwise estimated with Zhipu's official ratio (**Chinese characters : tokens ≈ 1 : 1.6**). Estimates are prefixed with `~` and flagged `tokensEst: true`, so they are distinguishable from real values
- **Cost formula**: `costCny = input/1M × input price + output/1M × output price`, always prefixed with `≈` (price tables can lag vendor changes)
- **Price changes need no code change**: edit the `llmPricing` config (key = model name, value = CNY per million tokens); defaults are taken from [Zhipu's official pricing page](https://docs.bigmodel.cn/cn/guide/start/pricing)
- **Spend roll-up**: `node scripts/llm-cost.mjs` (current month by default; filter with `--month` / `--day` / `--chat` / `--state`)
- Billing details and the two-stage generation experiment flag (`schemaTwoStage`): [docs/RUNBOOK.md](docs/RUNBOOK.md) §7.11 and [docs/TECH-DESIGN-llm-overload-mitigation.md](docs/TECH-DESIGN-llm-overload-mitigation.md)

## Security model: five red lines

Breaking any one of them is a **P0 incident** and blocks release. The full baseline, threat model and acceptance matrix live in **[docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md)**.

| # | Red line | Enforcement anchor |
|---|---|---|
| **R1** | **Single controlled egress**: sending is permitted from `src/sender.ts` only, over the `filehelper` channel only (hard-coded). Four gates = master switch (`senderEnabled` `false` by default + `sendDryRun` `true` by default), channel gate, interaction gate (foreground + user idle) and compliance gate (OCR-check the active chat); plus rate limiting and a retry ceiling to prevent storms, with metadata-only audit. **Any send primitive outside `sender.ts` = P0** | `src/sender.ts` + the `no-send` sentinel |
| **R2** | **Deny by default**: empty allow-list or unlisted group → zero reads, zero subprocess calls | `src/source/wechat-db.ts` construction gate + `gate()` |
| **R3** | **Path fence**: all filesystem writes must stay inside `stateDir` | `assertInsideState()` + `src/store.ts` as the single write point |
| **R4** | **Injection isolation**: message text is always data, never instructions | `sanitize()` + instruction/data separation |
| **R5** | **Zero key contact**: `keys.json` is never read, copied or printed; WeChat data is never written | Subprocesses go through the external CLI, which resolves keys itself; decryption goes over stdin (never as a command-line argument) |

Other boundaries: the wire protocol is never reversed and the WeChat client is never modified; any UI-automation sending goes through R1's controlled channel only.

## Knowledge-base template and local data

This repository also carries a self-contained knowledge-base template, [`0数据格式/`](0数据格式/README.md): a three-layer SQLite schema (documents `doc` + journal `report`/`entry` + chat digests `chat_digest`) with three tools — `make_template.py` (idempotently builds the template and a synthetic sample), `report_cli.py` (entries / daily-weekly-monthly reports / document management) and `export_md.py` (Markdown export tree).

**Its whole purpose is leak prevention** — real data and the publishable template are physically separated:

| Location | Contents | Git status |
|---|---|---|
| `0数据格式/` | Template schema, tools, **synthetic sample data** (`sample.db`) | Published with this repo ✓ |
| `1数据/` (local machine only) | **Where real data lands** — schema reuses the template, stored locally only | **Never committed** (ignored; do not `git init` it either) |

Rules (full red lines in [`0数据格式/PRIVACY.md`](0数据格式/PRIVACY.md)):

- Real wxids, chat records and exports may **only** live in `1数据/`; never copy them anywhere inside the repository
- `chat_digest` stores distilled **points only**, never raw chat text; `source_key` provides idempotent deduplication
- External writers must follow: frozen field names, `PRAGMA foreign_keys = ON`, short transactions, **single-writer principle**
- As a result, **cloning this repository is safe for anyone** — all you get is the template and synthetic data

## Documentation

| Document | Contents |
|---|---|
| [docs/README.md](docs/README.md) | **Documentation index — start here** |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Install / authorisation / allow-list / audit / uninstall / troubleshooting |
| [docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md) | Charter and acceptance matrix for the five red lines |
| [SECURITY.md](SECURITY.md) | Security policy and vulnerability reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute and commit conventions |
| [AGENTS.md](AGENTS.md) | Hard constraints for AI agents working in this repo (what to run before committing, what never to touch) |
| [CHANGELOG.md](CHANGELOG.md) / [docs/PROGRESS.md](docs/PROGRESS.md) | Release notes / development log |

> History: the first-generation `im-connect` route's vendored copy was deleted on 2026-10-13 (route abandoned); `vendor/` now holds only a committed snapshot of `macos-wechat-export` (see `vendor/VENDOR-NOTE.md`).

## Development

```bash
npm install
npm run build   # tsc → lib/
npm test        # node --test, 379 cases, fully offline mocks, no real database
```

> Tests import the **compiled `lib/` output**, so after editing `src/` you must run `npm run build` before `npm test`.

You **must** run the sensitive-data scan before committing, or CI will block you:

```bash
./scripts/check-sensitive.sh
```

## Disclaimer

- This tool is for **reading local data you have permission to access**, for **personal backup and research** purposes only
- Comply with WeChat's terms of service and your local laws; do not use it to monitor other people, scrape third-party data, or in any unauthorised context
- It contains **no** capability to break the wire protocol, bypass authentication or forge a login session; reading relies on a client already logged in on your own machine and its local database key
- You are solely responsible for any consequences of using this tool

## License

[MIT](LICENSE)
