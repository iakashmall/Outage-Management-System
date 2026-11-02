// CUSTOMERS_SERVED setting (runbook WP5, decision D4): SAIDI, SAIFI and MAIFI
// divide by the setting, not a fixed 18,500, and the figure is reported as
// "assumed" until CUSTOMERS_SERVED_CONFIRMED=true. No database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { customersServedSetting, computeIndices, DEFAULT_CUSTOMERS_SERVED } from './indices.js';
import { buildCsv } from './reports.js';

const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test('default is 18,500 and assumed', () => {
  assert.equal(DEFAULT_CUSTOMERS_SERVED, 18500);
  assert.deepEqual(customersServedSetting({}), { value: 18500, assumed: true, source: 'default' });
});

test('a valid setting is used and stays assumed until confirmed', () => {
  assert.deepEqual(customersServedSetting({ CUSTOMERS_SERVED: '25000' }), { value: 25000, assumed: true, source: 'setting' });
  assert.deepEqual(customersServedSetting({ CUSTOMERS_SERVED: '25000', CUSTOMERS_SERVED_CONFIRMED: 'true' }), { value: 25000, assumed: false, source: 'setting' });
});

test('invalid settings fall back to the default, which is never "confirmed"', () => {
  const orig = console.warn; let warns = 0; console.warn = () => { warns++; };
  try {
    for (const bad of ['abc', '0', '-5', '1.5', ' ', '']) {
      const s = customersServedSetting({ CUSTOMERS_SERVED: bad, CUSTOMERS_SERVED_CONFIRMED: 'true' });
      assert.equal(s.value, 18500, `value for ${JSON.stringify(bad)}`);
      assert.equal(s.assumed, true, `assumed for ${JSON.stringify(bad)}`);
    }
  } finally { console.warn = orig; }
  assert.ok(warns >= 4, `warned ${warns} times`);
});

// 471 customers out 30 minutes (restored), 556 momentary.
const opened = '2026-11-01T10:00:00.000Z';
const incidents = [
  { status: 'closed', type: 'Power Outage', severity: 'high', customers: 471, opened_at: opened, resolved_at: '2026-11-01T10:30:00.000Z' },
  { status: 'closed', type: 'outage', severity: 'high', customers: 556, momentary: true, opened_at: opened, resolved_at: '2026-11-01T10:02:00.000Z' },
];

test('SAIFI, SAIDI and MAIFI divide by the setting', () => {
  const at18500 = withEnv({ CUSTOMERS_SERVED: undefined, CUSTOMERS_SERVED_CONFIRMED: undefined }, () => computeIndices(incidents));
  assert.equal(at18500.customersServed, 18500);
  assert.equal(at18500.saifi, +(471 / 18500).toFixed(3));
  assert.equal(at18500.saidi, +(471 * 30 / 18500).toFixed(2));
  assert.equal(at18500.customersServedAssumed, true);
  const at10000 = withEnv({ CUSTOMERS_SERVED: '10000', CUSTOMERS_SERVED_CONFIRMED: 'true' }, () => computeIndices(incidents));
  assert.equal(at10000.customersServed, 10000);
  assert.equal(at10000.saifi, 0.047);   // 471 / 10000
  assert.equal(at10000.saidi, 1.41);    // 471 * 30 / 10000
  assert.equal(at10000.maifi, 0.056);   // 556 / 10000
  assert.equal(at10000.caidi, 30);      // independent of the served base
  assert.equal(at10000.customersServedAssumed, false);
});

test('the CSV report labels an assumed figure, and not a confirmed one', () => {
  const meta = { generatedAt: opened, filters: {} };
  const assumed = withEnv({ CUSTOMERS_SERVED: undefined }, () => buildCsv(computeIndices(incidents), meta));
  assert.match(assumed, /Customers served,18500,"assumed \(CUSTOMERS_SERVED setting/);
  const confirmed = withEnv({ CUSTOMERS_SERVED: '20000', CUSTOMERS_SERVED_CONFIRMED: 'true' }, () => buildCsv(computeIndices(incidents), meta));
  assert.match(confirmed, /Customers served,20000/);
  assert.doesNotMatch(confirmed, /assumed/);
});
