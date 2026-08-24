/**
 * Clean conversation corpus from the raw WAHA dump.
 * Phase 3 of the pipeline (phase 2 = src/export.mjs).
 *
 *   node --env-file=waha.env src/threads.mjs [--session <name>] [--no-net]
 *
 * What it does:
 *   1. Streams <out>/messages.jsonl line by line.
 *   2. Excludes group chats (@g.us).
 *   3. Resolves @lid identifiers to real numbers via WAHA, with an on-disk
 *      cache so hundreds of requests are not repeated.
 *   4. Normalizes phone numbers (src/lib/phone.mjs — WhatsApp-JID rules, with
 *      the AR mobile-9 collapse; foreign numbers stay untouched).
 *   5. Groups by normalized number, so a client that appears both as @lid and
 *      as @c.us counts as ONE thread.
 *   6. Joins against the optional CRM CSV (src/lib/crm.mjs).
 *   7. Computes per-thread metrics and writes threads.json, messages.csv and
 *      summary.json — schema_version 1, documented in docs/data-contract.md.
 *
 * Env (only for step 3; with --no-net none is needed):
 *   WAHA_BASE_URL, WAHA_API_KEY, WAHA_BASIC_AUTH ("user:password"), WAHA_SESSION
 * Configuration: wa-audit.config.json + env overrides (src/lib/config.mjs).
 *
 * Only reads from WAHA and writes local files.
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { normalizeJid, normalizeInput, display } from './lib/phone.mjs';
import { loadCrm, matchCrm } from './lib/crm.mjs';

// ---------------------------------------------------------------- config ---

const cfg = loadConfig();
const OUT_DIR = cfg.output.dir;
const MESSAGES_FILE = path.join(OUT_DIR, 'messages.jsonl');
const LID_CACHE_FILE = path.join(OUT_DIR, 'lid-cache.json');
const THREADS_FILE = path.join(OUT_DIR, 'threads.json');
const CSV_FILE = path.join(OUT_DIR, 'messages.csv');
const SUMMARY_FILE = path.join(OUT_DIR, 'summary.json');

const argv = process.argv.slice(2);
const argSession = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : null;
const SESSION = argSession ?? process.env.WAHA_SESSION ?? '';
const NO_NET = argv.includes('--no-net');
const CONCURRENCY = 6;
const RETRIES = 3;

const TZ_MIN = cfg.timezone.offsetMinutes;
const TZ_SUFFIX = cfg.timezone.utcOffset;

const INTERNAL_DOMAINS = cfg.business.internalEmailDomains.map((d) => d.toLowerCase());
const INTERNAL_NUMBERS = new Set(
  cfg.business.internalNumbers
    .map((n) => normalizeInput(n, cfg.phone.defaultCountry))
    .filter(Boolean),
);

const BASE = (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, '');
const HEADERS = { 'X-Api-Key': process.env.WAHA_API_KEY ?? '', Accept: 'application/json' };
if (process.env.WAHA_BASIC_AUTH) {
  HEADERS.Authorization = `Basic ${Buffer.from(process.env.WAHA_BASIC_AUTH, 'utf8').toString('base64')}`;
}

// Warnings travel into summary.json and from there into the report's
// methodology sheet: processing anomalies must reach the person reading the
// deliverable, not just a terminal nobody watches.
const warnings = [];
const warn = (msg) => {
  if (!warnings.includes(msg)) warnings.push(msg);
  console.warn(`  ! ${msg}`);
};

// ------------------------------------------------------------------ misc ---

const isoLocal = (ts) => new Date((ts + TZ_MIN * 60) * 1000).toISOString().replace('Z', TZ_SUFFIX);
const hourLocal = (ts) => new Date((ts + TZ_MIN * 60) * 1000).getUTCHours();

// Contract enum. Labels ("madrugada (00-05)") are presentation, not data.
function timeSlot(hour) {
  if (hour < 6) return 'early_morning';
  if (hour < 12) return 'morning';
  if (hour < 19) return 'afternoon';
  return 'evening';
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Message type: the dump was taken with downloadMedia=false, so `media` is
 *  null and the real type lives in _data.message (NOWEB shape). */
function messageType(m) {
  const msg = m?._data?.message ?? null;
  if (msg) {
    if (msg.imageMessage) return 'image';
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return msg.audioMessage.ptt ? 'voice_note' : 'audio';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage || msg.lottieStickerMessage) return 'sticker';
    if (msg.contactMessage || msg.contactsArrayMessage) return 'contact';
    if (msg.locationMessage) return 'location';
    if (msg.buttonsMessage) return 'buttons';
  }
  if (m.location) return 'location';
  if (Array.isArray(m.vCards) && m.vCards.length) return 'contact';
  if (m.hasMedia) return 'media';
  return 'text';
}

// -------------------------------------------------- @lid resolution ---

/** Resolve a @lid to phone number + contact name via WAHA. */
async function resolveLid(lid) {
  let pn = null;
  let name = null;
  try {
    const r = await fetchRetry(`${BASE}/api/${encodeURIComponent(SESSION)}/lids/${encodeURIComponent(lid)}`);
    if (r && r.ok) {
      const b = await r.json();
      if (typeof b?.pn === 'string') pn = b.pn;
    }
  } catch { /* best-effort */ }
  try {
    const r = await fetchRetry(
      `${BASE}/api/contacts?contactId=${encodeURIComponent(lid)}&session=${encodeURIComponent(SESSION)}`,
    );
    if (r && r.ok) {
      const b = await r.json();
      name = b?.name ?? b?.pushname ?? b?.verifiedName ?? null;
      if (!pn && typeof b?.number === 'string') pn = `${b.number}@c.us`;
    }
  } catch { /* best-effort */ }
  return { pn, name };
}

/** Name of a @c.us contact (no need to resolve the number, we already have it). */
async function resolveName(jid) {
  try {
    const r = await fetchRetry(
      `${BASE}/api/contacts?contactId=${encodeURIComponent(jid)}&session=${encodeURIComponent(SESSION)}`,
    );
    if (r && r.ok) {
      const b = await r.json();
      return { pn: null, name: b?.name ?? b?.pushname ?? b?.verifiedName ?? null };
    }
  } catch { /* best-effort */ }
  return { pn: null, name: null };
}

async function fetchRetry(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    // 4xx is not retried (it won't change); 5xx is.
    if (!res.ok && res.status >= 500 && attempt < RETRIES) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (attempt >= RETRIES) return null;
    await new Promise((r) => setTimeout(r, attempt * 800));
    return fetchRetry(url, attempt + 1);
  }
}

/** Runs `worker` over `items` with bounded concurrency. */
async function pool(items, limit, worker) {
  let i = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
      done++;
      if (done % 50 === 0) console.log(`    ${done}/${items.length}`);
    }
  });
  await Promise.all(runners);
}

// -------------------------------------------------------------- 1) read ---

console.log(`Reading ${MESSAGES_FILE}...`);
if (!existsSync(MESSAGES_FILE)) {
  console.error(`${MESSAGES_FILE} does not exist. Run src/export.mjs first.`);
  process.exit(1);
}

/** jid -> { jid, messages: [] } */
const byJid = new Map();
let linesRead = 0;
let malformed = 0;
let groupExcluded = 0;
let included = 0;
let noSender = 0;
const pushNames = new Map(); // jid -> pushName seen (almost always empty in practice)

await new Promise((resolve, reject) => {
  const rl = createInterface({ input: createReadStream(MESSAGES_FILE, 'utf8'), crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    linesRead++;
    let m;
    try { m = JSON.parse(line); } catch { malformed++; return; }
    const from = typeof m.from === 'string' ? m.from : '';
    if (!from) { noSender++; return; }
    if (from.includes('@g.us')) { groupExcluded++; return; }
    included++;
    let bucket = byJid.get(from);
    if (!bucket) { bucket = { jid: from, messages: [] }; byJid.set(from, bucket); }
    const pn = m?._data?.pushName;
    if (pn && !m.fromMe && !pushNames.has(from)) pushNames.set(from, String(pn));
    bucket.messages.push({
      ts: m.timestamp,
      direction: m.fromMe ? 'outbound' : 'inbound',
      type: messageType(m),
      text: typeof m.body === 'string' ? m.body : '',
      has_media: !!m.hasMedia,
    });
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});

console.log(`  ${linesRead} lines · ${groupExcluded} group messages excluded · ${included} included · ${byJid.size} 1-to-1 chats`);
if (malformed) warn(`${malformed} lines of messages.jsonl did not parse as JSON and were left out of the corpus`);
if (noSender) warn(`${noSender} messages without a "from" field were left out of the corpus`);

// --------------------------------------------------- 2) resolve @lid ---

const lids = [...byJid.keys()].filter((j) => j.endsWith('@lid'));
const cusJids = [...byJid.keys()].filter((j) => j.endsWith('@c.us'));
const otherJids = [...byJid.keys()].filter((j) => !j.endsWith('@lid') && !j.endsWith('@c.us'));
if (otherJids.length) warn(`${otherJids.length} JIDs with an unexpected suffix (e.g. ${otherJids[0]}); treated as raw numbers`);

/** jid -> { pn, name } */
let cache = {};
if (existsSync(LID_CACHE_FILE)) {
  try { cache = JSON.parse(await readFile(LID_CACHE_FILE, 'utf8')); } catch { cache = {}; }
  console.log(`Resolution cache: ${Object.keys(cache).length} entries in ${LID_CACHE_FILE}`);
}

const pendingLids = lids.filter((l) => !(l in cache));
const pendingNames = cusJids.filter((j) => !(j in cache));

if (NO_NET) {
  if (pendingLids.length) warn(`--no-net: ${pendingLids.length} @lid left unresolved (WAHA was not queried)`);
} else if (!BASE || !HEADERS['X-Api-Key'] || !SESSION) {
  warn('Missing WAHA_BASE_URL / WAHA_API_KEY / session: no new @lid was resolved');
} else {
  if (pendingLids.length) {
    console.log(`Resolving ${pendingLids.length} @lid against WAHA (session "${SESSION}", concurrency ${CONCURRENCY})...`);
    await pool(pendingLids, CONCURRENCY, async (lid) => { cache[lid] = await resolveLid(lid); });
    await writeFile(LID_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  }
  if (pendingNames.length) {
    console.log(`Fetching names for ${pendingNames.length} @c.us contacts...`);
    await pool(pendingNames, CONCURRENCY, async (jid) => { cache[jid] = await resolveName(jid); });
  }
  await writeFile(LID_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`  cache saved to ${LID_CACHE_FILE}`);
}

let lidsResolved = 0;
let lidsUnresolved = 0;
for (const lid of lids) {
  if (normalizeJid(cache[lid]?.pn ?? '')) lidsResolved++;
  else lidsUnresolved++;
}
console.log(`  @lid: ${lids.length} distinct · ${lidsResolved} resolved · ${lidsUnresolved} unresolved`);

// ------------------------------------------- 3) unify by number ---

/** key -> { phone, jids, names, messages } */
const convs = new Map();
let merges = 0;

/** WhatsApp system pseudo-contacts, not clients. */
const SYSTEM = new Set(['0@c.us', 'status@broadcast']);

for (const [jid, bucket] of byJid) {
  if (SYSTEM.has(jid)) {
    warn(`${jid} is a WhatsApp system pseudo-contact (${bucket.messages.length} message/s); flagged with is_system=true`);
  }
  const isLid = jid.endsWith('@lid');
  const rawNumber = isLid ? (cache[jid]?.pn ?? '') : jid.split('@')[0];
  const phone = normalizeJid(rawNumber);
  // An unresolved @lid can NOT be normalized: its digits are not a phone
  // number. It gets its own thread and a flag — never an invented number.
  const key = phone ?? `lid:${jid.split('@')[0]}`;

  let c = convs.get(key);
  if (!c) {
    c = { key, phone, jids: [], origins: new Set(), names: [], messages: [], unresolved_lid: !phone, is_system: SYSTEM.has(jid) };
    convs.set(key, c);
  }
  const origin = isLid ? 'lid' : 'c.us';
  if (phone && c.origins.size && !c.origins.has(origin)) merges++;
  c.origins.add(origin);
  c.jids.push(jid);
  const name = cache[jid]?.name || pushNames.get(jid) || null;
  if (name) c.names.push(name);
  c.messages.push(...bucket.messages);
}

console.log(`  ${convs.size} threads · ${merges} @lid + @c.us merges`);

// ------------------------------------------------------ 4) CRM (optional) ---

let crm = null;
let crmMatches = 0;
if (cfg.crm.file) {
  try {
    crm = loadCrm(cfg.crm.file, cfg.phone.defaultCountry);
    console.log(`CRM: ${crm.rows.length} contacts, ${crm.byNumber.size} distinct normalized numbers`);
  } catch (e) {
    warn(`Could not read CRM file ${cfg.crm.file}: ${String(e).slice(0, 120)}`);
    crm = null;
  }
} else {
  warn('No CRM file configured (crm.file): the corpus carries no CRM join (crm_available=false)');
}

// ---------------------------------------------------------- 5) metrics ---

function computeMetrics(msgs) {
  const ordered = [...msgs].sort((a, b) => a.ts - b.ts);
  const inbound = ordered.filter((m) => m.direction === 'inbound').length;
  const outbound = ordered.length - inbound;
  const withMedia = ordered.filter((m) => m.has_media).length;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  // Response time: for each burst of consecutive inbound messages, how long
  // until the first outbound reply. A burst that never got a reply doesn't count.
  const responses = [];
  let open = null;
  for (const m of ordered) {
    if (m.direction === 'inbound') { if (open === null) open = m.ts; }
    else if (open !== null) { responses.push((m.ts - open) / 60); open = null; }
  }

  const hours = new Map();
  const slots = new Map();
  for (const m of ordered) {
    const h = hourLocal(m.ts);
    hours.set(h, (hours.get(h) ?? 0) + 1);
    const s = timeSlot(h);
    slots.set(s, (slots.get(s) ?? 0) + 1);
  }
  const topSlot = [...slots.entries()].sort((a, b) => b[1] - a[1])[0];
  const topHour = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];

  const med = median(responses);
  return {
    total: ordered.length,
    inbound,
    outbound,
    with_media: withMedia,
    first_message: isoLocal(first.ts),
    last_message: isoLocal(last.ts),
    duration_days: Math.round(((last.ts - first.ts) / 86400) * 10) / 10,
    responses_measured: responses.length,
    median_response_min: med === null ? null : Math.round(med * 10) / 10,
    unanswered: last.direction === 'inbound',
    top_time_slot: topSlot ? topSlot[0] : null,
    peak_hour: topHour ? topHour[0] : null,
    two_way: inbound > 0 && outbound > 0,
  };
}

const threads = [];
let internal = 0;
for (const c of convs.values()) {
  const msgs = [...c.messages].sort((a, b) => a.ts - b.ts);
  const crmRow = c.phone ? matchCrm(crm, c.phone) : null;
  if (crmRow) crmMatches++;
  const name = c.names.find(Boolean) ?? null;
  const email = (crmRow?.email ?? '').toLowerCase();
  const isInternal =
    (!!email && INTERNAL_DOMAINS.some((d) => email.includes('@' + d))) ||
    (!!c.phone && INTERNAL_NUMBERS.has(c.phone));
  if (isInternal) internal++;
  threads.push({
    thread_id: c.phone ? c.phone.replace('+', '') : `lid_${c.key.slice(4)}`,
    phone: c.phone,
    phone_display: c.phone ? display(c.phone) : `@lid ${c.key.slice(4)} (unresolved)`,
    jids: c.jids,
    contact_name: name,
    unresolved_lid: c.unresolved_lid,
    is_system: !!c.is_system,
    is_internal: isInternal,
    crm: crmRow
      ? {
          name: crmRow.name,
          contact: crmRow.contact,
          phone: crmRow.phone,
          whatsapp: crmRow.whatsapp,
          email: crmRow.email,
          segment: crmRow.segment,
          stage: crmRow.stage,
          location: crmRow.location,
        }
      : null,
    metrics: computeMetrics(msgs),
    messages: msgs.map((m) => ({
      ts: m.ts,
      iso: isoLocal(m.ts),
      direction: m.direction,
      type: m.type,
      text: m.text,
      has_media: m.has_media,
    })),
  });
}

threads.sort((a, b) => b.metrics.total - a.metrics.total || a.thread_id.localeCompare(b.thread_id));

// ------------------------------------------------------ 6) verification ---

const messagesInThreads = threads.reduce((a, t) => a + t.metrics.total, 0);
const expectedTotal = linesRead;
if (messagesInThreads + groupExcluded + malformed + noSender !== expectedTotal) {
  warn(
    `Count mismatch: ${messagesInThreads} in threads + ${groupExcluded} group + ` +
    `${malformed} malformed + ${noSender} without sender != ${expectedTotal} lines read`,
  );
}
const ids = new Set();
const dupIds = [];
for (const t of threads) { if (ids.has(t.thread_id)) dupIds.push(t.thread_id); ids.add(t.thread_id); }
if (dupIds.length) warn(`duplicate thread_ids: ${dupIds.slice(0, 5).join(', ')}`);

// ---------------------------------------------------------- 7) outputs ---

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  THREADS_FILE,
  JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString(), session: SESSION || null, threads }, null, 2),
  'utf8',
);

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = ['﻿thread_id,phone,iso,direction,type,text'];
for (const t of threads) {
  for (const m of t.messages) {
    // Text is flattened: the CSV is for skimming, the faithful text is in threads.json.
    csv.push([t.thread_id, t.phone ?? '', m.iso, m.direction, m.type, m.text.replace(/\r?\n/g, ' | ')].map(q).join(','));
  }
}
await writeFile(CSV_FILE, csv.join('\n'), 'utf8');

const twoWay = threads.filter((t) => t.metrics.two_way).length;
const unanswered = threads.filter((t) => t.metrics.unanswered).length;
const medians = threads.map((t) => t.metrics.median_response_min).filter((v) => v !== null);

const summary = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: MESSAGES_FILE,
  session: SESSION || null,
  lines_read: linesRead,
  group_messages_excluded: groupExcluded,
  malformed_messages: malformed,
  messages_without_sender: noSender,
  messages_included: messagesInThreads,
  one_to_one_chats: byJid.size,
  lid_jids: lids.length,
  cus_jids: cusJids.length,
  other_jids: otherJids.length,
  lids_resolved: lidsResolved,
  lids_unresolved: lidsUnresolved,
  lid_cus_merges: merges,
  multi_jid_threads: threads.filter((t) => t.jids.length > 1).length,
  threads: threads.length,
  two_way_threads: twoWay,
  unanswered_threads: unanswered,
  threads_with_contact_name: threads.filter((t) => t.contact_name).length,
  crm_available: !!crm,
  crm_matches: crmMatches,
  internal_threads: internal,
  inbound: threads.reduce((a, t) => a + t.metrics.inbound, 0),
  outbound: threads.reduce((a, t) => a + t.metrics.outbound, 0),
  messages_with_media: threads.reduce((a, t) => a + t.metrics.with_media, 0),
  global_median_response_min: medians.length ? Math.round(median(medians) * 10) / 10 : null,
  count_check_ok: messagesInThreads + groupExcluded + malformed + noSender === expectedTotal,
  duplicate_thread_ids: dupIds.length,
  warnings,
};
await writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf8');

console.log(`\n✓ ${threads.length} threads → ${THREADS_FILE}`);
console.log(`✓ ${messagesInThreads} messages → ${CSV_FILE}`);
console.log(`✓ summary → ${SUMMARY_FILE}`);
console.log(`\nVerification: ${messagesInThreads} + ${groupExcluded} group + ${malformed} malformed + ${noSender} without sender = ${messagesInThreads + groupExcluded + malformed + noSender} (expected ${expectedTotal}) → ${summary.count_check_ok ? 'OK' : 'MISMATCH'}`);
console.log(`duplicate thread_ids: ${dupIds.length}`);
console.log('\nTop 5 threads by message count:');
for (const t of threads.slice(0, 5)) {
  console.log(`  ${t.phone_display ?? t.thread_id}  —  ${t.metrics.total} messages`);
}
if (warnings.length) {
  console.log('\nWarnings:');
  for (const a of warnings) console.log(`  - ${a}`);
}
