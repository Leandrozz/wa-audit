/**
 * Audit store for the web panel: one directory per audit under DATA_DIR
 * (`data/<slug>/`), each with its own wa-audit.config.json and every
 * pipeline file inside. Everything here is plain filesystem reads/writes;
 * no HTTP. Errors carry an HTTP status for the panel's router.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS_DIR = path.join(ROOT, 'analysis', 'prompts');
const CONFIG_NAME = 'wa-audit.config.json';
const PIPELINE_FILES = ['business-context.json', 'messages.jsonl', 'threads.json', 'summary.json', 'messages.csv', 'analysis.json'];
const EXTRA_DOWNLOADS = ['threads.json', 'summary.json', 'analysis.json', 'messages.csv'];

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class AuditError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const readJsonOr = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const stripDerived = (cfg) => {
  const { offsetMinutes, ...timezone } = cfg.timezone;
  return { ...cfg, timezone };
};
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Analysis dimensions available to the built-in engine: analysis/prompts/*.md minus the verifier. */
export function listDimensions() {
  return fs.readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'verifier.md')
    .sort()
    .map((f) => {
      const key = f.replace(/\.md$/, '');
      const first = fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf8').split('\n')[0] ?? '';
      return { key, title: first.replace(/^#\s*/, '').trim() || key };
    });
}

export function createAuditStore({ dataDir, baseline }) {
  const dirOf = (slug) => {
    if (!SLUG_RE.test(String(slug ?? ''))) throw new AuditError(400, `invalid audit slug "${slug}" — lowercase letters, digits and "-" (max 64)`);
    return path.join(dataDir, slug);
  };
  const existing = (slug) => {
    const d = dirOf(slug);
    if (!fs.existsSync(d)) throw new AuditError(404, `audit "${slug}" not found`);
    return d;
  };
  const configPath = (slug) => path.join(dirOf(slug), CONFIG_NAME);
  const seed = (slug) => structuredClone({
    ...baseline,
    business: { ...baseline.business, name: slug },
    output: { dir: dirOf(slug) },
  });
  const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');

  function readConfig(slug) {
    existing(slug);
    const file = configPath(slug);
    const stored = fs.existsSync(file) ? readJsonOr(file, null) : seed(slug);
    if (!isPlainObject(stored)) throw new AuditError(500, `${CONFIG_NAME} of "${slug}" is not a JSON object`);
    return stripDerived(resolveConfig(stored, {}).cfg);
  }
  function reportNames(slug) {
    const f = readConfig(slug).report.filename;
    const base = path.basename(f, path.extname(f));
    return [f, `${base}.html`, `${base}.docx`];
  }
  function files(slug) {
    const d = existing(slug);
    const out = {};
    for (const f of [...PIPELINE_FILES, ...reportNames(slug)]) out[f] = fs.existsSync(path.join(d, f));
    return out;
  }
  function loadThreads(slug) {
    const c = readJsonOr(path.join(existing(slug), 'threads.json'), null);
    if (c?.schema_version !== 1 || !Array.isArray(c.threads)) throw new AuditError(404, 'no corpus yet — run the threads step first');
    return c.threads;
  }
  const item = (slug) => ({ slug, has_config: fs.existsSync(configPath(slug)), business_name: readConfig(slug).business.name, files: files(slug) });

  return {
    dir: existing,
    configPath,

    list() {
      if (!fs.existsSync(dataDir)) return [];
      return fs.readdirSync(dataDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
        .map((e) => e.name)
        .sort()
        .map(item);
    },

    create(slug) {
      const d = dirOf(slug);
      if (fs.existsSync(d)) throw new AuditError(409, `audit "${slug}" already exists`);
      fs.mkdirSync(d, { recursive: true });
      writeJson(configPath(slug), seed(slug));
      return item(slug);
    },

    readConfig,

    ensureConfig(slug) {
      existing(slug);
      if (!fs.existsSync(configPath(slug))) writeJson(configPath(slug), seed(slug));
    },

    writeConfig(slug, body) {
      const d = existing(slug);
      if (!isPlainObject(body)) throw new AuditError(400, 'config must be a JSON object');
      const { cfg, warnings, errors } = resolveConfig(body, {});
      const problems = [...errors, ...warnings];
      if (problems.length) throw new AuditError(400, problems.join('\n'));
      const out = stripDerived({ ...cfg, output: { dir: d } });
      writeJson(configPath(slug), out);
      return out;
    },

    status(slug) {
      const d = existing(slug);
      const f = files(slug);
      const analysis = readJsonOr(path.join(d, 'analysis.json'), null);
      const next = !f['business-context.json'] ? 'context'
        : !f['messages.jsonl'] ? 'export'
        : !f['threads.json'] ? 'threads'
        : !f['analysis.json'] ? 'analyze'
        : 'report';
      return {
        slug,
        dir: d,
        files: f,
        summary: readJsonOr(path.join(d, 'summary.json'), null),
        dimensions_done: (analysis?.dimensions ?? []).map((x) => x.key),
        next_step: next,
      };
    },

    readContext(slug) {
      return readJsonOr(path.join(existing(slug), 'business-context.json'), {});
    },

    writeContext(slug, obj) {
      const d = existing(slug);
      if (!isPlainObject(obj)) throw new AuditError(400, 'context must be a JSON object');
      writeJson(path.join(d, 'business-context.json'), obj);
      return obj;
    },

    threadsPage(slug, offset = 0, limit = 20) {
      const off = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
      const lim = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
      const ordered = loadThreads(slug)
        .filter((t) => !t.is_system)
        .sort((a, b) => (b.metrics.two_way - a.metrics.two_way) || (b.metrics.total - a.metrics.total));
      const items = ordered.slice(off, off + lim).map(({ thread_id, contact_name, is_internal, is_system, unresolved_lid, crm, metrics }) =>
        ({ thread_id, contact_name, is_internal, is_system, unresolved_lid, crm, metrics }));
      return { items, total: ordered.length, offset: off, limit: lim };
    },

    thread(slug, id) {
      const t = loadThreads(slug).find((x) => x.thread_id === id);
      if (!t) throw new AuditError(404, `thread ${id} not found`);
      return t;
    },

    analysis(slug) {
      const a = readJsonOr(path.join(existing(slug), 'analysis.json'), null);
      if (!a) throw new AuditError(404, 'no analysis yet — run the analyze step first');
      return a;
    },

    /** Download whitelist: the three report names + the corpus/analysis files. Null when not allowed or not there. */
    filePath(slug, name) {
      const d = existing(slug);
      const allowed = [...reportNames(slug), ...EXTRA_DOWNLOADS];
      if (!allowed.includes(name)) return null;
      const p = path.resolve(d, name);
      if (!p.startsWith(d + path.sep) || !fs.existsSync(p)) return null;
      return p;
    },
  };
}
