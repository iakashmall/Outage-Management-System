// Intake validators and rate limiter (runbook WP3), no database. The HTTP
// gates (413/400/401/403/404 through the real app) are in selftest-intake-hardening.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateComplaint, validateScadaEvent, validateCall, rateLimit } from './intake.js';

const ok = { category: 'No Supply', lat: 29.9, lon: 78.1, customer: 'A', phone: '+91 90000 00000', externalId: 'E1' };

test('validateComplaint accepts a normal complaint and an address-only one', () => {
  assert.equal(validateComplaint(ok), null);
  assert.equal(validateComplaint({ address: 'Jwalapur' }), null); // category defaults to No Supply in api.js
});

test('validateComplaint names the bad field', () => {
  assert.match(validateComplaint(null), /JSON object/);
  assert.match(validateComplaint({ ...ok, category: 'x' }), /category/);
  assert.match(validateComplaint({ ...ok, lat: null }), /together/);
  assert.match(validateComplaint({ ...ok, lon: Infinity }), /lon must be/);
  assert.match(validateComplaint({ ...ok, phone: 12345 }), /phone must be a string/);
  assert.match(validateComplaint({ ...ok, address: 'a'.repeat(501) }), /address/);
  assert.match(validateComplaint({ category: 'Meter' }), /lat\/lon or address/);
  assert.match(validateComplaint({ address: '   ' }), /lat\/lon or address/);
});

test('validateScadaEvent', () => {
  assert.equal(validateScadaEvent({ tag: 'A.B.CB1.TRIP' }), null);
  assert.equal(validateScadaEvent({ tag: 'A.B', event: 'reclose', customers: 0, feeder: 'F', lat: 1, lon: 2 }), null);
  assert.match(validateScadaEvent({ tag: '  ' }), /tag is required/);
  assert.match(validateScadaEvent({ tag: 'A', customers: 1.5 }), /customers/);
  assert.match(validateScadaEvent({ tag: 'A', condition: 7 }), /condition must be a string/);
});

test('validateCall caps types and sizes', () => {
  assert.equal(validateCall({ customer: 'A', phone: '9000000000', address: 'B', category: 'No Supply' }), null);
  assert.match(validateCall({ customer: ['A'] }), /customer must be a string/);
});

test('rateLimit: per key, fixed window, 429 with Retry-After, 0 disables', () => {
  process.env.TEST_RL = '2';
  const mw = rateLimit('t', { envVar: 'TEST_RL', defaultPerMin: 100 });
  const run = (username) => {
    const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } };
    let passed = false;
    mw({ user: { username }, ip: '1.2.3.4' }, res, () => { passed = true; });
    return passed ? 200 : res.code;
  };
  assert.deepEqual([run('a'), run('a'), run('a'), run('b')], [200, 200, 429, 200]);
  process.env.TEST_RL = '0';
  assert.equal(run('a'), 200);
  delete process.env.TEST_RL;
});
