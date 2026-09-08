# Local web panel

`npm run panel` starts a small web panel on **http://127.0.0.1:8480**
(loopback only, no login) that manages everything the CLI and the MCP
server do, for several audits side by side.

```bash
npm run panel                # http://127.0.0.1:8480
WA_PANEL_PORT=9000 npm run panel
```

## Quick start (the "Inicio" screen)

1. Run a WAHA instance (Docker: `docker run -d -p 3000:3000 -e WAHA_API_KEY=change-me devlikeapro/waha`).
2. `npm run panel` and open http://127.0.0.1:8480.
3. **1 · WhatsApp**: WAHA URL and API key → "Guardar y probar".
4. **2 · IA**: provider and API key → "Guardar". ("Simulado" needs no key
   and only runs the dimensions that ship canned in `fixtures/llm-canned`.)
5. **3 · Auditoría**: business name → "Vincular teléfono" (scan the QR from
   the business phone until the session reads WORKING) → **Iniciar
   auditoría**. Probe, export, corpus, analysis with verification and the
   three reports run as one job with a step-by-step progress list; the
   download links appear at the end. Closing the tab does not stop it.

The keys are written to `waha.env` next to the repo (gitignored) and
applied at once; they are never sent back to the browser. Everything
else (per-step runs, corpus, findings, config) is behind "Avanzado".

It is a second face over the same scripts: every button spawns
`src/*.mjs` exactly like `tools/demo.mjs` does. The pipeline, the
verifier and the data contract do not change. Zero dependencies:
`node:http` plus one HTML file with vanilla JS.

## Audits: one folder per client

```
data/
  acme/
    wa-audit.config.json     ← this audit's config (business, LLM, source…)
    business-context.json    ← the operator interview
    messages.jsonl, threads.json, summary.json, messages.csv, analysis.json
    whatsapp-report.xlsx / .html / .docx
  other-client/
    …
```

- Typing a name in the header input and pressing "Crear" creates the folder and seeds its config from the repo-root `wa-audit.config.json` (so a customized locale/timezone/LLM carries over). Slugs are lowercase letters, digits and `-`.
- An existing `data/wa-history` shows up as an audit; it gets a config
  file on the first run from the panel.
- `WA_PANEL_DATA_DIR` moves the root somewhere else than `data/`.
- Every script the panel runs gets `WA_OUT_DIR=data/<slug>` and
  `WA_CONFIG_FILE=data/<slug>/wa-audit.config.json`. `WA_CONFIG_FILE`
  also works for the CLIs and the MCP server:

  ```bash
  WA_CONFIG_FILE=data/acme/wa-audit.config.json node src/analyze.mjs
  ```

  As everywhere in this project, `WA_*` variables in your shell override
  the file — keep the shell clean when you drive several audits.

  A `WA_CONFIG_FILE` that points at a missing file is an error, not a
  silent fallback. `report.filename` must be a bare file name (no
  directories); the panel refuses anything else.

## Secrets and env files

Secrets are stored only on your machine. The "Inicio" screen writes the
WAHA URL/key and the LLM key to `waha.env` (the same file the CLI uses)
and never echoes them back; the panel loads `waha.env`,
`kapso.env` and `ig.env` from the directory it starts in (usually the
repo root) with Node's `process.loadEnvFile`, and passes them to every
script it spawns. Put `ANTHROPIC_API_KEY` (or `LLM_API_KEY`) in any of
them. Variables already set in your shell win. Edit a file → **restart
the panel** (the "Fuente y WAHA" tab says so, and shows which files and
which key *names* were found — never values). The same is true for any
`WA_*` key inside those env files: it overrides the per-audit config for
every audit. The panel warns at startup and the "Fuente y WAHA" tab lists
such overrides in red; keep identity settings in the per-audit config
instead.

## Tabs

| Tab | What it does |
|---|---|
| Estado | Files present, the suggested next step, `summary.json` numbers, dimensions analyzed |
| Fuente y WAHA | Source (`waha`/`kapso`/`ig`) and session; env files; WAHA sessions, create one with fullSync, the pairing QR on screen (refreshes every 20 s until `WORKING`) |
| Pipeline | Probe, export, corpus (`--no-net`), analysis (dimension checkboxes, FATE set), reports. Live log over SSE, Cancelar |
| Contexto | The operator interview (`business-context.json`) |
| Corpus | Threads two-way first, click for the messages |
| Hallazgos | Per dimension: findings with evidence (jumps to the thread), the verifier's verdict and the refuted findings |
| Reportes | Generate and download XLSX / HTML / DOCX, plus the corpus and analysis files |
| Config | The per-audit `wa-audit.config.json`, validated with the same rules as the CLIs |

Which exporter runs depends on the audit's source: `waha` → `export.mjs`
(+ `probe.mjs`), `kapso` → `export-kapso.mjs`, `ig` → `export-ig.mjs`
(optional `--since`). For `kapso` and `ig` the corpus step always runs
with `--no-net`.

## Security posture (local does not mean careless)

- Binds `127.0.0.1` only. No option to change that; put a reverse proxy
  with auth in front if you really need LAN access.
- Requests whose `Host` header is not localhost are refused (DNS
  rebinding). Every mutation needs `Content-Type: application/json` and
  an `X-WA-Panel: 1` header; no CORS headers are ever sent, so a page on
  another origin can neither read nor write.
- Downloads are whitelisted by name and must resolve inside the audit
  folder. Slugs are validated everywhere.
- Chat content reaches the page as text nodes only (no HTML injection),
  and the page's Content-Security-Policy uses a per-response nonce for its one inline script (no `unsafe-inline` for scripts), forbids external resources, framing and `<base>` tricks.
- The panel is read-only toward WhatsApp, except for creating a WAHA
  session. It never sends a message.

## Limits (v1)

- One job at a time; a second "Correr" answers 409 until the first ends.
- Job logs live in memory (last 2000 lines) and vanish when the panel
  restarts. The scripts are resumable, so just run the step again.
- Cancelar kills the child process; an export can be resumed.
- No editing of findings from the panel: the engine is `analyze.mjs` or
  an agent through the MCP/PLAYBOOK path; the panel shows whatever
  `analysis.json` says.
- Manual checks not covered by `npm test`: Cancelar on a real export, and
  the QR flow against a real WAHA instance.
