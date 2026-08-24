/**
 * Read-only probe of a WAHA instance: which engine runs, which sessions exist
 * and how far back the synced history of each one goes. Phase 0 of the export:
 * it decides whether the session needs to be recreated with fullSync before
 * burning time (and a linked-device slot) on a full dump.
 *
 *   node --env-file=waha.env src/probe.mjs
 *
 * Required env:
 *   WAHA_API_KEY    X-Api-Key header of the instance
 *   WAHA_BASE_URL   Instance URL. No default on purpose: accidentally pointing
 *                   at the wrong instance is the expensive mistake.
 * Optional env:
 *   WAHA_BASIC_AUTH "user:password" if the instance sits behind nginx Basic Auth.
 *
 * Writes nothing: GETs only.
 */
const BASE = (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.WAHA_API_KEY ?? '';

if (!BASE) {
  console.error('Missing WAHA_BASE_URL (URL of the WAHA instance).');
  process.exit(1);
}
if (!API_KEY) {
  console.error('Missing WAHA_API_KEY (X-Api-Key header of the WAHA instance).');
  process.exit(1);
}

const AUTH_HEADERS = { 'X-Api-Key': API_KEY };
if (process.env.WAHA_BASIC_AUTH) {
  AUTH_HEADERS.Authorization = `Basic ${Buffer.from(process.env.WAHA_BASIC_AUTH, 'utf8').toString('base64')}`;
}

const DAY = 86400; // seconds; WAHA uses unix timestamps in seconds
const nowSec = Math.floor(Date.now() / 1000);

/** GET against WAHA. Returns the parsed body or an error marker — never throws. */
async function get(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { ...AUTH_HEADERS, Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const fmt = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');

/** Timestamp of a WAHA message: NOWEB/GOWS use `timestamp`, WEBJS sometimes `messageTimestamp`. */
function msgTs(m) {
  const raw = m?.timestamp ?? m?.messageTimestamp ?? m?._data?.t;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How far back the synced history goes. Instead of downloading everything, it
 * asks "is there any message older than N days?" for a few cutoffs. If 180
 * days comes back empty, fullSync is not active (engine default = ~3 months).
 */
async function historyDepth(session) {
  let deepest = 0;
  let oldestSeen = null;

  for (const days of [30, 90, 180, 270, 365, 550]) {
    const cutoff = nowSec - days * DAY;
    const r = await get(`/api/${session}/chats/all/messages?limit=1&downloadMedia=false&filter.timestamp.lte=${cutoff}`);
    if (!r.ok) return `  depth: could not measure (${r.error})`;
    const arr = Array.isArray(r.data) ? r.data : [];
    if (arr.length === 0) break; // nothing older: stop digging
    deepest = days;
    oldestSeen = msgTs(arr[0]) ?? oldestSeen;
  }

  if (deepest === 0) return '  depth: NOTHING older than 30 days (history is practically empty)';
  const hint = deepest <= 90 ? '  → looks like the engine default (~3 months): fullSync is NOT active.' : '';
  return `  depth: there are messages from ${deepest}+ days back${oldestSeen ? ` (seen: ${fmt(oldestSeen)})` : ''}${hint ? `\n${hint}` : ''}`;
}

const sessions = await get('/api/sessions?all=true');
if (!sessions.ok) {
  console.error(`Could not list sessions on ${BASE}: ${sessions.error}`);
  process.exit(1);
}

const list = Array.isArray(sessions.data) ? sessions.data : [];
console.log(`WAHA ${BASE} — ${list.length} session(s)\n`);

for (const s of list) {
  const store = s.config?.noweb?.store;
  console.log(`▸ ${s.name}`);
  console.log(`  status: ${s.status}   engine: ${s.engine?.engine ?? s.engine ?? '?'}   me: ${s.me?.id ?? '—'}`);
  console.log(`  store: ${store ? `enabled=${store.enabled} fullSync=${store.fullSync}` : 'no config (engine default)'}`);
  console.log(`  webhooks: ${(s.config?.webhooks ?? []).map((w) => w.url).join(', ') || '—'}`);

  if (s.status !== 'WORKING') {
    console.log('  (not WORKING: history not queried)\n');
    continue;
  }

  const chats = await get(`/api/${s.name}/chats?limit=5`);
  console.log(`  /chats: ${chats.ok ? `${(Array.isArray(chats.data) ? chats.data : []).length} returned (sample)` : `ERROR ${chats.error}`}`);

  const msgs = await get(`/api/${s.name}/chats/all/messages?limit=5&downloadMedia=false`);
  if (!msgs.ok) {
    // chats/all only exists on NOWEB and GOWS; on WEBJS this fails and you'd
    // have to go chat by chat.
    console.log(`  /chats/all/messages: ERROR ${msgs.error}`);
    console.log('  → without this endpoint the bulk dump is useless; a NOWEB session is required.\n');
    continue;
  }
  const arr = Array.isArray(msgs.data) ? msgs.data : [];
  console.log(`  /chats/all/messages: ${arr.length} returned`);
  if (arr.length) {
    const ts = arr.map(msgTs).filter((t) => t !== null);
    if (ts.length) console.log(`  sample range: ${fmt(Math.min(...ts))} → ${fmt(Math.max(...ts))}`);
    console.log(await historyDepth(s.name));
  }
  console.log('');
}
