/**
 * Clean conversation corpus from the raw WAHA dump.
 * Phase 3 of the export (phase 2 = src/export.mjs).
 *
 *   node --env-file=waha.env src/threads.mjs [--session <name>] [--no-net]
 *
 * What it does:
 *   1. Streams data/wa-history/messages.jsonl line by line.
 *   2. Excludes group chats (@g.us).
 *   3. Resolves @lid identifiers to real numbers via WAHA, with an on-disk
 *      cache so hundreds of requests are not repeated.
 *   4. Normalizes phone numbers (AR mobile rules for +54; foreign numbers are
 *      kept in E.164 untouched — see normalizeNumber()).
 *   5. Groups by normalized number, so a client that appears both as @lid and
 *      as @c.us counts as ONE conversation.
 *   6. Joins against the CRM if data/wa-history/crm-contacts.json exists.
 *   7. Computes per-conversation metrics and writes threads.json, mensajes.csv
 *      and resumen-corpus.json.
 *
 * Env (only for step 3; with --no-net none is needed):
 *   WAHA_BASE_URL, WAHA_API_KEY, WAHA_BASIC_AUTH ("user:password")
 * Optional env:
 *   WA_OUT_DIR                 default data/wa-history (gitignored: real chats)
 *   WAHA_SESSION               session name (or --session)
 *   WA_INTERNAL_EMAIL_DOMAINS  comma-separated email domains that mark a CRM
 *                              contact as an internal line of the business
 *
 * Only reads from WAHA and writes local files.
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

// ---------------------------------------------------------------- config ---

const OUT_DIR = process.env.WA_OUT_DIR ?? 'data/wa-history';
const MESSAGES_FILE = path.join(OUT_DIR, 'messages.jsonl');
const LID_CACHE_FILE = path.join(OUT_DIR, 'lid-cache.json');
const CRM_FILE = path.join(OUT_DIR, 'crm-contacts.json');
const THREADS_FILE = path.join(OUT_DIR, 'threads.json');
const CSV_FILE = path.join(OUT_DIR, 'mensajes.csv');
const RESUMEN_FILE = path.join(OUT_DIR, 'resumen-corpus.json');

const argv = process.argv.slice(2);
const argSession = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : null;
const SESSION = argSession ?? process.env.WAHA_SESSION ?? '';
const NO_NET = argv.includes('--no-net');
const CONCURRENCY = 6;
const RETRIES = 3;
/** Fixed offset for now (Argentina has no DST). A proper config replaces this in v0.2. */
const TZ_OFFSET_MIN = -180;

/** Internal lines of the business (their CRM contact carries a company email).
 *  They are not clients: left unmarked they distort every average. */
const INTERNAL_EMAIL_DOMAINS = (process.env.WA_INTERNAL_EMAIL_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const BASE = (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, '');
const HEADERS = { 'X-Api-Key': process.env.WAHA_API_KEY ?? '', Accept: 'application/json' };
if (process.env.WAHA_BASIC_AUTH) {
  HEADERS.Authorization = `Basic ${Buffer.from(process.env.WAHA_BASIC_AUTH, 'utf8').toString('base64')}`;
}

// Warnings travel into resumen-corpus.json (and from there into the report's
// methodology sheet), so their wording is part of the data contract — Spanish
// until contract v1 lands.
const advertencias = [];
const warn = (msg) => {
  if (!advertencias.includes(msg)) advertencias.push(msg);
  console.warn(`  ! ${msg}`);
};

// ------------------------------------------------------------ phone numbers ---

/**
 * Normalizes to E.164. For Argentina: ALWAYS +549 + 10 digits, so that
 * 5491155501234 and 541155501234 collapse to the same number (the mobile "9"
 * is optional in the JID).
 *
 * Deliberate: we do NOT force +549 onto non-Argentine numbers. Dumps contain
 * chats from Chile, Brazil, Spain, etc.; forcing the prefix would corrupt them
 * and could merge two different clients into a single thread.
 */
function normalizeNumber(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('54')) {
    let rest = digits.slice(2);
    // The Argentine mobile "9" is optional in the JID: always strip it.
    if (rest.startsWith('9') && rest.length >= 11) rest = rest.slice(1);
    if (!rest) return null;
    return '+549' + rest.slice(0, 10);
  }
  return '+' + digits;
}

/** Readable format; for AR splits 54 9 <area+line>. */
function displayNumber(e164) {
  if (!e164) return null;
  if (e164.startsWith('+549') && e164.length === 14) {
    const d = e164.slice(4);
    return `+54 9 ${d.slice(0, 2)} ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return e164;
}

// ------------------------------------------------------------------ misc ---

const isoLocal = (ts) => new Date((ts + TZ_OFFSET_MIN * 60) * 1000).toISOString().replace('Z', '-03:00');
const horaLocal = (ts) => new Date((ts + TZ_OFFSET_MIN * 60) * 1000).getUTCHours();

// Slot labels are part of the corpus contract (they land in threads.json) —
// Spanish until contract v1 lands.
function franja(hour) {
  if (hour < 6) return 'madrugada (00-05)';
  if (hour < 12) return 'mañana (06-11)';
  if (hour < 19) return 'tarde (12-18)';
  return 'noche (19-23)';
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Message type: the dump was taken with downloadMedia=false, so `media` is
 *  null and the real type lives in _data.message (NOWEB shape). */
function tipoMensaje(m) {
  const msg = m?._data?.message ?? null;
  if (msg) {
    if (msg.imageMessage) return 'imagen';
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return msg.audioMessage.ptt ? 'nota_de_voz' : 'audio';
    if (msg.documentMessage) return 'documento';
    if (msg.stickerMessage || msg.lottieStickerMessage) return 'sticker';
    if (msg.contactMessage || msg.contactsArrayMessage) return 'contacto';
    if (msg.locationMessage) return 'ubicacion';
    if (msg.buttonsMessage) return 'botones';
  }
  if (m.location) return 'ubicacion';
  if (Array.isArray(m.vCards) && m.vCards.length) return 'contacto';
  if (m.hasMedia) return 'media';
  return 'texto';
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

/** jid -> { jid, mensajes: [] } */
const porJid = new Map();
let lineas = 0;
let malformadas = 0;
let excluidosGrupo = 0;
let incluidos = 0;
let sinFrom = 0;
const pushNames = new Map(); // jid -> pushName seen (almost always empty in practice)

await new Promise((resolve, reject) => {
  const rl = createInterface({ input: createReadStream(MESSAGES_FILE, 'utf8'), crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    lineas++;
    let m;
    try { m = JSON.parse(line); } catch { malformadas++; return; }
    const from = typeof m.from === 'string' ? m.from : '';
    if (!from) { sinFrom++; return; }
    if (from.includes('@g.us')) { excluidosGrupo++; return; }
    incluidos++;
    let bucket = porJid.get(from);
    if (!bucket) { bucket = { jid: from, mensajes: [] }; porJid.set(from, bucket); }
    const pn = m?._data?.pushName;
    if (pn && !m.fromMe && !pushNames.has(from)) pushNames.set(from, String(pn));
    bucket.mensajes.push({
      ts: m.timestamp,
      direccion: m.fromMe ? 'saliente' : 'entrante',
      tipo: tipoMensaje(m),
      texto: typeof m.body === 'string' ? m.body : '',
      tiene_media: !!m.hasMedia,
    });
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});

console.log(`  ${lineas} lines · ${excluidosGrupo} group messages excluded · ${incluidos} included · ${porJid.size} 1-to-1 chats`);
if (malformadas) warn(`${malformadas} líneas de messages.jsonl no parsearon como JSON y quedaron fuera del corpus`);
if (sinFrom) warn(`${sinFrom} mensajes sin campo "from" quedaron fuera del corpus`);

// --------------------------------------------------- 2) resolve @lid ---

const lids = [...porJid.keys()].filter((j) => j.endsWith('@lid'));
const cusJids = [...porJid.keys()].filter((j) => j.endsWith('@c.us'));
const otrosJids = [...porJid.keys()].filter((j) => !j.endsWith('@lid') && !j.endsWith('@c.us'));
if (otrosJids.length) warn(`${otrosJids.length} JIDs con sufijo inesperado (ej. ${otrosJids[0]}); se tratan como número crudo`);

/** jid -> { pn, name } */
let cache = {};
if (existsSync(LID_CACHE_FILE)) {
  try { cache = JSON.parse(await readFile(LID_CACHE_FILE, 'utf8')); } catch { cache = {}; }
  console.log(`Resolution cache: ${Object.keys(cache).length} entries in ${LID_CACHE_FILE}`);
}

const pendientesLid = lids.filter((l) => !(l in cache));
const pendientesNombre = cusJids.filter((j) => !(j in cache));

if (NO_NET) {
  if (pendientesLid.length) warn(`--no-net: ${pendientesLid.length} @lid sin resolver (no se consultó WAHA)`);
} else if (!BASE || !HEADERS['X-Api-Key'] || !SESSION) {
  warn('Faltan WAHA_BASE_URL / WAHA_API_KEY / sesión: no se resolvió ningún @lid nuevo');
} else {
  if (pendientesLid.length) {
    console.log(`Resolving ${pendientesLid.length} @lid against WAHA (session "${SESSION}", concurrency ${CONCURRENCY})...`);
    await pool(pendientesLid, CONCURRENCY, async (lid) => { cache[lid] = await resolveLid(lid); });
    await writeFile(LID_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  }
  if (pendientesNombre.length) {
    console.log(`Fetching names for ${pendientesNombre.length} @c.us contacts...`);
    await pool(pendientesNombre, CONCURRENCY, async (jid) => { cache[jid] = await resolveName(jid); });
  }
  await writeFile(LID_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`  cache saved to ${LID_CACHE_FILE}`);
}

let lidsResueltos = 0;
let lidsNoResueltos = 0;
for (const lid of lids) {
  if (normalizeNumber(cache[lid]?.pn ?? '')) lidsResueltos++;
  else lidsNoResueltos++;
}
console.log(`  @lid: ${lids.length} distinct · ${lidsResueltos} resolved · ${lidsNoResueltos} unresolved`);

// ------------------------------------------- 3) unify by number ---

/** key -> { numero, jids, nombres, mensajes } */
const convs = new Map();
let fusiones = 0;

/** WhatsApp system pseudo-contacts, not clients. */
const SISTEMA = new Set(['0@c.us', 'status@broadcast']);

for (const [jid, bucket] of porJid) {
  if (SISTEMA.has(jid)) {
    warn(`${jid} es un pseudo-contacto del sistema de WhatsApp (${bucket.mensajes.length} mensaje/s), queda marcado con es_sistema=true`);
  }
  const esLid = jid.endsWith('@lid');
  const crudo = esLid ? (cache[jid]?.pn ?? '') : jid.split('@')[0];
  const numero = normalizeNumber(crudo);
  // An unresolved @lid can NOT be normalized: its digits are not a phone
  // number. It gets its own conversation and a flag — never an invented number.
  const key = numero ?? `lid:${jid.split('@')[0]}`;

  let c = convs.get(key);
  if (!c) {
    c = { key, numero, jids: [], origenes: new Set(), nombres: [], mensajes: [], lid_sin_resolver: !numero, es_sistema: SISTEMA.has(jid) };
    convs.set(key, c);
  }
  const origen = esLid ? 'lid' : 'c.us';
  if (numero && c.origenes.size && !c.origenes.has(origen)) fusiones++;
  c.origenes.add(origen);
  c.jids.push(jid);
  const nombre = cache[jid]?.name || pushNames.get(jid) || null;
  if (nombre) c.nombres.push(nombre);
  c.mensajes.push(...bucket.mensajes);
}

console.log(`  ${convs.size} conversations · ${fusiones} @lid + @c.us merges`);

// ------------------------------------------------------ 4) CRM (optional) ---

let crmDisponible = false;
let matchCrm = 0;
/** E.164 number -> CRM row */
const crmPorNumero = new Map();
if (existsSync(CRM_FILE)) {
  try {
    const filas = JSON.parse(await readFile(CRM_FILE, 'utf8'));
    if (Array.isArray(filas)) {
      crmDisponible = true;
      for (const f of filas) {
        // `match_suf` = the 10 significant digits of the AR number the join was
        // precomputed with. It takes priority because hand-loaded CRM phones
        // come in every imaginable format (e.g. "0341- 555 0678 / 0341-555-0884",
        // "115-555-1720"): normalizing them one by one loses most matches.
        if (f.match_suf) {
          const n = '+549' + String(f.match_suf);
          if (!crmPorNumero.has(n)) crmPorNumero.set(n, f);
          continue;
        }
        for (const campo of [f.telefono, f.whatsapp]) {
          const n = normalizeNumber(campo ?? '');
          if (n && !crmPorNumero.has(n)) crmPorNumero.set(n, f);
        }
      }
      console.log(`CRM: ${filas.length} contacts, ${crmPorNumero.size} distinct normalized numbers`);
    }
  } catch (e) {
    warn(`No se pudo leer ${CRM_FILE}: ${String(e).slice(0, 120)}`);
  }
} else {
  warn(`No hay ${CRM_FILE}: el corpus queda sin cruce con el CRM (crm_disponible=false)`);
}

// ---------------------------------------------------------- 5) metrics ---

function metricas(msgs) {
  const orden = [...msgs].sort((a, b) => a.ts - b.ts);
  const entrantes = orden.filter((m) => m.direccion === 'entrante').length;
  const salientes = orden.length - entrantes;
  const conMedia = orden.filter((m) => m.tiene_media).length;
  const primero = orden[0];
  const ultimo = orden[orden.length - 1];

  // Response time: for each burst of consecutive inbound messages, how long
  // until the first outbound reply. A burst that never got a reply doesn't count.
  const respuestas = [];
  let abierto = null;
  for (const m of orden) {
    if (m.direccion === 'entrante') { if (abierto === null) abierto = m.ts; }
    else if (abierto !== null) { respuestas.push((m.ts - abierto) / 60); abierto = null; }
  }

  const horas = new Map();
  const franjas = new Map();
  for (const m of orden) {
    const h = horaLocal(m.ts);
    horas.set(h, (horas.get(h) ?? 0) + 1);
    const f = franja(h);
    franjas.set(f, (franjas.get(f) ?? 0) + 1);
  }
  const topFranja = [...franjas.entries()].sort((a, b) => b[1] - a[1])[0];
  const topHora = [...horas.entries()].sort((a, b) => b[1] - a[1])[0];

  const med = median(respuestas);
  return {
    total: orden.length,
    entrantes,
    salientes,
    con_media: conMedia,
    primer_mensaje: isoLocal(primero.ts),
    ultimo_mensaje: isoLocal(ultimo.ts),
    duracion_dias: Math.round(((ultimo.ts - primero.ts) / 86400) * 10) / 10,
    respuestas_medidas: respuestas.length,
    mediana_respuesta_min: med === null ? null : Math.round(med * 10) / 10,
    sin_responder: ultimo.direccion === 'entrante',
    franja_mas_frecuente: topFranja ? topFranja[0] : null,
    hora_pico: topHora ? topHora[0] : null,
    ida_y_vuelta: entrantes > 0 && salientes > 0,
  };
}

const threads = [];
let internas = 0;
for (const c of convs.values()) {
  const msgs = [...c.mensajes].sort((a, b) => a.ts - b.ts);
  const crm = c.numero ? (crmPorNumero.get(c.numero) ?? null) : null;
  if (crm) matchCrm++;
  const nombre = c.nombres.find(Boolean) ?? null;
  const email = crm && typeof crm.email === 'string' ? crm.email.toLowerCase() : '';
  const esInterno = !!email && INTERNAL_EMAIL_DOMAINS.some((d) => email.includes('@' + d));
  if (esInterno) internas++;
  threads.push({
    conv_id: c.numero ? c.numero.replace('+', '') : `lid_${c.key.slice(4)}`,
    numero: c.numero,
    numero_display: c.numero ? displayNumber(c.numero) : `@lid ${c.key.slice(4)} (sin resolver)`,
    jids: c.jids,
    nombre_waha: nombre,
    lid_sin_resolver: c.lid_sin_resolver,
    es_sistema: !!c.es_sistema,
    es_interno: esInterno,
    crm: crm
      ? {
          id: crm.id ?? null,
          cliente: crm.cliente ?? null,
          contacto: crm.contacto ?? null,
          telefono: crm.telefono ?? null,
          whatsapp: crm.whatsapp ?? null,
          email: crm.email ?? null,
          tipo_cliente: crm.tipo_cliente ?? null,
          estadio_prospecto: crm.estadio_prospecto ?? null,
          localidad: crm.localidad ?? null,
          cod_cliente: crm.cod_cliente ?? null,
        }
      : null,
    metricas: metricas(msgs),
    mensajes: msgs.map((m) => ({
      ts: m.ts,
      fecha_iso: isoLocal(m.ts),
      direccion: m.direccion,
      tipo: m.tipo,
      texto: m.texto,
      tiene_media: m.tiene_media,
    })),
  });
}

threads.sort((a, b) => b.metricas.total - a.metricas.total || a.conv_id.localeCompare(b.conv_id));

// ------------------------------------------------------ 6) verification ---

const sumaMensajes = threads.reduce((a, t) => a + t.metricas.total, 0);
const totalEsperado = lineas;
if (sumaMensajes + excluidosGrupo + malformadas + sinFrom !== totalEsperado) {
  warn(
    `Descuadre: ${sumaMensajes} en conversaciones + ${excluidosGrupo} de grupos ` +
    `+ ${malformadas} malformadas + ${sinFrom} sin from != ${totalEsperado} líneas leídas`,
  );
}
const ids = new Set();
const dupIds = [];
for (const t of threads) { if (ids.has(t.conv_id)) dupIds.push(t.conv_id); ids.add(t.conv_id); }
if (dupIds.length) warn(`conv_id duplicados: ${dupIds.slice(0, 5).join(', ')}`);

// ---------------------------------------------------------- 7) outputs ---

await mkdir(OUT_DIR, { recursive: true });
await writeFile(THREADS_FILE, JSON.stringify(threads, null, 2), 'utf8');

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = ['﻿conv_id,numero,fecha_iso,direccion,tipo,texto'];
for (const t of threads) {
  for (const m of t.mensajes) {
    // Text is flattened: the CSV is for skimming, the faithful text is in threads.json.
    csv.push([t.conv_id, t.numero ?? '', m.fecha_iso, m.direccion, m.tipo, m.texto.replace(/\r?\n/g, ' | ')].map(q).join(','));
  }
}
await writeFile(CSV_FILE, csv.join('\n'), 'utf8');

const conIdaYVuelta = threads.filter((t) => t.metricas.ida_y_vuelta).length;
const sinResponder = threads.filter((t) => t.metricas.sin_responder).length;
const medianas = threads.map((t) => t.metricas.mediana_respuesta_min).filter((v) => v !== null);

const resumen = {
  generado: new Date().toISOString(),
  fuente: MESSAGES_FILE,
  sesion_waha: SESSION || null,
  lineas_leidas: lineas,
  mensajes_excluidos_grupos: excluidosGrupo,
  mensajes_malformados: malformadas,
  mensajes_sin_from: sinFrom,
  mensajes_incluidos: sumaMensajes,
  chats_1a1: porJid.size,
  jids_lid: lids.length,
  jids_cus: cusJids.length,
  jids_otros: otrosJids.length,
  lids_resueltos: lidsResueltos,
  lids_no_resueltos: lidsNoResueltos,
  fusiones_lid_cus: fusiones,
  conversaciones_multi_jid: threads.filter((t) => t.jids.length > 1).length,
  conversaciones: threads.length,
  conversaciones_con_ida_y_vuelta: conIdaYVuelta,
  conversaciones_sin_responder: sinResponder,
  conversaciones_con_nombre_waha: threads.filter((t) => t.nombre_waha).length,
  crm_disponible: crmDisponible,
  match_crm: matchCrm,
  conversaciones_internas: internas,
  entrantes: threads.reduce((a, t) => a + t.metricas.entrantes, 0),
  salientes: threads.reduce((a, t) => a + t.metricas.salientes, 0),
  mensajes_con_media: threads.reduce((a, t) => a + t.metricas.con_media, 0),
  mediana_global_respuesta_min: medianas.length ? Math.round(median(medianas) * 10) / 10 : null,
  verificacion_suma_ok: sumaMensajes + excluidosGrupo + malformadas + sinFrom === totalEsperado,
  conv_id_duplicados: dupIds.length,
  advertencias,
};
await writeFile(RESUMEN_FILE, JSON.stringify(resumen, null, 2), 'utf8');

console.log(`\n✓ ${threads.length} conversations → ${THREADS_FILE}`);
console.log(`✓ ${sumaMensajes} messages → ${CSV_FILE}`);
console.log(`✓ summary → ${RESUMEN_FILE}`);
console.log(`\nVerification: ${sumaMensajes} + ${excluidosGrupo} groups + ${malformadas} malformed + ${sinFrom} without from = ${sumaMensajes + excluidosGrupo + malformadas + sinFrom} (expected ${totalEsperado}) → ${resumen.verificacion_suma_ok ? 'OK' : 'MISMATCH'}`);
console.log(`duplicate conv_ids: ${dupIds.length}`);
console.log('\nTop 5 conversations by message count:');
for (const t of threads.slice(0, 5)) {
  console.log(`  ${t.numero_display ?? t.conv_id}  —  ${t.metricas.total} messages`);
}
if (advertencias.length) {
  console.log('\nWarnings:');
  for (const a of advertencias) console.log(`  - ${a}`);
}
