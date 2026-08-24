/**
 * Configuration loader. Precedence: defaults < wa-audit.config.json (cwd) < env.
 *
 * The config file is optional — the pipeline runs with defaults plus env vars.
 * Env overrides exist so tests and one-off runs don't need to write a file:
 *   WA_OUT_DIR, WA_BUSINESS_NAME, WA_INTERNAL_EMAIL_DOMAINS (comma-separated),
 *   WA_INTERNAL_NUMBERS (comma-separated), WA_CRM_FILE, WA_REPORT_FILENAME,
 *   WA_LOCALE, WA_TZ_OFFSET (e.g. "-03:00"), WA_DEFAULT_COUNTRY (ISO-3166)
 *
 * WAHA connection settings (WAHA_BASE_URL, WAHA_API_KEY, WAHA_BASIC_AUTH,
 * WAHA_SESSION) are env-only on purpose: they are secrets, not configuration.
 * WAHA_BASE_URL has no default on purpose — pointing at the wrong instance is
 * the expensive mistake.
 */
import { readFileSync, existsSync } from 'node:fs';

const DEFAULTS = {
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
};

const CONFIG_FILE = 'wa-audit.config.json';

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

export function loadConfig() {
  const warnings = [];
  let fromFile = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error(`Could not parse ${CONFIG_FILE}: ${String(e).slice(0, 160)}`);
      process.exit(1);
    }
  }
  const cfg = mergeSection(DEFAULTS, fromFile, '', warnings);

  const env = process.env;
  if (env.WA_OUT_DIR) cfg.output.dir = env.WA_OUT_DIR;
  if (env.WA_BUSINESS_NAME) cfg.business.name = env.WA_BUSINESS_NAME;
  if (env.WA_INTERNAL_EMAIL_DOMAINS) cfg.business.internalEmailDomains = csvList(env.WA_INTERNAL_EMAIL_DOMAINS);
  if (env.WA_INTERNAL_NUMBERS) cfg.business.internalNumbers = csvList(env.WA_INTERNAL_NUMBERS);
  if (env.WA_CRM_FILE) cfg.crm.file = env.WA_CRM_FILE;
  if (env.WA_REPORT_FILENAME) cfg.report.filename = env.WA_REPORT_FILENAME;
  if (env.WA_LOCALE) cfg.locale = env.WA_LOCALE;
  if (env.WA_TZ_OFFSET) cfg.timezone.utcOffset = env.WA_TZ_OFFSET;
  if (env.WA_DEFAULT_COUNTRY) cfg.phone.defaultCountry = env.WA_DEFAULT_COUNTRY;

  const m = /^([+-])(\d{2}):(\d{2})$/.exec(cfg.timezone.utcOffset);
  if (!m) {
    console.error(`Invalid timezone.utcOffset "${cfg.timezone.utcOffset}" — expected e.g. "-03:00"`);
    process.exit(1);
  }
  // Single source of truth for the offset: minutes for math, string for ISO suffixes.
  cfg.timezone.offsetMinutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));

  for (const w of warnings) console.warn(`  ! config: ${w}`);
  return cfg;
}
