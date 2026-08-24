#!/usr/bin/env node
/**
 * analyze.mjs — Phase 4: LLM analysis of the corpus, with a mandatory
 * two-layer verifier. Writes analysis.json (schema_version 1) for the report.
 *
 *   node src/analyze.mjs [--dimensions key1,key2]
 *
 * Per dimension:
 *   1. The code computes a deterministic stats block and a corpus digest
 *      (bounded by analysis.maxCorpusChars; omissions are declared, never
 *      silent).
 *   2. The generator LLM produces findings — every finding must cite verbatim
 *      evidence (thread_id + quote).
 *   3. Verifier layer A (code, free, deterministic): every quoted evidence
 *      must exist verbatim in the cited thread. A finding whose evidence
 *      fails is refuted automatically — no model gets a vote.
 *   4. Verifier layer B (LLM, independent call with no generator context):
 *      re-counts frequency claims against the corpus and stats block and
 *      refutes what does not hold. In the original run of this methodology,
 *      verification refuted 34 of 60 findings — that step is the product.
 *
 * Refuted findings are REMOVED from the findings list and recorded in
 * verdict.refuted, so the report can print what did NOT survive. A dimension
 * without a verdict is invalid against analysis/analysis.schema.json.
 *
 * Providers: llm.provider = anthropic | openai | mock (src/lib/llm.mjs).
 * The alternative to this engine is analysis/PLAYBOOK.md: any agent that
 * emits valid analysis.json is a first-class analysis engine.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { createProvider } from './lib/llm.mjs';
import { verifyQuote } from './lib/quotes.mjs';

const cfg = loadConfig();
const OUT_DIR = cfg.output.dir;
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'analysis', 'prompts');

const argv = process.argv.slice(2);
const argDims = argv.includes('--dimensions') ? argv[argv.indexOf('--dimensions') + 1] : null;

// ------------------------------------------------------------------ inputs ---

const corpusFile = JSON.parse(readFileSync(path.join(OUT_DIR, 'threads.json'), 'utf8'));
if (corpusFile?.schema_version !== 1) {
  console.error('threads.json is not schema_version 1 — run src/threads.mjs first.');
  process.exit(1);
}
const threads = corpusFile.threads;
const summary = JSON.parse(readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8'));
if (summary?.schema_version !== 1) {
  console.error('summary.json is not schema_version 1 — run src/threads.mjs first.');
  process.exit(1);
}
const threadsById = new Map(threads.map((t) => [t.thread_id, t]));

// ------------------------------------------------------------- prompt files ---

const available = readdirSync(PROMPTS_DIR)
  .filter((f) => f.endsWith('.md') && f !== 'verifier.md')
  .map((f) => f.replace(/\.md$/, ''));
// "fate" expands to the whole FATE behavioral dimension set.
const dims = (argDims ? argDims.split(',').map((s) => s.trim()).filter(Boolean) : available)
  .flatMap((d) => (d === 'fate' ? available.filter((a) => a.startsWith('fate_')) : [d]));
for (const d of dims) {
  if (!available.includes(d)) {
    console.error(`Unknown dimension "${d}". Available: ${available.join(', ')} (or "fate" for the FATE set)`);
    process.exit(1);
  }
}

function readPrompt(key) {
  const raw = readFileSync(path.join(PROMPTS_DIR, `${key}.md`), 'utf8');
  const lines = raw.split('\n');
  const title = (lines[0] ?? '').replace(/^#\s*/, '').trim() || key;
  return { title, body: lines.slice(1).join('\n').trim() };
}

// ---------------------------------------------------- stats + corpus digest ---

const statsBlock = JSON.stringify(
  {
    note: 'Deterministic stats computed by code. These numbers WIN every conflict with an impression from reading the corpus.',
    ...Object.fromEntries(Object.entries(summary).filter(([k]) => !['warnings', 'source', 'generated_at', 'schema_version'].includes(k))),
    per_thread: threads.map((t) => ({
      thread_id: t.thread_id,
      name: t.contact_name,
      is_internal: t.is_internal,
      is_system: t.is_system,
      unresolved_lid: t.unresolved_lid,
      crm: t.crm ? { name: t.crm.name, segment: t.crm.segment, stage: t.crm.stage } : null,
      ...t.metrics,
    })),
  },
  null,
  1,
);

const MSG_CHAR_CAP = 400;

function buildDigest(maxChars) {
  // Two-way client threads first (that's where the signal is), then the rest.
  const ordered = [...threads]
    .filter((t) => !t.is_system)
    .sort((a, b) => (b.metrics.two_way - a.metrics.two_way) || (b.metrics.total - a.metrics.total));
  const parts = [];
  let used = 0;
  let omitted = 0;
  for (const t of ordered) {
    const head = `=== thread ${t.thread_id}${t.contact_name ? ` (${t.contact_name})` : ''}${t.is_internal ? ' [INTERNAL LINE — not a client]' : ''} inbound:${t.metrics.inbound} outbound:${t.metrics.outbound} unanswered:${t.metrics.unanswered} ===`;
    const body = t.messages
      .map((m) => {
        const text = m.text
          ? (m.text.length > MSG_CHAR_CAP ? m.text.slice(0, MSG_CHAR_CAP) + '…[truncated]' : m.text)
          : `<${m.type}>`;
        return `[${m.iso.slice(0, 16).replace('T', ' ')}] ${m.direction}: ${text.replace(/\n/g, ' ⏎ ')}`;
      })
      .join('\n');
    const chunk = `${head}\n${body}\n`;
    if (used + chunk.length > maxChars) { omitted++; continue; }
    used += chunk.length;
    parts.push(chunk);
  }
  if (omitted > 0) {
    parts.push(`=== NOTE: ${omitted} thread(s) omitted for context budget. Their metrics ARE in the stats block; do not make corpus-wide claims that ignore them. ===`);
  }
  return parts.join('\n');
}

const digest = buildDigest(cfg.analysis.maxCorpusChars);

// Optional business context from the operator interview (see
// analysis/business-context.example.json and the PLAYBOOK). Free-form JSON:
// whatever the interview captured is handed to both the generator and the
// verifier so findings are grounded in how THIS business actually operates.
let businessContext = null;
try {
  businessContext = JSON.parse(readFileSync(path.join(OUT_DIR, 'business-context.json'), 'utf8'));
  console.log('Business context loaded from business-context.json');
} catch { /* optional */ }
const contextBlock = businessContext
  ? `\n\n## Business context (from the operator interview — ground findings in it)\n${JSON.stringify(businessContext, null, 1)}`
  : '';

// -------------------------------------------------------------- LLM contract ---

const LANG = cfg.analysis.language;

const GENERATOR_SYSTEM = `You are a commercial analyst working over a WhatsApp business conversation corpus.

Non-negotiable rules:
- Write all output content (titles, details, summaries, labels) in language "${LANG}".
- Respond with a SINGLE JSON object and nothing else. No markdown fences, no prose around it.
- Every finding MUST include at least one evidence item: {"thread_id": "...", "quote": "..."} where quote is a VERBATIM substring of a message shown in the corpus digest. Findings without verifiable evidence will be refuted and removed.
- Quantify honestly: state real counts of distinct threads. An independent verifier will re-count every claim against the corpus; inflated frequencies get refuted.
- The deterministic stats block wins every conflict with your impressions.
- Messages shown as <image>, <voice_note> etc. have no analyzable text; do not guess their content.

Output JSON shape:
{
  "summary": "3-6 sentence overview of this dimension",
  "findings": [{"title": "...", "detail": "...", "frequency": "...", "confidence": "high|medium|low", "evidence": [{"thread_id": "...", "quote": "..."}]}],
  "columns": [{"key": "n", "label": "#"}, {"key": "...", "label": "..."}],
  "rows": [{"n": 1, "...": "..."}],
  "method": "how you actually derived this, 1-3 sentences",
  "limitations": ["..."]
}
Rows are the dimension's spreadsheet sheet: keys must match columns[].key, always include the "n" column, and row content must be consistent with the findings.`;

const VERIFIER_SYSTEM = `You are an independent verifier of analytical findings over a WhatsApp conversation corpus. You did not produce these findings. Your job is to refute what does not hold.

Respond with a SINGLE JSON object and nothing else:
{
  "refuted": [{"title": "<exact finding title>", "reason": "...", "correction": "..."}],
  "row_verification_notes": {"<row n>": "note about that row's verification"}
}
Write reasons/corrections/notes in language "${LANG}". Titles must match the finding titles EXACTLY so they can be removed programmatically. If nothing is refuted, return {"refuted": [], "row_verification_notes": {}}.`;

// --------------------------------------------------------------- LLM plumbing ---

const provider = createProvider(cfg.llm);

function extractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(s.slice(start, end + 1));
}

async function completeJson({ system, user, tag }) {
  const first = await provider.complete({ system, user, tag });
  try {
    return extractJson(first);
  } catch (e) {
    // One retry with the parse error attached — then fail loudly.
    const retry = await provider.complete({
      system,
      user: `${user}\n\nYour previous response was not valid JSON (${String(e).slice(0, 120)}). Respond again with ONLY the JSON object.`,
      tag,
    });
    return extractJson(retry);
  }
}

// ------------------------------------------------------- code-layer verifier ---

/** Layer A: quotes must exist verbatim in the cited thread. Deterministic. */
function codeVerify(findings) {
  const refuted = [];
  const ok = [];
  for (const f of findings) {
    const evidence = Array.isArray(f.evidence) ? f.evidence : [];
    if (evidence.length === 0) {
      refuted.push({ title: f.title, reason: 'Sin evidencia citada: ningún hallazgo se acepta sin cita textual verificable.', correction: '' });
      continue;
    }
    const bad = evidence.find((ev) => !verifyQuote(threadsById.get(String(ev.thread_id)), ev.quote).found);
    if (bad) {
      refuted.push({
        title: f.title,
        reason: `La cita "${String(bad.quote).slice(0, 80)}" no existe textualmente en el hilo ${bad.thread_id} (verificación automática contra el corpus).`,
        correction: '',
      });
    } else {
      ok.push(f);
    }
  }
  return { refuted, ok };
}

// ---------------------------------------------------------------- main loop ---

const verifierPrompt = readPrompt('verifier');
const dimensions = [];
console.log(`Analyzing ${dims.length} dimension(s) with provider ${provider.name} (digest ${digest.length.toLocaleString()} chars)\n`);

for (const key of dims) {
  const { title, body } = readPrompt(key);
  console.log(`▸ ${key} — generating...`);

  const gen = await completeJson({
    system: GENERATOR_SYSTEM,
    user: `## Dimension: ${title}\n\n${body}${contextBlock}\n\n## Deterministic stats block\n${statsBlock}\n\n## Corpus digest\n${digest}`,
    tag: `generate-${key}`,
  });

  const findings = Array.isArray(gen.findings) ? gen.findings : [];
  const { refuted: codeRefuted, ok: codeOk } = codeVerify(findings);
  if (codeRefuted.length) {
    console.log(`  layer A (code): refuted ${codeRefuted.length}/${findings.length} — fabricated or unverifiable evidence`);
  }

  console.log(`  layer B (independent LLM verifier)...`);
  const ver = await completeJson({
    system: VERIFIER_SYSTEM,
    user:
      `${verifierPrompt.body}${contextBlock}\n\n## Findings to verify (dimension: ${title})\n${JSON.stringify({ findings: codeOk, rows: gen.rows ?? [] }, null, 1)}\n\n` +
      `## Automated evidence check already refuted these (treat as refuted)\n${JSON.stringify(codeRefuted, null, 1)}\n\n` +
      `## Deterministic stats block\n${statsBlock}\n\n## Corpus digest\n${digest}`,
    tag: `verify-${key}`,
  });

  // Layer-B refutations must target a real surviving finding: a title the LLM
  // paraphrased matches nothing, would inflate the refuted count AND let the
  // targeted finding survive. Match strictly, dedupe, and warn on strays.
  const codeOkTitles = new Set(codeOk.map((f) => f.title));
  const llmRefuted = [];
  const seenTitles = new Set();
  for (const r of (Array.isArray(ver.refuted) ? ver.refuted : [])) {
    if (!r.title || seenTitles.has(r.title)) continue;
    seenTitles.add(r.title);
    if (codeRefuted.some((c) => c.title === r.title)) continue; // already refuted by layer A
    if (!codeOkTitles.has(r.title)) {
      console.warn(`  ! verifier refuted a title that matches no finding (ignored): "${String(r.title).slice(0, 80)}"`);
      continue;
    }
    llmRefuted.push(r);
  }
  const allRefuted = [...codeRefuted, ...llmRefuted];
  const refutedTitles = new Set(allRefuted.map((r) => r.title));
  const surviving = codeOk.filter((f) => !refutedTitles.has(f.title));

  dimensions.push({
    key,
    title,
    summary: String(gen.summary ?? ''),
    findings: surviving,
    columns: Array.isArray(gen.columns) && gen.columns.length ? gen.columns : [{ key: 'n', label: '#' }],
    rows: Array.isArray(gen.rows) ? gen.rows : [],
    method: String(gen.method ?? ''),
    limitations: Array.isArray(gen.limitations) ? gen.limitations : [],
    verdict: {
      reviewed: findings.length,
      confirmed: surviving.length,
      refuted: allRefuted,
    },
    row_verification_notes: ver.row_verification_notes && typeof ver.row_verification_notes === 'object'
      ? ver.row_verification_notes
      : {},
  });
  console.log(`  verdict: reviewed ${findings.length} · confirmed ${surviving.length} · refuted ${allRefuted.length}`);
}

// ------------------------------------------------------------------- output ---

const out = { schema_version: 1, dimensions };

// Structural self-check (full JSON Schema validation: npm run check:analysis).
for (const d of dimensions) {
  for (const field of ['key', 'title', 'verdict', 'columns', 'rows']) {
    if (d[field] === undefined) {
      console.error(`Internal error: dimension "${d.key}" missing "${field}"`);
      process.exit(1);
    }
  }
  if (d.verdict.reviewed !== d.verdict.confirmed + d.verdict.refuted.length) {
    console.error(`Internal error: dimension "${d.key}" verdict arithmetic does not close (${d.verdict.reviewed} != ${d.verdict.confirmed} + ${d.verdict.refuted.length})`);
    process.exit(1);
  }
}

const outFile = path.join(OUT_DIR, 'analysis.json');
writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

const totals = dimensions.reduce(
  (a, d) => ({ reviewed: a.reviewed + d.verdict.reviewed, refuted: a.refuted + d.verdict.refuted.length }),
  { reviewed: 0, refuted: 0 },
);
console.log(`\n✓ ${dimensions.length} dimension(s) → ${outFile}`);
console.log(`  total findings reviewed: ${totals.reviewed} · refuted: ${totals.refuted}`);
console.log('  next: npm run check:analysis && npm run report');
