import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { SevBadge, StatusBadge, toast } from '../lib/ui.jsx';

// Analytics -> Standard reports: the five standard OMS reports (backend
// domain/standardReports.js). One report at a time, a date range, a zone
// filter, and a CSV export of exactly what is on screen.
const KINDS = [
  ['history', 'Outage History', 'Every outage in the period, newest first, with how long supply was off.'],
  ['cause', 'Cause Analysis', 'What is causing outages: count, share and customer impact per cause.'],
  ['recurring', 'Recurring Trouble', 'Feeders and devices that keep failing within a short window.'],
  ['worst', 'Worst Feeders / Devices', 'Top 10 feeders and devices by customer-minutes lost (their SAIDI share).'],
  ['closed', 'Closed Cases', 'Restored outages: restoration time, who restored them, and whether the SLA was met.'],
];
const PRESETS = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']];
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dur = (m) => (m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
const avg = (list, f) => (list.length ? Math.round(list.reduce((s, x) => s + f(x), 0) / list.length) : null);

// Headline figures above each report's table.
function statsFor(r) {
  if (r.kind === 'history') {
    const ongoing = r.rows.filter((x) => !x.resolved_at).length;
    return [['Outages', num(r.rows.length)], ['Customers affected', num(r.rows.reduce((s, x) => s + x.customers, 0))],
      ['Still ongoing', num(ongoing)], ['Avg duration (restored)', dur(avg(r.rows.filter((x) => x.resolved_at), (x) => x.duration_min))]];
  }
  if (r.kind === 'cause') {
    const top = r.rows[0];
    return [['Outages', num(r.incidents)], ['Cause categories', num(r.rows.length)], ['Top cause', top ? top.category : '—'], ['Top cause share', top ? `${top.share_pct}%` : '—']];
  }
  if (r.kind === 'recurring') {
    return [['Flagged', num(r.rows.length)], ['Feeders', num(r.rows.filter((x) => x.kind === 'Feeder').length)],
      ['Devices', num(r.rows.filter((x) => x.kind === 'Device').length)], ['Rule', `${r.minCount}+ in ${r.windowDays} days`]];
  }
  if (r.kind === 'worst') {
    return [['Worst feeder', r.feeders[0]?.key || '—'], ['Its customer-minutes', num(r.feeders[0]?.customer_minutes)],
      ['Worst device', r.devices[0]?.key || '—'], ['Its outages', num(r.devices[0]?.outages)]];
  }
  return [['Closed cases', num(r.summary.closed)], ['Avg restoration', dur(r.summary.avg_restore_min)],
    ['SLA met', r.summary.sla_met_pct == null ? '—' : `${r.summary.sla_met_pct}%`], ['Customers restored', num(r.rows.reduce((s, x) => s + x.customers, 0))]];
}

export default function StandardReports() {
  const [kind, setKind] = useState('history');
  const [preset, setPreset] = useState('90');
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(iso(new Date()));
  const [zone, setZone] = useState('');
  const [zones, setZones] = useState([]);
  const [windowDays, setWindowDays] = useState(30);
  const [minCount, setMinCount] = useState(3);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // `to` is a date; include the whole of that day.
  const params = { from, to: to ? `${to}T23:59:59` : '', zone, ...(kind === 'recurring' ? { windowDays, minCount } : {}) };
  const key = JSON.stringify([kind, params]);

  useEffect(() => {
    let live = true;
    setBusy(true); setErr('');
    api.standardReport(kind, params)
      .then((r) => { if (live) { setData(r); if (r.zones) setZones(r.zones); } })
      .catch((e) => { if (live) { setData(null); setErr(e.message); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPreset = (p) => { setPreset(p); setFrom(daysAgo(Number(p))); setTo(iso(new Date())); };
  const exportCsv = () => api.exportStandardReport(kind, params).catch((e) => toast(`Export failed: ${e.message}`, 'error'));
  const [, title, about] = KINDS.find(([k]) => k === kind);
  const shown = data && data.kind === kind ? data : null;

  return (
    <div className="fk sr">
      <div className="seg sr-kinds" role="group" aria-label="Report">
        {KINDS.map(([k, l]) => <button key={k} aria-pressed={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      <p className="sr-about">{about}</p>

      <div className="sr-filters">
        <div className="sr-field">
          <span className="sr-label" id="sr-period">Period</span>
          <div className="sr-row">
            <div className="seg" role="group" aria-labelledby="sr-period">
              {PRESETS.map(([p, l]) => <button key={p} aria-pressed={preset === p} className={preset === p ? 'on' : ''} onClick={() => pickPreset(p)}>{l}</button>)}
            </div>
            <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPreset(''); }} aria-label="From date" />
            <span className="muted">to</span>
            <input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPreset(''); }} aria-label="To date" />
          </div>
        </div>
        <div className="sr-field">
          <label className="sr-label" htmlFor="sr-zone">Zone</label>
          <select id="sr-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">All zones{zones.length ? ` (${zones.length})` : ''}</option>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        {kind === 'recurring' && (
          <div className="sr-field">
            <span className="sr-label" id="sr-rule">Flag when</span>
            <div className="sr-row" role="group" aria-labelledby="sr-rule">
              <input type="number" min={2} max={20} value={minCount} onChange={(e) => setMinCount(Number(e.target.value) || 3)} aria-label="Minimum outages" className="sr-num" />
              <span className="muted">or more outages within</span>
              <input type="number" min={1} max={365} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 30)} aria-label="Window in days" className="sr-num" />
              <span className="muted">days</span>
            </div>
          </div>
        )}
        <div className="grow" />
        <button className="btn sm" onClick={exportCsv} disabled={!shown}>Export CSV</button>
      </div>

      <div className="fk-range" role="status">
        <b>{title}</b>
        {shown && <span className="muted"> · {zone || 'all zones'} · {from} to {to}</span>}
        {busy && <span className="muted"> · updating…</span>}
        {err && <span className="fk-err"> {err}</span>}
      </div>

      {shown && (
        <div className="sr-stats">
          {statsFor(shown).map(([k, v]) => <div key={k} className="sr-stat"><span>{k}</span><b title={String(v)}>{v}</b></div>)}
        </div>
      )}

      {shown && kind === 'history' && <History rows={shown.rows} />}
      {shown && kind === 'cause' && <Cause rows={shown.rows} />}
      {shown && kind === 'recurring' && <Recurring rows={shown.rows} />}
      {shown && kind === 'worst' && <Worst feeders={shown.feeders} devices={shown.devices} />}
      {shown && kind === 'closed' && <Closed rows={shown.rows} />}
    </div>
  );
}

function Table({ label, head, children, empty }) {
  return (
    <div className="fk-scroll" style={{ maxHeight: 520, overflow: 'auto' }}>
      <table className="tbl fk-tbl" aria-label={label}>
        <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      {empty && <div className="muted" style={{ padding: 14 }}>{empty}</div>}
    </div>
  );
}

function History({ rows }) {
  return (
    <Table label="Outage history" head={['Incident', 'Opened', 'Restored', 'Duration', 'Zone', 'Feeder', 'Device', 'Severity', 'Customers', 'Cause', 'Status']} empty={!rows.length && 'No outages in this period.'}>
      {rows.slice(0, 500).map((r) => (
        <tr key={r.id}>
          <td className="mono">{r.id}</td><td>{when(r.opened_at)}</td><td>{when(r.resolved_at)}</td><td>{dur(r.duration_min)}{!r.resolved_at && <span className="muted"> (ongoing)</span>}</td>
          <td>{r.zone}</td><td className="mono">{r.feeder}</td><td className="mono">{r.device}</td>
          <td><SevBadge sev={r.severity} /></td><td>{num(r.customers)}</td><td title={r.cause}>{r.category}</td><td><StatusBadge status={r.status} /></td>
        </tr>
      ))}
    </Table>
  );
}

function Cause({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.outages));
  return (
    <Table label="Cause analysis" head={['Cause', 'Outages', 'Share', 'Customers affected', 'Customer-minutes', 'Avg duration']} empty={!rows.length && 'No outages in this period.'}>
      {rows.map((r) => (
        <tr key={r.category}>
          <td><b>{r.category}</b></td>
          <td>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden="true" style={{ display: 'inline-block', height: 8, width: Math.round((r.outages / max) * 120), background: 'var(--focus-ring)', borderRadius: 4 }} />
              {r.outages}
            </span>
          </td>
          <td>{r.share_pct}%</td><td>{num(r.customers)}</td><td>{num(r.customer_minutes)}</td><td>{dur(r.avg_duration_min)}</td>
        </tr>
      ))}
    </Table>
  );
}

function Recurring({ rows }) {
  return (
    <Table label="Recurring trouble" head={['Type', 'Feeder / device', 'Zone', 'Outages', 'Most in window', 'First', 'Last', 'Avg gap', 'Main cause']} empty={!rows.length && 'Nothing recurring with these settings.'}>
      {rows.map((r) => (
        <tr key={r.kind + r.key}>
          <td>{r.kind}</td><td className="mono">{r.key}</td><td>{r.zone}</td><td>{r.outages}</td><td><b>{r.max_in_window}</b></td>
          <td>{when(r.first_at)}</td><td>{when(r.last_at)}</td><td>{r.avg_gap_days == null ? '—' : `${r.avg_gap_days} d`}</td><td>{r.top_cause}</td>
        </tr>
      ))}
    </Table>
  );
}

function Worst({ feeders, devices }) {
  const rows = (list) => list.map((r) => (
    <tr key={r.key}>
      <td>{r.rank}</td><td className="mono">{r.key}</td><td>{r.zone}</td><td>{r.outages}</td><td>{r.open}</td>
      <td>{num(r.customers)}</td><td><b>{num(r.customer_minutes)}</b></td><td>{dur(r.avg_duration_min)}</td>
    </tr>
  ));
  const head = (what) => ['Rank', what, 'Zone', 'Outages', 'Still open', 'Customers affected', 'Customer-minutes', 'Avg duration'];
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <h3 style={{ margin: '4px 0 8px', fontSize: 14 }}>Worst feeders <span className="muted" style={{ fontWeight: 400 }}>· ranked by customer-minutes lost</span></h3>
        <Table label="Worst feeders" head={head('Feeder')} empty={!feeders.length && 'No feeder outages in this period.'}>{rows(feeders)}</Table>
      </div>
      <div>
        <h3 style={{ margin: '4px 0 8px', fontSize: 14 }}>Worst devices <span className="muted" style={{ fontWeight: 400 }}>· SCADA-tagged equipment</span></h3>
        <Table label="Worst devices" head={head('Device (SCADA tag)')} empty={!devices.length && 'No SCADA-tagged outages in this period.'}>{rows(devices)}</Table>
      </div>
    </div>
  );
}

function Closed({ rows }) {
  return (
    <>
      <Table label="Closed cases" head={['Incident', 'Opened', 'Restored', 'Restoration time', 'Zone', 'Feeder', 'Customers', 'Cause', 'Restored by', 'SLA']} empty={!rows.length && 'No closed cases in this period.'}>
        {rows.slice(0, 500).map((r) => (
          <tr key={r.id}>
            <td className="mono">{r.id}</td><td>{when(r.opened_at)}</td><td>{when(r.resolved_at)}</td><td>{dur(r.duration_min)}</td>
            <td>{r.zone}</td><td className="mono">{r.feeder}</td><td>{num(r.customers)}</td><td title={r.cause}>{r.category}</td><td>{r.restored_by || '—'}</td>
            <td>{r.sla_met == null ? <span className="muted">no SLA</span> : r.sla_met ? 'Met' : <b style={{ color: 'var(--crit)' }}>Missed</b>}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
