# Instagram DM exporter — design

Date: 2026-08-31 · Status: approved by the operator (chat), pending spec review

## Goal

Add Instagram DMs as a data source for the existing audit pipeline. A new
exporter reads the operator's **own inbox** through the same private web API
the official instagram.com client uses (session-cookie auth) and emits the
`messages.jsonl` contract that `threads.mjs` already consumes. Everything
downstream (corpus, metrics, analysis, verifier, reports) works unchanged
except two deliberate integration touches listed below.

Decisions taken by the operator during brainstorming:

- Lane: **own scraper over the private web API** (latency; the official
  "Download Your Information" zip takes hours to days). DYI stays documented
  as the zero-risk alternative, not built.
- Ships **public in wa-audit**, WAHA-style posture with an honest disclaimer.
- Order: IG lane first; the local web UI is a separate, later project.

## Non-goals (v1)

- No webapp (separate spec).
- No DYI zip parser (documented alternative only).
- No CRM matching for IG threads (phone-keyed today; deliberately skipped).
- No group DMs (skipped with a visible counter; commercial DMs are 1:1).
- No media download (type labels only, same as the WhatsApp lanes).
- No posting, reacting, marking-as-read or any write operation. Read-only.

## 1. Corpus contract & identity

`src/export-ig.mjs` emits the same raw line shape as `export-kapso.mjs`:

```json
{ "id": "...", "timestamp": 1756000000, "from": "<igUserId>@ig",
  "fromMe": false, "body": "...", "hasMedia": false,
  "_data": { "pushName": "<username>", "message": { "audioMessage": { "ptt": true } } } }
```

- `from` = **counterparty** JID in BOTH directions (NOWEB convention; keeps
  the `threads.mjs` engine-shape tripwire green).
- JID scheme `<igUserId>@ig` — the numeric IG user id (stable; usernames
  change).
- `timestamp` in **seconds** (IG's API returns microseconds; ÷ 1e6).
- Counterparty username/full name → `_data.pushName` on inbound lines, the
  same channel Kapso uses.
- Item-type mapping mirrors `messageShape()` in export-kapso: `voice_media` →
  `audioMessage{ptt:true}`, media items → their `*Message` markers, unknown
  types fall through as text.

**Required change in `threads.mjs`** (the one sharp edge): today every
non-`@lid` JID goes through `normalizeJid(digits)` (threads.mjs:289). A
10-11 digit IG user id can silently normalize into a plausible phone number
and even collide with a CRM number. Fix: `@ig` JIDs skip phone
normalization entirely — `key = "ig:<userId>"`, `phone = null`, display
falls back to pushName/username.

**Corpus meta**: the corpus gains `channel: "instagram"` (default
`"whatsapp"`) in `summary.json` and `threads.json` — named `channel`, not
`source`, because `summary.source` already holds the messages-file path.
Renderers use it only for their title lines; no other renderer changes.

## 2. The exporter (`src/export-ig.mjs`, `npm run export:ig`)

Auth (env-only, never flags, never config files in git):

- `IG_SESSION_ID` — the `sessionid` cookie from a logged-in browser session.
- `IG_DS_USER_ID` — the `ds_user_id` cookie (own numeric id; also drives
  `fromMe`).
- `ig.env.example` committed; `ig.env` gitignored (covered by existing
  `*.env` rule).

No passwords ever touch the tool. Login — where IG concentrates bot
detection — happens in the operator's real browser.

Transport: Node `fetch`, zero new dependencies. Endpoints (the official web
client's own):

- `GET https://www.instagram.com/api/v1/direct_v2/inbox/` — thread list,
  cursor-paginated.
- `GET https://www.instagram.com/api/v1/direct_v2/threads/{threadId}/` —
  per-thread messages, `oldest_cursor` pagination back in time.
- Headers: `x-ig-app-id` (the public web-app id), browser User-Agent,
  `Cookie: sessionid=...; ds_user_id=...`.

Safety rails (hard requirements, not options):

- **Throttle floor**: ≥ 3s + 0-2s jitter between requests. Not configurable
  below the floor.
- **Stop-dead on challenge**: HTTP 401, 429, or a body containing
  `challenge_required` / `login_required` aborts the run immediately, saves
  resume state, and prints what happened and what to do (wait, re-login in
  the browser, refresh cookies). Never retry into a checkpoint.
- **Read-only**: GET endpoints only.
- Group threads (>1 counterparty) skipped with a printed count.
- Resumable: on-disk state file with per-thread oldest cursor, same spirit
  as `export.mjs`.
- Optional `--since <days>` to bound the pull; default full history.

Output: same `output.dir` mechanism as the other lanes (`WA_OUT_DIR` env /
config). Recommended dir `data/ig-history/` so WhatsApp and IG corpora never
mix; docs show the two-terminal flow (`WA_OUT_DIR=data/ig-history npm run
export:ig`, then `threads` with the same dir).

## 3. Fixtures, tests, docs

- `fixtures/mock-ig.mjs`: local HTTP server with the real API shape —
  microsecond timestamps, a voice note, media items, one group thread, and a
  simulated `challenge_required` mode to test the stop-dead path.
- Integration test (node --test, no network): exporter against the mock →
  `threads --no-net` → assert direction split, one thread per counterparty,
  group skipped + counted, timestamps in seconds, corpus `source:
  "instagram"`.
- Unit test: an IG numeric id must NOT normalize into a phone; `ig:` keying
  and pushName display verified.
- Challenge test: mock returns `challenge_required` mid-run → exporter
  aborts, state file present, non-zero exit, clear message.
- `docs/ig-setup.md`: cookie how-to (devtools), the risk section in the
  WAHA-setup register (unofficial client, read-only + throttled by design,
  **test account first**, ToS honesty), and DYI documented as the official
  zero-risk alternative for the patient.
- README + README.es: IG lane section; disclaimer extended to Instagram.

## Test plan summary

`npm test` stays green offline. New tests cover: happy path end-to-end via
mock, identity keying (the normalization trap), the challenge abort, group
skipping, µs→s conversion. First real-account run: operator's test account,
never a client's.
