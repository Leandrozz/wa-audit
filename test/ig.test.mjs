import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, run, tmpDir, pipelineEnv } from './harness.mjs';
import { igFixture, OWN_ID } from '../fixtures/mock-ig.mjs';

const PORT = 8439;

function startMockIg(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'fixtures', 'mock-ig.mjs'), String(PORT), ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('mock-ig did not start')); }, 10_000);
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('listening')) { clearTimeout(timer); resolve(child); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock-ig exited early (${code}): ${buf}`)); });
  });
}

const igEnv = (out, extra = {}) => pipelineEnv(out, {
  IG_BASE_URL: `http://localhost:${PORT}`,
  IG_SESSION_ID: 'test-session',
  IG_DS_USER_ID: OWN_ID,
  ...extra,
});

test('IG lane: export maps the private-API shapes onto the corpus contract', async () => {
  const fix = igFixture();
  const oneToOne = fix.threads.filter((t) => !t.is_group);
  const expectedLines = oneToOne.reduce((a, t) => a + t.items.length, 0);

  const mock = await startMockIg();
  try {
    const out = tmpDir();
    const exp = run('src/export-ig.mjs', { env: igEnv(out) });
    assert.equal(exp.status, 0, `export-ig failed:\n${exp.stdout}\n${exp.stderr}`);
    assert.match(exp.stdout, /skipped 1 group thread/);

    const lines = readFileSync(path.join(out, 'messages.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.equal(lines.length, expectedLines, 'every 1:1 fixture item exported');

    for (const m of lines) {
      assert.match(m.from, /^\d+@ig$/, '`from` is the counterparty pk@ig in BOTH directions');
      assert.ok(Number.isInteger(m.timestamp) && m.timestamp < 20_000_000_000,
        `timestamp in seconds, not microseconds: ${m.timestamp}`);
      assert.equal(typeof m.fromMe, 'boolean');
    }
    // Direction: own user id → fromMe, counterparty stays in `from`.
    const own = lines.filter((m) => m.fromMe);
    assert.equal(own.length, 3, 'three outbound fixture items');
    assert.ok(own.every((m) => !m.from.startsWith(OWN_ID)), 'own id never lands in `from`');
    // Voice note maps to audioMessage{ptt:true}; inbound carries pushName.
    const voice = lines.find((m) => m._data?.message?.audioMessage);
    assert.ok(voice && voice._data.message.audioMessage.ptt === true, 'voice_media → audioMessage{ptt:true}');
    const withName = lines.filter((m) => !m.fromMe && m._data?.pushName);
    assert.ok(withName.length > 0, 'inbound lines carry the IG username as pushName');
    assert.ok(existsSync(path.join(out, 'ig-export-state.json')), 'resume state written');
  } finally { mock.kill(); }
});
