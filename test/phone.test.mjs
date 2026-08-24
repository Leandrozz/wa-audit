import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJid, normalizeInput, suffix, display } from '../src/lib/phone.mjs';

test('AR mobile with and without the optional 9 collapse to one number', () => {
  assert.equal(normalizeJid('5491155501234'), '+5491155501234');
  assert.equal(normalizeJid('541155501234'), '+5491155501234');
});

test('foreign numbers are never rewritten', () => {
  assert.equal(normalizeJid('56912345678'), '+56912345678');   // CL
  assert.equal(normalizeJid('5511987654321'), '+5511987654321'); // BR
  assert.equal(normalizeJid('34612345678'), '+34612345678');   // ES
});

test('empty / non-digit input returns null', () => {
  assert.equal(normalizeJid(''), null);
  assert.equal(normalizeJid(null), null);
  assert.equal(normalizeJid('status'), null);
});

test('hand-typed AR local formats parse with the default country', () => {
  assert.equal(normalizeInput('11 2233-4455', 'AR'), '+5491122334455');
  assert.equal(normalizeInput('+54 9 11 5550-1234', 'AR'), '+5491155501234');
  assert.equal(normalizeInput('0341 555-0678', 'AR'), '+5493415550678');
});

test('garbage input produces no match key, never a wrong one', () => {
  const n = normalizeInput('0341- 555 0678 / 0341-555-0884', 'AR');
  assert.notEqual(n, '+5493415550678'); // two numbers glued must not resolve to either
});

test('suffix takes the last 10 digits', () => {
  assert.equal(suffix('+5491155501234'), '1155501234');
  assert.equal(suffix('+123'), null);
});

test('display formats internationally and falls back to raw', () => {
  assert.match(display('+5491155501234'), /^\+54 9 11/);
  assert.equal(display(null), null);
});
