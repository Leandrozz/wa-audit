import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import CFB from 'cfb';
import { run, runDirectLane, pipelineEnv } from './harness.mjs';

test('HTML and DOCX renderers produce consistent output from the same contract', () => {
  const lane = runDirectLane(); // corpus + analysis-sample + xlsx already green
  const env = pipelineEnv(lane.out);

  const html = run('src/report-html.mjs', { env });
  assert.equal(html.status, 0, `html failed:\n${html.stdout}\n${html.stderr}`);
  const htmlInfo = JSON.parse(html.stdout);
  const page = readFileSync(path.join(lane.out, 'whatsapp-report.html'), 'utf8');
  assert.ok(page.includes('Demo Industrial SRL'), 'business name rendered');
  assert.ok(page.includes('LEER PRIMERO'), 'residual-window callout rendered');
  assert.ok(page.includes('Hallazgos refutados por la verificación'), 'refuted section rendered');
  assert.ok(page.includes('Los clientes preguntan por formas de pago'), 'refuted finding listed');
  assert.ok(!/<script/i.test(page), 'report HTML carries no scripts');
  assert.equal(htmlInfo.refuted_total, 2);

  const docx = run('src/report-docx.mjs', { env });
  assert.equal(docx.status, 0, `docx failed:\n${docx.stdout}\n${docx.stderr}`);
  // .docx is a ZIP: the document body must exist and carry the same content markers.
  const cfb = CFB.read(readFileSync(path.join(lane.out, 'whatsapp-report.docx')), { type: 'buffer' });
  const body = Buffer.from(CFB.find(cfb, '/word/document.xml').content).toString('utf8');
  assert.ok(body.includes('Demo Industrial SRL'), 'business name in docx');
  assert.ok(body.includes('Preguntas frecuentes reales'), 'dimension title in docx');
  assert.ok(body.includes('refutados'), 'verdict line in docx');
});
