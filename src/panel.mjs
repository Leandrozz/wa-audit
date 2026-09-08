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
import { createJobRunner, commandFor } from './lib/jobs.mjs';
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
  const cmd = commandFor(String(step), cfg, options && typeof options === 'object' ? options : {});
  store.ensureConfig(slug);
  const job = jobs.start({
    slug,
    step: String(step),
    ...cmd,
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
