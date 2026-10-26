// Report builder unit tests (node:test; part of `npm test`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, runReport, reportCsv, feederSummaries } from './reportBuilder.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const at = (d, h = 0) => new Date(Date.parse(`2026-10-${String(d).padStart(2, '0')}T00:00:00Z`) + h * 3600000).toISOString();
const inc = (id, o = {}) => ({ id, opened_at: at(1), resolved_at: at(1, 1), zone: 'Z1', feeder: 'F1', severity: 'high', status: 'resolved', customers: 10, cause: 'Tree', ...o });
const LIST = [
  inc('a'),
  inc('b', { feeder: 'F2', customers: 30, opened_at: at(5), resolved_at: at(5, 2) }),
  inc('c', { feeder: 'F2', customers: 5, opened_at: at(9), resolved_at: null, status: 'open', severity: 'critical' }),
  inc('x', { status: 'cancelled' }),
];

test('spec validation', () => {
  assert.throws(() => validateSpec({ columns: [] }), /at least one column/);
  assert.throws(() => validateSpec({ columns: ['nope'] }), /Unknown column/);
  assert.throws(() => validateSpec({ columns: ['id'], filters: [{ field: 'zone', op: 'like', value: 'x' }] }), /operator/);
  assert.throws(() => validateSpec({ columns: ['id'], groupBy: 'customers' }), /not a number/);
  assert.equal(validateSpec({ columns: ['id'], sort: { field: 'id', dir: 'x' } }).sort.dir, 'desc');
});

test('rows: columns, filters, sort, cancelled dropped', () => {
  const r = runReport(LIST, { columns: ['id', 'feeder', 'customers'], filters: [{ field: 'feeder', op: 'eq', value: 'f2' }], sort: { field: 'customers', dir: 'asc' } }, NOW);
  assert.deepEqual(r.rows, [{ id: 'c', feeder: 'F2', customers: 5 }, { id: 'b', feeder: 'F2', customers: 30 }]);
  assert.equal(runReport(LIST, { columns: ['id'] }, NOW).total, 3);
  const num = runReport(LIST, { columns: ['id'], filters: [{ field: 'customers', op: 'gte', value: '10' }] }, NOW);
  assert.deepEqual(num.rows.map((x) => x.id).sort(), ['a', 'b']);
  assert.equal(runReport(LIST, { columns: ['id'], from: at(4), to: at(6) }, NOW).total, 1);
});

test('grouped: counts, sums, averages, totals', () => {
  const r = runReport(LIST, { columns: ['feeder', 'customers', 'duration_min'], groupBy: 'feeder' }, NOW);
  assert.equal(r.grouped, true);
  assert.deepEqual(r.columns.map((c) => c.key), ['feeder', 'outages', 'customers', 'duration_min']);
  const f2 = r.rows.find((x) => x.feeder === 'F2');
  assert.equal(f2.outages, 2);
  assert.equal(f2.customers, 35);
  assert.deepEqual(r.totals, { feeder: 'Total', outages: 3, customers: 45, duration_min: r.totals.duration_min });
  assert.equal(r.rows[0].feeder, 'F2'); // most outages first
});

test('CSV and feeder SMS summaries', () => {
  const r = runReport(LIST, { columns: ['feeder', 'customers'], groupBy: 'feeder' }, NOW);
  const csv = reportCsv(r, 'By feeder');
  assert.match(csv, /^By feeder\n/);
  assert.match(csv, /Feeder,Outages,Total customers\n/);
  assert.match(csv, /Total,3,45\n$/);
  const s = feederSummaries(LIST, { columns: ['id'] }, 'Weekly', NOW);
  assert.deepEqual(s.map((x) => x.feeder).sort(), ['F1', 'F2']);
  assert.match(s.find((x) => x.feeder === 'F2').body, /feeder F2 had 2 outages, 35 customers affected, 1 still open, avg restoration 120 min/);
});
