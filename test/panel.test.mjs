import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT, tmpDir, startMock } from './harness.mjs';
import { resolveConfig, DEFAULTS } from '../src/lib/config.mjs';
import { listSessions, createSession, qrPng, WahaError, wahaBase } from '../src/lib/waha.mjs';
import { createAuditStore, listDimensions, AuditError, SLUG_RE } from '../src/lib/audits.mjs';
import { commandFor, createJobRunner, JobError } from '../src/lib/jobs.mjs';

/** process.env with every WA_/WAHA_/KAPSO_/IG_ key removed (the panel tests
 *  must not inherit the developer's shell), plus explicit extras. */
export function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(WA_|WAHA_|KAPSO_|IG_)/.test(k)) delete env[k];
  return { ...env, ...extra };
}

test('resolveConfig: defaults, unknown keys, bad offset, source validation', () => {
  const ok = resolveConfig({}, {});
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.cfg.timezone.offsetMinutes, -180);
  assert.deepEqual(ok.cfg.source, { kind: 'waha', session: 'default' });
  assert.equal(DEFAULTS.source.kind, 'waha');

  const unknown = resolveConfig({ bogus: 1, business: { nope: 2 } }, {});
  assert.deepEqual(unknown.errors, []);
  assert.deepEqual(unknown.warnings, ['unknown config key "bogus" ignored', 'unknown config key "business.nope" ignored']);

  const badTz = resolveConfig({ timezone: { utcOffset: 'nope' } }, {});
  assert.equal(badTz.errors.length, 1);
  assert.match(badTz.errors[0], /Invalid timezone\.utcOffset "nope"/);

  const badSource = resolveConfig({ source: { kind: 'telegram', session: 'a b' } }, {});
  assert.equal(badSource.errors.length, 2);
  assert.match(badSource.errors[0], /Invalid source\.kind "telegram"/);
  assert.match(badSource.errors[1], /Invalid source\.session "a b"/);

  const env = resolveConfig({ business: { name: 'file' } }, { WA_BUSINESS_NAME: 'env', WA_TZ_OFFSET: '+01:00' });
  assert.equal(env.cfg.business.name, 'env');
  assert.equal(env.cfg.timezone.offsetMinutes, 60);

  // Regression: resolveConfig must not mutate DEFAULTS or any previously returned cfg
  const beforeMutation = structuredClone(DEFAULTS);
  const cfg1 = resolveConfig({}, { WA_TZ_OFFSET: '+01:00', WA_BUSINESS_NAME: 'env' });
  assert.equal(cfg1.cfg.timezone.offsetMinutes, 60);
  assert.equal(cfg1.cfg.business.name, 'env');

  // Fresh call should return defaults unchanged, despite previous env overrides
  const cfg2 = resolveConfig({}, {});
  assert.deepEqual(DEFAULTS.timezone, { utcOffset: '-03:00' }, 'DEFAULTS.timezone should not have offsetMinutes added');
  assert.equal(DEFAULTS.business.name, 'My Business', 'DEFAULTS.business.name should not be mutated');
  assert.deepEqual(cfg2.cfg.timezone, { utcOffset: '-03:00', offsetMinutes: -180 }, 'Fresh call should have offsetMinutes but not mutate DEFAULTS');
});

test('loadConfig honors WA_CONFIG_FILE and refuses a missing one', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'audit.json');
  writeFileSync(file, JSON.stringify({ business: { name: 'Per-audit SRL' }, source: { kind: 'kapso', session: 'k1' } }));
  const script = "import { loadConfig } from './src/lib/config.mjs'; const c = loadConfig(); console.log(JSON.stringify({ name: c.business.name, kind: c.source.kind }))";
  const run = (envFile) => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, env: scrubbedEnv({ WA_CONFIG_FILE: envFile }), encoding: 'utf8',
  });
  const good = run(file);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), { name: 'Per-audit SRL', kind: 'kapso' });

  const missing = run(path.join(dir, 'does-not-exist.json'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /WA_CONFIG_FILE/);
});

test('waha lib: sessions, create, qr against the mock', async () => {
  const saved = { url: process.env.WAHA_BASE_URL, key: process.env.WAHA_API_KEY };
  delete process.env.WAHA_BASE_URL;
  assert.equal(wahaBase(), '');
  await assert.rejects(listSessions(), (e) => e instanceof WahaError && e.status === 0);

  const mock = await startMock(8441);
  process.env.WAHA_BASE_URL = 'http://localhost:8441/';
  process.env.WAHA_API_KEY = 'test';
  try {
    assert.equal(wahaBase(), 'http://localhost:8441');
    const sessions = await listSessions();
    assert.deepEqual(sessions, [{ name: 'fixture', status: 'WORKING', engine: 'NOWEB' }]);
    assert.match(await createSession('audit'), /SCAN_QR_CODE/);
    const png = await qrPng('fixture');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  } finally {
    mock.kill();
    if (saved.url === undefined) delete process.env.WAHA_BASE_URL; else process.env.WAHA_BASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.WAHA_API_KEY; else process.env.WAHA_API_KEY = saved.key;
  }
});

test('audit store: create, list, config validation, status rule, downloads whitelist', () => {
  const dataDir = path.join(tmpDir(), 'data');
  const baseline = resolveConfig({ locale: 'es-AR' }, {}).cfg;
  delete baseline.timezone.offsetMinutes;
  const store = createAuditStore({ dataDir, baseline });

  assert.deepEqual(store.list(), []);
  assert.throws(() => store.create('../x'), (e) => e instanceof AuditError && e.status === 400);
  assert.throws(() => store.create('Bad Slug'), (e) => e.status === 400);
  assert.throws(() => store.status('nope'), (e) => e.status === 404);

  const created = store.create('acme');
  assert.equal(created.slug, 'acme');
  assert.equal(created.has_config, true);
  assert.throws(() => store.create('acme'), (e) => e.status === 409);
  assert.ok(existsSync(path.join(dataDir, 'acme', 'wa-audit.config.json')));

  const cfg = store.readConfig('acme');
  assert.equal(cfg.business.name, 'acme');
  assert.equal(cfg.output.dir, path.join(dataDir, 'acme'));
  assert.equal(cfg.timezone.offsetMinutes, undefined);
  assert.deepEqual(cfg.source, { kind: 'waha', session: 'default' });

  // legacy directory without a config reads as the seeded baseline
  mkdirSync(path.join(dataDir, 'wa-history'));
  assert.equal(store.readConfig('wa-history').business.name, 'wa-history');
  assert.deepEqual(store.list().map((a) => [a.slug, a.has_config]), [['acme', true], ['wa-history', false]]);
  store.ensureConfig('wa-history');
  assert.ok(existsSync(path.join(dataDir, 'wa-history', 'wa-audit.config.json')));

  assert.throws(() => store.writeConfig('acme', { ...cfg, bogus: 1 }), (e) => e.status === 400 && /unknown config key "bogus"/.test(e.message));
  assert.throws(() => store.writeConfig('acme', { ...cfg, timezone: { utcOffset: 'x' } }), (e) => e.status === 400 && /utcOffset/.test(e.message));
  assert.throws(() => store.writeConfig('acme', []), (e) => e.status === 400);
  const written = store.writeConfig('acme', { ...cfg, business: { ...cfg.business, name: 'ACME SRL' }, report: { filename: 'acme.xlsx' }, output: { dir: '/elsewhere' } });
  assert.equal(written.business.name, 'ACME SRL');
  assert.equal(written.output.dir, path.join(dataDir, 'acme'), 'output.dir is pinned to the audit dir');
  assert.equal(written.timezone.offsetMinutes, undefined);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'acme', 'wa-audit.config.json'), 'utf8')), written);

  // report.filename sanitization: reject path traversal
  assert.throws(() => store.writeConfig('acme', { ...cfg, report: { filename: '../../evil.xlsx' } }), (e) => e.status === 400 && /report\.filename/.test(e.message));
  assert.throws(() => store.writeConfig('acme', { ...cfg, report: { filename: '..' } }), (e) => e.status === 400);
  // hand-edited config with a traversal filename: keys stay bare and probes stay inside the audit dir
  mkdirSync(path.join(dataDir, 'hand'));
  writeFileSync(path.join(dataDir, 'hand', 'wa-audit.config.json'), JSON.stringify({ report: { filename: '../../package.json' } }));
  const handFiles = store.status('hand').files;
  assert.ok(Object.keys(handFiles).every((k) => !k.includes('..') && !k.includes('/') && !k.includes('\\')));
  assert.equal(handFiles['package.json'], false, 'probes only inside the audit dir');
  assert.equal(store.filePath('hand', '../../package.json'), null);
  // create() never persists derived fields, even when the baseline carries them
  const rawStore = createAuditStore({ dataDir, baseline: resolveConfig({}, {}).cfg });
  rawStore.create('raw');
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'raw', 'wa-audit.config.json'), 'utf8')).timezone.offsetMinutes, undefined);

  let st = store.status('acme');
  assert.equal(st.next_step, 'context');
  assert.equal(st.files['acme.xlsx'], false);
  assert.equal(st.files['acme.html'], false);
  assert.equal(st.summary, null);
  store.writeContext('acme', { what_we_sell: 'cintas' });
  assert.deepEqual(store.readContext('acme'), { what_we_sell: 'cintas' });
  assert.equal(store.status('acme').next_step, 'export');
  writeFileSync(path.join(dataDir, 'acme', 'messages.jsonl'), '');
  assert.equal(store.status('acme').next_step, 'threads');
  assert.throws(() => store.threadsPage('acme', 0, 5), (e) => e.status === 404 && /corpus/.test(e.message));
  assert.throws(() => store.analysis('acme'), (e) => e.status === 404);

  // corpus + analysis views over the committed fixture files
  copyFileSync(path.join(ROOT, 'fixtures', 'analysis-sample.json'), path.join(dataDir, 'acme', 'analysis.json'));
  const threadsFile = path.join(ROOT, 'out', 'demo', 'threads.json');
  if (existsSync(threadsFile)) copyFileSync(threadsFile, path.join(dataDir, 'acme', 'threads.json'));
  else writeFileSync(path.join(dataDir, 'acme', 'threads.json'), JSON.stringify({ schema_version: 1, threads: [
    { thread_id: 'a', contact_name: 'A', is_internal: false, is_system: false, unresolved_lid: false, crm: null, metrics: { two_way: false, total: 9 }, messages: [] },
    { thread_id: 'b', contact_name: 'B', is_internal: false, is_system: false, unresolved_lid: false, crm: null, metrics: { two_way: true, total: 2 }, messages: [{ iso: '2026-01-01T10:00:00.000-03:00', direction: 'inbound', type: 'text', text: 'hola' }] },
    { thread_id: 'status@broadcast', contact_name: null, is_internal: false, is_system: true, unresolved_lid: false, crm: null, metrics: { two_way: false, total: 1 }, messages: [] },
  ] }));
  const page = store.threadsPage('acme', 0, 500);
  assert.ok(page.limit <= 50);
  assert.equal(page.items[0].metrics.two_way, true, 'two-way threads first');
  assert.equal(page.items[0].messages, undefined, 'list carries headers only');
  assert.ok(page.items.every((t) => !t.is_system));
  assert.ok(page.total >= page.items.length && page.total >= 1);
  const one = store.thread('acme', page.items[0].thread_id);
  assert.ok(Array.isArray(one.messages));
  assert.throws(() => store.thread('acme', 'nope'), (e) => e.status === 404);
  assert.equal(store.analysis('acme').dimensions[0].key, 'frequent_questions');
  assert.equal(store.status('acme').next_step, 'report');
  assert.deepEqual(store.status('acme').dimensions_done, store.analysis('acme').dimensions.map((d) => d.key));

  // downloads: whitelist + stays inside the audit dir
  assert.equal(store.filePath('acme', '../../package.json'), null);
  assert.equal(store.filePath('acme', 'wa-audit.config.json'), null, 'config is not a download');
  assert.equal(store.filePath('acme', 'acme.xlsx'), null, 'whitelisted but not rendered yet');
  assert.equal(store.filePath('acme', 'analysis.json'), path.join(dataDir, 'acme', 'analysis.json'));
  assert.equal(store.filePath('acme', 'threads.json'), path.join(dataDir, 'acme', 'threads.json'));

  const dims = listDimensions();
  assert.ok(dims.some((d) => d.key === 'frequent_questions' && d.title.length > 0));
  assert.ok(!dims.some((d) => d.key === 'verifier'));
  assert.ok(SLUG_RE.test('acme-2026'));
});

test('jobs: step → command table', () => {
  const cfg = (kind, session = 's1') => ({ source: { kind, session } });
  assert.deepEqual(commandFor('probe', cfg('waha')), { script: 'src/probe.mjs', args: [] });
  assert.throws(() => commandFor('probe', cfg('kapso')), (e) => e instanceof JobError && e.status === 400);
  assert.deepEqual(commandFor('export', cfg('waha')), { script: 'src/export.mjs', args: ['s1'] });
  assert.deepEqual(commandFor('export', cfg('kapso')), { script: 'src/export-kapso.mjs', args: [] });
  assert.deepEqual(commandFor('export', cfg('ig')), { script: 'src/export-ig.mjs', args: [] });
  assert.deepEqual(commandFor('export', cfg('ig'), { since: 30 }), { script: 'src/export-ig.mjs', args: ['--since', '30'] });
  assert.throws(() => commandFor('export', cfg('ig'), { since: -1 }), (e) => e.status === 400);
  assert.deepEqual(commandFor('threads', cfg('waha')), { script: 'src/threads.mjs', args: ['--session', 's1'] });
  assert.deepEqual(commandFor('threads', cfg('waha'), { noNet: true }), { script: 'src/threads.mjs', args: ['--session', 's1', '--no-net'] });
  assert.deepEqual(commandFor('threads', cfg('kapso')), { script: 'src/threads.mjs', args: ['--session', 's1', '--no-net'] });
  assert.deepEqual(commandFor('analyze', cfg('ig')), { script: 'src/analyze.mjs', args: [] });
  assert.deepEqual(commandFor('analyze', cfg('waha'), { dimensions: ['frequent_questions', 'fate'] }), { script: 'src/analyze.mjs', args: ['--dimensions', 'frequent_questions,fate'] });
  assert.throws(() => commandFor('analyze', cfg('waha'), { dimensions: ['bad key'] }), (e) => e.status === 400);
  assert.deepEqual(commandFor('report-xlsx', cfg('waha')), { script: 'src/report-xlsx.mjs', args: [] });
  assert.deepEqual(commandFor('report-html', cfg('waha')), { script: 'src/report-html.mjs', args: [] });
  assert.deepEqual(commandFor('report-docx', cfg('waha')), { script: 'src/report-docx.mjs', args: [] });
  assert.throws(() => commandFor('rm-rf', cfg('waha')), (e) => e.status === 400);
});

test('jobs: runner streams lines, ends with the exit code, refuses a second job', async () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, 'echo.mjs'), "console.log('one'); console.error('two'); process.stdout.write('three'); process.exit(3);");
  const runner = createJobRunner({ root: dir, maxLines: 2 });
  assert.equal(runner.current(), null);
  assert.equal(runner.cancel(), false);

  const events = [];
  runner.subscribe((ev) => events.push(ev));
  const ended = new Promise((resolve) => runner.subscribe((ev) => { if (ev.type === 'end') resolve(ev); }));
  const view = runner.start({ slug: 'x', step: 'probe', script: 'echo.mjs', args: [], env: process.env });
  assert.equal(view.running, true);
  assert.throws(() => runner.start({ slug: 'x', step: 'probe', script: 'echo.mjs', args: [], env: process.env }), (e) => e instanceof JobError && e.status === 409);

  const end = await ended;
  assert.equal(end.exit_code, 3);
  assert.deepEqual(events.filter((e) => e.type === 'line').map((e) => [e.s, e.t]).sort(), [['err', 'two'], ['out', 'one'], ['out', 'three']]);
  assert.equal(runner.lines().length, 2, 'ring buffer keeps the last maxLines');
  assert.equal(runner.current().running, false);
  assert.equal(runner.current().exit_code, 3);
  assert.equal(runner.running(), false);
});

test('jobs: a throwing subscriber does not break the others or the runner', async () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, 'ok.mjs'), "console.log('hello'); process.exit(0);");
  const runner = createJobRunner({ root: dir });
  const seen = [];
  runner.subscribe(() => { throw new Error('bad listener'); });
  const ended = new Promise((resolve) => runner.subscribe((ev) => { seen.push(ev); if (ev.type === 'end') resolve(ev); }));
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    runner.start({ slug: 'x', step: 'probe', script: 'ok.mjs', args: [], env: process.env });
    const end = await ended;
    assert.equal(end.exit_code, 0);
    assert.ok(seen.some((ev) => ev.type === 'line' && ev.t === 'hello'), 'the good subscriber still received the line');
    assert.ok(errors.some((m) => m.includes('bad listener')), 'the failure is logged, not swallowed');
  } finally {
    console.error = original;
  }
  assert.equal(runner.running(), false);
});

export const PANEL_HEADERS = { 'content-type': 'application/json', 'x-wa-panel': '1' };

/** Boots src/panel.mjs with the given cwd/env; resolves { child, base } once it prints its URL. */
export function startPanel(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'panel.mjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`panel did not start:\n${buf}`)); }, 10_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /panel listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, base: m[1] }); }
    });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`panel exited early (${code}):\n${buf}`)); });
  });
}

/** JSON API helper: GET without headers, everything else with the panel headers. */
export async function api(base, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: method === 'GET' ? {} : PANEL_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, ct, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

/** Raw node:http GET so the Host header can be forged (fetch drops it). */
export function rawGet(base, p, headers) {
  const u = new URL(base + p);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('panel HTTP: security gates, audits, config, context, env, dimensions, WAHA proxy', async () => {
  const mock = await startMock(8443);
  const cwd = tmpDir();
  const dataDir = path.join(cwd, 'data');
  const { child: panel, base } = await startPanel(cwd, scrubbedEnv({
    WA_PANEL_DATA_DIR: dataDir, WA_PANEL_PORT: '0', WAHA_BASE_URL: 'http://localhost:8443', WAHA_API_KEY: 'test',
  }));
  try {
    // --- security
    assert.equal(await rawGet(base, '/api/audits', { Host: 'evil.example' }), 403);
    assert.equal(await rawGet(base, '/api/audits', { Host: 'localhost:1' }), 200);
    assert.equal((await fetch(base + '/api/audits', { method: 'POST', body: '{}' })).status, 403, 'no panel headers');
    assert.equal((await fetch(base + '/api/audits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, 'json but no X-WA-Panel');
    assert.equal((await fetch(base + '/api/audits', { method: 'OPTIONS' })).status, 403);
    let r = await api(base, 'POST', '/api/audits', { slug: '../x' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /invalid audit slug/);
    r = await api(base, 'GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal((await fetch(base + '/api/audits', { method: 'POST', headers: PANEL_HEADERS, body: 'not json' })).status, 400);
    const big = await fetch(base + '/api/audits', { method: 'POST', headers: PANEL_HEADERS, body: '{"slug":"' + 'a'.repeat(1024 * 1024 + 10) + '"}' });
    assert.equal(big.status, 413);

    // --- audits
    r = await api(base, 'GET', '/api/audits');
    assert.deepEqual(r.body, []);
    r = await api(base, 'POST', '/api/audits', { slug: 'demo' });
    assert.equal(r.status, 201);
    assert.equal(r.body.slug, 'demo');
    assert.equal((await api(base, 'POST', '/api/audits', { slug: 'demo' })).status, 409);
    r = await api(base, 'GET', '/api/audits');
    assert.deepEqual(r.body.map((a) => [a.slug, a.has_config, a.business_name]), [['demo', true, 'demo']]);
    assert.equal((await api(base, 'GET', '/api/audits/nope/status')).status, 404);
    assert.equal((await api(base, 'GET', '/api/audits/demo/files/..%2F..%2Fpackage.json')).status, 404);

    // --- config round trip + validation through resolveConfig
    const cfg = (await api(base, 'GET', '/api/audits/demo/config')).body;
    assert.equal(cfg.business.name, 'demo');
    assert.equal(cfg.timezone.offsetMinutes, undefined);
    cfg.business.name = 'Demo Industrial SRL';
    cfg.source = { kind: 'waha', session: 'fixture' };
    r = await api(base, 'PUT', '/api/audits/demo/config', cfg);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.business.name, 'Demo Industrial SRL');
    assert.equal(r.body.output.dir, path.join(dataDir, 'demo'));
    assert.deepEqual((await api(base, 'GET', '/api/audits/demo/config')).body, r.body);
    r = await api(base, 'PUT', '/api/audits/demo/config', { ...cfg, bogus: 1 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /unknown config key "bogus"/);
    r = await api(base, 'PUT', '/api/audits/demo/config', { ...cfg, timezone: { utcOffset: 'nope' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /utcOffset/);

    // --- status + business context
    assert.equal((await api(base, 'GET', '/api/audits/demo/status')).body.next_step, 'context');
    r = await api(base, 'PUT', '/api/audits/demo/business-context', { what_we_sell: 'cintas', extra_key: 'kept' });
    assert.equal(r.status, 200);
    assert.deepEqual((await api(base, 'GET', '/api/audits/demo/business-context')).body, { what_we_sell: 'cintas', extra_key: 'kept' });
    assert.equal((await api(base, 'GET', '/api/audits/demo/status')).body.next_step, 'export');
    assert.equal((await api(base, 'PUT', '/api/audits/demo/business-context', [1, 2])).status, 400);

    // --- env + dimensions
    r = await api(base, 'GET', '/api/env');
    assert.deepEqual(r.body.map((e) => [e.file, e.exists]), [['waha.env', false], ['kapso.env', false], ['ig.env', false]]);
    writeFileSync(path.join(cwd, 'kapso.env'), '# comment\nKAPSO_API_KEY=secret-value\nexport KAPSO_PHONE_NUMBER_ID=123\n');
    r = await api(base, 'GET', '/api/env');
    assert.deepEqual(r.body[1], { file: 'kapso.env', exists: true, keys: ['KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID'] });
    assert.ok(!JSON.stringify(r.body).includes('secret-value'), 'values never leave the server');
    r = await api(base, 'GET', '/api/dimensions');
    assert.ok(r.body.some((d) => d.key === 'frequent_questions'));
    assert.ok(!r.body.some((d) => d.key === 'verifier'));

    // --- WAHA proxy
    r = await api(base, 'GET', '/api/waha/sessions');
    assert.equal(r.status, 200);
    assert.equal(r.body[0].name, 'fixture');
    r = await api(base, 'POST', '/api/waha/sessions', { name: 'audit' });
    assert.equal(r.status, 201);
    assert.equal((await api(base, 'POST', '/api/waha/sessions', { name: 'bad name' })).status, 400);
    const qr = await fetch(base + '/api/waha/qr/fixture');
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await qr.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
  } finally {
    panel.kill();
    mock.kill();
  }
});

/** Attaches to the SSE stream and resolves when `event: end` arrives (immediately if the job already ended). */
export async function waitJob(base) {
  const r = await fetch(base + '/api/jobs/stream');
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const text = await r.text();
  const m = /event: end\ndata: (\{[^\n]*\})/.exec(text);
  assert.ok(m, `no end event in stream:\n${text.slice(-2000)}`);
  return { exit_code: JSON.parse(m[1]).exit_code, text };
}

export async function runStep(base, slug, step, options = {}) {
  const r = await api(base, 'POST', `/api/audits/${slug}/run`, { step, options });
  assert.equal(r.status, 202, `${step}: ${JSON.stringify(r.body)}`);
  const { exit_code, text } = await waitJob(base);
  assert.equal(exit_code, 0, `${step} failed:\n${text.slice(-3000)}`);
}

test('panel HTTP: pipeline end to end (probe → export → threads → analyze → reports), lock, downloads', async () => {
  const mock = await startMock(8445);
  const cwd = tmpDir();
  const dataDir = path.join(cwd, 'data');
  const { child: panel, base } = await startPanel(cwd, scrubbedEnv({
    WA_PANEL_DATA_DIR: dataDir, WA_PANEL_PORT: '0', WAHA_BASE_URL: 'http://localhost:8445', WAHA_API_KEY: 'test',
  }));
  try {
    // no job ever started: the stream ends at once with a null exit code
    assert.equal((await waitJob(base)).exit_code, null);
    assert.equal((await api(base, 'GET', '/api/jobs/current')).body, null);
    assert.equal((await api(base, 'POST', '/api/jobs/cancel')).status, 404);

    await api(base, 'POST', '/api/audits', { slug: 'demo' });
    const cfg = (await api(base, 'GET', '/api/audits/demo/config')).body;
    cfg.business.name = 'Demo Industrial SRL';
    cfg.business.internalEmailDomains = ['fixture-internal.test'];
    cfg.crm.file = path.join(ROOT, 'fixtures', 'waha-dump', 'crm.csv');
    cfg.llm.provider = 'mock';
    cfg.llm.cannedDir = path.join(ROOT, 'fixtures', 'llm-canned');
    cfg.source = { kind: 'waha', session: 'fixture' };
    let r = await api(base, 'PUT', '/api/audits/demo/config', cfg);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await api(base, 'PUT', '/api/audits/demo/business-context', { what_we_sell: 'cintas transportadoras' });

    // unknown step / bad options are refused before anything spawns
    assert.equal((await api(base, 'POST', '/api/audits/demo/run', { step: 'rm-rf' })).status, 400);
    assert.equal((await api(base, 'POST', '/api/audits/nope/run', { step: 'probe' })).status, 404);

    // lock: two runs fired in the same tick → exactly one 409
    const pair = await Promise.all([
      api(base, 'POST', '/api/audits/demo/run', { step: 'probe' }),
      api(base, 'POST', '/api/audits/demo/run', { step: 'probe' }),
    ]);
    assert.deepEqual(pair.map((x) => x.status).sort(), [202, 409]);
    assert.equal((await waitJob(base)).exit_code, 0);
    let cur = (await api(base, 'GET', '/api/jobs/current')).body;
    assert.equal(cur.step, 'probe');
    assert.equal(cur.running, false);
    assert.equal(cur.exit_code, 0);
    assert.ok(cur.tail.length > 0);

    const hdr = await fetch(base + '/api/jobs/current');
    assert.equal(hdr.headers.get('access-control-allow-origin'), null, 'no CORS headers, ever');
    assert.equal(hdr.headers.get('cache-control'), 'no-store');
    assert.equal((await api(base, 'GET', '/api/audits/demo/threads/%ZZ')).status, 400, 'malformed escape is a bad request');
    assert.equal((await fetch(base + '/api/audits/demo/business-context', { method: 'PUT', headers: PANEL_HEADERS })).status, 400, 'empty body never wipes state');

    await runStep(base, 'demo', 'export');
    assert.equal((await api(base, 'GET', '/api/audits/demo/status')).body.next_step, 'threads');

    await runStep(base, 'demo', 'threads');
    let st = (await api(base, 'GET', '/api/audits/demo/status')).body;
    assert.equal(st.next_step, 'analyze');
    assert.ok(st.summary.messages_included > 0);
    assert.equal(st.summary.threads, 23);
    r = await api(base, 'GET', '/api/audits/demo/threads?limit=5');
    assert.equal(r.body.items.length, 5);
    assert.equal(r.body.items[0].metrics.two_way, true);
    assert.equal(r.body.items[0].messages, undefined);
    const first = r.body.items[0].thread_id;
    r = await api(base, 'GET', `/api/audits/demo/threads/${encodeURIComponent(first)}`);
    assert.ok(Array.isArray(r.body.messages) && r.body.messages.length > 0);

    await runStep(base, 'demo', 'analyze', { dimensions: ['frequent_questions', 'ops_response_times'] });
    r = await api(base, 'GET', '/api/audits/demo/analysis');
    assert.equal(r.body.dimensions.length, 2);
    assert.ok(r.body.dimensions.every((d) => typeof d.verdict.reviewed === 'number'));
    st = (await api(base, 'GET', '/api/audits/demo/status')).body;
    assert.equal(st.next_step, 'report');
    assert.deepEqual(st.dimensions_done, ['frequent_questions', 'ops_response_times']);

    await runStep(base, 'demo', 'report-xlsx');
    await runStep(base, 'demo', 'report-html');
    r = await api(base, 'GET', '/api/audits/demo/files/whatsapp-report.xlsx');
    assert.equal(r.status, 200);
    assert.match(r.ct, /spreadsheetml/);
    assert.ok(r.body.length > 1000);
    r = await api(base, 'GET', '/api/audits/demo/files/whatsapp-report.html');
    assert.equal(r.status, 200);
    assert.match(r.ct, /text\/html/);
    assert.equal((await api(base, 'GET', '/api/audits/demo/files/whatsapp-report.docx')).status, 404, 'not rendered');
    assert.equal((await api(base, 'GET', '/api/audits/demo/files/wa-audit.config.json')).status, 404, 'not whitelisted');
    st = (await api(base, 'GET', '/api/audits/demo/status')).body;
    assert.equal(st.files['whatsapp-report.xlsx'], true);
    assert.equal(st.files['whatsapp-report.html'], true);

    // a client that aborts a download mid-stream must not take the panel down, and the next download still works
    const ac = new AbortController();
    const partial = await fetch(base + '/api/audits/demo/files/whatsapp-report.xlsx', { signal: ac.signal });
    assert.equal(partial.status, 200);
    ac.abort();
    await assert.rejects(partial.arrayBuffer());
    assert.equal((await api(base, 'GET', '/api/jobs/current')).status, 200, 'panel still alive after an aborted download');
    r = await api(base, 'GET', '/api/audits/demo/files/whatsapp-report.xlsx');
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 1000);

    // probe on a non-WAHA audit is refused; a legacy dir without config gets one on first run
    await api(base, 'POST', '/api/audits', { slug: 'ig-test' });
    const igCfg = (await api(base, 'GET', '/api/audits/ig-test/config')).body;
    igCfg.source = { kind: 'ig', session: 'ig' };
    await api(base, 'PUT', '/api/audits/ig-test/config', igCfg);
    r = await api(base, 'POST', '/api/audits/ig-test/run', { step: 'probe' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /WAHA/);
    mkdirSync(path.join(dataDir, 'legacy'));
    assert.equal((await api(base, 'GET', '/api/audits')).body.find((a) => a.slug === 'legacy').has_config, false);
    r = await api(base, 'POST', '/api/audits/legacy/run', { step: 'report-xlsx' });
    assert.equal(r.status, 202);
    assert.notEqual((await waitJob(base)).exit_code, 0, 'no corpus there, the renderer fails — but the job ran');
    assert.ok(existsSync(path.join(dataDir, 'legacy', 'wa-audit.config.json')), 'config seeded on first run');
  } finally {
    panel.kill();
    mock.kill();
  }
});

test('panel HTML: served with CSP, no innerHTML, only talks to /api', async () => {
  const cwd = tmpDir();
  const { child: panel, base } = await startPanel(cwd, scrubbedEnv({ WA_PANEL_DATA_DIR: path.join(cwd, 'data'), WA_PANEL_PORT: '0' }));
  try {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await r.text();
    assert.match(html, /<html lang="es">/);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), 'DOM is built from text nodes only');
    assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external resources');
    for (const label of ['Estado', 'Fuente y WAHA', 'Pipeline', 'Contexto', 'Corpus', 'Hallazgos', 'Reportes', 'Config']) {
      assert.ok(html.includes(label), `tab ${label}`);
    }

    const cspHeader = r.headers.get('content-security-policy');
    const nonce = /script-src 'nonce-([0-9a-f-]{36})'/.exec(cspHeader)?.[1];
    assert.ok(nonce, 'script-src carries a per-response nonce');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(cspHeader), 'no unsafe-inline for scripts');
    assert.match(cspHeader, /base-uri 'none'/);
    assert.ok(html.includes(`<script nonce="${nonce}">`), 'the served script tag carries the same nonce');
    assert.ok(!html.includes('__CSP_NONCE__'), 'placeholder fully replaced');
    const again = await fetch(base + '/');
    assert.notEqual(again.headers.get('content-security-policy'), cspHeader, 'a fresh nonce per response');
  } finally {
    panel.kill();
  }
});
