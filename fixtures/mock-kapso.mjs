/**
 * Minimal mock of the Kapso Meta-proxy API (official WhatsApp Business path),
 * serving the committed synthetic fixture converted on the fly to the Cloud
 * API message shape. One synthetic corpus feeds every source.
 *
 *   node fixtures/mock-kapso.mjs [port]     (default 8435; prints "listening")
 *
 * Implements the one endpoint the Kapso exporter uses:
 *   GET /:phone_number_id/messages?limit&after&fields=kapso()
 * with cursor pagination like the real API (paging.cursors.after).
 *
 * Eligibility mirrors what an official-API store could contain: 1-to-1
 * threads with a real phone number. @lid, @g.us, system pseudo-contacts,
 * unparseable lines and no-sender messages simply don't exist there.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] ?? 8435);

const EXCLUDE = new Set(['0@c.us', 'status@broadcast']);

function cloudType(m) {
  const msg = m._data?.message ?? null;
  if (msg) {
    if (msg.imageMessage) return 'image';
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return 'audio';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage) return 'sticker';
    if (msg.contactMessage || msg.contactsArrayMessage) return 'contacts';
    if (msg.locationMessage) return 'location';
    if (msg.buttonsMessage) return 'interactive';
  }
  if (m.location) return 'location';
  if (Array.isArray(m.vCards) && m.vCards.length) return 'contacts';
  if (m.hasMedia) return 'image';
  return 'text';
}

export function eligibleFixtureMessages() {
  const raw = readFileSync(path.join(HERE, 'waha-dump', 'messages.jsonl'), 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.from !== 'string' || !m.from.endsWith('@c.us') || EXCLUDE.has(m.from)) continue;
    out.push(m);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

const messages = eligibleFixtureMessages().map((m) => ({
  id: m.id,
  timestamp: String(m.timestamp),
  type: cloudType(m),
  from: m.fromMe ? '15550000001' : m.from.split('@')[0],
  to: m.fromMe ? m.from.split('@')[0] : '15550000001',
  ...(m.body ? { text: { body: m.body } } : {}),
  kapso: {
    direction: m.fromMe ? 'outbound' : 'inbound',
    status: 'delivered',
    phone_number: '+' + m.from.split('@')[0],
    has_media: !!m.hasMedia,
    whatsapp_conversation_id: m.from,
    contact_name: m._data?.pushName ?? null,
    content: m.body ?? '',
  },
}));

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/([^/]+)\/messages$/);
  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!match) return json({ error: `mock-kapso: unhandled ${req.method} ${url.pathname}` }, 404);
  if (req.headers['x-api-key'] !== 'test') return json({ error: 'invalid api key' }, 401);

  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
  const after = url.searchParams.get('after');
  const start = after ? Number(Buffer.from(after, 'base64').toString('utf8')) : 0;
  const page = messages.slice(start, start + limit);
  const next = start + page.length;
  json({
    data: page,
    paging: { cursors: next < messages.length ? { after: Buffer.from(String(next)).toString('base64') } : {} },
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`mock-kapso listening on http://localhost:${PORT} (${messages.length} messages)`);
  });
}
