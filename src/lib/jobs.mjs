/**
 * Pipeline jobs for the web panel: which script a step spawns (commandFor)
 * and a one-at-a-time child-process runner that keeps the last N output
 * lines and notifies subscribers line by line (the server turns that into
 * SSE). Spawning mirrors tools/demo.mjs and the MCP server: the same
 * src/*.mjs scripts, a per-audit WA_OUT_DIR / WA_CONFIG_FILE in env.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export class JobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const STEPS = ['probe', 'export', 'threads', 'analyze', 'report-xlsx', 'report-html', 'report-docx'];
const DIM_RE = /^[a-z_]+$/;
const REPORTS = { 'report-xlsx': 'src/report-xlsx.mjs', 'report-html': 'src/report-html.mjs', 'report-docx': 'src/report-docx.mjs' };

/** step + resolved config (+ options) → { script, args }. Throws JobError(400) on anything it will not run. */
export function commandFor(step, cfg, options = {}) {
  const { kind, session } = cfg.source;
  switch (step) {
    case 'probe':
      if (kind !== 'waha') throw new JobError(400, 'probe only applies to WAHA audits');
      return { script: 'src/probe.mjs', args: [] };
    case 'export': {
      if (kind === 'waha') return { script: 'src/export.mjs', args: [session] };
      if (kind === 'kapso') return { script: 'src/export-kapso.mjs', args: [] };
      const args = [];
      if (options.since !== undefined && options.since !== null && options.since !== '') {
        const n = Number(options.since);
        if (!Number.isInteger(n) || n < 1) throw new JobError(400, 'since must be a positive integer (days)');
        args.push('--since', String(n));
      }
      return { script: 'src/export-ig.mjs', args };
    }
    case 'threads': {
      const args = ['--session', session];
      if (kind !== 'waha' || options.noNet) args.push('--no-net');
      return { script: 'src/threads.mjs', args };
    }
    case 'analyze': {
      const args = [];
      const dims = options.dimensions;
      if (Array.isArray(dims) && dims.length) {
        if (!dims.every((d) => typeof d === 'string' && DIM_RE.test(d))) throw new JobError(400, 'dimension keys are lowercase letters and "_" only');
        args.push('--dimensions', dims.join(','));
      }
      return { script: 'src/analyze.mjs', args };
    }
    default:
      if (REPORTS[step]) return { script: REPORTS[step], args: [] };
      throw new JobError(400, `unknown step "${step}" — expected one of ${STEPS.join(', ')}`);
  }
}

// ponytail: global lock, per-audit locks if two clients ever matter
export function createJobRunner({ root, maxLines = 2000 }) {
  let seq = 0;
  let job = null;
  let child = null;
  const listeners = new Set();
  const emit = (ev) => {
    for (const fn of [...listeners]) {
      try { fn(ev); } catch (e) { console.error(`job listener failed: ${e?.message ?? e}`); }
    }
  };
  const view = () => job && {
    id: job.id,
    slug: job.slug,
    step: job.step,
    started_at: job.started_at,
    ended_at: job.ended_at,
    exit_code: job.exit_code,
    running: child !== null,
    tail: job.lines.slice(-40),
  };

  return {
    current: view,
    running: () => child !== null,
    lines: () => (job ? job.lines : []),

    start({ slug, step, script, args = [], env }) {
      if (child) throw new JobError(409, `a job is already running (${job.step} on "${job.slug}")`);
      job = { id: ++seq, slug, step, started_at: new Date().toISOString(), ended_at: null, exit_code: null, lines: [] };
      const proc = spawn(process.execPath, [path.join(root, script), ...args], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child = proc;
      const push = (s, t) => {
        job.lines.push({ s, t });
        if (job.lines.length > maxLines) job.lines.shift();
        emit({ type: 'line', s, t });
      };
      // Chunks split lines anywhere; keep the partial tail per stream.
      const lineReader = (s) => {
        let rest = '';
        return {
          data: (chunk) => {
            rest += chunk;
            const parts = rest.split(/\r?\n/);
            rest = parts.pop();
            for (const t of parts) if (t) push(s, t);
          },
          flush: () => { if (rest) push(s, rest); rest = ''; },
        };
      };
      const out = lineReader('out');
      const err = lineReader('err');
      proc.stdout.setEncoding('utf8').on('data', out.data);
      proc.stderr.setEncoding('utf8').on('data', err.data);
      proc.on('error', (e) => push('err', `spawn failed: ${e.message}`));
      proc.on('close', (code) => {
        out.flush();
        err.flush();
        job.ended_at = new Date().toISOString();
        job.exit_code = code;
        child = null;
        emit({ type: 'end', exit_code: code });
      });
      return view();
    },

    cancel() {
      if (!child) return false;
      child.kill();
      return true;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
