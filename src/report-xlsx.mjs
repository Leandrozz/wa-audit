#!/usr/bin/env node
/**
 * report-xlsx.mjs — Builds the master XLSX report from the corpus + analysis.
 *
 * Inputs (all local, nothing leaves the machine), read from output.dir:
 *   threads.json     derived corpus, schema_version 1 (docs/data-contract.md)
 *   summary.json     metrics of the run that produced the corpus
 *   analysis.json    verified analysis, schema_version 1 (analysis/analysis.schema.json)
 *
 * Output (same dir): report.filename (default whatsapp-report.xlsx)
 *
 * Usage: node src/report-xlsx.mjs
 * Configuration: wa-audit.config.json + env overrides (src/lib/config.mjs).
 *
 * The report prose is Spanish (es-AR preset); the data contract underneath is
 * English. Prose i18n is roadmap, and deliberately not blocking.
 *
 * Technical note: xlsx 0.18.5 (SheetJS community) writes neither cell styles
 * nor frozen panes. The file is generated with SheetJS and then post-processed
 * as a ZIP with `cfb` to inject a custom styles.xml, bold the header rows and
 * freeze the first row.
 */

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import CFB from 'cfb';
import { loadConfig } from './lib/config.mjs';
import { loadReportData, tipoEs, dirEs, confEs, fechaHora, soloFecha, soloHora } from './lib/report-data.mjs';

const cfg = loadConfig();
const DIR = cfg.output.dir;
const OUT = path.join(DIR, cfg.report.filename);
const BUSINESS = cfg.business.name;

const MAX_CELL = 32767; // hard Excel limit per cell

// ---------------------------------------------------------------- utilities

const limpiar = (s) =>
  String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

let truncados = 0;
function celda(s) {
  const t = limpiar(s);
  if (t.length <= MAX_CELL) return t;
  truncados++;
  return t.slice(0, MAX_CELL - 20) + ' […TRUNCADO]';
}

/** Valid sheet name: <=31 chars, none of : \ / ? * [ ] */
function nombreHoja(s, usados) {
  let base = limpiar(s).replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  if (!base) base = 'Hoja';
  let n = base;
  let i = 2;
  while (usados.has(n)) {
    const suf = ` (${i++})`;
    n = base.slice(0, 31 - suf.length) + suf;
  }
  usados.add(n);
  return n;
}

// --------------------------------- inputs + derived metrics (shared lib) ---

const {
  summary, dimensiones, convs, totalMensajes, entrantes, salientes,
  porTipo, porMes, mesesOrdenados, primerIso, ultimoIso,
  hayResidual, mesInicioVentana, mesesVentana, mesesCalendario, mensajesResiduales,
  convsReales, numSistema, conCrm, sinResponder, idaYVuelta, conMedia, lidSinResolver,
  medianaGlobal, top10, num, num1, pct,
} = loadReportData(cfg);

// ------------------------------------------------------- writing helpers

const wb = XLSX.utils.book_new();
const usados = new Set();
/** post-processing: per sheet, which rows get which style */
const estilos = []; // {nombre, filas:{n:styleId}, bodyStyle, freezeRow}

function agregarHoja({ nombre, aoa, cols, autofiltro, filasEstilo, bodyStyle, freezeRow }) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (cols) ws['!cols'] = cols.map((w) => ({ wch: w }));
  if (autofiltro) {
    const ref = XLSX.utils.decode_range(ws['!ref']);
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range(
        { r: (autofiltro.headerRow ?? 1) - 1, c: 0 },
        { r: ref.e.r, c: ref.e.c }
      ),
    };
  }
  const n = nombreHoja(nombre, usados);
  XLSX.utils.book_append_sheet(wb, ws, n);
  estilos.push({
    nombre: n,
    filas: filasEstilo || {},
    bodyStyle: bodyStyle || 0,
    freezeRow: freezeRow || 0,
  });
  return n;
}

// ======================================================== SHEET 1: Resumen

const R = [];
const filasEstiloResumen = {};
const push = (fila, estilo) => {
  R.push(fila);
  if (estilo) filasEstiloResumen[R.length] = estilo;
};

push([`${BUSINESS} — Historial de WhatsApp: informe maestro`], 3);
push([`Generado el ${new Date().toISOString().slice(0, 10)} a partir del dump de la sesión WAHA ${summary.session}`]);
push([]);
if (hayResidual) {
  push(['LEER PRIMERO — el rango de fechas engaña'], 1);
  push([
    `El historial va del ${soloFecha(primerIso)} al ${soloFecha(ultimoIso)} (${mesesCalendario} meses calendario), pero NO es actividad pareja. ` +
      `Antes de ${mesInicioVentana} hay apenas ${num(mensajesResiduales)} mensajes en todo el dump (actividad residual, no conversaciones sostenidas). ` +
      `El ${pct(totalMensajes - mensajesResiduales, totalMensajes)} del volumen está concentrado en los ${mesesVentana} meses desde ${mesInicioVentana}. ` +
      `Cualquier promedio "por mes" calculado sobre el rango completo es falso: hay que dividir por ${mesesVentana}, no por ${mesesCalendario}.`,
  ]);
  push([]);
}

push(['VOLUMEN Y ALCANCE'], 1);
push(['Métrica', 'Valor', 'Aclaración']);
filasEstiloResumen[R.length] = 1;
const filaResumen = (k, v, nota) => push([k, v, nota || '']);
filaResumen('Mensajes en el corpus (1 a 1)', num(totalMensajes), 'Excluye los grupos de WhatsApp');
filaResumen('Mensajes descartados por ser de grupos', num(summary.group_messages_excluded), 'Sobre ' + num(summary.lines_read) + ' líneas leídas del dump crudo');
filaResumen('Entrantes (del cliente)', `${num(entrantes)} (${pct(entrantes, totalMensajes)})`, '');
filaResumen('Salientes (del negocio)', `${num(salientes)} (${pct(salientes, totalMensajes)})`, 'Incluye tanto personas como cualquier bot que haya respondido desde este número (el dump no los distingue)');
filaResumen('Conversaciones', num(convs.length), `${num(convsReales.length)} son de clientes reales (${summary.internal_threads} internas y ${numSistema} pseudo-contacto/s del sistema quedan marcadas aparte)`);
filaResumen('Clientes distintos (números)', num(convsReales.length), 'Una conversación = un número de teléfono');
filaResumen('Conversaciones con ida y vuelta', `${num(idaYVuelta)} (${pct(idaYVuelta, convs.length)})`, 'El resto es monólogo: o escribió sólo el cliente o sólo el negocio');
filaResumen('Conversaciones que quedaron sin responder', `${num(sinResponder)} (${pct(sinResponder, convs.length)})`, 'El último mensaje es del cliente');
filaResumen('Mensajes con archivo adjunto', `${num(conMedia)} (${pct(conMedia, totalMensajes)})`, 'Fotos, documentos, audios, stickers');
filaResumen('Mediana de tiempo de respuesta', summary.global_median_response_min != null ? `${num1(summary.global_median_response_min)} min` : '—', 'Mediana global reportada por el corpus; mediana de las medianas por conversación: ' + (medianaGlobal != null ? num1(medianaGlobal) + ' min' : '—'));
filaResumen('Primer mensaje del historial', fechaHora(primerIso), '');
filaResumen('Último mensaje del historial', fechaHora(ultimoIso), '');
push([]);

push(['VOLUMEN POR MES'], 1);
push(['Mes', 'Mensajes', 'Comentario']);
filasEstiloResumen[R.length] = 1;
for (const m of mesesOrdenados) {
  push([m, porMes[m], hayResidual && m < mesInicioVentana ? 'Actividad residual, no es un mes de operación' : '']);
}
push([]);

push(['QUÉ TIPO DE MENSAJES SON'], 1);
push(['Tipo', 'Cantidad', '% del corpus']);
filasEstiloResumen[R.length] = 1;
for (const [t, n] of Object.entries(porTipo).sort((a, b) => b[1] - a[1])) {
  push([tipoEs(t), n, pct(n, totalMensajes)]);
}
push([]);

push(['CRUCE CON EL CRM'], 1);
push([
  `Sólo ${conCrm} de las ${convs.length} conversaciones (${pct(conCrm, convs.length)}) se pudieron cruzar con un contacto del CRM. ` +
    `El resto son números que no están cargados, o que están cargados con otro formato. ` +
    `Esto limita cualquier análisis por segmento, estadio o localidad: la muestra con datos de CRM es demasiado chica para sacar conclusiones estadísticas.`,
]);
push([]);

push([`LOS ${top10.length} HALLAZGOS MÁS IMPORTANTES`], 1);
if (dimensiones.length === 0) {
  push([
    'ADVERTENCIA: no llegó ningún análisis de dimensiones al armar este archivo. ' +
      'Las hojas de análisis no están: correr la fase de análisis y regenerar el informe (los datos del corpus de este archivo siguen siendo válidos).',
  ]);
  push([]);
}
push(['#', 'Dimensión', 'Hallazgo', 'Qué dice', 'Medición', 'Confianza']);
filasEstiloResumen[R.length] = 1;
top10.forEach((h, i) => {
  push([i + 1, h._dim || '', h.title || '', h.detail || '', h.frequency || '', confEs(h.confidence)]);
});
push([]);
push(['CÓMO LEER ESTE ARCHIVO'], 1);
push(['Hoja', 'Qué tiene adentro']);
filasEstiloResumen[R.length] = 1;
push(['Conversaciones', 'Una fila por conversación, con sus métricas y el cruce con el CRM. Ordenada de más a menos mensajes.']);
push(['Transcripciones', 'Una fila por mensaje: todas las conversaciones crudas, en orden cronológico.']);
for (const d of dimensiones) {
  const r = String(d.summary ?? '');
  push([d.title || d.key, r.length > 400 ? r.slice(0, 400) + '…' : r]);
}
push(['Metodologia', 'De dónde salieron los datos, qué se excluyó, qué NO se puede medir y qué cifras refutó la verificación.']);

agregarHoja({
  nombre: 'Resumen',
  aoa: R.map((f) => f.map(celda)),
  cols: [46, 22, 90, 30, 60, 12],
  filasEstilo: filasEstiloResumen,
  bodyStyle: 2,
  freezeRow: 0,
});

// =================================================== SHEET 2: Conversaciones

const HDR_CONV = [
  'thread_id',
  'Número',
  'Nombre (WAHA o CRM)',
  '¿Matcheó CRM?',
  'Cliente / razón social (CRM)',
  'Segmento (CRM)',
  'Estadio (CRM)',
  'Localidad (CRM)',
  'Total mensajes',
  'Entrantes',
  'Salientes',
  'Primer mensaje',
  'Último mensaje',
  'Duración (días)',
  'Mediana de respuesta (min)',
  '¿Sin responder?',
  'Mensajes con adjunto',
  'Observación',
];

const filasConv = convs
  .slice()
  .sort((a, b) => b.metrics.total - a.metrics.total)
  .map((c) => {
    const obs = [];
    if (c.is_system) obs.push('Pseudo-contacto del sistema de WhatsApp, no es un cliente');
    if (c.is_internal) obs.push('Conversación interna del negocio');
    if (c.unresolved_lid) obs.push('LID sin resolver: el número puede no ser el real');
    if (!c.metrics.two_way) obs.push('Sin ida y vuelta (escribió una sola de las dos partes)');
    return [
      c.thread_id,
      c.phone_display || c.phone || '',
      c.contact_name || (c.crm ? c.crm.name : '') || '',
      c.crm ? 'Sí' : 'No',
      c.crm ? c.crm.name || '' : '',
      c.crm ? c.crm.segment || '' : '',
      c.crm ? c.crm.stage || '' : '',
      c.crm ? c.crm.location || '' : '',
      c.metrics.total,
      c.metrics.inbound,
      c.metrics.outbound,
      fechaHora(c.metrics.first_message),
      fechaHora(c.metrics.last_message),
      c.metrics.duration_days,
      c.metrics.median_response_min ?? '',
      c.metrics.unanswered ? 'Sí' : 'No',
      c.metrics.with_media,
      obs.join(' · '),
    ];
  });

agregarHoja({
  nombre: 'Conversaciones',
  aoa: [HDR_CONV, ...filasConv].map((f) =>
    f.map((v) => (typeof v === 'number' ? v : celda(v)))
  ),
  cols: [16, 20, 30, 13, 32, 18, 16, 18, 14, 11, 11, 17, 17, 14, 22, 15, 18, 46],
  autofiltro: { headerRow: 1 },
  filasEstilo: { 1: 1 },
  freezeRow: 1,
});

// ================================================== SHEET 3: Transcripciones

const HDR_TR = ['thread_id', 'Número', 'Nombre', 'Fecha', 'Hora', 'Dirección', 'Tipo', 'Texto'];
const filasTr = [];
for (const c of convs) {
  const nombre = c.contact_name || (c.crm ? c.crm.name : '') || '';
  for (const m of c.messages) {
    filasTr.push([
      c.thread_id,
      c.phone_display || c.phone || '',
      nombre,
      soloFecha(m.iso),
      soloHora(m.iso),
      dirEs(m.direction),
      tipoEs(m.type),
      celda(m.text || ''),
    ]);
  }
}

agregarHoja({
  nombre: 'Transcripciones',
  aoa: [HDR_TR, ...filasTr].map((f) => f.map((v) => (typeof v === 'number' ? v : celda(v)))),
  cols: [16, 20, 26, 12, 8, 12, 14, 120],
  autofiltro: { headerRow: 1 },
  filasEstilo: { 1: 1 },
  freezeRow: 1,
});

// ============================================ SHEETS 4..n: one per dimension

const hojasDimension = [];
for (const d of dimensiones) {
  const cols = (d.columns || []).slice();
  const notas = d.row_verification_notes || {};
  const hayNotas = Object.keys(notas).length > 0;
  const encabezado = cols.map((c) => c.label ?? c.key);
  if (hayNotas) encabezado.push('Nota de verificación');

  const filas = (d.rows || []).map((f) => {
    const base = cols.map((c) => (typeof f[c.key] === 'number' ? f[c.key] : celda(f[c.key] ?? '')));
    if (!hayNotas) return base;
    const clave = String(f.n ?? '');
    return [...base, celda(notas[clave] || '')];
  });

  const nombre = agregarHoja({
    nombre: d.title || d.key,
    aoa: [encabezado.map(celda), ...filas],
    cols: encabezado.map((c, i) => (i === 0 ? 5 : i === 1 ? 30 : i === encabezado.length - 1 && hayNotas ? 70 : 60)),
    autofiltro: { headerRow: 1 },
    filasEstilo: { 1: 1 },
    bodyStyle: 2,
    freezeRow: 1,
  });
  hojasDimension.push({ dim: d, nombre });
}

// =================================================== Final sheet: Metodologia

const M = [];
const filasEstiloMet = {};
const pm = (fila, estilo) => {
  M.push(Array.isArray(fila) ? fila : [fila]);
  if (estilo) filasEstiloMet[M.length] = estilo;
};

pm('METODOLOGÍA Y LÍMITES DE ESTE INFORME', 3);
pm([]);

pm('1. DE DÓNDE SALEN LOS DATOS', 1);
pm([
  `El origen es un dump completo del historial de WhatsApp del negocio exportado desde WAHA, sesión ${summary.session}, ` +
    `generado el ${String(summary.generated_at).slice(0, 10)}. Son ${num(summary.lines_read)} mensajes crudos en formato JSON, uno por línea. ` +
    `De ahí se derivó el corpus de trabajo (threads.json + messages.csv), que es lo que alimenta este Excel. ` +
    `El dump y el corpus quedan en el directorio de salida local, en la máquina que corrió el proceso; este generador no sube nada a ningún servicio externo. ` +
    `La única transmisión externa posible del pipeline es la de la fase de análisis, que envía un extracto del corpus al proveedor de LLM configurado (ninguna, si se usó un motor local).`,
]);
pm([]);

pm('2. QUÉ SE EXCLUYÓ', 1);
pm(['Criterio', 'Cantidad', 'Por qué']);
filasEstiloMet[M.length] = 1;
pm([
  'Mensajes de grupos (@g.us)',
  num(summary.group_messages_excluded),
  'No son conversaciones comerciales 1 a 1 con un cliente; mezclan varios interlocutores y ensucian cualquier métrica de respuesta.',
]);
pm([
  'Mensajes malformados / sin remitente',
  num(summary.malformed_messages + summary.messages_without_sender),
  summary.malformed_messages + summary.messages_without_sender === 0
    ? 'No hubo: el dump vino completo.'
    : 'Líneas del dump que no parsearon como JSON o mensajes sin remitente; quedan fuera del corpus y contados acá.',
]);
pm([
  'Conversaciones internas del negocio',
  String(summary.internal_threads),
  'Quedan EN el archivo pero marcadas en la columna Observación de la hoja Conversaciones, para que no se cuenten como clientes.',
]);
pm([
  'Pseudo-contactos del sistema (0@c.us, status@broadcast)',
  String(numSistema),
  'Son contactos del sistema de WhatsApp, no personas. Quedan marcados como sistema.',
]);
pm([
  'Resultado',
  num(summary.messages_included) + ' mensajes',
  `Repartidos en ${num(summary.threads)} conversaciones. La suma cierra contra el dump original (verificación automática: ${summary.count_check_ok ? 'OK' : 'FALLÓ'}).`,
]);
pm([]);

pm('3. CÓMO SE RESOLVIERON LOS LID', 1);
pm([
  'WhatsApp identifica a muchos contactos con un JID de tipo @lid (un identificador opaco) en vez del número de teléfono. En el dump crudo hay ' +
    `${summary.lid_jids} JIDs @lid y ${summary.cus_jids} @c.us (número directo). Para poder juntar la conversación de una misma persona y para poder cruzarla con el CRM, ` +
    `cada @lid se resolvió a su número real consultando el contacto en WAHA y cacheando el resultado (lid-cache.json en el directorio de salida).`,
]);
pm(['Resultado del resolve', 'Cantidad', 'Consecuencia']);
filasEstiloMet[M.length] = 1;
pm(['LID resueltos a número real', num(summary.lids_resolved), 'Conversación atribuida al teléfono correcto.']);
pm([
  'LID que NO se pudieron resolver',
  num(summary.lids_unresolved),
  `Quedan en el archivo con el identificador crudo y marcados en la columna Observación ("LID sin resolver"). En esas ${lidSinResolver} conversaciones el "número" que se muestra puede no ser el teléfono real y no se puede cruzar con el CRM.`,
]);
pm([
  'Fusiones @lid + @c.us',
  String(summary.lid_cus_merges),
  `${summary.multi_jid_threads} conversaciones venían partidas en dos JIDs distintos de la misma persona y se unificaron en un solo hilo.`,
]);
pm([]);

pm('4. CRUCE CON EL CRM', 1);
pm([
  `El cruce con el CRM ${summary.crm_available ? 'SÍ estuvo disponible' : 'NO estuvo disponible'}${summary.crm_available ? `: matchearon ${summary.crm_matches} conversaciones de ${summary.threads} (${pct(summary.crm_matches, summary.threads)})` : ''}. ` +
    `El match se hace por número normalizado exacto y, como respaldo, por sufijo de teléfono (los últimos 10 dígitos), para saltear las diferencias de prefijo internacional y de formato de carga manual. ` +
    `Las columnas de cliente, segmento, estadio y localidad de la hoja Conversaciones están vacías en las filas sin match: el número de WhatsApp no está cargado en el CRM o está cargado con otro formato.`,
]);
pm([]);

pm('5. CÓMO SE MIDIERON LAS COLUMNAS DE LA HOJA CONVERSACIONES', 1);
pm(['Columna', 'Definición exacta']);
filasEstiloMet[M.length] = 1;
pm(['Total / Entrantes / Salientes', 'Conteo de mensajes del hilo. "Saliente" = fromMe en el dump, o sea escrito desde el WhatsApp del negocio (persona o bot, el dump no los distingue).']);
pm(['Primer / Último mensaje', 'Fecha y hora local del primer y último mensaje del hilo, en formato YYYY-MM-DD HH:mm.']);
pm(['Duración (días)', 'Días entre el primer y el último mensaje del hilo.']);
pm(['Mediana de respuesta (min)', 'Mediana del tiempo entre el PRIMER mensaje de cada racha entrante y el primer saliente que la contesta. Una racha sin respuesta no cuenta. Sólo se calcula si hubo al menos una respuesta; queda vacía si no hubo ninguna.']);
pm(['¿Sin responder?', 'Sí = el último mensaje del hilo es del cliente. No implica necesariamente que se haya perdido la venta: puede haberse seguido por teléfono o mail.']);
pm(['Mensajes con adjunto', 'Mensajes con media (foto, documento, audio, nota de voz, sticker, video).']);
pm([]);

pm('6. QUÉ HAY EN LA HOJA TRANSCRIPCIONES', 1);
pm([
  `Están las ${num(convs.length)} conversaciones completas, un mensaje por fila, ${num(totalMensajes)} filas de datos en total, en orden cronológico dentro de cada conversación. ` +
    'El texto es el cuerpo del mensaje tal cual se envió, sin editar. Los mensajes que no son texto (fotos, documentos, audios, notas de voz, stickers) aparecen con la columna Texto vacía y el tipo indicado en la columna Tipo: ' +
    'el dump no trae ni el archivo ni la transcripción del audio, así que ese contenido no es analizable. ' +
    (truncados
      ? `${truncados} celdas superaban el límite de 32.767 caracteres de Excel y quedaron truncadas, marcadas al final con [...TRUNCADO].`
      : 'Ningún texto superó el límite de 32.767 caracteres por celda de Excel, así que no hubo truncamientos.'),
]);
pm([]);

pm('7. MÉTODO Y LÍMITES DE CADA DIMENSIÓN DE ANÁLISIS', 1);
if (dimensiones.length === 0) {
  pm(['(No llegó ningún análisis de dimensiones al armar este archivo.)']);
}
for (const d of dimensiones) {
  pm([`Dimensión: ${d.title || d.key}`], 1);
  if (d.method) pm(['Método: ' + d.method]);
  for (const l of d.limitations || []) pm(['• ' + l]);
  pm([]);
}

pm('8. HALLAZGOS QUE LA VERIFICACIÓN REFUTÓ (registro de lo que NO se sostiene)', 1);
pm([
  'Cada dimensión pasó por un verificador independiente que intentó reproducir las cifras contra el corpus. Lo que sigue es lo que NO reprodujo. ' +
    'Las cifras corregidas ya están aplicadas en el texto de los hallazgos y marcadas en la columna "Nota de verificación" de la hoja de cada dimensión; ' +
    'este registro queda para que nadie vuelva a citar los números viejos.',
]);
let hayRefutados = false;
for (const d of dimensiones) {
  const v = d.verdict || {};
  pm([
    `Dimensión: ${d.title || d.key} — hallazgos revisados: ${v.reviewed ?? '—'}, confirmados: ${v.confirmed ?? '—'}, refutados: ${(v.refuted || []).length}`,
  ], 1);
  pm(['Hallazgo refutado', 'Por qué no se sostiene', 'Cifra corregida']);
  filasEstiloMet[M.length] = 1;
  for (const r of v.refuted || []) {
    hayRefutados = true;
    pm([r.title || '', r.reason || '', r.correction || '(no se recibió corrección)']);
  }
  if (!(v.refuted || []).length) pm(['(ninguno)', '', '']);
  pm([]);
}
if (!hayRefutados) pm(['(No se registraron hallazgos refutados.)']);

pm('9. ADVERTENCIAS DE LA CORRIDA QUE GENERÓ EL CORPUS', 1);
for (const a of summary.warnings || []) pm(['• ' + a]);
pm([]);

pm('10. REPRODUCIBILIDAD', 1);
pm([
  'Este archivo lo genera src/report-xlsx.mjs (node src/report-xlsx.mjs) leyendo threads.json, summary.json y ' +
    'analysis.json del directorio de salida. Todos los números de la hoja Resumen se recalculan en cada corrida a partir del corpus. ' +
    'Los textos de las hojas de dimensión vienen tal cual del análisis verificado; el script no los reinterpreta.',
]);

agregarHoja({
  nombre: 'Metodologia',
  aoa: M.map((f) => f.map(celda)),
  cols: [46, 100, 70],
  filasEstilo: filasEstiloMet,
  bodyStyle: 2,
});

// ============================================== write + zip post-processing

// bookSST is LOAD-BEARING, not just a size optimization: with the shared-string
// table, user text lives in sharedStrings.xml and the sheet XML only holds
// numeric indexes — which is what makes the regex-based post-processing below
// safe. With bookSST:false, arbitrary message text (which can contain "</row>"
// or "<c ") would land inside sheetN.xml and corrupt the rewrite. Do not flip it.
XLSX.writeFile(wb, OUT, { bookType: 'xlsx', compression: true, bookSST: true });

// --- custom styles.xml: 0 normal, 1 header, 2 wrapped body, 3 title
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="3"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/></styleSheet>`;

const cfb = CFB.read(fs.readFileSync(OUT), { type: 'buffer' });
const contenido = (ruta) => {
  const e = CFB.find(cfb, ruta);
  return e ? Buffer.from(e.content).toString('utf8') : null;
};
const escribir = (ruta, txt) => {
  const e = CFB.find(cfb, ruta);
  if (!e) throw new Error('missing ' + ruta + ' inside the xlsx');
  e.content = Buffer.from(txt, 'utf8');
  e.size = e.content.length;
};

escribir('/xl/styles.xml', STYLES_XML);

// map sheet name -> sheetN.xml following workbook order
const orden = wb.SheetNames;
orden.forEach((nombre, i) => {
  const ruta = `/xl/worksheets/sheet${i + 1}.xml`;
  let xml = contenido(ruta);
  if (xml == null) throw new Error('missing ' + ruta);
  const cfgHoja = estilos.find((e) => e.nombre === nombre);
  if (!cfgHoja) return;

  // 1) freeze rows
  if (cfgHoja.freezeRow > 0) {
    const n = cfgHoja.freezeRow;
    const pane =
      `<sheetViews><sheetView workbookViewId="0">` +
      `<pane ySplit="${n}" topLeftCell="A${n + 1}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${n + 1}" sqref="A${n + 1}"/>` +
      `</sheetView></sheetViews>`;
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, pane);
  }

  // 2) per-row styles
  const conEstilo = Object.keys(cfgHoja.filas).length > 0 || cfgHoja.bodyStyle;
  if (conEstilo) {
    xml = xml.replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (todo, r, attrs, cuerpo) => {
      const s = cfgHoja.filas[Number(r)] ?? cfgHoja.bodyStyle;
      if (!s) return todo;
      const nuevoCuerpo = cuerpo.replace(/<c /g, `<c s="${s}" `);
      return `<row r="${r}"${attrs}>${nuevoCuerpo}</row>`;
    });
  }
  escribir(ruta, xml);
});

fs.writeFileSync(OUT, Buffer.from(CFB.write(cfb, { type: 'buffer', fileType: 'zip' })));

// =========================================================== VERIFICATION

const leido = XLSX.readFile(OUT);
const conteos = {};
for (const n of leido.SheetNames) {
  const rango = XLSX.utils.decode_range(leido.Sheets[n]['!ref']);
  conteos[n] = { rows: rango.e.r + 1, cols: rango.e.c + 1 };
}

const filasTranscripciones = conteos['Transcripciones'].rows - 1; // minus header
const filasConversaciones = conteos['Conversaciones'].rows - 1;
const okTr = filasTranscripciones === totalMensajes;
const okConv = filasConversaciones === convs.length;
const tam = fs.statSync(OUT).size;

console.log(JSON.stringify(
  {
    file: OUT,
    size_mb: +(tam / 1024 / 1024).toFixed(2),
    sheets: conteos,
    messages_in_corpus: totalMensajes,
    transcript_data_rows: filasTranscripciones,
    transcripts_match: okTr,
    threads_in_corpus: convs.length,
    thread_data_rows: filasConversaciones,
    threads_match: okConv,
    truncated_cells: truncados,
    dimensions_included: hojasDimension.map((h) => h.nombre),
  },
  null,
  2
));

if (!okTr || !okConv) {
  console.error('VERIFICATION FAILED: counts do not match the corpus.');
  process.exit(1);
}
