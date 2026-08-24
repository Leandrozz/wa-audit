/**
 * Shared test harness: runs the pipeline lanes the tests (and the golden
 * recorder) assert against. Keeping the lane logic here means the golden file
 * is recorded and verified through the exact same code path.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DUMP = path.join(ROOT, 'fixtures', 'waha-dump');

export const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'wa-audit-'));

/** Env for pipeline runs: fixture knobs on, inherited WAHA_* off. */
export function pipelineEnv(outDir, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.WAHA_BASE_URL;
  delete env.WAHA_API_KEY;
  delete env.WAHA_BASIC_AUTH;
  delete env.WAHA_SESSION;
  return {
    ...env,
    WA_OUT_DIR: outDir,
    WA_INTERNAL_EMAIL_DOMAINS: 'fixture-internal.test',
    WA_CRM_FILE: path.join(DUMP, 'crm.csv'),
    WA_BUSINESS_NAME: 'Demo Industrial SRL',
    ...extra,
  };
}

export function run(script, { args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

/** Strips run-dependent fields so summaries are comparable across machines. */
export function stableSummary(summary) {
  const { generated_at, source, ...rest } = summary;
  return rest;
}

export function stableReport(reportJson) {
  const sheets = {};
  for (const [name, v] of Object.entries(reportJson.sheets)) sheets[name] = v;
  return {
    sheets,
    transcripts_match: reportJson.transcripts_match,
    threads_match: reportJson.threads_match,
    truncated_cells: reportJson.truncated_cells,
    dimensions_included: reportJson.dimensions_included,
  };
}

/**
 * Direct lane: threads --no-net over the committed fixture (with the lid cache
 * prefilled from lid-truth), then the XLSX report. Exercises the malformed
 * line and the no-sender message, which the mock cannot serve.
 */
export function runDirectLane() {
  const out = tmpDir();
  copyFileSync(path.join(DUMP, 'messages.jsonl'), path.join(out, 'messages.jsonl'));
  const truth = readJson(path.join(DUMP, 'lid-truth.json'));
  writeFileSync(path.join(out, 'lid-cache.json'), JSON.stringify(truth.lids, null, 2));

  const threads = run('src/threads.mjs', { args: ['--session', 'fixture', '--no-net'], env: pipelineEnv(out) });
  if (threads.status !== 0) throw new Error(`threads failed:\n${threads.stdout}\n${threads.stderr}`);

  copyFileSync(path.join(ROOT, 'fixtures', 'analysis-sample.json'), path.join(out, 'analysis.json'));
  const report = run('src/report-xlsx.mjs', { env: pipelineEnv(out) });
  if (report.status !== 0) throw new Error(`report failed:\n${report.stdout}\n${report.stderr}`);

  return {
    out,
    summary: readJson(path.join(out, 'summary.json')),
    threads: readJson(path.join(out, 'threads.json')),
    report: JSON.parse(report.stdout),
    xlsxPath: path.join(out, 'whatsapp-report.xlsx'),
  };
}

/** Starts the mock WAHA server; resolves once it listens. */
export function startMock(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'fixtures', 'mock-waha.mjs'), String(port)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('mock-waha did not start')); }, 10_000);
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('listening')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock-waha exited early (${code}): ${buf}`)); });
  });
}

/**
 * Mock lane: probe + export + threads WITH network against the mock server.
 * Exercises pagination, the empty-page stop rule and live @lid resolution.
 */
export async function runMockLane(port = 8399) {
  const mock = await startMock(port);
  try {
    const wahaEnv = { WAHA_BASE_URL: `http://localhost:${port}`, WAHA_API_KEY: 'test' };
    const out = tmpDir();

    const probe = run('src/probe.mjs', { env: pipelineEnv(out, wahaEnv) });
    if (probe.status !== 0) throw new Error(`probe failed:\n${probe.stdout}\n${probe.stderr}`);

    const exp = run('src/export.mjs', { args: ['fixture'], env: pipelineEnv(out, wahaEnv) });
    if (exp.status !== 0) throw new Error(`export failed:\n${exp.stdout}\n${exp.stderr}`);
    const exportedLines = readFileSync(path.join(out, 'messages.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).length;

    const threads = run('src/threads.mjs', { args: ['--session', 'fixture'], env: pipelineEnv(out, wahaEnv) });
    if (threads.status !== 0) throw new Error(`threads failed:\n${threads.stdout}\n${threads.stderr}`);

    return {
      out,
      probeStdout: probe.stdout,
      exportedLines,
      summary: readJson(path.join(out, 'summary.json')),
    };
  } finally {
    mock.kill();
  }
}
