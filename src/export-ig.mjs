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
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';

const SESSION_ID = (process.env.IG_SESSION_ID ?? '').trim();
const DS_USER_ID = (process.env.IG_DS_USER_ID ?? '').trim();
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

/** First non-empty line of a (possibly huge) file, without loading it all. */
async function firstNonEmptyLine(file) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) return line;
  }
  return null;
}

// Guard against writing IG lines into a directory that already holds another
// channel's dump: messages.jsonl is append-only, so mixing channels there
// would silently corrupt the corpus (threads.mjs carries the mirror-image
// warning for a mixed corpus that gets past this guard some other way).
if (existsSync(MESSAGES_FILE)) {
  const firstLine = await firstNonEmptyLine(MESSAGES_FILE);
  let firstFrom = '';
  if (firstLine) {
    try { firstFrom = JSON.parse(firstLine)?.from ?? ''; } catch { /* unparseable: not this guard's call to make */ }
  }
  if (firstFrom && !String(firstFrom).endsWith('@ig')) {
    console.error(`\n${MESSAGES_FILE} already exists and belongs to another channel (first line's "from" is "${firstFrom}", not an @ig id).`);
    console.error('Set WA_OUT_DIR to a dedicated directory for this channel (e.g. WA_OUT_DIR=data/ig-history) and rerun.');
    process.exit(1);
  }
}

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
  let parsed = null;
  try { parsed = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { /* handled below */ }
  if (!parsed || !Array.isArray(parsed.done)) {
    console.error(`\n${STATE_FILE} is corrupt or missing the expected "done" array — refusing to guess.`);
    console.error('messages.jsonl is append-only, so silently resetting state here would re-walk threads');
    console.error('already recorded in it and duplicate lines. Two ways out:');
    console.error('  1. Restore ig-export-state.json from a backup, if you have one.');
    console.error(`  2. Delete both ig-export-state.json and messages.jsonl in ${OUT_DIR} and re-export from scratch.`);
    process.exit(1);
  }
  state = parsed;
  // A state file built under a narrower --since must never be resumed by a
  // broader run: threads already marked "done" were only walked back to the
  // OLD cutoff, so a broader rerun would silently skip the older messages in
  // between instead of fetching them. Refuse loudly, before any request.
  const storedSince = state.since_sec ?? 0; // missing field = pre-existing full-history state
  if (SINCE_SEC < storedSince) {
    const fmt = (s) => (s === 0 ? 'the full history (no --since)' : new Date(s * 1000).toISOString());
    console.error(`\nThis run's window goes further back than the saved export state covers.`);
    console.error(`  saved state cutoff:  ${fmt(storedSince)}`);
    console.error(`  this run's cutoff:   ${fmt(SINCE_SEC)}`);
    console.error('Resuming now would mark threads "done" without ever fetching the older messages');
    console.error('in that gap — a silent data loss. Refusing instead. Two ways out:');
    console.error('  1. Rerun with the same (or a narrower) --since <days> that produced the saved state.');
    console.error(`  2. Delete ig-export-state.json and messages.jsonl in ${OUT_DIR} for a fresh full export.`);
    process.exit(1);
  }
  console.log(`Resuming: ${state.done.length} thread(s) already exported`);
}
state.since_sec = SINCE_SEC;
const saveState = () => writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

/** Stop-dead: a read-only exporter has nothing to gain from any non-OK
 *  response, so ANY of them — not just the well-known challenge shapes —
 *  takes the same save-state-and-explain path instead of a raw crash. */
async function get(pathname) {
  await sleep(jitter());
  const res = await fetch(`${BASE}${pathname}`, { headers: HEADERS });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* HTML = login redirect */ }
  const challenge = !res.ok || !body || body.status === 'fail' ||
    body.message === 'challenge_required' || body.message === 'login_required';
  if (challenge) {
    await saveState();
    console.error(`\nInstagram interrupted the export (HTTP ${res.status}${body?.message ? `, ${body.message}` : ''}).`);
    console.error('State was saved — a rerun resumes where this stopped. Do NOT rerun immediately:');
    console.error('  1. Open instagram.com in your browser and complete any verification it shows.');
    console.error('  2. Wait a few hours. 3. Refresh IG_SESSION_ID/IG_DS_USER_ID from devtools. 4. Rerun.');
    process.exit(1);
  }
  return body;
}

/** item_type values the exporter knows how to shape into a NOWEB media
 *  marker. Anything else still exports fine (as an empty text line, same as
 *  an unrecognized type always has) but gets tallied so it's visible. */
const MAPPED_TYPES = new Set(['text', 'link', 'media', 'voice_media', 'animated_media']);

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
const oneToOne = threads.filter((t) => !t.is_group && (t.users?.length ?? 0) === 1);
const skipped = threads.length - oneToOne.length;
console.log(`Inbox: ${threads.length} thread(s) · skipped ${skipped} group thread(s)`);

// 2) walk each 1:1 thread back in time; append per completed thread (resume unit)
let total = 0;
let anyFromMe = false;
let unmappedCount = 0;
const unmappedTypes = new Set();
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
      if (raw) {
        lines.push(JSON.stringify(raw));
        if (raw.fromMe) anyFromMe = true;
        if (!MAPPED_TYPES.has(item.item_type)) { unmappedCount++; unmappedTypes.add(item.item_type); }
      } else if (SINCE_SEC) pastSince = true; // items are newest→oldest
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
if (unmappedCount > 0) {
  console.log(`${unmappedCount} message(s) of unmapped type(s) (${[...unmappedTypes].join(', ')}) exported as empty text`);
}
if (total > 0 && !anyFromMe) {
  console.log('\nWARNING: IG_DS_USER_ID matched no message — every line came out inbound. Check the ds_user_id cookie; a wrong value fabricates a 100% unanswered corpus.');
}
console.log('\nNext: node src/threads.mjs --session ig --no-net');
console.log('Tip: keep IG corpora in their own dir (WA_OUT_DIR=data/ig-history) so channels never mix.');
