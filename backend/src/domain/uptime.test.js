// Uptime maths unit tests (node:test; part of `npm test`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUptime, overallStatus, allowedDownMin } from './uptime.js';

const T0 = Date.parse('2026-10-27T00:00:00Z');
const at = (i) => new Date(T0 + i * 30000).toISOString();
const ok = { database: { ok: true, critical: true }, redis: { ok: true, critical: false } };
const dbDown = { database: { ok: false, critical: true }, redis: { ok: true, critical: false } };

test('overall status from components', () => {
  assert.equal(overallStatus(ok), 'up');
  assert.equal(overallStatus({ ...ok, redis: { ok: false, critical: false } }), 'degraded');
  assert.equal(overallStatus(dbDown), 'down');
});

test('allowed downtime at 99.9%', () => {
  assert.equal(allowedDownMin(30 * 86400000), 43.2);
});

test('all samples up = 100%', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ts: at(i), status: 'up', components: ok }));
  const r = computeUptime(rows, { from: at(0), to: at(9) });
  assert.equal(r.pct, 100);
  assert.equal(r.outages.length, 0);
});

test('down samples and gaps both count as downtime, with outage periods', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ ts: at(i), status: i === 3 || i === 4 ? 'down' : 'up', components: i === 3 || i === 4 ? dbDown : ok });
  for (let i = 15; i < 20; i++) rows.push({ ts: at(i), status: 'up', components: ok }); // 10..14 missing: server off
  const r = computeUptime(rows, { from: at(0), to: at(19) });
  assert.equal(r.expected, 20);
  assert.equal(r.up, 13);
  assert.equal(r.missing, 5);
  assert.equal(r.pct, 65);
  assert.equal(r.perComponent.database, 65);
  assert.equal(r.outages.length, 2);
  assert.equal(r.outages[0].cause, 'database');
  assert.equal(r.outages[0].minutes, 1);
  assert.match(r.outages[1].cause, /no data/);
  assert.equal(r.outages[1].minutes, 2.5);
});

test('window before monitoring started is not counted; empty window', () => {
  const rows = [{ ts: at(100), status: 'up', components: ok }, { ts: at(101), status: 'up', components: ok }];
  assert.equal(computeUptime(rows, { from: at(0), to: at(101) }).pct, 100);
  assert.equal(computeUptime([], { from: at(0), to: at(5) }).pct, null);
});
