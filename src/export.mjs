/**
 * Raw dump of the WhatsApp history of one WAHA session to disk.
 * Phase 2 of the export. Transforms NOTHING: it writes WAHA's response as-is,
 * so a parsing bug (phase 3) never forces a re-scrape. The dump is the fragile
 * part — it depends on a live session and a linked-device slot.
 *
 *   node --env-file=waha.env src/export.mjs <session-name>
 *
 * Required env:
 *   WAHA_API_KEY    X-Api-Key header
 *   WAHA_BASE_URL   Instance URL. No default on purpose: dumping from the
 *                   wrong instance is the expensive mistake.
 * Optional env:
 *   WAHA_BASIC_AUTH "user:password" if nginx Basic Auth sits in front
 *   WA_OUT_DIR      default data/wa-history (gitignored: these are real chats)
 *
 * Resumable: if messages.jsonl already exists, it continues from where it left off.
 * Only reads from WAHA and writes local files.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.WAHA_API_KEY ?? '';
const AUTH_HEADERS = { 'X-Api-Key': API_KEY };
if (process.env.WAHA_BASIC_AUTH) {
  AUTH_HEADERS.Authorization = `Basic ${Buffer.from(process.env.WAHA_BASIC_AUTH, 'utf8').toString('base64')}`;
}
const OUT_DIR = process.env.WA_OUT_DIR ?? 'data/wa-history';
const SESSION = process.argv[2];

const PAGE = 500;
// WAHA's docs warn that a short batch does not mean the end: keep incrementing
// the offset. We only stop after several consecutive empty pages.
const EMPTY_PAGES_TO_STOP = 3;

if (!BASE || !API_KEY || !SESSION) {
  console.error('Usage: node --env-file=waha.env src/export.mjs <session-name>');
  if (!BASE) console.error('  missing WAHA_BASE_URL');
  if (!API_KEY) console.error('  missing WAHA_API_KEY');
  if (!SESSION) console.error('  missing the session name (argument 1)');
  process.exit(1);
}

const MESSAGES_FILE = path.join(OUT_DIR, 'messages.jsonl');
const CHATS_FILE = path.join(OUT_DIR, 'chats.json');

/** GET with retries: the dump takes long and a transient failure must not lose it all. */
async function get(pathname, attempt = 1) {
  try {
    const res = await fetch(`${BASE}${pathname}`, { headers: { ...AUTH_HEADERS, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 3) throw err;
    const wait = attempt * 2000;
    console.warn(`  ! ${String(err).slice(0, 120)} — retry ${attempt}/3 in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
    return get(pathname, attempt + 1);
  }
}

const asArray = (d) => (Array.isArray(d) ? d : []);

/** How many lines are already dumped — the offset to resume from. */
async function alreadyDumped() {
  if (!existsSync(MESSAGES_FILE)) return 0;
  const txt = await readFile(MESSAGES_FILE, 'utf8');
  return txt.split('\n').filter((l) => l.trim()).length;
}

await mkdir(OUT_DIR, { recursive: true });

// --- chats (metadata) ---
console.log(`Dumping chats of "${SESSION}"...`);
const chats = [];
for (let offset = 0; ; offset += PAGE) {
  const page = asArray(await get(`/api/${SESSION}/chats?limit=${PAGE}&offset=${offset}`));
  if (page.length === 0) break;
  chats.push(...page);
  console.log(`  chats: ${chats.length}`);
  if (page.length < PAGE) break;
}
await writeFile(CHATS_FILE, JSON.stringify(chats, null, 2), 'utf8');
console.log(`✓ ${chats.length} chats → ${CHATS_FILE}\n`);

// --- messages ---
// Resume by line count. Assumes WAHA paginates in stable order; if a resumed
// dump looks odd, delete messages.jsonl and run clean.
const startAt = await alreadyDumped();
if (startAt) console.log(`Resuming: ${startAt} messages already dumped.`);

console.log(`Dumping messages of "${SESSION}"...`);
let total = startAt;
let emptyStreak = 0;

for (let offset = startAt; ; offset += PAGE) {
  const page = asArray(
    await get(`/api/${SESSION}/chats/all/messages?limit=${PAGE}&offset=${offset}&downloadMedia=false`),
  );

  if (page.length === 0) {
    emptyStreak++;
    if (emptyStreak >= EMPTY_PAGES_TO_STOP) break;
    console.log(`  (empty page ${emptyStreak}/${EMPTY_PAGES_TO_STOP} at offset ${offset}, continuing)`);
    continue;
  }
  emptyStreak = 0;

  await appendFile(MESSAGES_FILE, page.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  total += page.length;
  console.log(`  messages: ${total}`);
}

console.log(`\n✓ ${total} messages → ${MESSAGES_FILE}`);
console.log(`\nOnce you've verified the dump, free the linked-device slot:`);
console.log(`  curl -X DELETE -H "X-Api-Key: $WAHA_API_KEY" ${BASE}/api/sessions/${SESSION}`);
