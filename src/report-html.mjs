#!/usr/bin/env node
/**
 * report-html.mjs — Self-contained HTML report from the corpus + analysis.
 * Same contract and numbers as the XLSX (both consume src/lib/report-data.mjs);
 * this one is the shareable/linkable artifact.
 *
 * Usage: node src/report-html.mjs
 * Output: <output.dir>/<report.filename with .html extension>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { loadReportData, tipoEs, dirEs, confEs, fechaHora, soloFecha } from './lib/report-data.mjs';

const cfg = loadConfig();
const BUSINESS = cfg.business.name;
const D = loadReportData(cfg);
const {
  summary, dimensiones, convs, totalMensajes, entrantes, salientes,
  porTipo, porMes, mesesOrdenados, primerIso, ultimoIso,
  hayResidual, mesInicioVentana, mesesVentana, mesesCalendario, mensajesResiduales,
  convsReales, numSistema, conCrm, sinResponder, idaYVuelta, conMedia,
  medianaGlobal, top10, num, num1, pct,
} = D;

const OUT = path.join(D.dir, path.basename(cfg.report.filename, path.extname(cfg.report.filename)) + '.html');

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const maxMes = Math.max(...mesesOrdenados.map((m) => porMes[m]), 1);

const kpi = (label, value, note = '') => `
  <div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${esc(label)}</div>${note ? `<div class="kpi-n">${esc(note)}</div>` : ''}</div>`;

const confBadge = (c) => `<span class="badge conf-${esc(c ?? 'low')}">${esc(confEs(c))}</span>`;

const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(BUSINESS)} — Informe de WhatsApp</title>
<style>
  :root { --ink:#1c2733; --muted:#5b6b7b; --line:#e3e8ee; --accent:#1F3864; --bad:#b42318; --ok:#067647; --warn:#b54708; --bg:#f7f9fb; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); }
  .wrap { max-width:960px; margin:0 auto; padding:32px 20px 60px; }
  header.top { border-bottom:3px solid var(--accent); padding-bottom:16px; margin-bottom:24px; }
  h1 { font-size:26px; margin:0 0 4px; color:var(--accent); }
  .sub { color:var(--muted); font-size:13px; }
  h2 { font-size:19px; margin:36px 0 12px; color:var(--accent); }
  h3 { font-size:15px; margin:20px 0 8px; }
  .callout { background:#fff8e6; border:1px solid #f0d489; border-left:5px solid var(--warn); padding:14px 16px; border-radius:6px; margin:18px 0; }
  .callout b { color:var(--warn); }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:16px 0; }
  .kpi { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .kpi-v { font-size:22px; font-weight:700; }
  .kpi-l { font-size:12px; color:var(--muted); margin-top:2px; }
  .kpi-n { font-size:11px; color:var(--muted); margin-top:4px; }
  table { border-collapse:collapse; width:100%; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; font-size:13.5px; }
  th { background:var(--accent); color:#fff; text-align:left; padding:8px 10px; font-weight:600; }
  td { padding:8px 10px; border-top:1px solid var(--line); vertical-align:top; }
  .tablewrap { overflow-x:auto; margin:10px 0; }
  .bar { background:#dce6f5; height:14px; border-radius:3px; }
  .bar > i { display:block; height:100%; background:var(--accent); border-radius:3px; }
  .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:10px; font-weight:600; }
  .conf-high { background:#e6f4ea; color:var(--ok); }
  .conf-medium { background:#fff4e5; color:var(--warn); }
  .conf-low { background:#f1f3f5; color:var(--muted); }
  .finding { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:10px 0; }
  .finding h4 { margin:0 0 6px; font-size:14.5px; }
  .refuted { border-left:5px solid var(--bad); }
  .refuted h4 { color:var(--bad); }
  .evidence { font-size:12.5px; color:var(--muted); margin-top:8px; }
  .evidence code { background:var(--bg); padding:1px 5px; border-radius:4px; }
  .meta { font-size:13px; color:var(--muted); }
  .verdictline { font-size:13px; margin:8px 0 14px; }
  .verdictline b.r { color:var(--bad); }
  footer { margin-top:48px; border-top:1px solid var(--line); padding-top:14px; font-size:12px; color:var(--muted); }
  @media print { body { background:#fff; } .kpi, .finding, table { border-color:#ccc; } }
</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <h1>${esc(BUSINESS)} — Historial de WhatsApp: informe maestro</h1>
  <div class="sub">Generado el ${new Date().toISOString().slice(0, 10)} · sesión WAHA ${esc(summary.session)} · ${num(summary.lines_read)} mensajes crudos leídos</div>
</header>

${hayResidual ? `
<div class="callout">
  <b>LEER PRIMERO — el rango de fechas engaña.</b>
  El historial va del ${soloFecha(primerIso)} al ${soloFecha(ultimoIso)} (${mesesCalendario} meses calendario), pero NO es actividad pareja.
  Antes de ${esc(mesInicioVentana)} hay apenas ${num(mensajesResiduales)} mensajes en todo el dump (actividad residual).
  El ${pct(totalMensajes - mensajesResiduales, totalMensajes)} del volumen está concentrado en los ${mesesVentana} meses desde ${esc(mesInicioVentana)}.
  Cualquier promedio "por mes" sobre el rango completo es falso: dividir por ${mesesVentana}, no por ${mesesCalendario}.
</div>` : ''}

<h2>Volumen y alcance</h2>
<div class="kpis">
  ${kpi('Mensajes en el corpus (1 a 1)', num(totalMensajes), 'Excluye grupos')}
  ${kpi('Conversaciones', num(convs.length), `${num(convsReales.length)} de clientes reales`)}
  ${kpi('Entrantes (del cliente)', `${num(entrantes)}`, pct(entrantes, totalMensajes))}
  ${kpi('Salientes (del negocio)', `${num(salientes)}`, pct(salientes, totalMensajes))}
  ${kpi('Con ida y vuelta', `${num(idaYVuelta)}`, pct(idaYVuelta, convs.length))}
  ${kpi('Sin responder', `${num(sinResponder)}`, 'El último mensaje es del cliente')}
  ${kpi('Mediana de respuesta', summary.global_median_response_min != null ? `${num1(summary.global_median_response_min)} min` : '—', medianaGlobal != null ? `mediana de medianas: ${num1(medianaGlobal)} min` : '')}
  ${kpi('Con adjunto', `${num(conMedia)}`, pct(conMedia, totalMensajes))}
</div>
<p class="meta">Salientes incluye tanto personas como cualquier bot que haya respondido desde este número (el dump no los distingue). ${summary.internal_threads} conversación/es internas y ${numSistema} pseudo-contacto/s del sistema quedan marcadas aparte.</p>

<h2>Volumen por mes</h2>
<div class="tablewrap"><table>
<tr><th>Mes</th><th>Mensajes</th><th style="width:45%"></th><th>Comentario</th></tr>
${mesesOrdenados.map((m) => `<tr><td>${esc(m)}</td><td>${num(porMes[m])}</td><td><div class="bar"><i style="width:${Math.round((porMes[m] / maxMes) * 100)}%"></i></div></td><td class="meta">${hayResidual && m < mesInicioVentana ? 'Actividad residual, no es un mes de operación' : ''}</td></tr>`).join('\n')}
</table></div>

<h2>Qué tipo de mensajes son</h2>
<div class="tablewrap"><table>
<tr><th>Tipo</th><th>Cantidad</th><th>% del corpus</th></tr>
${Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<tr><td>${esc(tipoEs(t))}</td><td>${num(n)}</td><td>${pct(n, totalMensajes)}</td></tr>`).join('\n')}
</table></div>

<h2>Cruce con el CRM</h2>
<p>${summary.crm_available
    ? `Matchearon <b>${num(summary.crm_matches)}</b> de las ${num(convs.length)} conversaciones (${pct(summary.crm_matches, convs.length)}). El resto son números no cargados en el CRM o cargados con otro formato.`
    : 'No hubo CRM disponible en esta corrida: el corpus no tiene cruce con cartera de clientes.'}</p>

<h2>Los ${top10.length} hallazgos más importantes</h2>
${dimensiones.length === 0 ? '<div class="callout"><b>ADVERTENCIA:</b> no llegó ningún análisis de dimensiones al armar este informe. Correr la fase de análisis y regenerar.</div>' : ''}
${top10.map((h, i) => `
<div class="finding">
  <h4>${i + 1}. ${esc(h.title)} <span class="meta">· ${esc(h._dim)}</span> ${confBadge(h.confidence)}</h4>
  <div>${esc(h.detail)}</div>
  ${h.frequency ? `<div class="meta">Medición: ${esc(h.frequency)}</div>` : ''}
</div>`).join('\n')}

${dimensiones.map((d) => {
  const v = d.verdict || {};
  const notas = d.row_verification_notes || {};
  const cols = d.columns || [];
  return `
<h2>${esc(d.title || d.key)}</h2>
<p>${esc(d.summary)}</p>
<div class="verdictline">Verificación independiente: <b>${v.reviewed ?? '—'}</b> hallazgos revisados · <b>${v.confirmed ?? '—'}</b> confirmados · <b class="r">${(v.refuted || []).length} refutados</b></div>
${(d.findings || []).map((h) => `
<div class="finding">
  <h4>${esc(h.title)} ${confBadge(h.confidence)}</h4>
  <div>${esc(h.detail)}</div>
  ${h.frequency ? `<div class="meta">Medición: ${esc(h.frequency)}</div>` : ''}
  ${(h.evidence || []).length ? `<div class="evidence">Evidencia: ${(h.evidence || []).map((e) => `<code>${esc(e.quote)}</code> <span>(hilo ${esc(e.thread_id)})</span>`).join(' · ')}</div>` : ''}
</div>`).join('\n')}
${(d.rows || []).length ? `
<div class="tablewrap"><table>
<tr>${cols.map((c) => `<th>${esc(c.label ?? c.key)}</th>`).join('')}${Object.keys(notas).length ? '<th>Nota de verificación</th>' : ''}</tr>
${(d.rows || []).map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c.key] ?? '')}</td>`).join('')}${Object.keys(notas).length ? `<td class="meta">${esc(notas[String(r.n ?? '')] ?? '')}</td>` : ''}</tr>`).join('\n')}
</table></div>` : ''}
${(v.refuted || []).length ? `
<h3>Hallazgos refutados por la verificación (no citar estas cifras)</h3>
${(v.refuted || []).map((r) => `
<div class="finding refuted">
  <h4>✗ ${esc(r.title)}</h4>
  <div><b>Por qué no se sostiene:</b> ${esc(r.reason)}</div>
  ${r.correction ? `<div><b>Corrección:</b> ${esc(r.correction)}</div>` : ''}
</div>`).join('\n')}` : ''}
${d.method ? `<p class="meta"><b>Método:</b> ${esc(d.method)}</p>` : ''}
${(d.limitations || []).length ? `<p class="meta"><b>Limitaciones:</b> ${(d.limitations || []).map(esc).join(' · ')}</p>` : ''}`;
}).join('\n')}

<h2>Metodología y límites</h2>
<p class="meta">El origen es un dump completo del historial exportado desde WAHA (${num(summary.lines_read)} líneas crudas: ${num(summary.messages_included)} al corpus, ${num(summary.group_messages_excluded)} de grupos excluidas, ${num(summary.malformed_messages + summary.messages_without_sender)} malformadas o sin remitente). Verificación de suma contra el dump: <b>${summary.count_check_ok ? 'OK' : 'FALLÓ'}</b>. LIDs: ${num(summary.lids_resolved)} resueltos, ${num(summary.lids_unresolved)} sin resolver; ${summary.lid_cus_merges} fusiones de identidad. La mediana de respuesta se ancla al primer mensaje de cada racha entrante; una racha sin respuesta no cuenta. El dump y el corpus quedan en el directorio de salida local; la única transmisión externa posible del pipeline es la de la fase de análisis hacia el proveedor de LLM configurado (ninguna con un motor local). Cada dimensión pasó por un verificador independiente; los hallazgos refutados quedan registrados arriba para que nadie vuelva a citar los números viejos.</p>
${(summary.warnings || []).length ? `<h3>Advertencias de la corrida</h3><ul class="meta">${(summary.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}

<footer>
  Generado por <b>wa-audit</b> (src/report-html.mjs) leyendo threads.json, summary.json y analysis.json. Todos los números se recalculan en cada corrida a partir del corpus; los textos de análisis vienen tal cual del análisis verificado.
</footer>

</div>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
const tam = fs.statSync(OUT).size;
console.log(JSON.stringify({
  file: OUT,
  size_kb: +(tam / 1024).toFixed(1),
  dimensions_included: dimensiones.map((d) => d.title || d.key),
  refuted_total: dimensiones.reduce((a, d) => a + (d.verdict?.refuted?.length ?? 0), 0),
}, null, 2));
