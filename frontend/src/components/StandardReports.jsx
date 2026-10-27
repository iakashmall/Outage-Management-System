import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { SevBadge, StatusBadge, toast, focusAfter } from '../lib/ui.jsx';
import { useT, t, tOr, locale } from '../lib/i18n.js';

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
const when = (v) => (v ? new Date(v).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dur = (m) => (m == null ? '—' : m < 60 ? t('sr.dur.m', { m }) : m < 1440 ? t('sr.dur.h', { h: Math.floor(m / 60), m: m % 60 }) : t('sr.dur.d', { d: Math.floor(m / 1440), h: Math.floor((m % 1440) / 60) }));
const num = (n) => (n == null ? '—' : Number(n).toLocaleString(locale()));
const avg = (list, f) => (list.length ? Math.round(list.reduce((s, x) => s + f(x), 0) / list.length) : null);
const cat = (c) => (c ? tOr(`sr.cat.${c}`, c) : c);

// Headline figures above each report's table.
function statsFor(r) {
  if (r.kind === 'history') {
    const ongoing = r.rows.filter((x) => !x.resolved_at).length;
    return [[t('sr.s.outages'), num(r.rows.length)], [t('sr.s.custAffected'), num(r.rows.reduce((s, x) => s + x.customers, 0))],
      [t('sr.s.ongoing'), num(ongoing)], [t('sr.s.avgDurRestored'), dur(avg(r.rows.filter((x) => x.resolved_at), (x) => x.duration_min))]];
  }
  if (r.kind === 'cause') {
    const top = r.rows[0];
    return [[t('sr.s.outages'), num(r.incidents)], [t('sr.s.causeCats'), num(r.rows.length)], [t('sr.s.topCause'), top ? cat(top.category) : '—'], [t('sr.s.topShare'), top ? `${top.share_pct}%` : '—']];
  }
  if (r.kind === 'recurring') {
    return [[t('sr.s.flagged'), num(r.rows.length)], [t('sr.s.feeders'), num(r.rows.filter((x) => x.kind === 'Feeder').length)],
      [t('sr.s.devices'), num(r.rows.filter((x) => x.kind === 'Device').length)], [t('sr.s.rule'), t('sr.s.ruleVal', { n: r.minCount, d: r.windowDays })]];
  }
  if (r.kind === 'worst') {
    return [[t('sr.s.worstFeeder'), r.feeders[0]?.key || '—'], [t('sr.s.itsCm'), num(r.feeders[0]?.customer_minutes)],
      [t('sr.s.worstDevice'), r.devices[0]?.key || '—'], [t('sr.s.itsOutages'), num(r.devices[0]?.outages)]];
  }
  return [[t('sr.s.closed'), num(r.summary.closed)], [t('sr.s.avgRestore'), dur(r.summary.avg_restore_min)],
    [t('sr.s.slaMet'), r.summary.sla_met_pct == null ? '—' : `${r.summary.sla_met_pct}%`], [t('sr.s.custRestored'), num(r.rows.reduce((s, x) => s + x.customers, 0))]];
}

export default function StandardReports() {
  const { t } = useT();
  const [kind, setKind] = useState('history');
  const pickerRef = useRef(null);
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
  const exportCsv = () => api.exportStandardReport(kind, params).catch((e) => toast(t('sr.exportFailed', { e: e.message }), 'err'));
  const [, titleEn, aboutEn] = KINDS.find(([k]) => k === kind);
  const title = tOr(`sr.k.${kind}`, titleEn);
  const about = tOr(`sr.k.${kind}.about`, aboutEn);
  const shown = data && data.kind === kind ? data : null;

  return (
    <div className="fk sr">
      <div className="seg sr-kinds" role="group" aria-label={t('sr.report')} ref={pickerRef}>
        {KINDS.map(([k, l]) => <button key={k} aria-pressed={kind === k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); focusAfter(pickerRef.current); }}>{tOr(`sr.k.${k}`, l)}</button>)}
      </div>
      <p className="sr-about">{about}</p>

      <div className="sr-filters">
        <div className="sr-field">
          <span className="sr-label" id="sr-period">{t('sr.period')}</span>
          <div className="sr-row">
            <div className="seg" role="group" aria-labelledby="sr-period">
              {PRESETS.map(([p, l]) => <button key={p} aria-pressed={preset === p} className={preset === p ? 'on' : ''} onClick={() => pickPreset(p)}>{tOr(`sr.p${p}`, l)}</button>)}
            </div>
            <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPreset(''); }} aria-label={t('sr.fromDate')} />
            <span className="muted">{t('sr.to')}</span>
            <input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPreset(''); }} aria-label={t('sr.toDate')} />
          </div>
        </div>
        <div className="sr-field">
          <label className="sr-label" htmlFor="sr-zone">{t('sr.zone')}</label>
          <select id="sr-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">{t('sr.allZones')}{zones.length ? ` (${zones.length})` : ''}</option>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        {kind === 'recurring' && (
          <div className="sr-field">
            <span className="sr-label" id="sr-rule">{t('sr.flagWhen')}</span>
            <div className="sr-row" role="group" aria-labelledby="sr-rule">
              <input type="number" min={2} max={20} value={minCount} onChange={(e) => setMinCount(Number(e.target.value) || 3)} aria-label={t('sr.minOutages')} className="sr-num" />
              <span className="muted">{t('sr.orMore')}</span>
              <input type="number" min={1} max={365} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 30)} aria-label={t('sr.windowDays')} className="sr-num" />
              <span className="muted">{t('sr.daysWord')}</span>
            </div>
          </div>
        )}
        <div className="grow" />
        <button className="btn sm" onClick={exportCsv} disabled={!shown}>{t('sr.exportCsv')}</button>
      </div>

      <div className="fk-range" role="status">
        <b>{title}</b>
        {shown && <span className="muted"> · {zone || t('sr.allZonesLc')} · {t('sr.rangeTo', { from, to })}</span>}
        {busy && <span className="muted">{t('sr.updating')}</span>}
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
  const { t } = useT();
  const head = ['incident', 'opened', 'restored', 'duration', 'zone', 'feeder', 'device', 'severity', 'customers', 'cause', 'status'].map((k) => t(`sr.c.${k}`));
  return (
    <Table label={t('sr.t.history')} head={head} empty={!rows.length && t('sr.e.noOutages')}>
      {rows.slice(0, 500).map((r) => (
        <tr key={r.id}>
          <td className="mono">{r.id}</td><td>{when(r.opened_at)}</td><td>{when(r.resolved_at)}</td><td>{dur(r.duration_min)}{!r.resolved_at && <span className="muted">{t('sr.ongoing')}</span>}</td>
          <td>{r.zone}</td><td className="mono">{r.feeder}</td><td className="mono">{r.device}</td>
          <td><SevBadge sev={r.severity} /></td><td>{num(r.customers)}</td><td title={r.cause}>{cat(r.category)}</td><td><StatusBadge status={r.status} /></td>
        </tr>
      ))}
    </Table>
  );
}

function Cause({ rows }) {
  const { t } = useT();
  const max = Math.max(1, ...rows.map((r) => r.outages));
  const head = ['cause', 'outages', 'share', 'custAffected', 'cm', 'avgDur'].map((k) => t(`sr.c.${k}`));
  return (
    <Table label={t('sr.t.cause')} head={head} empty={!rows.length && t('sr.e.noOutages')}>
      {rows.map((r) => (
        <tr key={r.category}>
          <td><b>{cat(r.category)}</b></td>
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
  const { t } = useT();
  const head = ['type', 'feederDevice', 'zone', 'outages', 'mostInWindow', 'first', 'last', 'avgGap', 'mainCause'].map((k) => t(`sr.c.${k}`));
  return (
    <Table label={t('sr.t.recurring')} head={head} empty={!rows.length && t('sr.e.noRecurring')}>
      {rows.map((r) => (
        <tr key={r.kind + r.key}>
          <td>{tOr(`sr.kind.${r.kind}`, r.kind)}</td><td className="mono">{r.key}</td><td>{r.zone}</td><td>{r.outages}</td><td><b>{r.max_in_window}</b></td>
          <td>{when(r.first_at)}</td><td>{when(r.last_at)}</td><td>{r.avg_gap_days == null ? '—' : t('sr.days', { n: r.avg_gap_days })}</td><td>{cat(r.top_cause)}</td>
        </tr>
      ))}
    </Table>
  );
}

function Worst({ feeders, devices }) {
  const { t } = useT();
  const rows = (list) => list.map((r) => (
    <tr key={r.key}>
      <td>{r.rank}</td><td className="mono">{r.key}</td><td>{r.zone}</td><td>{r.outages}</td><td>{r.open}</td>
      <td>{num(r.customers)}</td><td><b>{num(r.customer_minutes)}</b></td><td>{dur(r.avg_duration_min)}</td>
    </tr>
  ));
  const head = (what) => [t('sr.c.rank'), what, t('sr.c.zone'), t('sr.c.outages'), t('sr.c.stillOpen'), t('sr.c.custAffected'), t('sr.c.cm'), t('sr.c.avgDur')];
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <h3 style={{ margin: '4px 0 8px', fontSize: 14 }}>{t('sr.t.worstFeeders')} <span className="muted" style={{ fontWeight: 400 }}>{t('sr.byCm')}</span></h3>
        <Table label={t('sr.t.worstFeeders')} head={head(t('sr.c.feeder'))} empty={!feeders.length && t('sr.e.noFeeder')}>{rows(feeders)}</Table>
      </div>
      <div>
        <h3 style={{ margin: '4px 0 8px', fontSize: 14 }}>{t('sr.t.worstDevices')} <span className="muted" style={{ fontWeight: 400 }}>{t('sr.scadaEq')}</span></h3>
        <Table label={t('sr.t.worstDevices')} head={head(t('sr.c.deviceTag'))} empty={!devices.length && t('sr.e.noScada')}>{rows(devices)}</Table>
      </div>
    </div>
  );
}

function Closed({ rows }) {
  const { t } = useT();
  const head = ['incident', 'opened', 'restored', 'restoreTime', 'zone', 'feeder', 'customers', 'cause', 'restoredBy', 'sla'].map((k) => t(`sr.c.${k}`));
  return (
    <>
      <Table label={t('sr.t.closed')} head={head} empty={!rows.length && t('sr.e.noClosed')}>
        {rows.slice(0, 500).map((r) => (
          <tr key={r.id}>
            <td className="mono">{r.id}</td><td>{when(r.opened_at)}</td><td>{when(r.resolved_at)}</td><td>{dur(r.duration_min)}</td>
            <td>{r.zone}</td><td className="mono">{r.feeder}</td><td>{num(r.customers)}</td><td title={r.cause}>{cat(r.category)}</td><td>{r.restored_by || '—'}</td>
            <td>{r.sla_met == null ? <span className="muted">{t('sr.noSla')}</span> : r.sla_met ? t('sr.met') : <b style={{ color: 'var(--crit)' }}>{t('sr.missed')}</b>}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
