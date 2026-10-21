# @zzh4206/dsh-group-lurker

[简体中文](README.md) ｜ **English**

[![CI](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml/badge.svg)](https://github.com/zzh4206/Wechat_Test/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)

A WeChat group-chat knowledge-base system: **read-only listening → LLM distillation → daily reports → a local SQLite knowledge base (query layer)**.

One [DSH](https://github.com/deepseek-ai) Cordis plugin plus a zero-data knowledge-base template. **macOS + WeChat 4.x only** (reads the local SQLCipher database).

**[30-second overview](#30-second-overview)** ｜ [Architecture](#architecture-from-chats-to-knowledge) ｜ [Quick start](#quick-start) ｜ [Configuration](#configuration) ｜ [Security model](#security-model-five-red-lines) ｜ [Knowledge-base template](#knowledge-base-template-and-local-data) ｜ [Docs](#documentation)

---

## 30-second overview

| | |
|---|---|
| **What it does** | Reads the WeChat database **already logged in on your own machine** → distills per group → `insights.jsonl` + reports → mirrors into a local SQLite knowledge base |
| **What it never does** | Never writes WeChat data, never touches the WeChat process, never reverses the wire protocol, never reads key files, sends nothing by default |
| **Default posture** | Empty allow-list = **refuses to start** (fail-closed); all four send gates closed; mirror write failures only warn, never break the main flow |
| **You need** | macOS, WeChat 4.x, `sqlcipher`, a key-extraction tool, DSH ≥ 0.2.0-rc.2 |
| **Where data lives** | JSONL source of truth in `$DSH_HOME/dsh-group-lurker/`; knowledge base at `~/WeChat/1数据/knowledge.db` (local machine only, never committed) |

## Repository layout

| Path | Contents |
|---|---|
| `src/` | The plugin: allow-listed reading, per-group buffering, LLM distillation, reports, single controlled send egress, SQLite mirror data layer (`src/db/`) |
| `0数据格式/` | **Pure knowledge-base template**: three-layer schema (`doc` / `report`+`entry` / `chat_digest`) + 3 Python tools. **Nothing is ever entered into it** |
| `web/` | Local web workbench (separate process, listens on 127.0.0.1 only): read-only browsing of reports by calendar, docs, media, chat digests and watched-person digests, plus an approval inbox (confirm / cancel / complete / set deadline) and report finalize / regenerate / queue-to-outbox (all executed by the plugin's action inbox; queue-to-outbox is off by default and then follows the existing send path). See [RUNBOOK §14](docs/RUNBOOK.md) |
| `scripts/` | `check-sensitive.sh` (sensitive-data scan), `llm-cost.mjs` (spend roll-up), `import-state-to-sqlite.mjs` (one-shot importer) |
| `tests/` | 60 test files / 567 cases, fully offline mocks, never touches a real database |

## Architecture: from chats to knowledge

```text
WeChat local database (SQLCipher)
   │  read-only subprocess (key goes over stdin, never as a CLI argument)
   ▼
Plugin: allow-listed reads → per-group buffers → LLM distillation
   │
   ├─▶ insights.jsonl + reports/*.md     ← JSONL = source of truth
   │
   └─▶ SQLite mirror (optional, sqlitePath) ← query layer; failures only warn
            default ~/WeChat/1数据/knowledge.db

Backfill existing state: node scripts/import-state-to-sqlite.mjs --state-dir <stateDir> [--db <path>]
          (reads state read-only; source_key content-hash idempotent; safe to re-run)
Query/export: 0数据格式/report_cli.py · export_md.py
```

- **JSONL is always the source of truth**: SQLite is only a query layer; mirror and importer share one mapping contract
- **Schema v0.4**: `report` carries `chat_id` (conflict key `(period_type, period_start, chat_id)`, no more cross-group aggregated sections), a new `media` metadata table (media files themselves are never stored); `user_version` migrations are idempotent and upgrade old databases automatically
- **Documents extracted from reports**: URLs / file indexes found in reports land in the `doc` table automatically, deduplicated with the same rules as the Python batch script
- **Approval loop & report revision flow (schema v0.6)**: `ApprovalActions` (single entry for approval actions) + `ActionInbox` (frontend action inbox); report revisions land in `report_revision` (immutable history) and cascade into weekly/monthly reports, completion status is tracked via append-only `marking` rows (done/undone/deleted) — all mirrored into the knowledge base as a single query copy

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
    sourceToolDir: /path/to/macos-wechat-export     # required, no default
    sourceDbRoot: ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid_hash>/db_storage  # required
    sourcePython: /opt/homebrew/bin/python3         # absolute path recommended
```

**5 · Import existing state (optional)**:

```bash
node scripts/import-state-to-sqlite.mjs --state-dir ~/.dsh/dsh-group-lurker
```

> What `source` means: `none` (default — reads nothing) or `wechat-db` (read the local database; three fields required, a missing one fails startup — deliberately no implicit defaults).

## Configuration

### Reading & distillation

| Field | Default | Description |
|---|---|---|
| `groups` | `[]` | **Allow-list.** Empty = refuse to read (fail-closed) |
| `source` | `none` | `none` ｜ `wechat-db` |
| `sourceToolDir` / `sourceDbRoot` / `sourcePython` | — (required) | Key tool directory / absolute path to WeChat's `db_storage` / Python interpreter |
| `pollIntervalSec` / `readLimit` | `10` / `50` | Poll interval and per-poll message cap |
| `backfillOnStart` | `0` | Backfill on startup (no history backfill by default) |
| `bufferSize` | `60` | Per-group ring buffer |
| `distillEveryMessages` / `distillIntervalMin` | `25` / `15` | LLM distillation by count / by time |
| `retentionDays` | `90` | **Message retention in days**: expired rows in `store.db` roll off. **The data-minimisation knob** — lower it if 90 days is more than you need |
| `persona` / `groupPersonas` | `default` / `{}` | Default persona / per-group override |

### Knowledge-base mirror & file index

| Field | Default | Description |
|---|---|---|
| `sqlitePath` | `''` | Mirror path. Empty = `~/WeChat/1数据/knowledge.db`; `'off'` disables. **JSONL remains the source of truth**; mirror failures only warn |
| `fileIndexListIntervalMin` | `30` (`0`=off) | Backfills the `files` table from the key tool's `files` listing (WeChat 4.x file messages hide their filenames from the message stream) |

### Send gates (all closed by default)

| Field | Default | Description |
|---|---|---|
| `senderEnabled` | `false` | Send master switch |
| `sendDryRun` | `true` | Dry-run: drafts land in the outbox, nothing is sent |
| `maxSendsPerDay` | `20` | Daily send cap (over-limit items are marked `skipped_quota`) |
| `accountWhitelist` | `[]` | **Account allow-list** (fail-closed, same semantics as `groups`): activity from an unlisted account suspends sending and blocks key extraction |

> Send locating and DB read-back gates (`sendTargetChat`, `readbackChatId`, `verifyDelaySec`, `verifyRetries`) belong to the send path — see [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Output

State directory (default `$DSH_HOME/dsh-group-lurker/`): `groups/<chatId>/{insights.jsonl, llm-calls.jsonl, store.db}`, `reports/<chatId>/YYYY-MM-DD.md` (weekly/daily in separate directories), `audit.log` (metadata only), `cursor.json`, `outbox.jsonl`, `notify/ retention/ scheduler/`.

The knowledge base (`~/WeChat/1数据/knowledge.db`) core objects: five fact tables — `doc` (documents, deduplicated by `content_hash`), `entry` (quick notes), `report` (daily/weekly/monthly, draft → final), `chat_digest` (**points only, never raw chat text**, idempotent via `source_key`), `media` (metadata only; media files are never stored) — plus v0.6's `report_revision` (immutable report revision history) and `marking` (append-only completion status), exposed through the `v_report_revised` / `v_marking_latest` views. Schema migrations are idempotent (`user_version` steps up); old databases upgrade automatically without data loss.

Every report ends with a cost summary line:

```text
> 统计：批 1（失败 0）· 最大批耗时 0.0 s · 缓存命中 0 · LLM 调用 1 次 / 5.6 s · 模型 glm-5.3 · 输入 ~618 / 输出 ~178 tok · ≈¥0.0099
```

- When real usage is unavailable, tokens are estimated with Zhipu's official ratio (**Chinese characters : tokens ≈ 1 : 1.6**), prefixed `~` and flagged `tokensEst: true`; cost is always prefixed `≈`
- Price changes need no code change: edit `llmPricing` (see [Zhipu's pricing page](https://docs.bigmodel.cn/cn/guide/start/pricing))
- Roll-up: `node scripts/llm-cost.mjs` (`--month` / `--day` / `--chat` / `--state`); details in [docs/RUNBOOK.md](docs/RUNBOOK.md) §7.11

## Security model: five red lines

Breaking any one of them is a **P0 incident** and blocks release. Full baseline, threat model and acceptance matrix: **[docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md)**.

| # | Red line | Enforcement anchor |
|---|---|---|
| **R1** | **Single controlled egress**: sending is permitted from `src/sender.ts` only, over the `filehelper` channel only (hard-coded). Four gates = master switch (`senderEnabled` `false` + `sendDryRun` `true` by default), channel gate, interaction gate (foreground + user idle), compliance gate (**DB read-back verification**: after sending, the target chat is read back to confirm delivery; exhausted retries count as failure); plus `maxSendsPerDay`, a retry ceiling, metadata-only audit. **Any send primitive outside `sender.ts` = P0** | `src/sender.ts` + the `no-send` sentinel |
| **R2** | **Deny by default**: empty allow-list or unlisted group → zero reads, zero subprocess calls; the account allow-list follows the same semantics | `src/source/wechat-db.ts` construction gate + `gate()` |
| **R3** | **Path fence**: all filesystem writes stay inside `stateDir` | `assertInsideState()` + `src/store.ts` as the single write point |
| **R4** | **Injection isolation**: message text is always data, never instructions | `sanitize()` + instruction/data separation |
| **R5** | **Zero key contact**: `keys.json` is never read, copied or printed; WeChat data is never written | Subprocesses go through the external CLI, which resolves keys itself; decryption goes over stdin |

Other boundaries: the wire protocol is never reversed and the WeChat client is never modified; UI-automation sending goes through R1's controlled channel only (keyboard-based locating and delivery, with DB read-back as the backstop).

## Knowledge-base template and local data

This repository also carries the self-contained knowledge-base template [`0数据格式/`](0数据格式/README.md). **No data is ever entered into the template itself — data entry happens only in the local `1数据/`.**

| Location | Contents | Git status |
|---|---|---|
| `0数据格式/` | **Pure template**: schema, tools, documentation. **Nothing is ever entered into it** — `.db` files are local build artifacts and are not committed | Published with this repo ✓ |
| `1数据/` (local machine only) | **The only place data is ever entered** — schema reuses the template, real data stays local | **Never committed** (ignored; do not `git init` it either) |

Rules (full red lines in [`0数据格式/PRIVACY.md`](0数据格式/PRIVACY.md)): real wxids, chat records and exports may **only** live in `1数据/`; `chat_digest` stores distilled points only; external writers follow frozen field names + `source_key` idempotency + the single-writer principle.
- **No hardcoded API keys**: the LLM key is only referenced via the `apiKeyEnv` environment variable; no literal key may appear in code or config. CI's `sensitive-scan` blocks both key patterns and real identifiers As a result, **cloning this repository is safe for anyone** — it contains only the schema, tools and documentation, never any data files.

## Documentation

| Document | Contents |
|---|---|
| [docs/README.md](docs/README.md) | **Documentation index — start here** |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Install / authorisation / allow-list / audit / send path / troubleshooting |
| [docs/SECURITY-TEST-PLAN.md](docs/SECURITY-TEST-PLAN.md) | Charter and acceptance matrix for the five red lines |
| [0数据格式/README.md](0数据格式/README.md) | Knowledge-base template: table diagram, tool usage |
| [0数据格式/PRIVACY.md](0数据格式/PRIVACY.md) | Template-side privacy red lines and external-writer contract |
| [docs/DESIGN-approval-marking.md](docs/DESIGN-approval-marking.md) / [docs/TECH-DESIGN-confirm-loop.md](docs/TECH-DESIGN-confirm-loop.md) | Approval-marking and dual-channel confirmation loop design |
| [docs/REF-prefixes.md](docs/REF-prefixes.md) | Numbering-prefix registry (PLG-N etc., prevents cross-line name clashes) |
| [SECURITY.md](SECURITY.md) / [CONTRIBUTING.md](CONTRIBUTING.md) / [AGENTS.md](AGENTS.md) | Vulnerability reporting / contributing / agent constraints |
| [CHANGELOG.md](CHANGELOG.md) / [docs/PROGRESS.md](docs/PROGRESS.md) | Release notes / development log |

> History: the first-generation `im-connect` route's vendored copy was deleted on 2026-10-13 (route abandoned); `vendor/` now holds only a snapshot of `macos-wechat-export`.

## Development

```bash
npm install
npm run build   # tsc → lib/
npm test        # node --test, 60 files / 567 cases, fully offline mocks
./scripts/check-sensitive.sh   # must pass before committing; CI enforces it
```

> Tests import the **compiled `lib/` output**, so run `npm run build` before `npm test` after editing `src/`.

## Disclaimer

- For **reading local data you have permission to access**, for **personal backup and research** only
- Comply with WeChat's terms of service and your local laws; do not use it to monitor other people or scrape third-party data
- Contains **no** capability to break the wire protocol, bypass authentication or forge a login session
- You are solely responsible for any consequences of using this tool

## License

[MIT](LICENSE)
