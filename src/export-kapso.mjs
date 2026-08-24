/**
 * Kapso exporter — the OFFICIAL WhatsApp Business Platform path.
 * Phase 2 alternative to src/export.mjs (WAHA): pulls the stored message
 * history of a Kapso phone number (https://kapso.ai, Meta Cloud API provider)
 * and writes the exact same messages.jsonl shape the corpus phase consumes,
 * so threads/analyze/report run unchanged.
 *
 *   node --env-file=kapso.env src/export-kapso.mjs
 *
 * Required env:
 *   KAPSO_API_KEY          project API key (X-API-Key header)
 *   KAPSO_PHONE_NUMBER_ID  the WhatsApp phone number id in Kapso
 * Optional env:
 *   KAPSO_BASE_URL         default https://api.kapso.ai/meta/whatsapp/v24.0
 *   KAPSO_SINCE            ISO 8601: only messages on/after this time
 *   WA_OUT_DIR             default data/wa-history
 *
 * Honesty notes, also printed at the end of every run:
 *   - The official platform has no retroactive backfill: history covers what
 *     flowed through Kapso since the number was connected there.
 *   - The Cloud API distinguishes audio but not voice notes; audio messages
 *     are typed "audio".
 *   - This path needs no ToS disclaimer: it is the official API.
 *
 * Not resumable by design: each run rewrites messages.jsonl from Kapso's
 * cursor-paginated store (the store itself is the durable copy).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';

const BASE = (process.env.KAPSO_BASE_URL ?? 'https://api.kapso.ai/meta/whatsapp/v24.0').replace(/\/+$/, '');
const API_KEY = process.env.KAPSO_API_KEY ?? '';
const PHONE_ID = process.env.KAPSO_PHONE_NUMBER_ID ?? '';
const SINCE = process.env.KAPSO_SINCE ?? '';
const OUT_DIR = loadConfig().output.dir;

if (!API_KEY || !PHONE_ID) {
  console.error('Usage: node --env-file=kapso.env src/export-kapso.mjs');
  if (!API_KEY) console.error('  missing KAPSO_API_KEY');
  if (!PHONE_ID) console.error('  missing KAPSO_PHONE_NUMBER_ID');
  process.exit(1);
}

const MESSAGES_FILE = path.join(OUT_DIR, 'messages.jsonl');

async function get(pathname, attempt = 1) {
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') ?? attempt * 2) * 1000;
      console.warn(`  ! 429 rate limited — retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      return get(pathname, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, attempt * 2000));
    return get(pathname, attempt + 1);
  }
}

// Map a Cloud API message type onto the NOWEB _data.message shape the corpus
// phase already classifies. Unknown types fall through as text.
function messageShape(type) {
  switch (type) {
    case 'image': return { imageMessage: {} };
    case 'video': return { videoMessage: {} };
    case 'audio': return { audioMessage: { ptt: false } }; // Cloud API doesn't flag voice notes
    case 'document': return { documentMessage: {} };
    case 'sticker': return { stickerMessage: {} };
    case 'location': return { locationMessage: {} };
    case 'contacts': return { contactMessage: {} };
    case 'interactive': return { buttonsMessage: {} };
    default: return null; // text, template, reaction, unknown -> plain text
  }
}

function toRawLine(m) {
  const k = m.kapso ?? {};
  const digits = String(k.phone_number ?? '').replace(/\D/g, '');
  if (!digits) return null; // no counterparty number: the corpus can't thread it
  const shape = messageShape(m.type);
  const out = {
    id: m.id,
    timestamp: Number(m.timestamp),
    // Counterparty JID in `from` for BOTH directions — the shape the corpus
    // phase groups on (same convention as WAHA NOWEB).
    from: `${digits}@c.us`,
    fromMe: k.direction === 'outbound',
    body: m.text?.body ?? k.content ?? '',
    hasMedia: !!k.has_media,
    _data: {},
  };
  if (k.contact_name && k.direction === 'inbound') out._data.pushName = String(k.contact_name);
  if (shape) out._data.message = shape;
  return out;
}

await mkdir(OUT_DIR, { recursive: true });

console.log(`Exporting stored history for phone number ${PHONE_ID} from Kapso (official API)...`);
const lines = [];
let dropped = 0;
let cursor = null;
for (;;) {
  // Explicit kapso subfields: verified against the live API, an EMPTY
  // kapso() strips the extension entirely (undocumented sharp edge).
  const qs = new URLSearchParams({
    limit: '100',
    fields: 'kapso(direction,phone_number,has_media,contact_name,content,whatsapp_conversation_id)',
  });
  if (SINCE) qs.set('since', SINCE);
  if (cursor) qs.set('after', cursor);
  const page = await get(`/${encodeURIComponent(PHONE_ID)}/messages?${qs}`);
  const data = Array.isArray(page.data) ? page.data : [];
  for (const m of data) {
    const raw = toRawLine(m);
    if (raw) lines.push(JSON.stringify(raw));
    else dropped++;
  }
  console.log(`  messages: ${lines.length}`);
  cursor = page.paging?.cursors?.after ?? null;
  if (!cursor || data.length === 0) break;
}

await writeFile(MESSAGES_FILE, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

console.log(`\n✓ ${lines.length} messages → ${MESSAGES_FILE}`);
if (dropped) console.log(`  (${dropped} message/s without a counterparty phone number were skipped)`);
console.log('\nNext: node src/threads.mjs --session kapso --no-net');
console.log('(no @lid resolution needed: the official API always carries real numbers)');
console.log('\nCoverage note: the official platform has no retroactive backfill — this');
console.log('history covers what flowed through Kapso since the number was connected there.');
