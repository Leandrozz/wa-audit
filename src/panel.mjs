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
import { loadConfig } from './lib/config.mjs';
import { createAuditStore, listDimensions } from './lib/audits.mjs';
import { createJobRunner, commandFor } from './lib/jobs.mjs';
import { listSessions, createSession, qrPng, WahaError } from './lib/waha.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'src', 'panel.html');
const ENV_FILES = ['waha.env', 'kapso.env', 'ig.env'];
for (const f of ENV_FILES) if (fs.existsSync(f)) process.loadEnvFile(f);

const DATA_DIR = path.resolve(process.env.WA_PANEL_DATA_DIR || 'data');
const PORT = Number(process.env.WA_PANEL_PORT ?? 8480);
const { timezone: { offsetMinutes, ...timezone }, ...restOfBaseline } = loadConfig();
const store = createAuditStore({ dataDir: DATA_DIR, baseline: { ...restOfBaseline, timezone } });
const jobs = createJobRunner({ root: ROOT });

const HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BODY = 1024 * 1024;
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'";
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
      if (!raw.trim()) return resolve({});
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(HTML));
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
route('GET', /^\/api\/audits\/([^/]+)\/threads\/([^/]+)$/, (req, res, [slug, id]) => [200, store.thread(slug, decodeURIComponent(id))]);
route('GET', /^\/api\/audits\/([^/]+)\/analysis$/, (req, res, [slug]) => [200, store.analysis(slug)]);
route('GET', /^\/api\/dimensions$/, () => [200, listDimensions()]);
route('GET', /^\/api\/env$/, () => [200, envFiles()]);

route('GET', /^\/api\/waha\/sessions$/, async () => [200, await listSessions()]);
route('POST', /^\/api\/waha\/sessions$/, async (req) => {
  const name = String((await readJson(req)).name ?? '');
  if (!SESSION_RE.test(name)) throw new HttpError(400, 'invalid session name — letters, digits, "_" and "-" only');
  return [201, { name, body: await createSession(name) }];
});
route('GET', /^\/api\/waha\/qr\/([^/]+)$/, async (req, res, [session]) => {
  const png = await qrPng(decodeURIComponent(session));
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(png);
});

// Jobs, SSE and downloads: Task 6 appends them here.

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
    throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
  } catch (e) {
    const status = e.status && e.status >= 400 && !(e instanceof WahaError) ? e.status : e instanceof WahaError ? 502 : 500;
    if (status >= 500) console.error(e);
    if (res.headersSent) { res.end(); return; }
    send(res, status, { error: e.message ?? String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`panel listening on http://127.0.0.1:${server.address().port}`);
  console.log(`data dir: ${DATA_DIR} · env files loaded: ${ENV_FILES.filter((f) => fs.existsSync(f)).join(', ') || 'none'}`);
});
