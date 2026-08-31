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

test('IG lane: a broader rerun refuses to resume over narrower --since state (review round 1)', async () => {
  const mock = await startMockIg();
  try {
    const out = tmpDir();
    const stateFile = path.join(out, 'ig-export-state.json');
    const messagesFile = path.join(out, 'messages.jsonl');
    const readLines = () => existsSync(messagesFile)
      ? readFileSync(messagesFile, 'utf8').split('\n').filter((l) => l.trim())
      : [];

    // 1) Narrow run: the fixture is over a year old, so --since 100 (days) excludes
    // every message. Every 1:1 thread still gets walked and marked "done" — correctly,
    // since there's genuinely nothing newer than the cutoff to fetch.
    const narrow = run('src/export-ig.mjs', { args: ['--since', '100'], env: igEnv(out) });
    assert.equal(narrow.status, 0, `narrow export failed:\n${narrow.stdout}\n${narrow.stderr}`);
    assert.equal(readLines().length, 0, 'the --since window excludes every fixture message');
    const state1 = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state1.done.length, 3, 'all 3 one-to-one threads marked done');
    assert.ok(state1.since_sec > 0, 'the narrow run records its cutoff in state');

    // 2) Broader rerun, same output dir, no --since: the 8 real fixture messages sit
    // BEHIND the old cutoff. Resuming would skip them silently (they're all in `done`
    // already). This must refuse loudly instead — and before any throttled request,
    // which a tight wall-clock bound on this call proves (a real request costs >=3s).
    const t0 = Date.now();
    const broad = run('src/export-ig.mjs', { env: igEnv(out) });
    const elapsedMs = Date.now() - t0;
    assert.equal(broad.status, 1, 'a broader rerun over narrower resume state must fail loudly');
    const msg = broad.stdout + broad.stderr;
    assert.match(msg, /further back/i, 'explains the window mismatch');
    assert.match(msg, /silent data loss/i, 'names the risk being refused');
    assert.match(msg, /rerun with the same/i, 'gives remediation option 1 (same/narrower --since)');
    assert.match(msg, /ig-export-state\.json/, 'gives remediation option 2 (wipe state for a fresh export)');
    assert.ok(elapsedMs < 2500, `refusal must happen before the first throttled request (took ${elapsedMs}ms)`);
    assert.equal(readLines().length, 0, 'refused run appended nothing to messages.jsonl');
    const state2 = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state2, state1, 'refused run never touched the state file');

    // 3) Same window again: the legitimate resume path stays open (no false refusal).
    const again = run('src/export-ig.mjs', { args: ['--since', '100'], env: igEnv(out) });
    assert.equal(again.status, 0, `same-window rerun should still resume cleanly:\n${again.stdout}\n${again.stderr}`);
  } finally { mock.kill(); }
});

test('IG lane: corpus keys @ig by user id — never as a phone number', async () => {
  const fix = igFixture();
  const oneToOne = fix.threads.filter((t) => !t.is_group);

  const mock = await startMockIg();
  let out;
  try {
    out = tmpDir();
    const exp = run('src/export-ig.mjs', { env: igEnv(out) });
    assert.equal(exp.status, 0, `export-ig failed:\n${exp.stdout}\n${exp.stderr}`);
  } finally { mock.kill(); }

  const threads = run('src/threads.mjs', { args: ['--session', 'ig', '--no-net'], env: igEnv(out) });
  assert.equal(threads.status, 0, `threads failed:\n${threads.stdout}\n${threads.stderr}`);

  const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.count_check_ok, true);
  assert.equal(summary.threads, oneToOne.length);
  assert.equal(summary.lids_unresolved, 0, '@ig must never be mistaken for an unresolved @lid');
  assert.equal(summary.channel, 'instagram');

  const corpus = JSON.parse(readFileSync(path.join(out, 'threads.json'), 'utf8'));
  for (const t of corpus.threads) {
    assert.match(t.thread_id, /^ig:\d+$/, `IG thread key: ${t.thread_id}`);
    assert.equal(t.phone, null, 'an IG user id must NEVER normalize into a phone');
    assert.match(t.phone_display, /^IG:\d+$/);
    assert.equal(t.unresolved_lid, false, 'an @ig thread must never be flagged as an unresolved @lid');
  }
  const maria = corpus.threads.find((t) => t.thread_id === 'ig:77000001');
  assert.equal(maria.contact_name, 'maria.deco', 'username flows in as contact_name via pushName');
  assert.equal(maria.metrics.inbound, 2);
  assert.equal(maria.metrics.outbound, 1);
});

test('IG identity: a 10-digit IG id that LOOKS like an AR phone still keys as ig:', async () => {
  // Hand-written 2-line corpus: digits that normalizeInput would happily turn
  // into a phone with defaultCountry AR. The @ig suffix must prevent that.
  const out = tmpDir();
  const jid = '1155443322@ig';
  const rows = [
    { id: 'a1', timestamp: 1756000100, from: jid, fromMe: false, body: 'hola', hasMedia: false, _data: { pushName: 'trampa.ig' } },
    { id: 'a2', timestamp: 1756000200, from: jid, fromMe: true, body: 'buenas', hasMedia: false, _data: {} },
  ];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(out, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const threads = run('src/threads.mjs', { args: ['--session', 'ig', '--no-net'], env: pipelineEnv(out) });
  assert.equal(threads.status, 0, `threads failed:\n${threads.stdout}\n${threads.stderr}`);
  const corpus = JSON.parse(readFileSync(path.join(out, 'threads.json'), 'utf8'));
  assert.equal(corpus.threads.length, 1);
  assert.equal(corpus.threads[0].thread_id, 'ig:1155443322');
  assert.equal(corpus.threads[0].phone, null);
});
