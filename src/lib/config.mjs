/**
 * Configuration loader. Precedence: defaults < wa-audit.config.json (cwd) < env.
 *
 * The config file is optional — the pipeline runs with defaults plus env vars.
 * Env overrides exist so tests and one-off runs don't need to write a file:
 *   WA_OUT_DIR, WA_BUSINESS_NAME, WA_INTERNAL_EMAIL_DOMAINS (comma-separated),
 *   WA_INTERNAL_NUMBERS (comma-separated), WA_CRM_FILE, WA_REPORT_FILENAME,
 *   WA_LOCALE, WA_TZ_OFFSET (e.g. "-03:00"), WA_DEFAULT_COUNTRY (ISO-3166),
 *   WA_LLM_PROVIDER, WA_LLM_MODEL, WA_LLM_BASE_URL, WA_LLM_CANNED_DIR,
 *   WA_ANALYSIS_LANGUAGE,
 *   WA_CONFIG_FILE (path of the config file to read instead of ./wa-audit.config.json; must exist if set)
 *
 * WAHA connection settings (WAHA_BASE_URL, WAHA_API_KEY, WAHA_BASIC_AUTH,
 * WAHA_SESSION) are env-only on purpose: they are secrets, not configuration.
 * WAHA_BASE_URL has no default on purpose — pointing at the wrong instance is
 * the expensive mistake.
 */
import { readFileSync, existsSync } from 'node:fs';

export const DEFAULTS = {
  business: {
    name: 'My Business',
    internalNumbers: [],       // E.164 or any parseable format; marked is_internal
    internalEmailDomains: [],  // CRM contacts on these domains are internal lines
  },
  phone: {
    defaultCountry: 'AR',      // ISO-3166 country for CRM numbers without prefix
  },
  timezone: {
    utcOffset: '-03:00',       // fixed offset for local timestamps in the corpus
  },
  locale: 'es-AR',             // number formatting of the generated report
  output: {
    dir: 'data/wa-history',
  },
  report: {
    filename: 'whatsapp-report.xlsx',
  },
  crm: {
    file: null,                // path to a CRM CSV (see docs/data-contract.md)
  },
  llm: {
    provider: 'anthropic',     // anthropic | openai | mock (src/lib/llm.mjs)
    model: null,               // default per provider (anthropic: claude-opus-5)
    baseUrl: null,             // override for OpenAI-compatible endpoints
    maxTokens: 16000,
    cannedDir: null,           // mock provider: directory of canned responses
  },
  analysis: {
    language: 'es',            // language the LLM writes the report content in
    maxCorpusChars: 150000,    // context budget for the corpus digest
  },
  source: {
    kind: 'waha',              // waha | kapso | ig — which exporter the panel runs
    session: 'default',        // WAHA session name / corpus label for kapso and ig
  },
};

const CONFIG_FILE = 'wa-audit.config.json';
const SOURCE_KINDS = ['waha', 'kapso', 'ig'];
const SESSION_RE = /^[A-Za-z0-9_-]+$/;

function mergeSection(base, over, path, warnings) {
  if (over === undefined) return base;
  if (base !== null && typeof base === 'object' && !Array.isArray(base)) {
    const out = { ...base };
    for (const k of Object.keys(over ?? {})) {
      if (!(k in base)) {
        warnings.push(`unknown config key "${path}${k}" ignored`);
        continue;
      }
      out[k] = mergeSection(base[k], over[k], `${path}${k}.`, warnings);
    }
    return out;
  }
  return over;
}

const csvList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Pure resolution: defaults < fromFile < env. Never prints, never exits.
 * Returns { cfg, warnings, errors }; cfg.timezone.offsetMinutes is set when
 * the offset is valid. Both the CLIs (via loadConfig) and the web panel
 * validate through this one function.
 */
export function resolveConfig(fromFile = {}, env = {}) {
  const warnings = [];
  const errors = [];
  const cfg = mergeSection(structuredClone(DEFAULTS), fromFile, '', warnings);

  if (env.WA_OUT_DIR) cfg.output.dir = env.WA_OUT_DIR;
  if (env.WA_BUSINESS_NAME) cfg.business.name = env.WA_BUSINESS_NAME;
  if (env.WA_INTERNAL_EMAIL_DOMAINS) cfg.business.internalEmailDomains = csvList(env.WA_INTERNAL_EMAIL_DOMAINS);
  if (env.WA_INTERNAL_NUMBERS) cfg.business.internalNumbers = csvList(env.WA_INTERNAL_NUMBERS);
  if (env.WA_CRM_FILE) cfg.crm.file = env.WA_CRM_FILE;
  if (env.WA_REPORT_FILENAME) cfg.report.filename = env.WA_REPORT_FILENAME;
  if (env.WA_LOCALE) cfg.locale = env.WA_LOCALE;
  if (env.WA_TZ_OFFSET) cfg.timezone.utcOffset = env.WA_TZ_OFFSET;
  if (env.WA_DEFAULT_COUNTRY) cfg.phone.defaultCountry = env.WA_DEFAULT_COUNTRY;
  if (env.WA_LLM_PROVIDER) cfg.llm.provider = env.WA_LLM_PROVIDER;
  if (env.WA_LLM_MODEL) cfg.llm.model = env.WA_LLM_MODEL;
  if (env.WA_LLM_BASE_URL) cfg.llm.baseUrl = env.WA_LLM_BASE_URL;
  if (env.WA_LLM_CANNED_DIR) cfg.llm.cannedDir = env.WA_LLM_CANNED_DIR;
  if (env.WA_ANALYSIS_LANGUAGE) cfg.analysis.language = env.WA_ANALYSIS_LANGUAGE;

  const m = /^([+-])(\d{2}):(\d{2})$/.exec(cfg.timezone.utcOffset);
  if (!m) {
    errors.push(`Invalid timezone.utcOffset "${cfg.timezone.utcOffset}" — expected e.g. "-03:00"`);
  } else {
    // Single source of truth for the offset: minutes for math, string for ISO suffixes.
    cfg.timezone.offsetMinutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  }
  if (!SOURCE_KINDS.includes(cfg.source.kind)) {
    errors.push(`Invalid source.kind "${cfg.source.kind}" — expected one of ${SOURCE_KINDS.join(', ')}`);
  }
  if (!SESSION_RE.test(String(cfg.source.session))) {
    errors.push(`Invalid source.session "${cfg.source.session}" — letters, digits, "_" and "-" only`);
  }
  return { cfg, warnings, errors };
}

export function loadConfig() {
  const explicit = process.env.WA_CONFIG_FILE;
  const file = explicit || CONFIG_FILE;
  let fromFile = {};
  if (explicit && !existsSync(file)) {
    console.error(`WA_CONFIG_FILE points to "${file}", which does not exist`);
    process.exit(1);
  }
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`Could not parse ${file}: ${String(e).slice(0, 160)}`);
      process.exit(1);
    }
  }
  const { cfg, warnings, errors } = resolveConfig(fromFile, process.env);
  for (const e of errors) console.error(e);
  if (errors.length) process.exit(1);
  for (const w of warnings) console.warn(`  ! config: ${w}`);
  return cfg;
}
