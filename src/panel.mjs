#!/usr/bin/env node
/**
 * wa-audit local web panel — manage several audits from a browser: source
 * selection, WAHA onboarding (QR on screen), every pipeline phase with live
 * logs, corpus and verified findings as read-only views, per-audit config
 * and the reports as downloads.
 *
 * Loopback only, no login. Zero dependencies: node:http + src/panel.html.
 * It spawns the same src/*.mjs scripts the CLI and the MCP server run; the
 * pipeline, the verifier and the data contract do not change.
 *
 * Run: npm run panel   (http://127.0.0.1:8480; WA_PANEL_PORT to change)
 * Env files waha.env / kapso.env / ig.env are loaded from cwd at start
 * (existing env wins) — restart after editing them. Layout:
 *   data/<slug>/wa-audit.config.json + the pipeline files of that audit
 *   (WA_PANEL_DATA_DIR overrides data/).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './lib/config.mjs';
import { createAuditStore, listDimensions } from './lib/audits.mjs';
import { createJobRunner, commandFor, commandsForAll } from './lib/jobs.mjs';
import { listSessions, createSession, qrPng, WahaError } from './lib/waha.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'src', 'panel.html');
const ENV_FILES = ['waha.env', 'kapso.env', 'ig.env'];
for (const f of ENV_FILES) if (fs.existsSync(f)) process.loadEnvFile(f);

// WA_* env vars beat every audit's config file (see src/lib/config.mjs); make
// that visible instead of letting it silently rewrite every report's identity.
const OVERRIDES = Object.keys(process.env).filter((k) => /^WA_/.test(k) && !/^WA_(PANEL_|CONFIG_FILE$|OUT_DIR$)/.test(k)).sort();
if (OVERRIDES.length) console.warn(`! WA_* variables in the environment override every audit's config: ${OVERRIDES.join(', ')}`);

const DATA_DIR = path.resolve(process.env.WA_PANEL_DATA_DIR || 'data');
const PORT = Number(process.env.WA_PANEL_PORT ?? 8480);
const { timezone: { offsetMinutes, ...timezone }, ...restOfBaseline } = loadConfig();
const store = createAuditStore({ dataDir: DATA_DIR, baseline: { ...restOfBaseline, timezone } });
const jobs = createJobRunner({ root: ROOT });

const HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BODY = 1024 * 1024;
const csp = (nonce) => `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`;
const MIME = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function send(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Over the cap: stop keeping chunks but keep draining, so the client
    // finishes sending and gets a clean 413 instead of a reset socket.
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'body too large (max 1 MiB)'));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return reject(new HttpError(400, 'body must be a JSON object'));
      try {
        const v = JSON.parse(raw);
        if (v === null || typeof v !== 'object') throw new Error('not an object');
        resolve(v);
      } catch {
        reject(new HttpError(400, 'body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** decodeURIComponent that turns a malformed escape into a 400 instead of a 500. */
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'malformed URL escape');
  }
};

function envFiles() {
  return ENV_FILES.map((file) => {
    if (!fs.existsSync(file)) return { file, exists: false, keys: [] };
    const keys = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter(Boolean);
    return { file, exists: true, keys };
  });
}

// ------------------------------------------------------------------ routes ---
// handler(req, res, params, url) → [status, jsonBody] or undefined when it wrote the response itself.
const routes = [];
const route = (method, re, handler) => routes.push({ method, re, handler });

route('GET', /^\/$/, (req, res) => {
  if (!fs.existsSync(HTML)) throw new HttpError(404, 'src/panel.html is missing');
  const nonce = randomUUID();
  const html = fs.readFileSync(HTML, 'utf8').replaceAll('__CSP_NONCE__', nonce);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp(nonce), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(html);
});

route('GET', /^\/api\/audits$/, () => [200, store.list()]);
route('POST', /^\/api\/audits$/, async (req) => [201, store.create((await readJson(req)).slug)]);
route('GET', /^\/api\/audits\/([^/]+)\/config$/, (req, res, [slug]) => [200, store.readConfig(slug)]);
route('PUT', /^\/api\/audits\/([^/]+)\/config$/, async (req, res, [slug]) => [200, store.writeConfig(slug, await readJson(req))]);
route('GET', /^\/api\/audits\/([^/]+)\/status$/, (req, res, [slug]) => [200, store.status(slug)]);
route('GET', /^\/api\/audits\/([^/]+)\/business-context$/, (req, res, [slug]) => [200, store.readContext(slug)]);
route('PUT', /^\/api\/audits\/([^/]+)\/business-context$/, async (req, res, [slug]) => [200, store.writeContext(slug, await readJson(req))]);
route('GET', /^\/api\/audits\/([^/]+)\/threads$/, (req, res, [slug], url) =>
  [200, store.threadsPage(slug, Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 20))]);
route('GET', /^\/api\/audits\/([^/]+)\/threads\/([^/]+)$/, (req, res, [slug, id]) => [200, store.thread(slug, decode(id))]);
route('GET', /^\/api\/audits\/([^/]+)\/analysis$/, (req, res, [slug]) => [200, store.analysis(slug)]);
route('GET', /^\/api\/dimensions$/, () => [200, listDimensions()]);
route('GET', /^\/api\/env$/, () => [200, { files: envFiles(), overrides: OVERRIDES }]);

// ----------------------------------------------------------------- setup ---
// First-run setup from the Inicio screen: WAHA URL/key and the LLM key are
// written to waha.env in cwd (the file the README already prescribes) and
// applied to this process at once. Values are never sent back to the browser.
const SETUP_FILE = 'waha.env';
const LLM_KEY = { anthropic: 'ANTHROPIC_API_KEY', openai: 'LLM_API_KEY' };
const setupView = () => ({
  waha: { base: (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, ''), has_key: Boolean(process.env.WAHA_API_KEY) },
  llm: { has_anthropic_key: Boolean(process.env.ANTHROPIC_API_KEY), has_openai_key: Boolean(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY) },
  env_file: SETUP_FILE,
  // The simulated provider only knows the dimensions that have canned answers in the fixtures.
  demo_canned_dir: path.join(ROOT, 'fixtures', 'llm-canned'),
  demo_dimensions: fs.readdirSync(path.join(ROOT, 'fixtures', 'llm-canned')).map((f) => /^generate-(.+)\.json$/.exec(f)?.[1]).filter(Boolean).sort(),
});
const secret = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 512) throw new HttpError(400, `${name} must be a single line of at most 512 characters`);
  return v.trim();
};
/** Upserts KEY=value lines into an env file, keeping every other line (comments included), and applies them to process.env. */
function upsertEnv(file, entries) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(entries)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
    process.env[key] = value;
  }
  // Owner-only: the file holds API keys. (A no-op on Windows ACLs; real on Linux/macOS.)
  fs.writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* filesystem without POSIX modes */ }
}
route('GET', /^\/api\/setup$/, () => [200, setupView()]);
route('POST', /^\/api\/setup$/, async (req) => {
  const body = await readJson(req);
  const entries = {};
  if (body.waha_base !== undefined && body.waha_base !== '') {
    const base = String(body.waha_base).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(base)) throw new HttpError(400, 'waha_base must be an http(s) URL');
    entries.WAHA_BASE_URL = base;
  }
  const wahaKey = secret(body.waha_key, 'waha_key');
  if (wahaKey) entries.WAHA_API_KEY = wahaKey;
  if (body.llm_provider !== undefined) {
    if (!Object.hasOwn(LLM_KEY, body.llm_provider) && body.llm_provider !== 'mock') throw new HttpError(400, 'llm_provider must be anthropic, openai or mock');
    const llmKey = secret(body.llm_key, 'llm_key');
    if (llmKey && LLM_KEY[body.llm_provider]) entries[LLM_KEY[body.llm_provider]] = llmKey;
  } else if (body.llm_key !== undefined && body.llm_key !== '') {
    throw new HttpError(400, 'llm_key needs llm_provider');
  }
  if (Object.keys(entries).length) upsertEnv(SETUP_FILE, entries);
  return [200, setupView()];
});

/** Runs a WAHA client call; a network failure (fetch throws TypeError, e.g. the instance is unreachable) becomes a 502 instead of an uncaught crash. */
async function waha(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TypeError) throw new HttpError(502, 'WAHA unreachable: ' + e.message);
    throw e;
  }
}

route('GET', /^\/api\/waha\/sessions$/, async () => [200, await waha(() => listSessions())]);
route('POST', /^\/api\/waha\/sessions$/, async (req) => {
  const name = String((await readJson(req)).name ?? '');
  if (!SESSION_RE.test(name)) throw new HttpError(400, 'invalid session name — letters, digits, "_" and "-" only');
  return [201, { name, body: await waha(() => createSession(name)) }];
});
route('GET', /^\/api\/waha\/qr\/([^/]+)$/, async (req, res, [session]) => {
  const png = await waha(() => qrPng(decode(session)));
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(png);
});

route('GET', /^\/api\/audits\/([^/]+)\/files\/([^/]+)$/, async (req, res, [slug, name]) => {
  const file = store.filePath(slug, decode(name));
  if (!file) throw new HttpError(404, 'no such file');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${path.basename(file).replace(/["\\\r\n]/g, '_')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  await pipeline(fs.createReadStream(file), res).catch((e) => { console.error(e); res.destroy(); });
});

route('POST', /^\/api\/audits\/([^/]+)\/run$/, async (req, res, [slug]) => {
  const { step, options = {} } = await readJson(req);
  const cfg = store.readConfig(slug);
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  // "all" = the whole pipeline as one job (Iniciar auditoría); anything else is a single step.
  const spec = String(step) === 'all' ? { commands: commandsForAll(cfg, opts) } : commandFor(String(step), cfg, opts);
  store.ensureConfig(slug);
  // "Iniciar" skips the operator interview on purpose; seed the minimum so the analysis knows the business name.
  if (spec.commands && !Object.keys(store.readContext(slug)).length) store.writeContext(slug, { business_name: cfg.business.name });
  const job = jobs.start({
    slug,
    step: String(step),
    ...spec,
    env: { ...process.env, WA_OUT_DIR: store.dir(slug), WA_CONFIG_FILE: store.configPath(slug) },
  });
  return [202, job];
});

route('GET', /^\/api\/jobs\/current$/, () => [200, jobs.current()]);

route('POST', /^\/api\/jobs\/cancel$/, () => {
  if (!jobs.cancel()) throw new HttpError(404, 'no job is running');
  return [200, { cancelled: true }];
});

route('GET', /^\/api\/jobs\/stream$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
  res.flushHeaders();
  const write = (ev) => res.write(ev.type === 'end'
    ? `event: end\ndata: ${JSON.stringify({ exit_code: ev.exit_code, signal: ev.signal ?? null, cancelled: ev.cancelled ?? false })}\n\n`
    : `data: ${JSON.stringify({ s: ev.s, t: ev.t })}\n\n`);
  for (const line of jobs.lines()) write({ type: 'line', ...line });
  if (!jobs.running()) {
    const cur = jobs.current();
    write({ type: 'end', exit_code: cur?.exit_code ?? null, signal: cur?.signal ?? null, cancelled: cur?.cancelled ?? false });
    res.end();
    return;
  }
  const off = jobs.subscribe((ev) => {
    write(ev);
    if (ev.type === 'end') { off(); res.end(); }
  });
  req.on('close', off);
});

// ------------------------------------------------------------------ server ---
const server = http.createServer(async (req, res) => {
  try {
    if (!HOST_RE.test(req.headers.host ?? '')) throw new HttpError(403, 'forbidden host');
    if (req.method !== 'GET') {
      const ct = String(req.headers['content-type'] ?? '');
      if (!ct.startsWith('application/json') || req.headers['x-wa-panel'] !== '1') {
        throw new HttpError(403, 'mutations need Content-Type: application/json and X-WA-Panel: 1');
      }
    }
    const url = new URL(req.url, 'http://localhost');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const out = await r.handler(req, res, m.slice(1), url);
      if (out) send(res, out[0], out[1]);
      return;
    }
    if (req.method !== 'GET') req.resume();
    throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
  } catch (e) {
    const status = e instanceof WahaError ? 502 : (e.status >= 400 ? e.status : 500);
    if (status >= 500) console.error(e);
    if (res.headersSent) { res.end(); return; }
    send(res, status, { error: e.message ?? String(e) });
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is already in use — is another panel running? (WA_PANEL_PORT changes it)` : e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`panel listening on http://127.0.0.1:${server.address().port}`);
  console.log(`data dir: ${DATA_DIR} · env files loaded: ${ENV_FILES.filter((f) => fs.existsSync(f)).join(', ') || 'none'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  jobs.cancel();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
