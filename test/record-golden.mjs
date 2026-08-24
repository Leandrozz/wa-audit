/**
 * Regenerates test/golden/expected.json by running both pipeline lanes through
 * the same harness the tests use. Run it ONLY when a change legitimately moves
 * the numbers — then eyeball the diff before committing: the golden file is
 * the reviewed spec of what the fixture must produce.
 *
 *   node test/record-golden.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, runDirectLane, runMockLane, stableSummary, stableReport } from './harness.mjs';

const direct = runDirectLane();
const mock = await runMockLane(8401); // port distinct from the test suite's

const golden = {
  _note: 'Recorded by test/record-golden.mjs. Review every diff to this file like a spec change.',
  direct: {
    summary: stableSummary(direct.summary),
    report: stableReport(direct.report),
  },
  mock: {
    exportedLines: mock.exportedLines,
    summary: stableSummary(mock.summary),
  },
};

mkdirSync(path.join(ROOT, 'test', 'golden'), { recursive: true });
const file = path.join(ROOT, 'test', 'golden', 'expected.json');
writeFileSync(file, JSON.stringify(golden, null, 2) + '\n');
console.log(`✓ golden written to ${file}`);
