// Report builder (Analytics -> Report builder). A report is a spec:
//   { columns: [fieldKey...], filters: [{ field, op, value }], groupBy: fieldKey|null,
//     sort: { field, dir: 'asc'|'desc' }, from, to }
// run over incident rows. Without groupBy it returns one row per outage with the
// chosen columns; with groupBy it returns one row per group with the outage count
// and totals of the chosen numeric columns (averages for durations), plus a total row.
// Pure functions: the route loads incidents and saved specs.
import { causeCategory, deviceOf, durationMin } from './standardReports.js';

const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');

// type: text | number | date. agg (numbers only, when grouped): sum | avg.
export const FIELDS = {
  id:               { label: 'Incident',          type: 'text',   get: (i) => i.id },
  opened_at:        { label: 'Opened',            type: 'date',   get: (i) => i.opened_at },
  resolved_at:      { label: 'Restored',          type: 'date',   get: (i) => i.resolved_at || null },
  opened_day:       { label: 'Day opened',        type: 'text',   get: (i) => day(i.opened_at) },
  opened_month:     { label: 'Month opened',      type: 'text',   get: (i) => day(i.opened_at).slice(0, 7) },
  zone:             { label: 'Zone',              type: 'text',   get: (i) => i.zone || '' },
  feeder:           { label: 'Feeder',            type: 'text',   get: (i) => i.feeder || '' },
  substation:       { label: 'Substation',        type: 'text',   get: (i) => i.substation || '' },
  device:           { label: 'Device (SCADA tag)', type: 'text',  get: (i) => deviceOf(i) || '' },
  severity:         { label: 'Severity',          type: 'text',   get: (i) => i.severity || '' },
  status:           { label: 'Status',            type: 'text',   get: (i) => i.status || '' },
  type:             { label: 'Type',              type: 'text',   get: (i) => i.type || '' },
  source:           { label: 'Source',            type: 'text',   get: (i) => i.source || '' },
  cause_category:   { label: 'Cause category',    type: 'text',   get: (i) => causeCategory(i.cause) },
  cause:            { label: 'Cause (as entered)', type: 'text',  get: (i) => i.cause || '' },
  restored_by:      { label: 'Restored by',       type: 'text',   get: (i) => i.restored_by || '' },
  sla_result:       { label: 'SLA result',        type: 'text',   get: (i) => (!i.sla_due_at ? 'No SLA' : !i.resolved_at ? 'Open' : new Date(i.resolved_at) <= new Date(i.sla_due_at) ? 'Met' : 'Missed') },
  customers:        { label: 'Customers',         type: 'number', agg: 'sum', get: (i) => i.customers || 0 },
  duration_min:     { label: 'Duration (min)',    type: 'number', agg: 'avg', get: (i, now) => durationMin(i, now) },
  customer_minutes: { label: 'Customer-minutes',  type: 'number', agg: 'sum', get: (i, now) => (i.customers || 0) * durationMin(i, now) },
};

export const OPS = {
  eq: 'is', neq: 'is not', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤',
};

export const fieldList = () => Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label, type: f.type, agg: f.agg || null }));

// Throws a 400-able message for anything the page should not have sent.
export function validateSpec(spec = {}) {
  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  if (!columns.length) throw new Error('Add at least one column');
  if (columns.length > 20) throw new Error('At most 20 columns');
  for (const c of columns) if (!FIELDS[c]) throw new Error(`Unknown column "${c}"`);
  const filters = Array.isArray(spec.filters) ? spec.filters : [];
  if (filters.length > 10) throw new Error('At most 10 filters');
  for (const f of filters) {
    if (!FIELDS[f.field]) throw new Error(`Unknown filter field "${f.field}"`);
    if (!OPS[f.op]) throw new Error(`Unknown filter operator "${f.op}"`);
  }
  if (spec.groupBy && !FIELDS[spec.groupBy]) throw new Error(`Unknown group-by field "${spec.groupBy}"`);
  if (spec.groupBy && FIELDS[spec.groupBy].type === 'number') throw new Error('Group by a text or date field, not a number');
  return {
    columns, filters, groupBy: spec.groupBy || null,
    sort: spec.sort && FIELDS[spec.sort.field] ? { field: spec.sort.field, dir: spec.sort.dir === 'asc' ? 'asc' : 'desc' } : null,
    from: spec.from || null, to: spec.to || null,
  };
}

function matches(value, type, op, raw) {
  if (type === 'number' || type === 'date') {
    const a = type === 'date' ? new Date(value).getTime() : Number(value);
    const b = type === 'date' ? new Date(raw).getTime() : Number(raw);
    if (Number.isNaN(a) || Number.isNaN(b)) return op === 'neq';
    return { eq: a === b, neq: a !== b, gt: a > b, gte: a >= b, lt: a < b, lte: a <= b, contains: String(value).includes(String(raw)) }[op];
  }
  const a = String(value ?? '').toLowerCase(), b = String(raw ?? '').toLowerCase();
  return { eq: a === b, neq: a !== b, contains: a.includes(b), gt: a > b, gte: a >= b, lt: a < b, lte: a <= b }[op];
}

// Outages the spec covers (date range + filters; cancelled ones never count).
export function scopeIncidents(incidents, spec, now = Date.now()) {
  const from = spec.from ? new Date(spec.from).getTime() : null;
  const to = spec.to ? new Date(spec.to).getTime() : null;
  return incidents.filter((i) => {
    if (i.status === 'cancelled') return false;
    const t = new Date(i.opened_at).getTime();
    if (from !== null && t < from) return false;
    if (to !== null && t > to) return false;
    return spec.filters.every((f) => matches(FIELDS[f.field].get(i, now), FIELDS[f.field].type, f.op, f.value));
  });
}

const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true }));

export function runReport(incidents, rawSpec, now = Date.now()) {
  const spec = validateSpec(rawSpec);
  const scoped = scopeIncidents(incidents, spec, now);
  const feeders = [...new Set(scoped.map((i) => i.feeder).filter(Boolean))].sort();

  if (!spec.groupBy) {
    const columns = spec.columns.map((key) => ({ key, label: FIELDS[key].label, type: FIELDS[key].type }));
    let rows = scoped.map((i) => Object.fromEntries(spec.columns.map((c) => [c, FIELDS[c].get(i, now)])));
    const s = spec.sort && spec.columns.includes(spec.sort.field) ? spec.sort : null;
    if (s) rows.sort((a, b) => cmp(a[s.field], b[s.field]) * (s.dir === 'asc' ? 1 : -1));
    else rows.sort((a, b) => cmp(b.opened_at, a.opened_at));
    return { spec, grouped: false, columns, rows, total: rows.length, outages: scoped.length, feeders };
  }

  // Grouped: one row per value of groupBy; count + an aggregate of each numeric column.
  const g = FIELDS[spec.groupBy];
  const nums = spec.columns.filter((c) => FIELDS[c].type === 'number');
  const groups = new Map();
  for (const i of scoped) {
    const k = String(g.get(i, now) || '(blank)');
    const acc = groups.get(k) || { n: 0, sums: Object.fromEntries(nums.map((c) => [c, 0])) };
    acc.n += 1;
    for (const c of nums) acc.sums[c] += FIELDS[c].get(i, now);
    groups.set(k, acc);
  }
  const value = (acc, c) => (FIELDS[c].agg === 'avg' ? Math.round(acc.sums[c] / acc.n) : acc.sums[c]);
  const columns = [
    { key: spec.groupBy, label: g.label, type: 'text' },
    { key: 'outages', label: 'Outages', type: 'number' },
    ...nums.map((c) => ({ key: c, label: `${FIELDS[c].agg === 'avg' ? 'Avg' : 'Total'} ${FIELDS[c].label.toLowerCase()}`, type: 'number' })),
  ];
  let rows = [...groups].map(([k, acc]) => ({ [spec.groupBy]: k, outages: acc.n, ...Object.fromEntries(nums.map((c) => [c, value(acc, c)])) }));
  const s = spec.sort && columns.some((c) => c.key === spec.sort.field) ? spec.sort : { field: 'outages', dir: 'desc' };
  rows.sort((a, b) => cmp(a[s.field], b[s.field]) * (s.dir === 'asc' ? 1 : -1));
  const all = { n: scoped.length, sums: Object.fromEntries(nums.map((c) => [c, scoped.reduce((t, i) => t + FIELDS[c].get(i, now), 0)])) };
  const totals = { [spec.groupBy]: 'Total', outages: all.n, ...Object.fromEntries(nums.map((c) => [c, all.n ? value(all, c) : 0])) };
  return { spec, grouped: true, columns, rows, totals, total: rows.length, outages: scoped.length, feeders };
}

const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportCsv(result, name = 'Custom report') {
  const head = `${cell(name)}\nGenerated,${new Date().toISOString()}\nFrom,${result.spec.from || 'all'}\nTo,${result.spec.to || 'all'}\n` +
    (result.spec.filters.length ? `Filters,${cell(result.spec.filters.map((f) => `${FIELDS[f.field].label} ${OPS[f.op]} ${f.value}`).join('; '))}\n` : '') + '\n';
  const lines = [result.columns.map((c) => cell(c.label)).join(',')];
  for (const r of result.rows) lines.push(result.columns.map((c) => cell(r[c.key])).join(','));
  if (result.totals) lines.push(result.columns.map((c) => cell(result.totals[c.key])).join(','));
  return head + lines.join('\n') + '\n';
}

// One short SMS per feeder in the report: that feeder's slice of it.
export function feederSummaries(incidents, rawSpec, name, now = Date.now()) {
  const spec = validateSpec(rawSpec);
  const scoped = scopeIncidents(incidents, spec, now);
  const by = new Map();
  for (const i of scoped) if (i.feeder) (by.get(i.feeder) || by.set(i.feeder, []).get(i.feeder)).push(i);
  const period = spec.from || spec.to ? ` (${day(spec.from) || 'start'} to ${day(spec.to) || 'today'})` : '';
  return [...by].map(([feeder, list]) => {
    const open = list.filter((i) => !['resolved', 'closed'].includes(i.status)).length;
    const cust = list.reduce((t, i) => t + (i.customers || 0), 0);
    const restored = list.filter((i) => i.resolved_at);
    const avg = restored.length ? Math.round(restored.reduce((t, i) => t + durationMin(i, now), 0) / restored.length) : null;
    return {
      feeder,
      body: `GridQ report "${name}"${period}: feeder ${feeder} had ${list.length} outage${list.length === 1 ? '' : 's'}, ` +
        `${cust} customers affected, ${open} still open${avg !== null ? `, avg restoration ${avg} min` : ''}.`,
    };
  });
}
