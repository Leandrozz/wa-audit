import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, run, tmpDir, pipelineEnv } from './harness.mjs';
import { eligibleFixtureMessages } from '../fixtures/mock-kapso.mjs';
import { normalizeJid } from '../src/lib/phone.mjs';

const PORT = 8437;

function startMockKapso() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'fixtures', 'mock-kapso.mjs'), String(PORT)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('mock-kapso did not start')); }, 10_000);
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('listening')) { clearTimeout(timer); resolve(child); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock-kapso exited early (${code}): ${buf}`)); });
  });
}

test('Kapso lane (official API): export + corpus, no @lid, per-direction preserved', async () => {
  const eligible = eligibleFixtureMessages();
  const expectedThreads = new Set(eligible.map((m) => normalizeJid(m.from.split('@')[0]))).size;

  const mock = await startMockKapso();
  try {
    const out = tmpDir();
    const env = pipelineEnv(out, {
      KAPSO_API_KEY: 'test',
      KAPSO_PHONE_NUMBER_ID: 'fixture-pn',
      KAPSO_BASE_URL: `http://localhost:${PORT}`,
    });

    const exp = run('src/export-kapso.mjs', { env });
    assert.equal(exp.status, 0, `export-kapso failed:\n${exp.stdout}\n${exp.stderr}`);
    const lines = readFileSync(path.join(out, 'messages.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, eligible.length, 'every eligible fixture message exported');

    const threads = run('src/threads.mjs', { args: ['--session', 'kapso', '--no-net'], env });
    assert.equal(threads.status, 0, `threads failed:\n${threads.stdout}\n${threads.stderr}`);
    const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.equal(summary.count_check_ok, true);
    assert.equal(summary.lid_jids, 0, 'official API carries no @lid');
    assert.equal(summary.malformed_messages, 0);
    assert.equal(summary.threads, expectedThreads);

    const corpus = JSON.parse(readFileSync(path.join(out, 'threads.json'), 'utf8'));
    const ana = corpus.threads.find((t) => t.thread_id === '5491155501234');
    assert.ok(ana, 'known contact threads correctly');
    assert.ok(ana.metrics.inbound > 0 && ana.metrics.outbound > 0, 'both directions survive the mapping');
  } finally {
    mock.kill();
  }
});
