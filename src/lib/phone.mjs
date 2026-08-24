/**
 * Phone normalization.
 *
 * Two distinct inputs, two functions:
 *  - JIDs from WhatsApp always carry the full country code (5491155501234@c.us):
 *    normalizeJid() handles those.
 *  - CRM / config numbers are hand-typed in every imaginable format
 *    ("11 2233-4455", "0341 555-0678"): normalizeInput() parses them with
 *    libphonenumber using a default country, then applies the same canonical
 *    form, so both sides of the join collapse to identical strings.
 *
 * The Argentina quirk, kept deliberately: WhatsApp JIDs write AR mobiles both
 * with and without the "9" (5491155501234 / 541155501234). Canonical form is
 * ALWAYS +549 + 10 digits — this is a WhatsApp-JID rule, not something
 * libphonenumber does for us. It applies only to +54; numbers from any other
 * country are never rewritten (forcing a prefix could merge two different
 * clients into one thread).
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** JID digits (full country code) -> canonical E.164, or null. */
export function normalizeJid(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('54')) {
    let rest = digits.slice(2);
    if (rest.startsWith('9') && rest.length >= 11) rest = rest.slice(1);
    if (!rest) return null;
    return '+549' + rest.slice(0, 10);
  }
  return '+' + digits;
}

/** Hand-typed number (CRM, config) -> canonical E.164, or null. */
export function normalizeInput(raw, defaultCountry = 'AR') {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parsed = parsePhoneNumberFromString(s, defaultCountry);
  if (parsed) return normalizeJid(parsed.number);
  return normalizeJid(s); // fallback: digit-strip (garbage in, no match out)
}

/** Last N digits — the join key of last resort for messy CRM data. */
export function suffix(e164, n = 10) {
  const digits = String(e164 ?? '').replace(/\D/g, '');
  return digits.length >= n ? digits.slice(-n) : null;
}

/** Readable international format for any country; falls back to the raw value. */
export function display(e164) {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}
