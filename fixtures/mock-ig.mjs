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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv[2];
const PORT = (portArg && !portArg.startsWith('--')) ? Number(portArg) : 8439;
const chAt = process.argv.indexOf('--challenge-after');
const CHALLENGE_AFTER = chAt > -1 ? Number(process.argv[chAt + 1]) : Infinity;

export const OWN_ID = '99000001';
const US = { maria: { pk: '77000001', username: 'maria.deco', full_name: 'María Decoraciones' },
             carlos: { pk: '77000002', username: 'carlos_mueble', full_name: 'Carlos Muebles' },
             lucia:  { pk: '77000003', username: 'lucia.eventos', full_name: 'Lucía Eventos' } };

const us = (ts) => String(ts * 1_000_000); // seconds → microsecond string

// Three 1:1 threads + one group (the exporter must skip the group).
export function igFixture() {
  let iid = 0;
  const item = (userId, tsSec, type, extra = {}) =>
    ({ item_id: `it_${++iid}`, user_id: userId, timestamp: us(tsSec), item_type: type, ...extra });

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
}
