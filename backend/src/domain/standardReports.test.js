// Standard reports unit tests (node:test; part of `npm test`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { causeCategory, deviceOf, durationMin, causeAnalysis, recurringTrouble, worstPerforming, closedCases, buildStandardReport, standardReportCsv } from './standardReports.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const at = (d, h = 0) => new Date(Date.parse(`2026-10-${String(d).padStart(2, '0')}T00:00:00Z`) + h * 3600000).toISOString();
const inc = (id, o = {}) => ({ id, opened_at: at(1), resolved_at: null, zone: 'Z1', feeder: 'F1', severity: 'high', status: 'open', customers: 100, cause: 'Tree on line', ...o });

test('cause categories and SCADA device', () => {
  assert.equal(causeCategory('SCADA MAJOR on HW03.FDR01.COMM'), 'SCADA trip');
  assert.equal(causeCategory('Tree fell on line'), 'Vegetation');
  assert.equal(causeCategory('DTR burnt'), 'Equipment failure');
  assert.equal(causeCategory(''), 'Not recorded');
  assert.equal(deviceOf({ cause: 'SCADA MAJOR on HW03.FDR01.COMM' }), 'HW03.FDR01.COMM');
  assert.equal(deviceOf({ trip_tag: 'T1', cause: 'SCADA MAJOR on X' }), 'T1');
  assert.equal(deviceOf({ cause: 'Tree' }), null);
});

test('duration runs to resolved_at, or now while open', () => {
  assert.equal(durationMin(inc('a', { opened_at: at(1), resolved_at: at(1, 2) }), NOW), 120);
  assert.equal(durationMin(inc('a', { opened_at: at(26, 11) }), NOW), 60);
});

test('cause analysis groups and shares', () => {
  const rows = causeAnalysis([inc('a'), inc('b'), inc('c', { cause: 'SCADA MAJOR on T' })], NOW);
  assert.equal(rows[0].category, 'Vegetation');
  assert.equal(rows[0].outages, 2);
  assert.equal(rows[0].share_pct, 66.7);
});

test('recurring needs minCount inside the rolling window', () => {
  const spread = [inc('a', { opened_at: at(1) }), inc('b', { opened_at: at(12) }), inc('c', { opened_at: at(25) })];
  assert.equal(recurringTrouble(spread, { windowDays: 10, minCount: 3 }).length, 0);
  const r = recurringTrouble(spread, { windowDays: 30, minCount: 3 });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].kind, r[0].key, r[0].outages, r[0].max_in_window], ['Feeder', 'F1', 3, 3]);
});

test('worst performing ranks by customer-minutes', () => {
  const { feeders } = worstPerforming([
    inc('a', { feeder: 'F1', customers: 10, resolved_at: at(1, 1) }),
    inc('b', { feeder: 'F2', customers: 5, resolved_at: at(1, 10), status: 'closed' }),
  ], { now: NOW });
  assert.deepEqual(feeders.map((f) => [f.rank, f.key, f.customer_minutes]), [[1, 'F2', 3000], [2, 'F1', 600]]);
  assert.equal(feeders[0].open, 0);
});

test('closed cases judge SLA', () => {
  const rows = closedCases([
    inc('a', { status: 'closed', resolved_at: at(1, 1), sla_due_at: at(1, 2) }),
    inc('b', { status: 'resolved', resolved_at: at(1, 3), sla_due_at: at(1, 2) }),
    inc('c', { status: 'open' }),
  ], NOW);
  assert.deepEqual(rows.map((r) => [r.id, r.sla_met]), [['b', false], ['a', true]]);
});

test('build: filters, drops cancelled, unknown kind, CSV', () => {
  const list = [inc('a', { status: 'closed', resolved_at: at(2) }), inc('b', { status: 'cancelled' }), inc('c', { opened_at: at(20) })];
  assert.equal(buildStandardReport('nope', list), null);
  const r = buildStandardReport('history', list, { from: at(10) }, NOW);
  assert.deepEqual(r.rows.map((x) => x.id), ['c']);
  const c = buildStandardReport('closed', list, {}, NOW);
  assert.equal(c.summary.closed, 1);
  const csv = standardReportCsv(buildStandardReport('worst', list, {}, NOW));
  assert.match(csv, /Worst feeders\nrank,key,/);
  assert.match(standardReportCsv(buildStandardReport('cause', [inc('x', { cause: 'a, "b"' })], {}, NOW)), /Other/);
});
