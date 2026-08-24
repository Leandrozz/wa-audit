#!/usr/bin/env node
/**
 * report-docx.mjs — Word (.docx) report from the corpus + analysis. Same
 * contract and numbers as the XLSX and HTML outputs (all three consume
 * src/lib/report-data.mjs); this is the format a client opens in Word.
 *
 * Usage: node src/report-docx.mjs
 * Output: <output.dir>/<report.filename with .docx extension>
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, AlignmentType, BorderStyle,
} from 'docx';
import { loadConfig } from './lib/config.mjs';
import { loadReportData, tipoEs, confEs, soloFecha } from './lib/report-data.mjs';

const cfg = loadConfig();
const BUSINESS = cfg.business.name;
const D = loadReportData(cfg);
const {
  summary, dimensiones, convs, totalMensajes, entrantes, salientes,
  porTipo, porMes, mesesOrdenados, primerIso, ultimoIso,
  hayResidual, mesInicioVentana, mesesVentana, mesesCalendario, mensajesResiduales,
  convsReales, numSistema, sinResponder, idaYVuelta, conMedia,
  medianaGlobal, top10, num, num1, pct,
} = D;

const OUT = path.join(D.dir, path.basename(cfg.report.filename, path.extname(cfg.report.filename)) + '.docx');

const ACCENT = '1F3864';
const RED = 'B42318';
const MUTED = '5B6B7B';

const clean = (s) => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const p = (text, opts = {}) => new Paragraph({
  children: [new TextRun({ text: clean(text), ...opts })],
  spacing: { after: 120 },
});
const meta = (text) => new Paragraph({
  children: [new TextRun({ text: clean(text), size: 18, color: MUTED })],
  spacing: { after: 100 },
});
const h = (text, level = HeadingLevel.HEADING_1) => new Paragraph({
  heading: level,
  children: [new TextRun({ text: clean(text) })],
  spacing: { before: 280, after: 140 },
});

const cell = (text, { header = false, color } = {}) => new TableCell({
  children: [new Paragraph({
    children: [new TextRun({
      text: clean(text),
      bold: header,
      color: header ? 'FFFFFF' : color,
      size: 19,
    })],
  })],
  shading: header ? { fill: ACCENT } : undefined,
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
});

const table = (headerRow, rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 2, color: 'D0D7DE' },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: 'D0D7DE' },
    left: { style: BorderStyle.SINGLE, size: 2, color: 'D0D7DE' },
    right: { style: BorderStyle.SINGLE, size: 2, color: 'D0D7DE' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'D0D7DE' },
    insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'D0D7DE' },
  },
  rows: [
    new TableRow({ tableHeader: true, children: headerRow.map((t) => cell(t, { header: true })) }),
    ...rows.map((r) => new TableRow({ children: r.map((t) => cell(t)) })),
  ],
});

const children = [];

// ------------------------------------------------------------------- header
children.push(new Paragraph({
  children: [new TextRun({ text: clean(`${BUSINESS} — Historial de WhatsApp: informe maestro`), bold: true, size: 40, color: ACCENT })],
  spacing: { after: 60 },
}));
children.push(meta(`Generado el ${new Date().toISOString().slice(0, 10)} · sesión WAHA ${summary.session} · ${num(summary.lines_read)} mensajes crudos leídos`));

if (hayResidual) {
  children.push(h('LEER PRIMERO — el rango de fechas engaña', HeadingLevel.HEADING_2));
  children.push(p(
    `El historial va del ${soloFecha(primerIso)} al ${soloFecha(ultimoIso)} (${mesesCalendario} meses calendario), pero NO es actividad pareja. ` +
    `Antes de ${mesInicioVentana} hay apenas ${num(mensajesResiduales)} mensajes en todo el dump (actividad residual). ` +
    `El ${pct(totalMensajes - mensajesResiduales, totalMensajes)} del volumen está concentrado en los ${mesesVentana} meses desde ${mesInicioVentana}. ` +
    `Cualquier promedio "por mes" sobre el rango completo es falso: dividir por ${mesesVentana}, no por ${mesesCalendario}.`,
  ));
}

// ---------------------------------------------------------------- kpi table
children.push(h('Volumen y alcance'));
children.push(table(
  ['Métrica', 'Valor', 'Aclaración'],
  [
    ['Mensajes en el corpus (1 a 1)', num(totalMensajes), 'Excluye los grupos de WhatsApp'],
    ['Entrantes (del cliente)', `${num(entrantes)} (${pct(entrantes, totalMensajes)})`, ''],
    ['Salientes (del negocio)', `${num(salientes)} (${pct(salientes, totalMensajes)})`, 'Incluye personas y cualquier bot (el dump no los distingue)'],
    ['Conversaciones', num(convs.length), `${num(convsReales.length)} de clientes reales (${summary.internal_threads} internas y ${numSistema} del sistema, marcadas aparte)`],
    ['Con ida y vuelta', `${num(idaYVuelta)} (${pct(idaYVuelta, convs.length)})`, 'El resto es monólogo'],
    ['Sin responder', `${num(sinResponder)} (${pct(sinResponder, convs.length)})`, 'El último mensaje es del cliente'],
    ['Mensajes con adjunto', `${num(conMedia)} (${pct(conMedia, totalMensajes)})`, ''],
    ['Mediana de tiempo de respuesta', summary.global_median_response_min != null ? `${num1(summary.global_median_response_min)} min` : '—', medianaGlobal != null ? `Mediana de medianas por conversación: ${num1(medianaGlobal)} min` : ''],
  ],
));

// ------------------------------------------------------------------- months
children.push(h('Volumen por mes'));
children.push(table(
  ['Mes', 'Mensajes', 'Comentario'],
  mesesOrdenados.map((m) => [m, num(porMes[m]), hayResidual && m < mesInicioVentana ? 'Actividad residual, no es un mes de operación' : '']),
));

children.push(h('Qué tipo de mensajes son'));
children.push(table(
  ['Tipo', 'Cantidad', '% del corpus'],
  Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([t, n]) => [tipoEs(t), num(n), pct(n, totalMensajes)]),
));

children.push(h('Cruce con el CRM'));
children.push(p(summary.crm_available
  ? `Matchearon ${num(summary.crm_matches)} de las ${num(convs.length)} conversaciones (${pct(summary.crm_matches, convs.length)}). El resto son números no cargados en el CRM o cargados con otro formato.`
  : 'No hubo CRM disponible en esta corrida: el corpus no tiene cruce con cartera de clientes.'));

// ----------------------------------------------------------------- findings
children.push(h(`Los ${top10.length} hallazgos más importantes`));
if (dimensiones.length === 0) {
  children.push(p('ADVERTENCIA: no llegó ningún análisis de dimensiones al armar este informe. Correr la fase de análisis y regenerar.', { bold: true, color: RED }));
}
if (top10.length) {
  children.push(table(
    ['#', 'Dimensión', 'Hallazgo', 'Qué dice', 'Confianza'],
    top10.map((hl, i) => [String(i + 1), hl._dim ?? '', hl.title ?? '', hl.detail ?? '', confEs(hl.confidence)]),
  ));
}

for (const d of dimensiones) {
  const v = d.verdict || {};
  const notas = d.row_verification_notes || {};
  const cols = d.columns || [];
  children.push(h(d.title || d.key));
  children.push(p(d.summary));
  children.push(meta(`Verificación independiente: ${v.reviewed ?? '—'} hallazgos revisados · ${v.confirmed ?? '—'} confirmados · ${(v.refuted || []).length} refutados`));

  for (const f of d.findings || []) {
    children.push(new Paragraph({
      spacing: { before: 140, after: 40 },
      children: [
        new TextRun({ text: clean(f.title), bold: true, size: 21 }),
        new TextRun({ text: `   [confianza ${confEs(f.confidence)}]`, size: 17, color: MUTED }),
      ],
    }));
    children.push(p(f.detail));
    if (f.frequency) children.push(meta(`Medición: ${f.frequency}`));
    for (const e of f.evidence || []) {
      children.push(meta(`Evidencia (hilo ${e.thread_id}): "${e.quote}"`));
    }
  }

  if ((d.rows || []).length) {
    const hayNotas = Object.keys(notas).length > 0;
    children.push(table(
      [...cols.map((c) => c.label ?? c.key), ...(hayNotas ? ['Nota de verificación'] : [])],
      (d.rows || []).map((r) => [
        ...cols.map((c) => String(r[c.key] ?? '')),
        ...(hayNotas ? [notas[String(r.n ?? '')] ?? ''] : []),
      ]),
    ));
  }

  if ((v.refuted || []).length) {
    children.push(new Paragraph({
      spacing: { before: 180, after: 80 },
      children: [new TextRun({ text: 'Hallazgos refutados por la verificación (no citar estas cifras)', bold: true, color: RED, size: 21 })],
    }));
    for (const r of v.refuted || []) {
      children.push(p(`✗ ${r.title}`, { bold: true, color: RED }));
      children.push(p(`Por qué no se sostiene: ${r.reason}`));
      if (r.correction) children.push(p(`Corrección: ${r.correction}`));
    }
  }
  if (d.method) children.push(meta(`Método: ${d.method}`));
  if ((d.limitations || []).length) children.push(meta(`Limitaciones: ${(d.limitations || []).join(' · ')}`));
}

// -------------------------------------------------------------- methodology
children.push(h('Metodología y límites'));
children.push(meta(
  `Origen: dump completo del historial exportado desde WAHA (${num(summary.lines_read)} líneas crudas: ${num(summary.messages_included)} al corpus, ` +
  `${num(summary.group_messages_excluded)} de grupos excluidas, ${num(summary.malformed_messages + summary.messages_without_sender)} malformadas o sin remitente). ` +
  `Verificación de suma contra el dump: ${summary.count_check_ok ? 'OK' : 'FALLÓ'}. LIDs: ${num(summary.lids_resolved)} resueltos, ${num(summary.lids_unresolved)} sin resolver; ` +
  `${summary.lid_cus_merges} fusiones de identidad. La mediana de respuesta se ancla al primer mensaje de cada racha entrante; una racha sin respuesta no cuenta. ` +
  `El dump y el corpus quedan en el directorio de salida local; la única transmisión externa posible del pipeline es la de la fase de análisis hacia el proveedor de LLM configurado (ninguna con un motor local).`,
));
for (const w of summary.warnings || []) children.push(meta(`• ${w}`));
children.push(meta('Generado por wa-audit (src/report-docx.mjs). Todos los números se recalculan en cada corrida a partir del corpus; los textos de análisis vienen tal cual del análisis verificado.'));

// ---------------------------------------------------------------- write out
const doc = new Document({
  creator: 'wa-audit',
  title: `${BUSINESS} — Informe de WhatsApp`,
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 21 } },
      heading1: { run: { color: ACCENT, bold: true, size: 30 } },
      heading2: { run: { color: ACCENT, bold: true, size: 24 } },
    },
  },
  sections: [{ children }],
});

const buf = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buf);
console.log(JSON.stringify({
  file: OUT,
  size_kb: +(buf.length / 1024).toFixed(1),
  dimensions_included: dimensiones.map((d) => d.title || d.key),
}, null, 2));
