/**
 * Minimal mock of the WAHA HTTP API, serving the committed fixture. Lets the
 * whole pipeline (probe → export → threads) run end-to-end without WhatsApp,
 * a WAHA instance, or the network. This is what `npm run demo` and the tests
 * talk to.
 *
 *   node fixtures/mock-waha.mjs [port]     (default 8321; prints "listening")
 *
 * Endpoints implemented (the only five the pipeline uses):
 *   GET /api/sessions?all=true
 *   GET /api/:session/chats?limit&offset
 *   GET /api/:session/chats/all/messages?limit&offset&filter.timestamp.lte
 *   GET /api/:session/lids/:lid
 *   GET /api/contacts?contactId=&session=
 *
 * Notes kept deliberately faithful to real WAHA behavior:
 *   - messages pagination does NOT promise short pages mean the end; the mock
 *     simply returns [] past the end (export stops after 3 empty pages).
 *   - the malformed JSONL line in the fixture cannot be represented in a JSON
 *     response, so the mock serves one line less than the fixture file has.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUMP = path.join(HERE, 'waha-dump');
const PORT = Number(process.argv[2] ?? process.env.MOCK_WAHA_PORT ?? 8321);
const SESSION_NAME = 'fixture';

const chats = JSON.parse(readFileSync(path.join(DUMP, 'chats.json'), 'utf8'));
const truth = JSON.parse(readFileSync(path.join(DUMP, 'lid-truth.json'), 'utf8'));
const messages = readFileSync(path.join(DUMP, 'messages.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

const sessions = [
  {
    name: SESSION_NAME,
    status: 'WORKING',
    engine: { engine: 'NOWEB' },
    me: { id: '5491100000001@c.us' },
    config: { noweb: { store: { enabled: true, fullSync: true } }, webhooks: [] },
  },
];

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const offset = Number(url.searchParams.get('offset') ?? 0);

  if (p === '/api/sessions') return json(res, sessions);

  if (p === '/api/contacts') {
    const id = url.searchParams.get('contactId') ?? '';
    if (id.endsWith('@lid')) {
      const t = truth.lids[id];
      if (!t) return json(res, { error: 'not found' }, 404);
      return json(res, { name: t.name, number: t.pn ? t.pn.replace('@c.us', '') : undefined });
    }
    const name = truth.contacts[id];
    return json(res, name ? { name } : {});
  }

  let m = p.match(/^\/api\/([^/]+)\/lids\/(.+)$/);
  if (m) {
    const t = truth.lids[decodeURIComponent(m[2])];
    if (!t || !t.pn) return json(res, {}, 404);
    return json(res, { pn: t.pn });
  }

  m = p.match(/^\/api\/([^/]+)\/chats\/all\/messages$/);
  if (m) {
    if (m[1] !== SESSION_NAME) return json(res, { error: 'unknown session' }, 404);
    const lte = url.searchParams.get('filter.timestamp.lte');
    const pool = lte ? messages.filter((x) => x.timestamp <= Number(lte)) : messages;
    return json(res, pool.slice(offset, offset + limit));
  }

  m = p.match(/^\/api\/([^/]+)\/chats$/);
  if (m) {
    if (m[1] !== SESSION_NAME) return json(res, { error: 'unknown session' }, 404);
    return json(res, chats.slice(offset, offset + limit));
  }

  json(res, { error: `mock-waha: unhandled ${req.method} ${p}` }, 404);
});

server.listen(PORT, () => {
  console.log(`mock-waha listening on http://localhost:${PORT} (session "${SESSION_NAME}", ${messages.length} messages)`);
});
