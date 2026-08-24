import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import CFB from 'cfb';
import { ROOT, runDirectLane, runMockLane, stableSummary, stableReport } from './harness.mjs';

const golden = JSON.parse(readFileSync(path.join(ROOT, 'test', 'golden', 'expected.json'), 'utf8'));

test('direct lane: threads --no-net + report over the committed fixture', () => {
  const r = runDirectLane();

  assert.deepEqual(stableSummary(r.summary), golden.direct.summary);
  assert.deepEqual(stableReport(r.report), golden.direct.report);

  // Contract v1 shape
  assert.equal(r.threads.schema_version, 1);
  const ana = r.threads.threads.find((t) => t.thread_id === '5491155501234');
  assert.ok(ana, 'merged AR thread exists');
  assert.deepEqual([...ana.jids].sort(), ['200000000000001@lid', '5491155501234@c.us']);
  assert.equal(ana.crm.name, 'Ferretería La Tuerca');
  assert.equal(ana.messages[0].direction, 'inbound');

  // Post-processing actually landed inside the ZIP: our styles + frozen panes.
  const cfb = CFB.read(readFileSync(r.xlsxPath), { type: 'buffer' });
  const styles = Buffer.from(CFB.find(cfb, '/xl/styles.xml').content).toString('utf8');
  assert.ok(styles.includes('FF1F3864'), 'custom styles.xml injected');
  const sheet2 = Buffer.from(CFB.find(cfb, '/xl/worksheets/sheet2.xml').content).toString('utf8');
  assert.ok(sheet2.includes('state="frozen"'), 'frozen pane injected in Conversaciones');
});

test('mock lane: probe + export + threads with live @lid resolution', async () => {
  const r = await runMockLane();

  assert.match(r.probeStdout, /NOWEB/);
  assert.match(r.probeStdout, /fullSync=true/);
  assert.equal(r.exportedLines, golden.mock.exportedLines);
  assert.deepEqual(stableSummary(r.summary), golden.mock.summary);
});
