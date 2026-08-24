/**
 * Deterministic synthetic fixture generator. No dependencies, no Date.now():
 * running it twice produces byte-identical output (CI regenerates and diffs).
 *
 *   node fixtures/generate.mjs
 *
 * Emits into fixtures/waha-dump/:
 *   messages.jsonl     raw WAHA-shaped dump, incl. deliberate edge cases
 *   chats.json         chat metadata (what export.mjs would write)
 *   lid-truth.json     ground truth for @lid resolution + contact names
 *                      (consumed by mock-waha.mjs, and to prefill lid-cache)
 *   crm-contacts.json  synthetic CRM in the ad-hoc format threads.mjs reads
 *
 * Every phone number, name and quote in here is invented.
 *
 * Edge cases exercised (each one is an expected counter in test/golden):
 *   - AR mobile with and without the optional "9"  -> same normalization
 *   - foreign numbers (CL/BR/ES)                   -> NOT forced to +549
 *   - @lid + @c.us pair of the same person         -> 1 merge
 *   - @lid that resolves to a fresh number          -> resolved
 *   - @lid with no resolution                       -> own conversation, flagged
 *   - 0@c.us and status@broadcast                   -> system pseudo-contacts
 *   - one @g.us group chat                          -> excluded
 *   - one JID with an unexpected suffix             -> treated as raw number
 *   - one malformed JSONL line                      -> counted, not fatal
 *   - one message without "from"                    -> counted, not fatal
 *   - every NOWEB media shape                       -> message-type mapping
 *   - a text > 32,767 chars                         -> XLSX cell truncation
 *   - text containing "</row>" and "<c "            -> SST post-process safety
 *   - a control character in a body                 -> cell sanitization
 *   - months with residual traffic before the real activity window
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'waha-dump');

// Seeded PRNG (mulberry32) — the only source of "randomness".
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/** Unix seconds for a fixed UTC moment. */
const ts = (y, mo, d, h = 12, mi = 0) => Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000);

let msgSeq = 0;
function msg(from, fromMe, t, body, extra = {}) {
  const { pushName, message, hasMedia, location, vCards, noFrom } = extra;
  const m = {
    id: `false_${from}_${(++msgSeq).toString(16).padStart(8, '0')}`,
    timestamp: t,
    from,
    fromMe: !!fromMe,
    body: body ?? '',
    hasMedia: !!hasMedia,
    _data: {},
  };
  if (pushName) m._data.pushName = pushName;
  if (message) m._data.message = message;
  if (location) m.location = location;
  if (vCards) m.vCards = vCards;
  if (noFrom) delete m.from;
  return m;
}

// Repeated quote template: exercises the shared-string table (bookSST) and is
// realistic — businesses paste the same quotation blocks over and over.
const QUOTE_TEMPLATE =
  'COTIZACIÓN N.º {n}\nProducto: cinta transportadora modelo CT-{n}\nPrecio unitario: USD {p}\n' +
  'Plazo de entrega: 15 días hábiles\nValidez de la oferta: 7 días\nFormas de pago: 50% anticipo, 50% contra entrega';
const quote = (n, p) => QUOTE_TEMPLATE.replace(/\{n\}/g, String(n)).replace(/\{p\}/g, String(p));

const INBOUND_LINES = [
  'Hola! Precio de la cinta de 60cm?',
  'Buenas, ¿tienen stock?',
  'Me pasás la cotización de nuevo?',
  '¿Hacen envíos al interior?',
  'Dale, perfecto, gracias',
  '¿Cuánto sale el modelo grande?',
  'Necesito 3 unidades para la semana que viene',
  '¿Aceptan tarjeta?',
];
const OUTBOUND_LINES = [
  'Hola! Sí, tenemos stock. Te paso precios.',
  'Buenas tardes, ¿cómo estás? Ya te cotizo.',
  'Sí, hacemos envíos a todo el país.',
  'Quedo a disposición por cualquier consulta.',
  'Te confirmo mañana a primera hora.',
];

const lines = []; // strings, one per JSONL line
const addMsg = (...a) => lines.push(JSON.stringify(msg(...a)));

// --------------------------------------------------------------- personas ---

// 1+2) Ana: AR mobile, appears BOTH as @c.us and as @lid (same person) -> merge.
const ANA_CUS = '5491155501234@c.us';
const ANA_LID = '200000000000001@lid';
addMsg(ANA_CUS, false, ts(2026, 5, 4, 13, 2), 'Hola! Precio de la cinta de 60cm?', { pushName: 'Ana G.' });
addMsg(ANA_CUS, true, ts(2026, 5, 4, 13, 9), 'Hola Ana! Sí, te paso: ' );
addMsg(ANA_CUS, true, ts(2026, 5, 4, 13, 10), quote(101, 450));
addMsg(ANA_CUS, false, ts(2026, 5, 4, 14, 30), 'Dale, perfecto, gracias');
addMsg(ANA_LID, false, ts(2026, 6, 11, 10, 15), 'Hola de nuevo! Al final necesito dos', { pushName: 'Ana G.' });
addMsg(ANA_LID, true, ts(2026, 6, 11, 10, 40), 'Genial, te armo la orden.');
// Residual old-month traffic (before the real activity window):
addMsg(ANA_CUS, false, ts(2025, 10, 3, 15, 0), 'Hola, consulta por bombas de agua');
addMsg(ANA_CUS, true, ts(2025, 12, 18, 11, 0), 'Feliz año! Cerramos del 24 al 2.');

// 3) Bruno: AR without the mobile "9" in the JID -> normalizes to the same +549 shape.
const BRUNO = '541122334455@c.us';
addMsg(BRUNO, false, ts(2026, 5, 20, 16, 45), '¿Hacen envíos al interior?', { pushName: 'Bruno' });
addMsg(BRUNO, true, ts(2026, 5, 20, 17, 20), 'Sí, hacemos envíos a todo el país.');
addMsg(BRUNO, false, ts(2026, 5, 21, 9, 5), 'Buenísimo. ¿Cuánto a Rosario?');
addMsg(BRUNO, true, ts(2026, 5, 21, 9, 55), 'USD 30 por bulto. Te paso la cotización:');
addMsg(BRUNO, true, ts(2026, 5, 21, 9, 56), quote(102, 450));
addMsg(BRUNO, false, ts(2026, 2, 12, 10, 0), 'consulta vieja suelta'); // residual month

// 4-6) Foreigners: must stay E.164 as-is, never forced to +549.
addMsg('56912345678@c.us', false, ts(2026, 6, 2, 18, 20), 'Hola, escribo desde Chile. ¿Exportan?', { pushName: 'Camila CL' });
addMsg('56912345678@c.us', true, ts(2026, 6, 3, 9, 30), 'Hola Camila! Sí, exportamos vía courier.');
addMsg('5511987654321@c.us', false, ts(2026, 6, 9, 20, 10), 'Oi! Vocês entregam no Brasil?');
addMsg('5511987654321@c.us', true, ts(2026, 6, 10, 8, 45), 'Olá! Sim, com frete internacional.');
addMsg('34612345678@c.us', false, ts(2026, 7, 1, 6, 50), 'Buenas, consulto desde España por el modelo XL');
// (never answered -> sin_responder)

// 7) A @lid that resolves to a fresh number nobody else uses.
const LID_OK = '200000000000002@lid';
addMsg(LID_OK, false, ts(2026, 7, 7, 11, 25), 'Me pasás la cotización de nuevo?', { pushName: 'Lidia' });
addMsg(LID_OK, true, ts(2026, 7, 7, 11, 50), quote(103, 780));

// 8) A @lid that does NOT resolve: own conversation, flagged, never a made-up number.
const LID_BAD = '300000000000003@lid';
addMsg(LID_BAD, false, ts(2026, 7, 15, 23, 40), 'Hola? Atienden a esta hora?');
addMsg(LID_BAD, true, ts(2026, 7, 16, 8, 30), 'Buen día! Atendemos de 8 a 18.');

// 9) Internal line of the business (CRM email on an internal domain).
const INTERNA = '5491199887766@c.us';
addMsg(INTERNA, false, ts(2026, 6, 5, 9, 0), 'Che, ¿llegó el pedido del depósito?', { pushName: 'Depósito' });
addMsg(INTERNA, true, ts(2026, 6, 5, 9, 2), 'Sí, entró hoy a la mañana.');

// 10-11) System pseudo-contacts.
addMsg('0@c.us', false, ts(2026, 6, 20, 3, 0), 'Actualización de seguridad de WhatsApp');
addMsg('status@broadcast', false, ts(2026, 7, 2, 12, 0), '');

// 12) Group chat: excluded from the corpus (5 messages).
const GRUPO = '120363000000000001@g.us';
for (let i = 0; i < 5; i++) {
  addMsg(GRUPO, i % 2 === 0, ts(2026, 6, 15, 10, i * 7), `mensaje de grupo ${i + 1}`);
}

// 13) JID with an unexpected suffix: treated as a raw number.
addMsg('990000001@weird', false, ts(2026, 7, 22, 15, 0), 'hola?');
addMsg('990000001@weird', true, ts(2026, 7, 22, 15, 5), 'Hola! ¿En qué te ayudo?');

// 14) Media fest: one message per NOWEB shape (type mapping coverage).
const MEDIA = '5491144556677@c.us';
let mh = 9;
const mediaCases = [
  [{ message: { imageMessage: {} }, hasMedia: true }, ''],
  [{ message: { videoMessage: {} }, hasMedia: true }, ''],
  [{ message: { audioMessage: { ptt: true } }, hasMedia: true }, ''],   // voice note
  [{ message: { audioMessage: { ptt: false } }, hasMedia: true }, ''],  // plain audio
  [{ message: { documentMessage: {} }, hasMedia: true }, 'lista-de-precios.pdf'],
  [{ message: { stickerMessage: {} }, hasMedia: true }, ''],
  [{ message: { contactMessage: {} } }, ''],
  [{ message: { locationMessage: {} } }, ''],
  [{ message: { buttonsMessage: {} } }, 'Elegí una opción'],
  [{ hasMedia: true }, ''],                       // no _data.message -> generic "media"
  [{ location: { latitude: -34.6, longitude: -58.4 } }, ''],
  [{ vCards: ['BEGIN:VCARD\nEND:VCARD'] }, ''],
];
for (const [extra, body] of mediaCases) {
  addMsg(MEDIA, false, ts(2026, 7, 18, mh++, 0), body, extra);
}
addMsg(MEDIA, true, ts(2026, 7, 18, 21, 30), 'Recibido! Mañana te contesto todo.');

// 15) Inbound-only conversation, left unanswered.
const SINRESP = '5491133445566@c.us';
addMsg(SINRESP, false, ts(2026, 8, 3, 10, 0), 'Necesito 3 unidades para la semana que viene');
addMsg(SINRESP, false, ts(2026, 8, 3, 10, 1), '¿Hola?');
addMsg(SINRESP, false, ts(2026, 8, 4, 9, 30), '¿Me leen?');

// 16) Outbound-only monologue (e.g. a broadcast follow-up nobody answered).
const MONO = '5491166778899@c.us';
addMsg(MONO, true, ts(2026, 8, 6, 11, 0), 'Hola! Te escribo por la promo de agosto.');
addMsg(MONO, true, ts(2026, 8, 13, 11, 0), '¿Pudiste ver la promo? Sigue vigente.');

// 17) Long text (> 32,767 chars -> truncated in the XLSX) + XML-hostile text
//     + a control character. All in one conversation.
const LONGTXT = '5491177889900@c.us';
const longBody = ('Detalle del pedido: ' + 'ítem repuesto industrial código X-99; '.repeat(900)).trim();
addMsg(LONGTXT, false, ts(2026, 8, 10, 14, 0), longBody);
addMsg(LONGTXT, false, ts(2026, 8, 10, 14, 2), 'ojo que esto tiene xml: </row> y <c s="1"> adentro');
addMsg(LONGTXT, false, ts(2026, 8, 10, 14, 3), 'y esto un control char: \u0007 <- campana');
addMsg(LONGTXT, true, ts(2026, 8, 10, 14, 20), 'Recibido, te lo cotizo completo.');

// 18) Procedural filler: 8 realistic conversations across May-Aug 2026.
for (let i = 0; i < 8; i++) {
  const jid = `54911${String(40000000 + i * 137137).padStart(8, '0')}@c.us`;
  const month = 5 + (i % 4);
  const day = 2 + Math.floor(rnd() * 24);
  let t = ts(2026, month, day, 9 + Math.floor(rnd() * 9), Math.floor(rnd() * 60));
  const n = 6 + Math.floor(rnd() * 10);
  for (let k = 0; k < n; k++) {
    const inbound = k % 2 === 0;
    const body = inbound
      ? pick(INBOUND_LINES)
      : (k === 3 ? quote(110 + i, 300 + i * 25) : pick(OUTBOUND_LINES));
    addMsg(jid, !inbound, t, body, inbound && k === 0 ? { pushName: `Cliente ${i + 1}` } : {});
    t += 60 * (3 + Math.floor(rnd() * 240)); // 3 min .. 4 h between messages
  }
}

// 19) Deliberately broken lines: one malformed JSON, one message without "from".
lines.splice(20, 0, '{this line is not json at all');
lines.push(JSON.stringify(msg('x@c.us', false, ts(2026, 8, 11, 12, 0), 'orphan without sender', { noFrom: true })));

// -------------------------------------------------------------- lid truth ---

const lidTruth = {
  lids: {
    [ANA_LID]: { pn: '5491155501234@c.us', name: 'Ana Gómez' },
    [LID_OK]: { pn: '5491155667788@c.us', name: 'Lidia Reyes' },
    [LID_BAD]: { pn: null, name: null },
  },
  contacts: {
    [ANA_CUS]: 'Ana Gómez',
    [BRUNO]: 'Bruno Díaz',
    '56912345678@c.us': 'Camila Soto',
    [MEDIA]: 'Marcos Media',
    [INTERNA]: 'Depósito (interno)',
  },
};

// -------------------------------------------------------------------- CRM ---

// Synthetic CRM in the current ad-hoc format. Phone formats are deliberately
// messy — that's the real-world condition the suffix match exists for.
const crm = [
  { id: 1, cliente: 'Ferretería La Tuerca', contacto: 'Ana Gómez', telefono: '+54 9 11 5550-1234', whatsapp: null, email: 'ana@latuerca.example', tipo_cliente: 'minorista', estadio_prospecto: 'cliente', localidad: 'CABA', cod_cliente: 'C-0001', match_suf: null },
  { id: 2, cliente: 'Distribuidora Díaz', contacto: 'Bruno Díaz', telefono: '11 2233-4455 / 11 5555-0000', whatsapp: null, email: 'bruno@ddiaz.example', tipo_cliente: 'mayorista', estadio_prospecto: 'negociacion', localidad: 'Rosario', cod_cliente: 'C-0002', match_suf: '1122334455' },
  { id: 3, cliente: 'Uso interno', contacto: 'Depósito', telefono: null, whatsapp: null, email: 'deposito@fixture-internal.test', tipo_cliente: null, estadio_prospecto: null, localidad: null, cod_cliente: null, match_suf: '1199887766' },
  { id: 4, cliente: 'Cliente Fantasma SRL', contacto: 'Nadie', telefono: '0341- 555 0678 / 0341-555-0884', whatsapp: '115-555-1720', email: 'nadie@fantasma.example', tipo_cliente: 'minorista', estadio_prospecto: 'prospecto', localidad: 'Rosario', cod_cliente: 'C-0044', match_suf: null },
];

// ------------------------------------------------------------------ chats ---

const jids = [...new Set(lines.flatMap((l) => { try { const m = JSON.parse(l); return m.from ? [m.from] : []; } catch { return []; } }))];
const chats = jids.map((id) => ({ id, name: lidTruth.contacts[id] ?? null }));

// ------------------------------------------------------------------ write ---

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'messages.jsonl'), lines.join('\n') + '\n', 'utf8');
await writeFile(path.join(OUT, 'chats.json'), JSON.stringify(chats, null, 2) + '\n', 'utf8');
await writeFile(path.join(OUT, 'lid-truth.json'), JSON.stringify(lidTruth, null, 2) + '\n', 'utf8');
await writeFile(path.join(OUT, 'crm-contacts.json'), JSON.stringify(crm, null, 2) + '\n', 'utf8');

console.log(`✓ ${lines.length} JSONL lines (${jids.length} JIDs) → ${path.join(OUT, 'messages.jsonl')}`);
console.log(`✓ chats.json, lid-truth.json, crm-contacts.json`);
