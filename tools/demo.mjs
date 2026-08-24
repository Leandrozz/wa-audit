/**
 * npm run demo — the whole pipeline, end to end, in about a minute, with
 * ZERO external requirements: no WhatsApp, no WAHA instance, no LLM key, no
 * network. Synthetic fixture + mock WAHA + mock LLM.
 *
 * Leaves the result in out/demo/ — open out/demo/whatsapp-report.xlsx.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'demo');
const PORT = 8433;

const env = {
  ...process.env,
  WAHA_BASE_URL: `http://localhost:${PORT}`,
  WAHA_API_KEY: 'demo',
  WA_OUT_DIR: OUT,
  WA_BUSINESS_NAME: 'Demo Industrial SRL',
  WA_INTERNAL_EMAIL_DOMAINS: 'fixture-internal.test',
  WA_CRM_FILE: path.join(ROOT, 'fixtures', 'waha-dump', 'crm.csv'),
  WA_LLM_PROVIDER: 'mock',
  WA_LLM_CANNED_DIR: path.join(ROOT, 'fixtures', 'llm-canned'),
};

function step(title, script, args = []) {
  console.log(`\n━━━ ${title} ━━━`);
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT, env, stdio: 'inherit', timeout: 180_000,
  });
  if (r.status !== 0) {
    console.error(`\n✗ ${script} failed (exit ${r.status})`);
    process.exit(1);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

step('0. Generate synthetic fixture', 'fixtures/generate.mjs');

console.log(`\n━━━ starting mock WAHA on :${PORT} ━━━`);
const mock = spawn(process.execPath, [path.join(ROOT, 'fixtures', 'mock-waha.mjs'), String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
});
await new Promise((r) => setTimeout(r, 800));

try {
  step('1. Probe the (mock) WAHA instance', 'src/probe.mjs');
  step('2. Export the raw history', 'src/export.mjs', ['fixture']);
  step('3. Build the clean corpus', 'src/threads.mjs', ['--session', 'fixture']);
  step('4. Analyze + verify (mock LLM)', 'src/analyze.mjs', ['--dimensions', 'frequent_questions,ops_response_times']);
  step('4b. Validate the analysis contract', 'tools/check-analysis.mjs');
  step('5. Build the XLSX report', 'src/report-xlsx.mjs');
  step('5b. Build the HTML report', 'src/report-html.mjs');
  step('5c. Build the Word report', 'src/report-docx.mjs');
} finally {
  mock.kill();
}

console.log(`\n✓ Demo complete. Open any of:`);
console.log(`  ${path.join(OUT, 'whatsapp-report.xlsx')}`);
console.log(`  ${path.join(OUT, 'whatsapp-report.html')}`);
console.log(`  ${path.join(OUT, 'whatsapp-report.docx')}`);
console.log('  Everything you just saw ran locally: synthetic data, mock WAHA, mock LLM.');
console.log('  Against a real WAHA instance the flow is identical — see README quickstart.');
