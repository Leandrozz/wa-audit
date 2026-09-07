/**
 * WAHA HTTP client shared by the MCP server and the web panel. Reads the
 * connection settings from env AT CALL TIME (they are secrets, env-only):
 *   WAHA_BASE_URL, WAHA_API_KEY, optional WAHA_BASIC_AUTH ("user:password").
 *
 * Toward WhatsApp this is read-only except for creating a session
 * (onboarding). Non-OK answers throw WahaError; an unreachable instance
 * throws whatever fetch throws (a TypeError).
 */

export const wahaBase = () => (process.env.WAHA_BASE_URL ?? '').replace(/\/+$/, '');

function headers(extra = {}) {
  const h = { 'X-Api-Key': process.env.WAHA_API_KEY ?? '', Accept: 'application/json', ...extra };
  if (process.env.WAHA_BASIC_AUTH) {
    h.Authorization = `Basic ${Buffer.from(process.env.WAHA_BASIC_AUTH, 'utf8').toString('base64')}`;
  }
  return h;
}

export class WahaError extends Error {
  constructor(message, status = 0, body = '') {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function requireBase() {
  const base = wahaBase();
  if (!base) throw new WahaError('WAHA_BASE_URL is not configured.', 0);
  return base;
}

/** GET /api/sessions?all=true → [{ name, status, engine }] */
export async function listSessions() {
  const base = requireBase();
  const r = await fetch(`${base}/api/sessions?all=true`, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new WahaError(`HTTP ${r.status} from ${base}`, r.status, (await r.text()).slice(0, 500));
  return (await r.json()).map((s) => ({ name: s.name, status: s.status, engine: s.engine?.engine ?? s.engine }));
}

/** POST /api/sessions with noweb.store.fullSync enabled. Returns the response body (≤500 chars). */
export async function createSession(name) {
  const base = requireBase();
  const r = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ name, start: true, config: { noweb: { store: { enabled: true, fullSync: true } } } }),
  });
  const body = (await r.text()).slice(0, 500);
  if (!r.ok) throw new WahaError(`WAHA answered HTTP ${r.status}: ${body}`, r.status, body);
  return body;
}

/** GET /api/{session}/auth/qr?format=image → PNG bytes. */
export async function qrPng(session) {
  const base = requireBase();
  const r = await fetch(`${base}/api/${encodeURIComponent(session)}/auth/qr?format=image`, {
    headers: headers({ Accept: 'image/png' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    throw new WahaError(`WAHA answered HTTP ${r.status}: ${body} (a WORKING session has no QR — check status)`, r.status, body);
  }
  return Buffer.from(await r.arrayBuffer());
}
