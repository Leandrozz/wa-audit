import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, tmpDir } from './harness.mjs';
import { resolveConfig, DEFAULTS } from '../src/lib/config.mjs';

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
