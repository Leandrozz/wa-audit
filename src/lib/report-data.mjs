/**
 * Shared view-model for every report renderer (XLSX, HTML, DOCX): reads the
 * three contract files, version-checks them, and computes the derived metrics
 * exactly once so the three outputs can never disagree with each other.
 */
import fs from 'node:fs';
import path from 'node:path';

// Presentation maps: the data contract is English, the report is Spanish.
export const TIPO_ES = {
  text: 'texto', image: 'imagen', video: 'video', audio: 'audio',
  voice_note: 'nota de voz', document: 'documento', sticker: 'sticker',
  contact: 'contacto', location: 'ubicación', buttons: 'botones', media: 'media',
};
export const DIR_ES = { inbound: 'entrante', outbound: 'saliente' };
export const CONF_ES = { high: 'alta', medium: 'media', low: 'baja' };
export const tipoEs = (t) => TIPO_ES[t] ?? t;
export const dirEs = (d) => DIR_ES[d] ?? d;
export const confEs = (c) => CONF_ES[c] ?? (c ?? '');

/** "2026-05-14T15:58:38.000-03:00" -> "2026-05-14 15:58" */
export const fechaHora = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '');
export const soloFecha = (iso) => (iso ? iso.slice(0, 10) : '');
export const soloHora = (iso) => (iso ? iso.slice(11, 16) : '');

export function loadReportData(cfg) {
  const DIR = cfg.output.dir;
  const leerJson = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

  const corpusFile = leerJson('threads.json');
  if (corpusFile?.schema_version !== 1 || !Array.isArray(corpusFile.threads)) {
    console.error('threads.json is not schema_version 1 — regenerate the corpus with src/threads.mjs.');
    process.exit(1);
  }
  const threads = corpusFile.threads;
  const summary = leerJson('summary.json');
  if (summary?.schema_version !== 1) {
    console.error('summary.json is not schema_version 1 — regenerate the corpus with src/threads.mjs.');
    process.exit(1);
  }

  let dimensiones = [];
  try {
    const analysis = leerJson('analysis.json');
    if (analysis?.schema_version === 1 && Array.isArray(analysis.dimensions)) {
      dimensiones = analysis.dimensions;
    } else {
      // Present but wrong version: reject loudly, never silently degrade.
      console.error('analysis.json exists but is not schema_version 1 — validate with npm run check:analysis.');
      process.exit(1);
    }
  } catch {
    dimensiones = []; // absent analysis is fine: reports ship without dimension sections
  }
  for (const d of dimensiones) {
    if (!d.verdict) console.warn(`  ! dimension "${d.key ?? d.title}" has no verdict — unverified analysis should not ship`);
  }

  // Locale-driven formatters
  const nf = new Intl.NumberFormat(cfg.locale);
  const nf1 = new Intl.NumberFormat(cfg.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num = (n) => nf.format(n);
  const num1 = (n) => nf1.format(n);
  const pct = (a, b) => (b ? nf1.format((a / b) * 100) + '%' : '—');

  // ------------------------------------------------------------ base metrics
  const convs = threads.slice();
  const totalMensajes = convs.reduce((a, c) => a + c.messages.length, 0);
  const entrantes = convs.reduce((a, c) => a + c.messages.filter((m) => m.direction === 'inbound').length, 0);
  const salientes = totalMensajes - entrantes;

  const porTipo = {};
  const porMes = {};
  let primerIso = null;
  let ultimoIso = null;
  for (const c of convs) {
    for (const m of c.messages) {
      porTipo[m.type] = (porTipo[m.type] || 0) + 1;
      const mes = m.iso.slice(0, 7);
      porMes[mes] = (porMes[mes] || 0) + 1;
      if (!primerIso || m.iso < primerIso) primerIso = m.iso;
      if (!ultimoIso || m.iso > ultimoIso) ultimoIso = m.iso;
    }
  }
  const mesesOrdenados = Object.keys(porMes).sort();

  // Active-window auto-detection: the shortest contiguous suffix of months
  // that concentrates >= WINDOW_THRESHOLD of the volume. Months before it are
  // residual traffic and any "per month" average over the full range would
  // lie. Computed, never hardcoded.
  const WINDOW_THRESHOLD = 0.95;
  let ventanaDesdeIdx = 0;
  {
    let acc = 0;
    for (let i = mesesOrdenados.length - 1; i >= 0; i--) {
      acc += porMes[mesesOrdenados[i]];
      if (totalMensajes > 0 && acc / totalMensajes >= WINDOW_THRESHOLD) { ventanaDesdeIdx = i; break; }
    }
  }
  const mesInicioVentana = mesesOrdenados[ventanaDesdeIdx] ?? null;
  // Calendar spans, not months-with-traffic: a dormant month inside the range
  // still counts toward any honest "per month" divisor.
  const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  const ultimoMes = mesesOrdenados[mesesOrdenados.length - 1] ?? null;
  const mesesCalendario = ultimoMes ? monthIndex(ultimoMes) - monthIndex(mesesOrdenados[0]) + 1 : 0;
  const mesesVentana = ultimoMes && mesInicioVentana ? monthIndex(ultimoMes) - monthIndex(mesInicioVentana) + 1 : 0;
  const mensajesResiduales = mesesOrdenados
    .slice(0, ventanaDesdeIdx)
    .reduce((a, m) => a + porMes[m], 0);
  const hayResidual = ventanaDesdeIdx > 0;

  const convsReales = convs.filter((c) => !c.is_system && !c.is_internal);
  const numSistema = convs.filter((c) => c.is_system).length;
  const conCrm = convs.filter((c) => c.crm).length;
  const sinResponder = convs.filter((c) => c.metrics.unanswered).length;
  const idaYVuelta = convs.filter((c) => c.metrics.two_way).length;
  const conMedia = convs.reduce((a, c) => a + c.metrics.with_media, 0);
  const lidSinResolver = convs.filter((c) => c.unresolved_lid).length;

  const medianas = convs
    .map((c) => c.metrics.median_response_min)
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b);
  const medianaGlobal = medianas.length ? medianas[Math.floor(medianas.length / 2)] : null;

  // Top findings across all dimensions (critical/alert first, then high
  // confidence). Keyword heuristic over finding titles (ES and EN spellings)
  // — documented, deliberately simple.
  const todosHallazgos = [];
  for (const d of dimensiones) {
    for (const h of d.findings || []) todosHallazgos.push({ ...h, _dim: d.title || d.key });
  }
  const prioridad = (h) => {
    const t = (h.title || '').toUpperCase();
    if (t.includes('CRÍTIC') || t.includes('CRITIC')) return 0;
    if (t.startsWith('ALERTA') || t.startsWith('ALERT')) return 1;
    if (h.confidence === 'high') return 2;
    return 3;
  };
  const top10 = todosHallazgos
    .map((h, i) => ({ h, i }))
    .sort((a, b) => prioridad(a.h) - prioridad(b.h) || a.i - b.i)
    .slice(0, 10)
    .map((x) => x.h);

  return {
    dir: DIR,
    threads, summary, dimensiones,
    convs, totalMensajes, entrantes, salientes,
    porTipo, porMes, mesesOrdenados,
    primerIso, ultimoIso,
    hayResidual, mesInicioVentana, mesesVentana, mesesCalendario, mensajesResiduales,
    convsReales, numSistema, conCrm, sinResponder, idaYVuelta, conMedia, lidSinResolver,
    medianaGlobal, top10,
    num, num1, pct,
  };
}
