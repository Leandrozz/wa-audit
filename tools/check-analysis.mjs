/**
 * Validates an analysis file against analysis/analysis.schema.json (the
 * contract any analysis engine must honor). Exit 0 = valid.
 *
 *   npm run check:analysis            validates <output.dir>/analysis.json
 *   npm run check:analysis -- <file>  validates a specific file
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadConfig } from '../src/lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? path.join(loadConfig().output.dir, 'analysis.json');

const schema = JSON.parse(readFileSync(path.join(ROOT, 'analysis', 'analysis.schema.json'), 'utf8'));
let data;
try {
  data = JSON.parse(readFileSync(target, 'utf8'));
} catch (e) {
  console.error(`Could not read ${target}: ${String(e).slice(0, 160)}`);
  process.exit(1);
}

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

if (validate(data)) {
  const dims = data.dimensions.map((d) => `${d.key} (${d.verdict.confirmed}/${d.verdict.reviewed} confirmed)`);
  console.log(`✓ ${target} is valid analysis v1 — ${data.dimensions.length} dimension(s): ${dims.join(', ')}`);
} else {
  console.error(`✗ ${target} FAILS the analysis contract:`);
  for (const err of validate.errors) {
    console.error(`  ${err.instancePath || '(root)'}: ${err.message}`);
  }
  process.exit(1);
}
