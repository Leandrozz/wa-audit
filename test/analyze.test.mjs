import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, run, runDirectLane, pipelineEnv } from './harness.mjs';

const CANNED = path.join(ROOT, 'fixtures', 'llm-canned');

test('analysis engine: mock provider + two-layer verifier + schema-valid output', () => {
  const lane = runDirectLane(); // produces threads.json + summary.json in lane.out
  const env = pipelineEnv(lane.out, { WA_LLM_PROVIDER: 'mock', WA_LLM_CANNED_DIR: CANNED });

  const analyze = run('src/analyze.mjs', {
    args: ['--dimensions', 'frequent_questions,ops_response_times'],
    env,
  });
  assert.equal(analyze.status, 0, `analyze failed:\n${analyze.stdout}\n${analyze.stderr}`);

  const analysis = JSON.parse(readFileSync(path.join(lane.out, 'analysis.json'), 'utf8'));
  assert.equal(analysis.schema_version, 1);
  assert.equal(analysis.dimensions.length, 2);

  const fq = analysis.dimensions.find((d) => d.key === 'frequent_questions');
  assert.equal(fq.title, 'Preguntas frecuentes reales'); // title comes from the prompt file

  // Layer A (code) must refute the finding whose quote does not exist in the corpus.
  const codeRefutation = fq.verdict.refuted.find((r) => r.title === 'Los clientes piden facturación A');
  assert.ok(codeRefutation, 'fabricated-evidence finding was refuted');
  assert.match(codeRefutation.reason, /no existe textualmente/);

  // Layer B (LLM verifier) must refute the overclaim, via the canned verdict.
  const llmRefutation = fq.verdict.refuted.find((r) => r.title === 'Los pedidos urgentes dominan el canal');
  assert.ok(llmRefutation, 'overclaimed finding was refuted by the verifier');

  // Refuted findings are gone from findings, and the arithmetic closes.
  assert.equal(fq.verdict.reviewed, 4);
  assert.equal(fq.verdict.refuted.length, 2);
  assert.equal(fq.verdict.confirmed, 2);
  assert.equal(fq.findings.length, 2);
  const titles = fq.findings.map((f) => f.title);
  assert.ok(!titles.includes('Los clientes piden facturación A'));
  assert.ok(!titles.includes('Los pedidos urgentes dominan el canal'));

  const ops = analysis.dimensions.find((d) => d.key === 'ops_response_times');
  assert.equal(ops.verdict.refuted.length, 0);
  assert.ok(Object.keys(ops.row_verification_notes).length > 0);

  // The engine output must satisfy the public contract...
  const check = run('tools/check-analysis.mjs', { env });
  assert.equal(check.status, 0, `check:analysis failed:\n${check.stdout}\n${check.stderr}`);

  // ...and feed the report generator without any hand-editing.
  const report = run('src/report-xlsx.mjs', { env });
  assert.equal(report.status, 0, `report failed:\n${report.stdout}\n${report.stderr}`);
  const info = JSON.parse(report.stdout);
  assert.ok(info.dimensions_included.includes('Preguntas frecuentes reales'));
});

test('FATE dimension: business context injected, multi-line digest quote survives layer A', () => {
  const lane = runDirectLane();
  copyFileSync(
    path.join(ROOT, 'analysis', 'business-context.example.json'),
    path.join(lane.out, 'business-context.json'),
  );
  const env = pipelineEnv(lane.out, { WA_LLM_PROVIDER: 'mock', WA_LLM_CANNED_DIR: CANNED });

  const analyze = run('src/analyze.mjs', { args: ['--dimensions', 'fate_focus'], env });
  assert.equal(analyze.status, 0, `analyze failed:\n${analyze.stdout}\n${analyze.stderr}`);
  assert.match(analyze.stdout, /Business context loaded/);

  const analysis = JSON.parse(readFileSync(path.join(lane.out, 'analysis.json'), 'utf8'));
  const fate = analysis.dimensions.find((d) => d.key === 'fate_focus');
  assert.equal(fate.title, 'FATE · Foco — captura y retención de atención');

  // The quotation-template quote crosses a line break: the digest renders it
  // with the return marker, and layer A must still verify it against the
  // corpus (regression test for the quote-normalization fix).
  const template = fate.findings.find((f) => f.title.includes('plantilla'));
  assert.ok(template, 'multi-line-quote finding survived the code verifier');
  assert.equal(fate.verdict.refuted.length, 0);
  assert.equal(fate.verdict.reviewed, 2);
  assert.equal(fate.verdict.confirmed, 2);
});
