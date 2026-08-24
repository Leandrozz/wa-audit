/**
 * Optional CRM adapter. Input: a CSV with a header row. Recognized columns
 * (any order, extra columns are ignored):
 *
 *   phone      required for matching (any format — it gets normalized)
 *   whatsapp   optional second number
 *   name       company / display name
 *   contact    person
 *   email      used for internal-line detection (business.internalEmailDomains)
 *   segment    free label (e.g. retail / wholesale)
 *   stage      free label (e.g. prospect / customer)
 *   location   free label
 *
 * Matching strategy: exact canonical E.164 first, then last-10-digit suffix as
 * fallback — hand-loaded CRM phones come in every imaginable format and the
 * suffix is what survives the formatting chaos.
 */
import { readFileSync } from 'node:fs';
import { normalizeInput, suffix } from './phone.mjs';

/** Tiny CSV parser: quoted fields, "" escapes, commas/newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const FIELDS = ['phone', 'whatsapp', 'name', 'contact', 'email', 'segment', 'stage', 'location'];

/**
 * Loads the CRM CSV. Returns { rows, byNumber, bySuffix } or null if no file.
 * Throws on unreadable file — a configured-but-broken CRM should be loud.
 */
export function loadCrm(file, defaultCountry) {
  if (!file) return null;
  const raw = parseCsv(readFileSync(file, 'utf8'));
  if (raw.length < 2) return { rows: [], byNumber: new Map(), bySuffix: new Map() };

  const header = raw[0].map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(FIELDS.map((f) => [f, header.indexOf(f)]));
  if (idx.phone === -1) throw new Error(`CRM file ${file}: missing required "phone" column`);

  const rows = raw.slice(1).map((r) => {
    const row = {};
    for (const f of FIELDS) row[f] = idx[f] >= 0 ? (r[idx[f]] ?? '').trim() || null : null;
    return row;
  });

  const byNumber = new Map();
  const bySuffix = new Map();
  for (const row of rows) {
    for (const field of [row.phone, row.whatsapp]) {
      if (!field) continue;
      const n = normalizeInput(field, defaultCountry);
      if (!n) continue;
      if (!byNumber.has(n)) byNumber.set(n, row);
      const suf = suffix(n);
      if (suf && !bySuffix.has(suf)) bySuffix.set(suf, row);
    }
  }
  return { rows, byNumber, bySuffix };
}

/** Finds the CRM row for a canonical E.164 number, exact first then suffix. */
export function matchCrm(crm, e164) {
  if (!crm || !e164) return null;
  const exact = crm.byNumber.get(e164);
  if (exact) return exact;
  const suf = suffix(e164);
  return suf ? (crm.bySuffix.get(suf) ?? null) : null;
}
