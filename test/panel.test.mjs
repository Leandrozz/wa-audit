import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, tmpDir, startMock } from './harness.mjs';
import { resolveConfig, DEFAULTS } from '../src/lib/config.mjs';
import { listSessions, createSession, qrPng, WahaError, wahaBase } from '../src/lib/waha.mjs';
import { createAuditStore, listDimensions, AuditError, SLUG_RE } from '../src/lib/audits.mjs';

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
