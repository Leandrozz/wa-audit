# Local web panel — design

Date: 2026-09-07 · Status: approved by the operator (chat), pending spec review

## Goal

A local web panel to manage everything the CLI and the MCP server already
do, from a browser: several audits side by side (one folder per client),
source selection (WAHA / Kapso / Instagram), WAHA onboarding with the QR on
screen, the pipeline phase by phase with live logs, the corpus and the
verified findings as read-only views, per-audit configuration, and the
three reports as downloads.

Zero new dependencies. The panel is a second face over the same scripts:
it spawns `src/*.mjs` exactly like `tools/demo.mjs` and the MCP server do,
so nothing in the pipeline, the verifier or the data contract changes.

Decisions taken by the operator during brainstorming:

- Audience: **the operator, on their own machine**. No login, loopback only.
- **Multi-audit**: `data/<slug>/` is one audit with its own config.
- Stack: `node:http` + one HTML file with vanilla JS + SSE for logs. No
  framework, no build step.
- UI copy in Spanish (es-AR), matching the report prose. Docs in English.

## Non-goals (v1)

- No authentication, no hosting, no client-facing access.
- No secret entry from the browser. Secrets stay env-only (`waha.env`,
  `kapso.env`, `ig.env`), exactly as today.
- No concurrent jobs (one at a time, global lock).
- No editing of analysis findings from the panel (read-only; the engine is
  `analyze.mjs` or an agent through the MCP/PLAYBOOK path).
- No UI i18n, no dark-mode work beyond what `color-scheme` gives for free.
- No live reload of env files: the panel loads them at start; restart after
  editing (stated in the env tab).

## 1. Audits and configuration

An audit is a directory `DATA_DIR/<slug>/`:

- `DATA_DIR` = `WA_PANEL_DATA_DIR` env, default `<cwd>/data` (already
  gitignored).
- `slug` matches `^[a-z0-9][a-z0-9-]{0,63}$`. Anything else is 400.
- Inside: `wa-audit.config.json` (per-audit config), `business-context.json`,
  and every pipeline file (`messages.jsonl`, `threads.json`, `summary.json`,
  `analysis.json`, the three reports, caches).
- Listing = subdirectories of `DATA_DIR`, so an existing `data/wa-history`
  appears as an audit. An audit without a config file reads as the baseline
  (below) until the first save.

**Baseline** for new audits: `loadConfig()` at panel start (repo-root
`wa-audit.config.json` + env, minus the derived `offsetMinutes`), with
`business.name = slug` and `output.dir = DATA_DIR/<slug>`. A customized
root config therefore seeds every new audit (locale, timezone, LLM).

**Changes to `src/lib/config.mjs`** (small, backward compatible):

1. `WA_CONFIG_FILE` env: path of the config file to read instead of
   `<cwd>/wa-audit.config.json`. The panel sets it on every child process.
   Side effect: the MCP server and the CLIs gain per-audit configs for free
   (`WA_CONFIG_FILE=data/acme/wa-audit.config.json node src/analyze.mjs`).
2. New defaults section `source: { kind: "waha", session: "default" }`.
   `kind` is one of `waha | kapso | ig`; `session` matches
   `^[A-Za-z0-9_-]+$`. Only the panel reads it in v1; the CLIs keep their
   flags.
3. Validation is extracted into a pure `resolveConfig(fromFile, env)` that
   returns `{ cfg, warnings, errors }` (no `process.exit`, no console).
   `loadConfig()` keeps its exact behavior by wrapping it (prints warnings,
   exits on errors). The panel validates a `PUT config` with the same
   function, so the browser can never write a config the CLIs would reject.
   Unknown keys are an error for the panel (a warning for the CLIs,
   unchanged).

Child processes get `WA_OUT_DIR=<audit dir>` and `WA_CONFIG_FILE=<audit
config>`; env beats file in `loadConfig`, so `output.dir` in the file is
informational for CLI use.

## 2. Server (`src/panel.mjs`, `npm run panel`)

`node:http`, listening on `127.0.0.1` only (no override; put a reverse
proxy in front if you really want LAN access). Port `WA_PANEL_PORT`,
default 8480; `0` asks the OS. Prints `panel listening on
http://127.0.0.1:<port>` once bound (tests parse that line, like
`mock-waha`). Scripts are resolved from the repo root derived from
`import.meta.url`, like the MCP server does, so the panel's `cwd` only
decides where env files and `data/` are looked up. A broken repo-root
config makes `loadConfig()` exit at start, same as every CLI: fail fast.

At start, for each of `waha.env`, `kapso.env`, `ig.env` that exists in
`cwd`, `process.loadEnvFile(file)` (stdlib). That is how the panel's own
WAHA proxy and every child process see the secrets. The keys are disjoint
by prefix, so loading all three is harmless. `ANTHROPIC_API_KEY` /
`LLM_API_KEY` may live in any of them (the README already puts it in
`waha.env`).

### API

All JSON under `/api`. `GET /` serves `src/panel.html`. Errors are
`{ error: "<message>" }` with 400/403/404/409/500.

| Method · path | Does |
|---|---|
| `GET /api/audits` | `[{slug, has_config, business_name, files}]`, `files` being the same presence map `status` returns |
| `POST /api/audits` `{slug}` | creates dir + baseline config; 409 if it exists |
| `GET /api/audits/:slug/config` | config as stored (or baseline) |
| `PUT /api/audits/:slug/config` | body is the full config object; validated via `resolveConfig`; the merged result (defaults + body, minus derived fields) is written as pretty JSON so the file is always complete |
| `GET /api/audits/:slug/status` | files present (`business-context.json`, `messages.jsonl`, `threads.json`, `summary.json`, `analysis.json`, reports), `summary.json` if present, dimensions submitted, `next_step` (same rule as the MCP `status`) |
| `GET/PUT /api/audits/:slug/business-context` | free-form JSON object |
| `GET /api/audits/:slug/threads?offset&limit` | non-system threads, two-way first (same order as MCP `read_threads`), `limit` capped at 50; each item carries the thread header only (`thread_id`, `contact_name`, `is_internal`, `is_system`, `unresolved_lid`, `crm`, `metrics`), no messages; plus `total` |
| `GET /api/audits/:slug/threads/:id` | one thread with messages |
| `GET /api/audits/:slug/analysis` | `analysis.json` as is |
| `GET /api/audits/:slug/files/:name` | download; `name` must equal one of the report basenames derived from `report.filename`, or `threads.json` / `summary.json` / `analysis.json` / `messages.csv` |
| `GET /api/dimensions` | `[{key, title}]` from `analysis/prompts` (title = first line, `verifier` excluded); the UI adds the "FATE set" shortcut |
| `GET /api/env` | which env files exist and the **names** of the keys they define; never values |
| `GET /api/waha/sessions` | proxy of `GET /api/sessions?all=true` |
| `POST /api/waha/sessions` `{name}` | create with `noweb.store.fullSync: true` |
| `GET /api/waha/qr/:session` | proxy of the PNG QR |
| `POST /api/audits/:slug/run` `{step, options}` | starts a job; 409 if one is running |
| `GET /api/jobs/current` | `{id, slug, step, started_at, ended_at, exit_code, tail}` or `null` |
| `GET /api/jobs/stream` | SSE: buffered lines then live lines, each as `data: {"s":"out"|"err","t":"<line>"}`; `event: end` with `data: {"exit_code":N}`; a client attaching after the end gets buffer + `end` immediately; with no job ever started it gets `end` with `exit_code: null` |
| `POST /api/jobs/cancel` | `child.kill()`; 404 if nothing runs |

### Jobs

`step` decides what is spawned. Every child runs with `cwd = process.cwd()`,
`env = process.env + WA_OUT_DIR + WA_CONFIG_FILE`, stdio piped.

| step | source | command |
|---|---|---|
| `probe` | waha | `src/probe.mjs` |
| `export` | waha | `src/export.mjs <source.session>` |
| `export` | kapso | `src/export-kapso.mjs` |
| `export` | ig | `src/export-ig.mjs [--since <days>]` (`options.since`) |
| `threads` | waha | `src/threads.mjs --session <session> [--no-net]` (`options.noNet`) |
| `threads` | kapso, ig | `src/threads.mjs --session <session> --no-net` (forced) |
| `analyze` | any | `src/analyze.mjs [--dimensions a,b]` (`options.dimensions[]`) |
| `report-xlsx` / `report-html` / `report-docx` | any | the matching renderer |

Unknown step, or `probe` on a non-WAHA audit, is 400. One job at a time,
marked in code as `// ponytail: global lock, per-audit locks if two clients
ever matter`. Job state lives in memory: last 2000 lines, exit code,
timestamps. Lost on restart (the scripts print to their own stdout anyway;
export is resumable).

### Security (kept even though it is local)

- Bind `127.0.0.1`.
- `Host` header must match `^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$`,
  else 403 (DNS-rebinding guard).
- Every non-GET request needs `Content-Type: application/json` and the
  header `X-WA-Panel: 1`; no CORS headers are ever sent and preflights are
  not answered, so a cross-origin page can neither mutate nor read.
- Body cap 1 MiB. Slug regex everywhere. Download names by whitelist; the
  resolved path must stay inside the audit dir (checked after `resolve`).
- Env endpoint returns key names only. The QR proxy returns bytes; the API
  key never leaves the server.
- Response headers on `/`: `Content-Security-Policy: default-src 'none';
  script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src
  'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action
  'none'`, plus `X-Content-Type-Options: nosniff`.
- Chat content and every server string reach the DOM through `textContent`,
  never `innerHTML`.

## 3. UI (`src/panel.html`)

One file, inline CSS + JS, no dependencies. A top bar with the audit
selector (+ "nueva auditoría"); the selected slug is remembered in
`localStorage`. Tabs:

1. **Estado**: files present, `next_step`, the `summary.json` numbers,
   dimensions done. Buttons that jump to the next phase.
2. **Fuente y WAHA**: `source.kind` / `session`; env file presence and key
   names (with "reiniciá el panel después de editar"). For WAHA: list
   sessions, create one (fullSync), show the QR (`<img>` refreshed every
   20 s while the session is not `WORKING`), with the same warnings the MCP
   guide prints (device slot, engine).
3. **Pipeline**: one row per step with its options (session, `--no-net`,
   `--since`, dimension checkboxes incl. "FATE set"), a Run button, and the
   live log pane (SSE, autoscroll, exit code, Cancelar).
4. **Contexto**: the interview, the seven fields the MCP suggests
   (`what_we_sell`, `who_buys`, `sales_process`, `team_on_this_number`,
   `goals`, `known_problems`, `tone_intent`) as textareas; extra keys in an
   existing file are preserved untouched.
5. **Corpus**: paginated thread list (contact, internal/system flags,
   inbound/outbound/unanswered/median); click opens the messages.
6. **Hallazgos**: per dimension: title, summary, findings (title, detail,
   frequency, confidence, evidence with a link to the thread), verdict
   (reviewed / confirmed / refuted with the refuted titles and reasons).
7. **Reportes**: the three renderers' Run buttons and download links, plus
   `threads.json` / `summary.json` / `analysis.json` / `messages.csv`.
8. **Config**: form over the per-audit config (business, phone, timezone,
   locale, report filename, CRM file, LLM provider/model/baseUrl, analysis
   language, source). Save does the `PUT`; validation errors are shown
   verbatim.

Empty states point to the previous phase ("Corré el corpus primero").
WAHA being unreachable only affects tab 2 and the status line.

## 4. Shared code

`src/lib/waha.mjs` (new): `listSessions()`, `createSession(name)`,
`qrPng(session)`: the fetch calls currently inline in `mcp-server.mjs`,
reading `WAHA_BASE_URL` / `WAHA_API_KEY` / `WAHA_BASIC_AUTH` from env at call
time. `mcp-server.mjs` switches to it (mechanical; same messages, same
timeouts). Nothing else in the MCP server moves.

## 5. Fixtures, tests, docs

- `fixtures/mock-waha.mjs`: add `GET /api/:session/auth/qr` returning a
  1×1 PNG, so the QR proxy is exercised end to end.
- `test/panel.test.mjs` (node:test, no new deps); see the plan below.
- `docs/panel.md`: run it, env files, the `data/<slug>` layout,
  `WA_CONFIG_FILE`, security posture, limits. README EN/ES: one short
  section ("Or manage everything from a local web panel").
- `package.json`: `"panel": "node src/panel.mjs"`.

## Test plan summary

The panel test boots `src/panel.mjs` with `cwd` = a temp dir (no env files
there), `WA_PANEL_DATA_DIR` = temp `data/`, `WA_PANEL_PORT=0`, WAHA env
pointing at `startMock()` from `test/harness.mjs`, and every ambient `WA_*`
scrubbed the way `pipelineEnv` does. Then, through HTTP only:

1. **Security**: `Host: evil.example` gives 403; `POST` without
   `X-WA-Panel` gives 403; slug `../x` gives 400; download of
   `..%2F..%2Fpackage.json` gives 404.
2. **Audits**: create `demo`, list shows it, `PUT config` with the fixture
   knobs (business name, CRM CSV, internal domains, tz, locale,
   `llm.provider: mock`, `llm.cannedDir`) reads back equal; a config with
   an unknown key or a bad `utcOffset` gives 400 with the loader's message.
3. **Pipeline**: `probe`, `export`, `threads`, `analyze`
   (`frequent_questions,ops_response_times`), `report-xlsx`, `report-html`,
   each awaited through the SSE `end` event with exit 0; `status` advances
   (`next_step` changes, files flip to present, `summary.messages_included
   > 0`); `analysis` returns two dimensions with verdicts; downloads answer
   200 with the right content type and a non-empty body.
4. **Corpus**: threads page returns at most 5, two-way first; a thread by
   id returns its messages.
5. **Context**: `PUT`/`GET business-context` round trip preserves extra keys.
6. **Lock**: two `run` requests fired in the same tick give exactly one 409.
7. **WAHA proxy**: sessions list matches the mock; create session gives
   200; `qr/fixture` answers `image/png`.
8. **config.mjs**: `resolveConfig` unit cases (unknown key, bad offset) and
   `WA_CONFIG_FILE` honored by `loadConfig`, in the same test file.

Manual only (documented in `docs/panel.md`): Cancelar on a real export,
the QR flow against a real WAHA instance.
