# Instagram DM Exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the operator's own Instagram DM inbox (session-cookie auth, official web client's private API) into the existing `messages.jsonl` contract so the whole audit pipeline works over IG conversations.

**Architecture:** A new exporter (`src/export-ig.mjs`) mirrors `src/export-kapso.mjs`: foreign API → NOWEB-convention raw lines → same corpus phase. Identity uses a new `<igUserId>@ig` JID suffix; `threads.mjs` learns to key those as `ig:<id>` without phone normalization. A mock IG server (`fixtures/mock-ig.mjs`) makes every test hermetic.

**Tech Stack:** Plain Node ≥20 ESM, `node:test`, zero new dependencies. `fetch` for HTTP.

**Spec:** `docs/superpowers/specs/2026-08-31-ig-dm-exporter-design.md`

## Global Constraints

- Zero new npm dependencies. Plain `.mjs` ESM, matching repo idiom.
- Secrets env-only: `IG_SESSION_ID`, `IG_DS_USER_ID`. Never flags, never config files, never committed. `ig.env` is covered by the existing `*.env` gitignore rule.
- Read-only: GET requests only. Nothing that writes to Instagram.
- Throttle floor: ≥ 3000 ms + 0–2000 ms jitter before EVERY request. The floor is a `const`, not configurable.
- Stop-dead on `challenge_required` / `login_required` / HTTP 401 / 429: save state, print recovery instructions, `process.exit(1)`. Never retry into a checkpoint.
- Raw-line contract (NOWEB convention): `from` = counterparty JID in BOTH directions; `timestamp` in epoch **seconds**; IG API timestamps are **microseconds** (÷ 1e6).
- JID scheme: `<numeric ig user id>@ig`. Thread key `ig:<id>`, `phone: null`, never phone-normalized.
- Corpus meta field is named `channel` (`"whatsapp"` default, `"instagram"`), NOT `source` (`summary.source` already holds the messages-file path).
- `npm test` must stay green offline; no test touches instagram.com.
- Report prose stays es-AR; only renderer TITLE lines become channel-aware.
- Group DM threads are skipped by the exporter with a printed count (v1 is 1:1 only).

---

### Task 1: Mock IG server + synthetic fixture

**Files:**
- Create: `fixtures/mock-ig.mjs`

**Interfaces:**
- Produces: HTTP endpoints `GET /api/v1/direct_v2/inbox/` and `GET /api/v1/direct_v2/threads/:id/` (cursor pagination, shapes below); exported helper `igFixture()` returning `{ ownUserId, threads }` for tests; CLI `node fixtures/mock-ig.mjs [port] [--challenge-after N]` printing `mock-ig listening on <port>` when ready.
- Consumes: nothing (fixture data is inline).

The real API's shapes, encoded by the mock (this is the contract the exporter is written against):

- Inbox: `{ inbox: { threads: [...], has_older: bool, oldest_cursor: string } }`, each thread `{ thread_id, users: [{ pk, username, full_name }], is_group: bool }` (`users` excludes self).
- Thread page: `{ thread: { thread_id, users, items: [...], has_older: bool, oldest_cursor: string } }`, items newest→oldest; each item `{ item_id, user_id, timestamp: "<microseconds as string>", item_type, ... }` with `item_type` ∈ `text | media | voice_media | animated_media | link | ...`.
- Auth check: requests without `Cookie` containing `sessionid=` get `403 { message: "login_required", status: "fail" }`.
- Challenge mode: with `--challenge-after N`, request N+1 onward answers `400 { message: "challenge_required", status: "fail" }`.

- [ ] **Step 1: Write the mock**

```js
/**
 * Minimal mock of Instagram's private web DM API (the endpoints the official
 * instagram.com client uses), serving a small synthetic inbox. Same spirit as
 * mock-waha / mock-kapso: hermetic tests, no real accounts.
 *
 *   node fixtures/mock-ig.mjs [port] [--challenge-after N]
 *
 * Endpoints:
 *   GET /api/v1/direct_v2/inbox/?limit&cursor
 *   GET /api/v1/direct_v2/threads/:id/?limit&cursor
 * Timestamps are MICROSECOND strings, like the real API.
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8439);
const chAt = process.argv.indexOf('--challenge-after');
const CHALLENGE_AFTER = chAt > -1 ? Number(process.argv[chAt + 1]) : Infinity;

export const OWN_ID = '99000001';
const US = { maria: { pk: '77000001', username: 'maria.deco', full_name: 'María Decoraciones' },
             carlos: { pk: '77000002', username: 'carlos_mueble', full_name: 'Carlos Muebles' },
             lucia:  { pk: '77000003', username: 'lucia.eventos', full_name: 'Lucía Eventos' } };

const us = (ts) => String(ts * 1_000_000); // seconds → microsecond string
let iid = 0;
const item = (userId, tsSec, type, extra = {}) =>
  ({ item_id: `it_${++iid}`, user_id: userId, timestamp: us(tsSec), item_type: type, ...extra });

// Three 1:1 threads + one group (the exporter must skip the group).
export function igFixture() {
  return { ownUserId: OWN_ID, threads: [
    { thread_id: 'th_maria', is_group: false, users: [US.maria], items: [
      item(OWN_ID, 1756100300, 'text', { text: 'Perfecto, te agendo para el jueves' }),
      item(US.maria.pk, 1756100200, 'voice_media', { voice_media: {} }),
      item(US.maria.pk, 1756100100, 'text', { text: 'Hola! ¿Tenés stock de la lámpara nórdica?' }),
    ] },
    { thread_id: 'th_carlos', is_group: false, users: [US.carlos], items: [
      item(US.carlos.pk, 1756200400, 'media', { media: { media_type: 1 } }),
      item(US.carlos.pk, 1756200300, 'text', { text: '¿Cuánto sale el envío a Rosario?' }),
      item(OWN_ID, 1756200200, 'text', { text: 'Buenas! Catálogo actualizado acá' }),
      item(OWN_ID, 1756200100, 'link', { link: { text: 'https://ejemplo.test/catalogo' } }),
    ] },
    { thread_id: 'th_lucia', is_group: false, users: [US.lucia], items: [
      item(US.lucia.pk, 1756300100, 'text', { text: 'Precio del pack de 50 souvenirs?' }),
    ] },
    { thread_id: 'th_grupo', is_group: true, users: [US.maria, US.carlos], items: [
      item(US.maria.pk, 1756400100, 'text', { text: 'Grupo de proveedores' }),
    ] },
  ] };
}

const FIX = igFixture();
let requests = 0;

const server = createServer((req, res) => {
  requests++;
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (requests > CHALLENGE_AFTER) return send(400, { message: 'challenge_required', status: 'fail' });
  if (!String(req.headers.cookie ?? '').includes('sessionid=')) return send(403, { message: 'login_required', status: 'fail' });

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const cursor = Number(url.searchParams.get('cursor') ?? 0);

  if (url.pathname === '/api/v1/direct_v2/inbox/') {
    const page = FIX.threads.slice(cursor, cursor + limit);
    const next = cursor + page.length;
    return send(200, { inbox: {
      threads: page.map(({ items, ...t }) => t),
      has_older: next < FIX.threads.length,
      oldest_cursor: String(next),
    } });
  }
  const m = url.pathname.match(/^\/api\/v1\/direct_v2\/threads\/([^/]+)\/$/);
  if (m) {
    const t = FIX.threads.find((x) => x.thread_id === m[1]);
    if (!t) return send(404, { message: 'not found', status: 'fail' });
    const page = t.items.slice(cursor, cursor + limit); // items newest→oldest
    const next = cursor + page.length;
    return send(200, { thread: { thread_id: t.thread_id, users: t.users, items: page,
      has_older: next < t.items.length, oldest_cursor: String(next) } });
  }
  send(404, { message: 'not found', status: 'fail' });
});

server.listen(PORT, () => console.log(`mock-ig listening on ${PORT} (challenge after ${CHALLENGE_AFTER})`));
```

- [ ] **Step 2: Smoke-check it by hand**

Run: `node fixtures/mock-ig.mjs 8439 &` then
`curl -s -H "Cookie: sessionid=x" "http://localhost:8439/api/v1/direct_v2/inbox/?limit=2"`
Expected: JSON with 2 threads, `has_older: true`, `oldest_cursor: "2"`. Without the Cookie header: 403 `login_required`. Kill the background server after.

- [ ] **Step 3: Commit**

```bash
git add fixtures/mock-ig.mjs
git commit -m "IG lane: mock of the private web DM API (hermetic fixture server)"
```

---

### Task 2: Exporter happy path (`src/export-ig.mjs`)

**Files:**
- Create: `src/export-ig.mjs`, `ig.env.example`, `test/ig.test.mjs`
- Modify: `package.json` (scripts), `test/harness.mjs` (env scrub)

**Interfaces:**
- Consumes: mock endpoints + `igFixture()`/`OWN_ID` from Task 1; `loadConfig().output.dir` from `src/lib/config.mjs`; `run`/`tmpDir`/`pipelineEnv` from `test/harness.mjs`.
- Produces: `messages.jsonl` raw lines `{ id, timestamp (sec), from: "<pk>@ig", fromMe, body, hasMedia, _data: { pushName?, message? } }`; env contract `IG_SESSION_ID`, `IG_DS_USER_ID`, `IG_BASE_URL` (default `https://www.instagram.com`; the mock hook, same trick as `KAPSO_BASE_URL`); npm script `export:ig`; stdout line `skipped N group thread(s)`.

- [ ] **Step 1: Write the failing test**

```js
// test/ig.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, run, tmpDir, pipelineEnv } from './harness.mjs';
import { igFixture, OWN_ID } from '../fixtures/mock-ig.mjs';

const PORT = 8439;

function startMockIg(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'fixtures', 'mock-ig.mjs'), String(PORT), ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('mock-ig did not start')); }, 10_000);
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('listening')) { clearTimeout(timer); resolve(child); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock-ig exited early (${code}): ${buf}`)); });
  });
}

const igEnv = (out, extra = {}) => pipelineEnv(out, {
  IG_BASE_URL: `http://localhost:${PORT}`,
  IG_SESSION_ID: 'test-session',
  IG_DS_USER_ID: OWN_ID,
  ...extra,
});

test('IG lane: export maps the private-API shapes onto the corpus contract', async () => {
  const fix = igFixture();
  const oneToOne = fix.threads.filter((t) => !t.is_group);
  const expectedLines = oneToOne.reduce((a, t) => a + t.items.length, 0);

  const mock = await startMockIg();
  try {
    const out = tmpDir();
    const exp = run('src/export-ig.mjs', { env: igEnv(out) });
    assert.equal(exp.status, 0, `export-ig failed:\n${exp.stdout}\n${exp.stderr}`);
    assert.match(exp.stdout, /skipped 1 group thread/);

    const lines = readFileSync(path.join(out, 'messages.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.equal(lines.length, expectedLines, 'every 1:1 fixture item exported');

    for (const m of lines) {
      assert.match(m.from, /^\d+@ig$/, '`from` is the counterparty pk@ig in BOTH directions');
      assert.ok(Number.isInteger(m.timestamp) && m.timestamp < 20_000_000_000,
        `timestamp in seconds, not microseconds: ${m.timestamp}`);
      assert.equal(typeof m.fromMe, 'boolean');
    }
    // Direction: own user id → fromMe, counterparty stays in `from`.
    const own = lines.filter((m) => m.fromMe);
    assert.equal(own.length, 3, 'three outbound fixture items');
    assert.ok(own.every((m) => !m.from.startsWith(OWN_ID)), 'own id never lands in `from`');
    // Voice note maps to audioMessage{ptt:true}; inbound carries pushName.
    const voice = lines.find((m) => m._data?.message?.audioMessage);
    assert.ok(voice && voice._data.message.audioMessage.ptt === true, 'voice_media → audioMessage{ptt:true}');
    const withName = lines.filter((m) => !m.fromMe && m._data?.pushName);
    assert.ok(withName.length > 0, 'inbound lines carry the IG username as pushName');
    assert.ok(existsSync(path.join(out, 'ig-export-state.json')), 'resume state written');
  } finally { mock.kill(); }
});
```

- [ ] **Step 2: Run it, verify it fails for the right reason**

Run: `node --test test/ig.test.mjs`
Expected: FAIL — `export-ig failed` / `Cannot find module ... src/export-ig.mjs`.

- [ ] **Step 3: Implement the exporter**

```js
/**
 * src/export-ig.mjs — export the operator's OWN Instagram DM inbox through
 * the same private web API the official instagram.com client uses.
 *
 * Auth is a session cookie the operator copies from their logged-in browser
 * (docs/ig-setup.md). No passwords ever touch this tool. Read-only: GET
 * endpoints only, throttled hard, and any challenge stops the run dead.
 *
 *   IG_SESSION_ID   sessionid cookie            (required)
 *   IG_DS_USER_ID   ds_user_id cookie (own id)  (required)
 *   IG_BASE_URL     default https://www.instagram.com (mock hook for tests)
 *   --since <days>  only pull items newer than N days (default: everything)
 *
 * Emits the corpus contract (NOWEB convention): `from` = counterparty
 * <pk>@ig in BOTH directions, timestamps in seconds (IG sends microseconds).
 * Resumable: completed threads are appended to messages.jsonl and recorded
 * in ig-export-state.json; a rerun skips them.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';

const SESSION_ID = process.env.IG_SESSION_ID;
const DS_USER_ID = process.env.IG_DS_USER_ID;
const BASE = (process.env.IG_BASE_URL || 'https://www.instagram.com').replace(/\/+$/, '');
if (!SESSION_ID || !DS_USER_ID) {
  console.error('IG_SESSION_ID and IG_DS_USER_ID are required (cookies from your logged-in browser — docs/ig-setup.md)');
  process.exit(1);
}

const sinceAt = process.argv.indexOf('--since');
const SINCE_SEC = sinceAt > -1
  ? Math.floor(Date.now() / 1000) - Number(process.argv[sinceAt + 1]) * 86_400
  : 0;

const OUT_DIR = loadConfig().output.dir;
const MESSAGES_FILE = path.join(OUT_DIR, 'messages.jsonl');
const STATE_FILE = path.join(OUT_DIR, 'ig-export-state.json');

// Hard floor. Reading your own inbox at human pace is the whole risk posture.
const THROTTLE_MS = 3000;
const jitter = () => THROTTLE_MS + Math.floor(Math.random() * 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  'x-ig-app-id': '936619743392459', // the public web client's app id
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  cookie: `sessionid=${SESSION_ID}; ds_user_id=${DS_USER_ID}`,
  accept: 'application/json',
};

let state = { done: [] };
if (existsSync(STATE_FILE)) {
  state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  console.log(`Resuming: ${state.done.length} thread(s) already exported`);
}
const saveState = () => writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

/** Stop-dead: challenges are never retried into. */
async function get(pathname) {
  await sleep(jitter());
  const res = await fetch(`${BASE}${pathname}`, { headers: HEADERS });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* HTML = login redirect */ }
  const challenge = res.status === 401 || res.status === 429 || !body ||
    body.message === 'challenge_required' || body.message === 'login_required';
  if (challenge) {
    await saveState();
    console.error(`\nInstagram interrupted the export (HTTP ${res.status}${body?.message ? `, ${body.message}` : ''}).`);
    console.error('State was saved — a rerun resumes where this stopped. Do NOT rerun immediately:');
    console.error('  1. Open instagram.com in your browser and complete any verification it shows.');
    console.error('  2. Wait a few hours. 3. Refresh IG_SESSION_ID/IG_DS_USER_ID from devtools. 4. Rerun.');
    process.exit(1);
  }
  if (!res.ok) throw new Error(`IG HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

/** IG item → NOWEB-shape marker (same fallthrough idea as export-kapso). */
function messageShape(item) {
  switch (item.item_type) {
    case 'voice_media': return { audioMessage: { ptt: true } };
    case 'media': return item.media?.media_type === 2 ? { videoMessage: {} } : { imageMessage: {} };
    case 'animated_media': return { stickerMessage: {} };
    default: return null; // text, link, unknown → plain text
  }
}

function toRawLine(item, counterpart) {
  const sec = Math.floor(Number(item.timestamp) / 1e6); // µs → s
  if (sec < SINCE_SEC) return null;
  const shape = messageShape(item);
  const fromMe = String(item.user_id) === DS_USER_ID;
  const out = {
    id: item.item_id,
    timestamp: sec,
    from: `${counterpart.pk}@ig`, // counterparty in BOTH directions
    fromMe,
    body: item.text ?? item.link?.text ?? '',
    hasMedia: !!shape, // voice notes count as media, same as the WAHA lane
    _data: {},
  };
  if (!fromMe) out._data.pushName = counterpart.username || counterpart.full_name || '';
  if (shape) out._data.message = shape;
  return out;
}

await mkdir(OUT_DIR, { recursive: true });
console.log(`Exporting your Instagram DM inbox (read-only, throttled ≥${THROTTLE_MS / 1000}s/request)...`);

// 1) walk the inbox
const threads = [];
let cursor = null;
for (;;) {
  const qs = new URLSearchParams({ limit: '20' });
  if (cursor) qs.set('cursor', cursor);
  const page = await get(`/api/v1/direct_v2/inbox/?${qs}`);
  threads.push(...(page.inbox?.threads ?? []));
  if (!page.inbox?.has_older) break;
  cursor = page.inbox.oldest_cursor;
}
const groups = threads.filter((t) => t.is_group || (t.users?.length ?? 0) > 1);
const oneToOne = threads.filter((t) => !groups.includes(t) && (t.users?.length ?? 0) === 1);
console.log(`Inbox: ${threads.length} thread(s) · skipped ${groups.length} group thread(s)`);

// 2) walk each 1:1 thread back in time; append per completed thread (resume unit)
let total = 0;
for (const t of oneToOne) {
  if (state.done.includes(t.thread_id)) continue;
  const counterpart = t.users[0];
  const lines = [];
  let tCursor = null;
  for (;;) {
    const qs = new URLSearchParams({ limit: '50' });
    if (tCursor) qs.set('cursor', tCursor);
    const page = await get(`/api/v1/direct_v2/threads/${encodeURIComponent(t.thread_id)}/?${qs}`);
    const items = page.thread?.items ?? [];
    let pastSince = false;
    for (const item of items) {
      const raw = toRawLine(item, counterpart);
      if (raw) lines.push(JSON.stringify(raw));
      else if (SINCE_SEC) pastSince = true; // items are newest→oldest
    }
    if (pastSince || !page.thread?.has_older || items.length === 0) break;
    tCursor = page.thread.oldest_cursor;
  }
  if (lines.length) await appendFile(MESSAGES_FILE, lines.join('\n') + '\n', 'utf8');
  total += lines.length;
  state.done.push(t.thread_id);
  await saveState();
  console.log(`  @${counterpart.username}: ${lines.length} message(s) (${total} total)`);
}

console.log(`\n✓ ${total} messages → ${MESSAGES_FILE}`);
console.log('\nNext: node src/threads.mjs --session ig --no-net');
console.log('Tip: keep IG corpora in their own dir (WA_OUT_DIR=data/ig-history) so channels never mix.');
```

- [ ] **Step 4: Wire the npm script and env example; scrub `IG_` in the harness**

`package.json` scripts (after `"export:kapso"`):

```json
    "export:ig": "node src/export-ig.mjs",
```

`ig.env.example`:

```bash
# Copy to ig.env (gitignored) and fill from your logged-in browser's devtools:
# instagram.com → DevTools → Application → Cookies → sessionid / ds_user_id
# docs/ig-setup.md explains the how and the risks. Never commit ig.env.
IG_SESSION_ID=
IG_DS_USER_ID=
```

`test/harness.mjs`, in `pipelineEnv`, extend the scrub loop:

```js
    if (k.startsWith('WA_') || k.startsWith('WAHA_') || k.startsWith('KAPSO_') || k.startsWith('IG_')) delete env[k];
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `node --test test/ig.test.mjs`
Expected: PASS.

- [ ] **Step 6: Full suite still green**

Run: `npm test`
Expected: all pass (14 existing + 1 new).

- [ ] **Step 7: Commit**

```bash
git add src/export-ig.mjs test/ig.test.mjs ig.env.example package.json test/harness.mjs
git commit -m "IG lane: exporter over the private web DM API (cookie auth, throttled, resumable)"
```

---

### Task 3: `@ig` identity in `threads.mjs` (the normalization trap)

**Files:**
- Modify: `src/threads.mjs` (keying loop ~line 284, thread build ~line 390)
- Test: `test/ig.test.mjs` (extend)

**Interfaces:**
- Consumes: `messages.jsonl` with `@ig` JIDs from Task 2.
- Produces: threads keyed `ig:<pk>` with `phone: null`, `origins: ['ig']`, `unresolved_lid: false`, `phone_display: "IG:<pk>"`, `contact_name` from pushName. Later tasks rely on `summary.lids_unresolved` staying 0 for IG corpora.

- [ ] **Step 1: Write the failing tests**

Append to `test/ig.test.mjs`:

```js
test('IG lane: corpus keys @ig by user id — never as a phone number', async () => {
  const fix = igFixture();
  const oneToOne = fix.threads.filter((t) => !t.is_group);

  const mock = await startMockIg();
  let out;
  try {
    out = tmpDir();
    const exp = run('src/export-ig.mjs', { env: igEnv(out) });
    assert.equal(exp.status, 0, `export-ig failed:\n${exp.stdout}\n${exp.stderr}`);
  } finally { mock.kill(); }

  const threads = run('src/threads.mjs', { args: ['--session', 'ig', '--no-net'], env: igEnv(out) });
  assert.equal(threads.status, 0, `threads failed:\n${threads.stdout}\n${threads.stderr}`);

  const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.count_check_ok, true);
  assert.equal(summary.threads, oneToOne.length);
  assert.equal(summary.lids_unresolved, 0, '@ig must never be mistaken for an unresolved @lid');

  const corpus = JSON.parse(readFileSync(path.join(out, 'threads.json'), 'utf8'));
  for (const t of corpus.threads) {
    assert.match(t.thread_id, /^ig:\d+$/, `IG thread key: ${t.thread_id}`);
    assert.equal(t.phone, null, 'an IG user id must NEVER normalize into a phone');
    assert.match(t.phone_display, /^IG:\d+$/);
  }
  const maria = corpus.threads.find((t) => t.thread_id === 'ig:77000001');
  assert.equal(maria.contact_name, 'maria.deco', 'username flows in as contact_name via pushName');
  assert.equal(maria.metrics.inbound, 2);
  assert.equal(maria.metrics.outbound, 1);
});

test('IG identity: a 10-digit IG id that LOOKS like an AR phone still keys as ig:', async () => {
  // Hand-written 2-line corpus: digits that normalizeInput would happily turn
  // into a phone with defaultCountry AR. The @ig suffix must prevent that.
  const out = tmpDir();
  const jid = '1155443322@ig';
  const rows = [
    { id: 'a1', timestamp: 1756000100, from: jid, fromMe: false, body: 'hola', hasMedia: false, _data: { pushName: 'trampa.ig' } },
    { id: 'a2', timestamp: 1756000200, from: jid, fromMe: true, body: 'buenas', hasMedia: false, _data: {} },
  ];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(out, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const threads = run('src/threads.mjs', { args: ['--session', 'ig', '--no-net'], env: pipelineEnv(out) });
  assert.equal(threads.status, 0, `threads failed:\n${threads.stdout}\n${threads.stderr}`);
  const corpus = JSON.parse(readFileSync(path.join(out, 'threads.json'), 'utf8'));
  assert.equal(corpus.threads.length, 1);
  assert.equal(corpus.threads[0].thread_id, 'ig:1155443322');
  assert.equal(corpus.threads[0].phone, null);
});
```

- [ ] **Step 2: Run, verify both fail**

Run: `node --test test/ig.test.mjs`
Expected: FAIL — thread_id comes out as a normalized phone (e.g. `+54911...`), phone non-null.

- [ ] **Step 3: Implement in `threads.mjs`**

Keying loop (current lines ~288–301). Replace:

```js
  const isLid = jid.endsWith('@lid');
  const rawNumber = isLid ? (cache[jid]?.pn ?? '') : jid.split('@')[0];
  const phone = normalizeJid(rawNumber);
  // An unresolved @lid can NOT be normalized: its digits are not a phone
  // number. It gets its own thread and a flag — never an invented number.
  const key = phone ?? `lid:${jid.split('@')[0]}`;
```

with:

```js
  const isLid = jid.endsWith('@lid');
  const isIg = jid.endsWith('@ig');
  // An IG user id is NOT a phone number: 10-11 digits would normalize into a
  // plausible phone and could even collide with a CRM number. Skip entirely.
  const rawNumber = isLid ? (cache[jid]?.pn ?? '') : isIg ? '' : jid.split('@')[0];
  const phone = normalizeJid(rawNumber);
  // An unresolved @lid can NOT be normalized: its digits are not a phone
  // number. It gets its own thread and a flag — never an invented number.
  const key = phone ?? `${isIg ? 'ig' : 'lid'}:${jid.split('@')[0]}`;
```

Two lines below, the conv creation and origin:

```js
    c = { key, phone, jids: [], origins: new Set(), names: [], messages: [], unresolved_lid: !phone && isLid, is_system: SYSTEM.has(jid) };
```

```js
  const origin = isLid ? 'lid' : isIg ? 'ig' : 'c.us';
```

Thread build (~line 390), replace the `phone_display` line:

```js
    phone_display: c.phone ? display(c.phone)
      : c.key.startsWith('ig:') ? `IG:${c.key.slice(3)}`
      : `@lid ${c.key.slice(4)} (unresolved)`,
```

- [ ] **Step 4: Run the IG tests, then the whole suite**

Run: `node --test test/ig.test.mjs` → PASS.
Run: `npm test` → all green (the WhatsApp goldens must be untouched: no `@ig` JIDs exist in the WA fixtures, so behavior there is identical).

- [ ] **Step 5: Commit**

```bash
git add src/threads.mjs test/ig.test.mjs
git commit -m "threads: @ig identity — key by IG user id, never phone-normalize it"
```

---

### Task 4: `channel` meta + channel-aware report titles

**Files:**
- Modify: `src/threads.mjs` (summary + threads.json headers), `src/lib/report-data.mjs`, `src/report-html.mjs:44,89`, `src/report-xlsx.mjs:114,341`, `src/report-docx.mjs:85,210`
- Test: `test/ig.test.mjs` (extend the corpus test)

**Interfaces:**
- Consumes: corpus with `@ig` origins (Task 3).
- Produces: `summary.channel` and `threads.json` `channel` ∈ `"whatsapp" | "instagram"`; `loadReportData` returns `canal` (`"WhatsApp"` | `"Instagram"`), consumed by the three renderers' title lines.

- [ ] **Step 1: Extend the failing assertions**

In the `IG lane: corpus keys @ig...` test, after the summary asserts, add:

```js
  assert.equal(summary.channel, 'instagram');
```

and in the WhatsApp-side safety net, add to the existing direct-lane pipeline test (`test/pipeline.test.mjs`, inside the direct-lane test after its summary asserts):

```js
  assert.equal(lane.summary.channel, 'whatsapp');
```

(Adapt the variable name to what that test already binds — it uses `runDirectLane()`'s return value.)

- [ ] **Step 2: Run, verify fail**

Run: `node --test test/ig.test.mjs test/pipeline.test.mjs`
Expected: FAIL — `channel` undefined.

- [ ] **Step 3: Implement**

`src/threads.mjs` — derive once, before the outputs section (~line 458):

```js
// Channel: an all-@ig corpus is an Instagram export; anything else is WhatsApp.
const igJids = [...byJid.keys()].filter((j) => j.endsWith('@ig')).length;
const channel = igJids > 0 && igJids === byJid.size ? 'instagram' : 'whatsapp';
```

Add `channel,` to BOTH output headers: the `THREADS_FILE` write (`{ schema_version: 1, generated_at, session, channel, threads }`) and the `summary` object (right after `session`).

`src/lib/report-data.mjs` — inside `loadReportData`, after `summary` is read, compute and return:

```js
  const canal = summary.channel === 'instagram' ? 'Instagram' : 'WhatsApp';
```

(add `canal,` to the returned object at ~line 148).

Renderers — destructure `canal` from `loadReportData` alongside `summary` and replace ONLY these hardcoded strings:

- `report-html.mjs:44`: `<title>${esc(BUSINESS)} — Informe de ${canal}</title>`
- `report-html.mjs:89`: `<h1>${esc(BUSINESS)} — Historial de ${canal}: informe maestro</h1>`
- `report-xlsx.mjs:114`: `push([`${BUSINESS} — Historial de ${canal}: informe maestro`], 3);`
- `report-xlsx.mjs:341` (methodology): keep the WAHA sentence for WhatsApp; for Instagram swap the source clause:

```js
  (summary.channel === 'instagram'
    ? `El origen es un export de la bandeja de DMs de Instagram del negocio, leído con la sesión del operador (solo lectura), sesión ${summary.session}, `
    : `El origen es un dump completo del historial de WhatsApp del negocio exportado desde WAHA, sesión ${summary.session}, `) +
```

- `report-docx.mjs:85`: `` text: clean(`${BUSINESS} — Historial de ${canal}: informe maestro`) ``
- `report-docx.mjs:210`: `` title: `${BUSINESS} — Informe de ${canal}` ``

Do NOT touch the other "WhatsApp" prose strings (group exclusions, @lid explanations): they describe WhatsApp mechanics and only render meaningfully for WhatsApp corpora; a full channel-aware prose pass is out of scope (spec: titles only).

- [ ] **Step 4: Run everything; regenerate the goldens**

Run: `npm test`
Expected: rendered strings stay byte-identical for WhatsApp corpora (`canal` is `"WhatsApp"` there), BUT any golden that snapshots `summary.json` now sees the new `channel` key and fails with a deep-equal diff showing only `channel: "whatsapp"` added. That exact diff is the expected one — anything else failing is a real bug. Regenerate:

Run: `node test/record-golden.mjs` then `npm test` again → all green.

- [ ] **Step 5: Commit**

```bash
git add src/threads.mjs src/lib/report-data.mjs src/report-html.mjs src/report-xlsx.mjs src/report-docx.mjs test/ig.test.mjs test/pipeline.test.mjs test/golden
git commit -m "corpus: channel meta (whatsapp|instagram); report titles follow the channel"
```

---

### Task 5: Stop-dead on challenge + resume

**Files:**
- Modify: `src/export-ig.mjs` (already implements it — this task PROVES it)
- Test: `test/ig.test.mjs` (extend)

**Interfaces:**
- Consumes: mock `--challenge-after N` mode (Task 1); state file `ig-export-state.json` (Task 2).
- Produces: verified abort/resume behavior later docs rely on describing.

- [ ] **Step 1: Write the failing test**

```js
test('IG lane: challenge stops the run dead, state survives, rerun resumes and completes', async () => {
  const fix = igFixture();
  const oneToOne = fix.threads.filter((t) => !t.is_group);
  const expectedLines = oneToOne.reduce((a, t) => a + t.items.length, 0);
  const out = tmpDir();

  // Run 1: the mock throws a challenge mid-run (after inbox + first thread).
  let mock = await startMockIg(['--challenge-after', '3']);
  try {
    const exp1 = run('src/export-ig.mjs', { env: igEnv(out) });
    assert.equal(exp1.status, 1, 'challenge must exit non-zero');
    assert.match(exp1.stderr, /interrupted|challenge/i);
    assert.ok(existsSync(path.join(out, 'ig-export-state.json')), 'state saved on abort');
  } finally { mock.kill(); }

  // Run 2: clean mock; the exporter must skip finished threads and complete.
  mock = await startMockIg();
  try {
    const exp2 = run('src/export-ig.mjs', { env: igEnv(out) });
    assert.equal(exp2.status, 0, `resume failed:\n${exp2.stdout}\n${exp2.stderr}`);
    assert.match(exp2.stdout, /Resuming/);
    const lines = readFileSync(path.join(out, 'messages.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
    const ids = new Set(lines.map((l) => JSON.parse(l).id));
    assert.equal(ids.size, lines.length, 'no duplicated messages after resume');
    assert.equal(lines.length, expectedLines, 'resume completes the full corpus');
  } finally { mock.kill(); }
});
```

- [ ] **Step 2: Add the `--since` test (the fixture lives in the past, so both branches are deterministic)**

```js
test('IG lane: --since bounds the pull', async () => {
  const mock = await startMockIg();
  try {
    // Fixture timestamps are ~2025; --since 100 days excludes everything,
    // and stays exclusionary forever as the fixture only gets older.
    const out = tmpDir();
    const exp = run('src/export-ig.mjs', { args: ['--since', '100'], env: igEnv(out) });
    assert.equal(exp.status, 0, `export-ig --since failed:\n${exp.stdout}\n${exp.stderr}`);
    assert.ok(!existsSync(path.join(out, 'messages.jsonl')) ||
      readFileSync(path.join(out, 'messages.jsonl'), 'utf8').trim() === '',
      'nothing newer than 100 days in the fixture');

    // --since 10000 days (~27 years) includes the whole fixture.
    const out2 = tmpDir();
    const exp2 = run('src/export-ig.mjs', { args: ['--since', '10000'], env: igEnv(out2) });
    assert.equal(exp2.status, 0);
    const fix = igFixture();
    const expected = fix.threads.filter((t) => !t.is_group).reduce((a, t) => a + t.items.length, 0);
    const lines = readFileSync(path.join(out2, 'messages.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, expected);
  } finally { mock.kill(); }
});
```

- [ ] **Step 3: Run it**

Run: `node --test test/ig.test.mjs`
Expected: likely PASS already (Task 2 implemented abort+state and `--since`). If a test FAILS, the failure pinpoints the gap (most likely: a partially-exported thread appended lines before the challenge and re-appends on resume — fix by appending a thread's lines ONLY after its full walk completes, which is what the Task 2 code does; verify).

- [ ] **Step 4: Full suite**

Run: `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add test/ig.test.mjs
git commit -m "IG lane: prove the challenge stop-dead and clean resume"
```

---

### Task 6: Docs + disclaimer

**Files:**
- Create: `docs/ig-setup.md`
- Modify: `README.md` (new lane section after the Kapso one + disclaimer line), `README.es.md` (same in Spanish)

**Interfaces:**
- Consumes: everything above (documents real behavior only).
- Produces: operator-facing setup + risk docs.

- [ ] **Step 1: Write `docs/ig-setup.md`**

```markdown
# Instagram DMs — export your own inbox

`npm run export:ig` reads **your own** Instagram DM inbox through the same
private web API the official instagram.com client uses, and emits the exact
`messages.jsonl` the rest of the pipeline consumes. From there everything is
identical: `threads` → analysis → verified report, now labeled Instagram.

## Read this first (risk, honestly)

Like the WAHA lane, this is an **unofficial client** and it is against
Instagram's terms. The design keeps the risk profile as low as it goes —
login happens in your real browser (the tool never sees a password), the
exporter only reads, it waits ≥3 s between requests, and it stops dead the
moment Instagram raises a checkpoint instead of retrying — but the risk is
not zero and Instagram is far more trigger-happy than WhatsApp.

- **First run on a test account, never on a client's.**
- The zero-risk alternative exists: Instagram → Accounts Center →
  "Download your information" gives you every DM as JSON, officially. It
  just takes hours to days. If you are not in a hurry, use that.

## Setup (2 minutes)

1. Log into instagram.com in your browser as usual.
2. DevTools → Application → Cookies → copy `sessionid` and `ds_user_id`.
3. `cp ig.env.example ig.env`, paste both values (gitignored, never commit).
4. Point the output somewhere IG-only, so channels never mix:

```bash
set -a; . ./ig.env; set +a
WA_OUT_DIR=data/ig-history npm run export:ig
WA_OUT_DIR=data/ig-history node src/threads.mjs --session ig --no-net
```

`--since 365` bounds the pull to the last year. The export is resumable: a
rerun skips completed conversations.

## If Instagram interrupts the run

The exporter saves its state and tells you. Do not rerun immediately: open
instagram.com, complete any verification, wait a few hours, refresh the two
cookies in `ig.env`, rerun. It resumes where it stopped.

## What lands in the corpus

1:1 conversations only (group DMs are skipped and counted). Identity is the
numeric IG user id (`ig:<id>` threads — usernames change, ids don't), the
username shows as the contact name, and no phone-based CRM matching applies
to IG threads in v1.
```

- [ ] **Step 2: README sections**

`README.md`, after the Kapso section, add:

```markdown
## Instagram DMs too

The same audit runs over your Instagram inbox: `npm run export:ig` reads
your own DMs through the web client's API (cookie from your browser, no
passwords, read-only, hard-throttled, stops dead on any checkpoint) and
emits the same corpus contract. 1:1 threads only, identity by IG user id,
reports come out labeled Instagram. Honest notes — unofficial client, test
account first, and the official zero-risk path (Accounts Center → Download
your information) — in [docs/ig-setup.md](docs/ig-setup.md).
```

Find the existing WhatsApp ToS disclaimer line in `README.md` (grep
`disclaimer` / `unofficial`) and extend it to mention Instagram in the same
sentence, e.g. append: `The same applies to the Instagram lane.` Mirror both
changes in `README.es.md` in es-AR (translate faithfully; keep the register
of the surrounding text; no em-dashes in the Spanish copy).

- [ ] **Step 3: Verify docs and suite**

Run: `npm test` → green. Skim README rendering (`grep -n "Instagram" README.md README.es.md docs/ig-setup.md`) — sections present in both languages.

- [ ] **Step 4: Commit**

```bash
git add docs/ig-setup.md README.md README.es.md
git commit -m "IG lane: setup + risk docs, README sections (EN/ES), disclaimer extended"
```

---

## Reality-check note for the first real run (not a task)

The mock encodes the API shapes as known-good (`inbox.threads`, `thread.items`, µs timestamps, `oldest_cursor`/`has_older`, `challenge_required`). Before the first real-account run, diff one real inbox page against the mock's assumptions (`curl` with the two cookies, jq the keys). If reality differs, fix the MOCK first so tests encode truth — the Kapso `fields=kapso()` bug taught this exact lesson.
