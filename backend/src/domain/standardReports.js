// The five standard OMS reports shown on Analytics -> Standard reports.
// Pure functions over incident rows (repo.incidents()); the route applies the
// same date / zone filters as the reliability report (filterIncidents).
//
//   history    Outage History            every outage in the period, newest first
//   cause      Cause Analysis            outages grouped by cause category
//   recurring  Recurring Trouble         feeders / devices with repeat outages in a rolling window
//   worst      Worst-Performing          feeders and devices ranked by customer-minutes lost
//   closed     Closed Cases              resolved / closed outages with restore time and SLA result
import { filterIncidents } from './indices.js';

export const REPORTS = {
  history: 'Outage History',
  cause: 'Cause Analysis',
  recurring: 'Recurring Trouble',
  worst: 'Worst-Performing Feeders / Devices',
  closed: 'Closed Cases',
};

const CLOSED = new Set(['resolved', 'closed']);
const DAY = 86400000;

// Minutes the supply was off: to resolved_at, or to `now` while still open.
export function durationMin(i, now = Date.now()) {
  const start = new Date(i.opened_at).getTime();
  const end = i.resolved_at ? new Date(i.resolved_at).getTime() : now;
  return Math.max(0, Math.round((end - start) / 60000));
}

// Free-text causes collapse into a few categories. SCADA-raised incidents
// carry "SCADA <SEVERITY> on <tag>" as their cause; the device is the tag.
export function causeCategory(cause) {
  const c = String(cause || '').trim();
  if (!c) return 'Not recorded';
  if (/^scada\b/i.test(c)) return 'SCADA trip';
  const k = c.toLowerCase();
  if (/tree|vegetation|branch/.test(k)) return 'Vegetation';
  if (/weather|storm|rain|wind|lightning|flood|snow/.test(k)) return 'Weather';
  if (/transformer|dtr|equipment|breaker|fuse|insulator|cable|conductor|fault/.test(k)) return 'Equipment failure';
  if (/planned|scheduled|maintenance|shutdown/.test(k)) return 'Planned / maintenance';
  if (/customer/.test(k)) return 'Customer reported';
  if (/overload|load/.test(k)) return 'Overload';
  if (/accident|vehicle|third|theft|animal|bird/.test(k)) return 'Third party / animal';
  return 'Other';
}

// Device behind an outage: the SCADA trip tag when there is one, else the tag
// named in a "SCADA ... on <tag>" cause.
export function deviceOf(i) {
  if (i.trip_tag) return i.trip_tag;
  const m = /^scada\s+\w+\s+on\s+(\S+)/i.exec(String(i.cause || ''));
  return m ? m[1] : null;
}

const base = (i, now) => ({
  id: i.id, opened_at: i.opened_at, resolved_at: i.resolved_at || null,
  zone: i.zone || '', feeder: i.feeder || '', severity: i.severity, status: i.status,
  customers: i.customers || 0, cause: i.cause || '', category: causeCategory(i.cause),
  duration_min: durationMin(i, now),
});

export function outageHistory(incidents, now = Date.now()) {
  return incidents
    .map((i) => ({ ...base(i, now), type: i.type || '', source: i.source || '', device: deviceOf(i) || '' }))
    .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at));
}

export function causeAnalysis(incidents, now = Date.now()) {
  const groups = new Map();
  for (const i of incidents) {
    const k = causeCategory(i.cause);
    const g = groups.get(k) || { category: k, outages: 0, customers: 0, customer_minutes: 0, total_min: 0 };
    const d = durationMin(i, now);
    g.outages += 1; g.customers += i.customers || 0; g.customer_minutes += (i.customers || 0) * d; g.total_min += d;
    groups.set(k, g);
  }
  const total = incidents.length || 1;
  return [...groups.values()]
    .map(({ total_min, ...g }) => ({ ...g, share_pct: Math.round((g.outages / total) * 1000) / 10, avg_duration_min: Math.round(total_min / g.outages) }))
    .sort((a, b) => b.outages - a.outages || b.customer_minutes - a.customer_minutes);
}

// A feeder (or device) is "recurring trouble" when it has at least `minCount`
// outages inside any `windowDays` rolling window.
export function recurringTrouble(incidents, { windowDays = 30, minCount = 3 } = {}) {
  const out = [];
  const scan = (kind, keyOf) => {
    const by = new Map();
    for (const i of incidents) { const k = keyOf(i); if (k) (by.get(k) || by.set(k, []).get(k)).push(i); }
    for (const [key, list] of by) {
      if (list.length < minCount) continue;
      const t = list.map((i) => new Date(i.opened_at).getTime()).sort((a, b) => a - b);
      let best = 0;
      for (let a = 0, b = 0; b < t.length; b++) { while (t[b] - t[a] > windowDays * DAY) a++; best = Math.max(best, b - a + 1); }
      if (best < minCount) continue;
      const gaps = t.slice(1).map((x, n) => x - t[n]);
      const causes = new Map();
      for (const i of list) { const c = causeCategory(i.cause); causes.set(c, (causes.get(c) || 0) + 1); }
      out.push({
        kind, key, zone: list[0].zone || '', outages: list.length, max_in_window: best,
        first_at: new Date(t[0]).toISOString(), last_at: new Date(t[t.length - 1]).toISOString(),
        avg_gap_days: gaps.length ? Math.round((gaps.reduce((s, g) => s + g, 0) / gaps.length / DAY) * 10) / 10 : null,
        top_cause: [...causes].sort((a, b) => b[1] - a[1])[0][0],
      });
    }
  };
  scan('Feeder', (i) => i.feeder);
  scan('Device', deviceOf);
  return out.sort((a, b) => b.max_in_window - a.max_in_window || b.outages - a.outages);
}

// Ranked by customer-minutes interrupted (the SAIDI contribution), then count.
export function worstPerforming(incidents, { limit = 10, now = Date.now() } = {}) {
  const rank = (keyOf) => {
    const by = new Map();
    for (const i of incidents) {
      const k = keyOf(i); if (!k) continue;
      const g = by.get(k) || { key: k, zone: i.zone || '', outages: 0, customers: 0, customer_minutes: 0, total_min: 0, open: 0 };
      const d = durationMin(i, now);
      g.outages += 1; g.customers += i.customers || 0; g.customer_minutes += (i.customers || 0) * d; g.total_min += d;
      if (!CLOSED.has(i.status) && i.status !== 'cancelled') g.open += 1;
      by.set(k, g);
    }
    return [...by.values()]
      .map(({ total_min, ...g }) => ({ ...g, avg_duration_min: Math.round(total_min / g.outages) }))
      .sort((a, b) => b.customer_minutes - a.customer_minutes || b.outages - a.outages)
      .slice(0, limit)
      .map((g, n) => ({ rank: n + 1, ...g }));
  };
  return { feeders: rank((i) => i.feeder), devices: rank(deviceOf) };
}

export function closedCases(incidents, now = Date.now()) {
  return incidents
    .filter((i) => CLOSED.has(i.status))
    .map((i) => ({
      ...base(i, now),
      restored_by: i.restored_by || '',
      sla_due_at: i.sla_due_at || null,
      sla_met: i.sla_due_at && i.resolved_at ? new Date(i.resolved_at) <= new Date(i.sla_due_at) : null,
    }))
    .sort((a, b) => new Date(b.resolved_at || b.opened_at) - new Date(a.resolved_at || a.opened_at));
}

// One entry point for the route: filters, then builds the named report with a
// short summary line set for the page header and the CSV.
export function buildStandardReport(kind, incidents, filters = {}, now = Date.now()) {
  if (!REPORTS[kind]) return null;
  const scoped = filterIncidents(incidents, filters).filter((i) => i.status !== 'cancelled');
  // Zones that have outages at all (ignoring the current filters), for the page's zone picker.
  const zones = [...new Set(incidents.filter((i) => i.status !== 'cancelled').map((i) => i.zone).filter(Boolean))].sort();
  const meta = { kind, title: REPORTS[kind], generatedAt: new Date(now).toISOString(), filters, incidents: scoped.length, zones };
  if (kind === 'history') return { ...meta, rows: outageHistory(scoped, now) };
  if (kind === 'cause') return { ...meta, rows: causeAnalysis(scoped, now) };
  if (kind === 'recurring') {
    const windowDays = Number(filters.windowDays) || 30, minCount = Number(filters.minCount) || 3;
    return { ...meta, windowDays, minCount, rows: recurringTrouble(scoped, { windowDays, minCount }) };
  }
  if (kind === 'worst') return { ...meta, ...worstPerforming(scoped, { limit: Number(filters.limit) || 10, now }) };
  const rows = closedCases(scoped, now);
  const judged = rows.filter((r) => r.sla_met !== null);
  return {
    ...meta, rows,
    summary: {
      closed: rows.length,
      avg_restore_min: rows.length ? Math.round(rows.reduce((s, r) => s + r.duration_min, 0) / rows.length) : null,
      sla_met_pct: judged.length ? Math.round((judged.filter((r) => r.sla_met).length / judged.length) * 1000) / 10 : null,
    },
  };
}

// CSV for any report: a header block, then one table (two for "worst").
const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const table = (rows) => {
  if (!rows.length) return 'No rows\n';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
};
export function standardReportCsv(r) {
  const f = r.filters || {};
  let out = `${cell(r.title)}\nGenerated,${r.generatedAt}\nFrom,${f.from || 'all'}\nTo,${f.to || 'all'}\nZone,${cell(f.zone || 'all')}\nIncidents in scope,${r.incidents}\n\n`;
  if (r.kind === 'worst') return out + 'Worst feeders\n' + table(r.feeders) + '\nWorst devices\n' + table(r.devices);
  if (r.summary) out += Object.entries(r.summary).map(([k, v]) => `${k},${v ?? ''}`).join('\n') + '\n\n';
  return out + table(r.rows);
}
