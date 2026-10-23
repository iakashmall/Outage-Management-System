import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { TrendChart, WorstBars, allZeroMessage } from './KpiCharts.jsx';
import FeederPdfPicker from './FeederPdfPicker.jsx';

// PFC feeder-wise KPIs (FVHI ... FLIF) for the Analytics screen.
// Two views:
//   All feeders - one row per feeder, worst first; click a row to open it
//   One feeder  - all 17 indices x R / Y / B / Total
// The period selector covers daily, weekly, monthly, quarterly, yearly and a
// custom day range; a period that includes today refreshes every minute.

const PERIODS = [
  ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'], ['yearly', 'Yearly'], ['custom', 'Custom'],
];
const PHASES = ['R', 'Y', 'B', 'T'];
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

// Colour bands. Thresholds are the same defaults the backend uses; a feeder
// with its own rating is still judged in % of ITS nominal, so these hold.
function tone(code, v) {
  if (v == null) return '';
  switch (code) {
    case 'FVHI': case 'FVLI': case 'FCHI': case 'FCLI': return v >= 5 ? 'crit' : v > 0 ? 'warn' : 'ok';
    case 'FVHD': case 'FVLD': case 'FCHD': case 'FCLD': return v >= 60 ? 'crit' : v > 0 ? 'warn' : 'ok';
    case 'FMXV': return v > 110 ? 'crit' : v > 105 ? 'warn' : 'ok';
    case 'FMNV': return v < 90 ? 'crit' : v < 95 ? 'warn' : 'ok';
    case 'FMXC': return v > 100 ? 'crit' : v > 90 ? 'warn' : 'ok';
    case 'FVSM': return v < 70 ? 'crit' : 'warn';
    case 'FCSM': return v < 30 ? 'crit' : 'warn';
    case 'FLIF': return v > 150 ? 'crit' : v > 120 ? 'warn' : 'ok';
    default: return '';
  }
}
const fmt = (v, unit) => {
  if (v == null) return '—';
  if (unit === 'Nos') return Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(1); // axis ticks are fractional
  if (Math.abs(v) >= 10000) return Math.round(v).toLocaleString('en-IN');
  return Number(v).toFixed(unit === 'min' ? 0 : 1);
};

// League-table columns (All feeders view). `code` gets the phase suffix.
const LEAGUE = [
  { code: 'FVHI', label: 'V high', sub: 'Nos' }, { code: 'FVHD', label: 'V high', sub: 'min' },
  { code: 'FVLI', label: 'V low', sub: 'Nos' }, { code: 'FVLD', label: 'V low', sub: 'min' },
  { code: 'FCHI', label: 'I high', sub: 'Nos' }, { code: 'FCHD', label: 'I high', sub: 'min' },
  { code: 'FMXV', label: 'Max V', sub: '%' }, { code: 'FMNV', label: 'Min V', sub: '%' },
  { code: 'FMXC', label: 'Max I', sub: '%' }, { code: 'FVSM', label: 'V sag', sub: '%' },
  { code: 'FLIF', label: 'Imbalance', sub: '%', phased: false },
];
// "Worst first" ordering per column.
const WORST_LOW = new Set(['FMNV', 'FMNC', 'FVSM', 'FCSM']);

export default function FeederKpiPanel() {
  const [defs, setDefs] = useState(null);
  const [mode, setMode] = useState('tree');
  const [period, setPeriod] = useState('daily');
  const [date, setDate] = useState(todayIst());
  const [from, setFrom] = useState(todayIst());
  const [to, setTo] = useState(todayIst());
  const [feeder, setFeeder] = useState('');
  const [phase, setPhase] = useState('T');
  const [sort, setSort] = useState({ code: 'FVLD', dir: 'worst' });
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('FVLD'); // index shown in the chart
  const [series, setSeries] = useState(null);
  const dataRef = useRef(null); // the refresh timer reads the latest range from here
  const [treeScope, setTreeScope] = useState([]); // feeders under the hierarchy's current drill-down

  useEffect(() => {
    api.feederKpiDefs().then((d) => { setDefs(d); setFeeder((f) => f || d.feeders[0]?.feeder || ''); })
      .catch((e) => setErr(e.message));
  }, []);

  const params = useMemo(() => {
    const p = { period };
    if (period === 'custom') { p.from = from; p.to = to; } else p.date = date;
    if (mode === 'one' && feeder) p.feeder = feeder;
    return p;
  }, [period, date, from, to, mode, feeder]);

  useEffect(() => {
    if (mode === 'one' && !feeder) return undefined;
    let live = true;
    const load = () => {
      setBusy(true);
      api.feederKpi(params)
        .then((d) => { if (live) { dataRef.current = d; setData(d); setErr(null); } })
        .catch((e) => live && setErr(e.message))
        .finally(() => live && setBusy(false));
    };
    load();
    // Only a period that is still running (includes today) changes minute to minute.
    const t = setInterval(() => { const r = dataRef.current?.range; if (r && new Date(r.to) > new Date()) load(); }, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  // Time series for the trend chart (One feeder view only).
  useEffect(() => {
    if (mode !== 'one' || !feeder) return undefined;
    let live = true;
    const load = () => api.feederKpiSeries(params).then((d) => { if (live) setSeries(d); }).catch(() => {});
    setSeries(null);
    load();
    const t = setInterval(() => { const r = dataRef.current?.range; if (r && new Date(r.to) > new Date()) load(); }, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [params, mode, feeder]);

  const key = (code, ph = phase) => (code === 'FLIF' ? 'FLIF' : `${code}_${ph}`);
  const rows = useMemo(() => {
    const list = [...(data?.feeders || [])];
    const k = key(sort.code);
    const lowWorst = WORST_LOW.has(sort.code);
    list.sort((a, b) => {
      const x = a.kpis[k], y = b.kpis[k];
      if (x == null && y == null) return a.feeder.localeCompare(b.feeder);
      if (x == null) return 1; if (y == null) return -1;
      const worstFirst = lowWorst ? x - y : y - x;
      return sort.dir === 'worst' ? worstFirst : -worstFirst;
    });
    return list;
  }, [data, sort, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const one = mode === 'one' ? data?.feeders?.[0] : null;
  const exportCsv = () => api.exportFeederKpi(params).catch((e) => alert('Export failed: ' + e.message));
  // The PDF picker opens with the feeder(s) in view ticked.
  const pdfInitial = mode === 'one' ? (feeder ? [feeder] : []) : mode === 'tree' ? treeScope : [];
  const openFeeder = (f) => { setFeeder(f); setMode('one'); };
  const clickSort = (c) => { setCode(c); setSort((s) => ({ code: c, dir: s.code === c && s.dir === 'worst' ? 'best' : 'worst' })); };
  const chartDef = defs?.defs.find((d) => d.code === code);
  const worst = useMemo(() => {
    if (!data || !chartDef) return [];
    const k = chartDef.phased === false ? code : `${code}_${phase}`;
    const list = data.feeders.filter((f) => f.kpis[k] != null).map((f) => ({ feeder: f.feeder, value: f.kpis[k] }));
    list.sort((a, b) => (WORST_LOW.has(code) ? a.value - b.value : b.value - a.value));
    return list.slice(0, 10);
  }, [data, chartDef, code, phase]);
  const indexSelect = (
    <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Index to chart">
      {(defs?.defs || []).map((d) => <option key={d.code} value={d.code}>{d.code} · {d.name}</option>)}
    </select>
  );

  return (
    <div className="fk">
      <div className="fk-bar">
        {/* Toggle groups (role=group + aria-pressed), not tablists: these buttons switch a filter, they do not own tab panels. */}
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={mode === 'tree'} className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')}>Hierarchy</button>
          <button aria-pressed={mode === 'all'} className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>All feeders</button>
          <button aria-pressed={mode === 'one'} className={mode === 'one' ? 'on' : ''} onClick={() => setMode('one')}>One feeder</button>
        </div>
        <div className="seg" role="group" aria-label="Period">
          {PERIODS.map(([k, l]) => <button key={k} aria-pressed={period === k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
        {period === 'custom' ? (
          <span className="fk-dates">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </span>
        ) : (
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Any day in the period" title="Any day inside the period" />
        )}
        {mode === 'one' && (
          <select value={feeder} onChange={(e) => setFeeder(e.target.value)} aria-label="Feeder">
            {(defs?.feeders || []).map((f) => <option key={f.feeder} value={f.feeder}>{f.feeder}{f.substation ? ` · ${f.substation}` : ''}</option>)}
          </select>
        )}
        {mode !== 'one' && (
          <div className="seg" role="group" aria-label="Phase">
            {PHASES.map((p) => <button key={p} aria-pressed={phase === p} className={phase === p ? 'on' : ''} onClick={() => setPhase(p)}>{p === 'T' ? 'Total' : p}</button>)}
          </div>
        )}
        <div className="grow" />
        <button className="btn sm" onClick={exportCsv} disabled={!data}>Export CSV</button>
        <FeederPdfPicker feeders={defs?.feeders || []} initial={pdfInitial} disabled={!defs}
          onExport={(list) => api.exportFeederKpiPdf(params, list)} />
      </div>

      <div className="fk-range">
        {data ? (
          <>
            <b>{data.range.label}</b>
            <span className="muted"> · {data.range.daysElapsed} of {data.range.days} day{data.range.days === 1 ? '' : 's'} elapsed</span>
            {one && <span className="muted"> · data completeness <b className={one.coverage.completenessPct < 90 ? 'fk-warn-t' : ''}>{one.coverage.completenessPct ?? 0}%</b></span>}
            {busy && <span className="muted"> · updating…</span>}
          </>
        ) : <span className="muted">{err ? '' : 'Loading…'}</span>}
        {err && <span className="fk-err"> {err}</span>}
      </div>

      {mode === 'tree' && data && defs && (
        <KpiHierarchy feeders={data.feeders} defs={defs.defs} phase={phase} params={params} onOpenFeeder={openFeeder} onScope={setTreeScope} />
      )}

      {mode === 'all' && data && chartDef && (
        <div className="fk-chartcard">
          <div className="fk-charthead">
            <div><b>Worst 10 feeders</b><span className="muted"> · {chartDef.name} ({chartDef.phased === false ? code : `${code}_${phase}`}, {chartDef.unit})</span></div>
            {indexSelect}
          </div>
          <WorstBars rows={worst} unit={chartDef.unit === '% of nominal' ? '%' : chartDef.unit} toneOf={(v) => tone(code, v)} onPick={openFeeder} />
        </div>
      )}

      {mode === 'all' && data && (
        <div className="fk-scroll">
          <table className="tbl fk-tbl">
            <thead>
              <tr>
                <th>Feeder</th><th>Substation</th><th title="Share of the period covered by telemetry">Data</th>
                {LEAGUE.map((c) => (
                  <th key={c.code + c.sub} className="fk-num fk-sort" onClick={() => clickSort(c.code)} aria-sort={sort.code === c.code ? (sort.dir === 'worst' ? 'descending' : 'ascending') : 'none'}>
                    {c.label}<br /><span className="fk-sub">{c.code}{c.phased === false ? '' : `_${phase}`} · {c.sub}</span>
                    {sort.code === c.code && <span className="fk-arrow">{sort.dir === 'worst' ? '▼' : '▲'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const none = !f.coverage.coveredMinutes;
                return (
                  <tr key={f.feeder} onClick={() => openFeeder(f.feeder)} className={none ? 'fk-nodata' : ''} style={{ cursor: 'pointer' }}>
                    <td className="mono">{f.feeder}</td>
                    <td className="fk-subst">{f.substation || '—'}</td>
                    <td className="mono">{none ? 'no data' : `${Math.round(f.coverage.completenessPct)}%`}</td>
                    {LEAGUE.map((c) => {
                      const v = f.kpis[key(c.code)];
                      return <td key={c.code + c.sub} className={`mono fk-num fk-${tone(c.code, v)}`}>{fmt(v, c.sub === '%' ? '%' : c.sub)}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {mode === 'one' && one && defs && (
        <>
          <div className="fk-chartcard">
            <div className="fk-charthead">
              <div><b>{chartDef?.name}</b><span className="muted"> · {one.feeder} · {data.range.label}</span></div>
              {indexSelect}
            </div>
            {series && chartDef
              ? <TrendChart points={series.points} def={chartDef} granularity={series.granularity} rating={series.rating} />
              : <div className="empty">Loading chart…</div>}
          </div>
          <div className="fk-cards">
            {['FMXV', 'FMNV', 'FMXC', 'FMNC', 'FLIF'].map((code) => {
              const d = defs.defs.find((x) => x.code === code);
              const v = one.kpis[key(code, 'T')];
              return (
                <div key={code} className={`stat fk-card fk-edge-${tone(code, v)}`}>
                  <div className="stat-l">{code}</div>
                  <div className="stat-n">{fmt(v, '%')}<span className="kpi-u"> %</span></div>
                  <div className="kpi-hint">{d.name}</div>
                </div>
              );
            })}
          </div>
          <div className="fk-scroll">
            <table className="tbl fk-tbl">
              <thead>
                <tr><th>#</th><th>Code</th><th>Index</th><th>Unit</th>
                  {PHASES.map((p) => <th key={p} className="fk-num">{p === 'T' ? 'Total' : p}</th>)}</tr>
              </thead>
              <tbody>
                {defs.defs.map((d) => {
                  if (d.phased === false) {
                    const v = one.kpis[d.code];
                    return (
                      <tr key={d.code} onClick={() => setCode(d.code)} className={code === d.code ? 'fk-rowsel' : ''} style={{ cursor: 'pointer' }}>
                        <td className="muted">{d.item}</td><td className="mono"><b>{d.code}</b></td><td>{d.name}</td><td className="muted">{d.unit}</td>
                        <td colSpan={3} className="muted fk-note">R/Y/B combined{one.extras?.FLIF_AVG != null ? ` · average ${one.extras.FLIF_AVG}%` : ''}</td>
                        <td className={`mono fk-num fk-${tone(d.code, v)}`}>{fmt(v, d.unit)}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={d.code} onClick={() => setCode(d.code)} className={code === d.code ? 'fk-rowsel' : ''} style={{ cursor: 'pointer' }}>
                      <td className="muted">{d.item}</td><td className="mono"><b>{d.code}</b></td><td>{d.name}</td><td className="muted">{d.unit}</td>
                      {PHASES.map((p) => {
                        const v = one.kpis[`${d.code}_${p}`];
                        return <td key={p} className={`mono fk-num fk-${tone(d.code, v)} ${p === 'T' ? 'fk-total' : ''}`}>{fmt(v, d.unit)}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="fk-foot muted">
            Total (T): incidents and durations count the feeder as in breach when any phase is; stress values add the three phases;
            max takes the highest phase and min / sag the lowest. Minutes while the whole feeder is de-energised are left out (they are
            interruptions, counted in SAIDI/SAIFI). — = no sag, or no data. Gaps over {defs.maxGapMinutes} min in the telemetry are not counted.
          </p>
        </>
      )}
    </div>
  );
}
// ---- Hierarchy view: Entire region -> substation -> feeder -> phase ----
// Every index gets a line chart over the period: one line per child of the
// current scope (substations, then feeders, then R / Y / B / Total), the
// worst five by period value. Click a legend entry to drill into it.
// Scope totals use each index's own rule (incidents / durations / stress add
// up, max takes the highest, min the lowest).
const LINE_COLORS = ['#2f6fd6', '#e23b2e', '#0fb39d', '#d99a14', '#8b5cf6', '#0f2847', '#db2777', '#65a30d', '#0891b2', '#9a3412'];
const PHASE_LINE = { R: '#d7382a', Y: '#d99a14', B: '#2f6fd6', T: '#0f2847' };
const LINE_COUNTS = [5, 10]; // more than 10 lines cannot be told apart; the ranked list shows the rest
// Tabs of the hierarchy view: one screen of related indices each.
const KH_GROUPS = [
  { key: 'volt', label: 'Voltage events', codes: ['FVHI', 'FVHD', 'FVLI', 'FVLD'] },
  { key: 'curr', label: 'Current events', codes: ['FCHI', 'FCHD', 'FCLI', 'FCLD'] },
  { key: 'sag', label: 'Sags & stress', codes: ['FVSM', 'FCSM', 'FVSV', 'FCSV'] },
  { key: 'ext', label: 'Max / min', codes: ['FMXV', 'FMNV', 'FMXC', 'FMNC'] },
  { key: 'imb', label: 'Load imbalance', codes: ['FLIF'] },
];

function aggOf(def, xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
  if (!v.length) return null;
  if (def.agg === 'sum') return Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100;
  return def.agg === 'max' ? Math.max(...v) : Math.min(...v);
}
const shortSub = (s) => s.replace(/^33\/11 kV\s*/i, '').replace(/\s*S\/s$/i, '');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const xLabel = (l, g) => (g === 'hour' ? l : `${+l.slice(8, 10)} ${MON[+l.slice(5, 7) - 1]}`);

function MiniLines({ labels: allLabels, granularity, lines: allLines, def, unit }) {
  const [hover, setHover] = useState(null);
  const W = 560, H = 230, ML = 46, MR = 14, MT = 10, MB = 26;
  // Drop leading/trailing time steps with no data, so the lines use the full width.
  const has = (i) => allLines.some((l) => l.values[i] != null);
  let a = 0, z = allLabels.length - 1;
  while (a <= z && !has(a)) a++;
  while (z >= a && !has(z)) z--;
  const labels = allLabels.slice(a, z + 1);
  const lines = allLines.map((l) => ({ ...l, values: l.values.slice(a, z + 1) }));
  const vals = lines.flatMap((l) => l.values).filter((v) => v != null);
  if (!labels.length || !vals.length) return <div className="muted kh-empty">No data in this period</div>;
  const zero = allZeroMessage(def, vals, granularity);
  if (zero) return <div className="kh-zero">{zero}</div>;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (def.agg === 'sum') lo = Math.min(lo, 0);
  const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.1;
  if (def.agg !== 'sum') lo -= pad;
  hi += pad;
  const n = labels.length;
  const x = (i) => ML + (n === 1 ? (W - ML - MR) / 2 : (i / (n - 1)) * (W - ML - MR));
  const y = (v) => MT + (1 - (v - lo) / (hi - lo)) * (H - MT - MB);
  const ticks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
  // At most ~7 date labels, evenly spaced; the last one only if it has room.
  const step = Math.max(1, Math.ceil(n / 7));
  const showX = (i) => i % step === 0 || (i === n - 1 && (n - 1) % step >= step * 0.6);
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - ML) / (W - ML - MR)) * (n - 1)))));
  };
  return (
    <div className="kh-chart">
      <svg viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${def.code} trend`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} stroke="var(--line-2)" strokeWidth={0.6} />
            <text x={ML - 6} y={y(t) + 3.5} fontSize={10.5} textAnchor="end" fill="var(--muted)">{fmt(t, unit)}</text>
          </g>
        ))}
        {labels.map((l, i) => showX(i) && (
          <text key={i} x={x(i)} y={H - 6} fontSize={10.5} textAnchor="middle" fill="var(--muted)">{xLabel(l.label, granularity)}</text>
        ))}
        {lines.map((ln) => {
          let d = '';
          ln.values.forEach((v, i) => { if (v == null) return; d += `${d && ln.values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
          return (
            <g key={ln.id}>
              <path d={d} fill="none" stroke={ln.color} strokeWidth={ln.bold ? 2.6 : 1.8} strokeLinejoin="round" />
              {n <= 31 && ln.values.map((v, i) => v != null && <circle key={i} cx={x(i)} cy={y(v)} r={2.6} fill={ln.color} />)}
            </g>
          );
        })}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={MT} y2={H - MB} stroke="var(--muted)" strokeDasharray="3 3" strokeWidth={0.8} />}
      </svg>
      {hover != null && (
        <div className="kh-tip">
          <b>{xLabel(labels[hover].label, granularity)}</b>
          {lines.map((ln) => <div key={ln.id}><i style={{ background: ln.color }} />{ln.label}: <b>{fmt(ln.values[hover], unit)}</b></div>)}
        </div>
      )}
    </div>
  );
}

function KpiHierarchy({ feeders, defs, phase, params, onOpenFeeder, onScope }) {
  const [sub, setSub] = useState(null);
  const [fdr, setFdr] = useState(null);
  const [loaded, setLoaded] = useState(null); // { scope, data }
  const [group, setGroup] = useState('volt');
  const [topN, setTopN] = useState(5);
  const [expanded, setExpanded] = useState(() => new Set()); // index codes whose full ranking is open
  const groupCodes = KH_GROUPS.find((g) => g.key === group).codes;
  const keyOf = (d, ph = phase) => (d.phased === false ? d.code : `${d.code}_${ph}`);
  const level = fdr ? 'phase' : sub ? 'feeder' : 'substation';

  const bySub = useMemo(() => {
    const m = new Map();
    for (const f of feeders) {
      const s = f.substation || 'Unassigned';
      (m.get(s) || m.set(s, []).get(s)).push(f);
    }
    return m;
  }, [feeders]);
  const scopeFeeders = useMemo(
    () => (fdr ? feeders.filter((f) => f.feeder === fdr) : sub ? (bySub.get(sub) || []) : feeders),
    [feeders, bySub, sub, fdr],
  );
  // Tell the panel which feeders are in view (none at region level), for the PDF picker.
  useEffect(() => { onScope?.(sub || fdr ? scopeFeeders.map((f) => f.feeder) : []); }, [scopeFeeders, sub, fdr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Time series of the children of the current scope. Tagged with the scope
  // it was fetched for: right after a drill, the previous scope's data (a
  // different shape) must not be read for the new one.
  const scope = `${params.period}|${params.date}|${params.from}|${params.to}|${sub}|${fdr}`;
  const series = loaded?.scope === scope ? loaded.data : null;
  useEffect(() => {
    let live = true;
    const req = fdr
      ? api.feederKpiSeries({ ...params, feeder: fdr }).then((d) => ({
        granularity: d.granularity, labels: d.points, phasePoints: d.points.map((p) => p.kpis),
      }))
      : api.feederKpiChildSeries({ ...params, ...(sub ? { substation: sub } : {}) });
    req.then((d) => { if (live) setLoaded({ scope, data: d }); })
      .catch(() => live && setLoaded({ scope, data: { labels: [], children: [], phasePoints: [] } }));
    return () => { live = false; };
  }, [params, sub, fdr]);

  const childName = { substation: 'substations', feeder: 'feeders', phase: 'phases' }[level];
  const scopeValue = (d) => (level === 'phase'
    ? scopeFeeders[0]?.kpis[keyOf(d, 'T')]
    : aggOf(d, scopeFeeders.map((f) => f.kpis[keyOf(d)])));
  // Period value of a child, used to pick and order the lines.
  const childValue = (d, id) => (level === 'substation'
    ? aggOf(d, (bySub.get(id) || []).map((f) => f.kpis[keyOf(d)]))
    : feeders.find((f) => f.feeder === id)?.kpis[keyOf(d)]);

  // Every child of the scope with a value for this index, worst first.
  const rankedFor = (d) => {
    if (!series || level === 'phase') return [];
    const lowWorst = WORST_LOW.has(d.code);
    return series.children
      .map((c) => ({ id: c.id, value: childValue(d, c.id), values: c.points.map((k) => k[keyOf(d)]) }))
      .filter((c) => c.value != null)
      .sort((a, b) => (lowWorst ? a.value - b.value : b.value - a.value))
      .map((c) => ({
        ...c, label: level === 'substation' ? shortSub(c.id) : c.id,
        drill: () => (level === 'substation' ? setSub(c.id) : setFdr(c.id)),
      }));
  };
  const toggleRanking = (code) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(code)) n.delete(code); else n.add(code);
    return n;
  });

  const linesFor = (d) => {
    if (!series) return [];
    if (level === 'phase') {
      const phs = d.phased === false ? ['T'] : ['R', 'Y', 'B', 'T'];
      return phs.map((p) => ({
        id: p, label: p === 'T' ? (d.phased === false ? 'RYB' : 'Total') : p, color: PHASE_LINE[p], bold: p === 'T',
        value: scopeFeeders[0]?.kpis[d.phased === false ? d.code : `${d.code}_${p}`],
        values: series.phasePoints.map((k) => k[d.phased === false ? d.code : `${d.code}_${p}`]),
      }));
    }
    return rankedFor(d).slice(0, topN).map((c, i) => ({ ...c, color: LINE_COLORS[i] }));
  };

  return (
    <div className="kh">
      <nav className="kh-crumbs" aria-label="Scope">
        <button className={!sub ? 'on' : ''} onClick={() => { setSub(null); setFdr(null); }}>Entire region</button>
        {sub && <><span>›</span><button className={!fdr ? 'on' : ''} onClick={() => setFdr(null)}>{sub}</button></>}
        {fdr && <><span>›</span><button className="on">{fdr}</button>
          <button className="btn sm" onClick={() => onOpenFeeder(fdr)}>Open feeder detail</button></>}
        <span className="kh-jump">
          <select value={sub || ''} aria-label="Go to substation"
            onChange={(e) => { setSub(e.target.value || null); setFdr(null); }}>
            <option value="">Go to substation…</option>
            {[...bySub.keys()].sort().map((s) => <option key={s} value={s}>{shortSub(s)}</option>)}
          </select>
          <select value={fdr || ''} aria-label="Go to feeder"
            onChange={(e) => {
              const f = feeders.find((x) => x.feeder === e.target.value);
              if (f) { setSub(f.substation || 'Unassigned'); setFdr(f.feeder); } else setFdr(null);
            }}>
            <option value="">Go to feeder…</option>
            {[...bySub.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([s, fs]) => (
              <optgroup key={s} label={shortSub(s)}>
                {[...fs].sort((a, b) => a.feeder.localeCompare(b.feeder)).map((f) => <option key={f.feeder} value={f.feeder}>{f.feeder}</option>)}
              </optgroup>
            ))}
          </select>
        </span>
        <span className="muted kh-hint">
          {level === 'phase'
            ? 'Lines = R / Y / B / Total for this feeder'
            : `Lines = worst ${topN} ${childName}${phase !== 'T' ? ` · phase ${phase}` : ''} · click a name to drill down`}
        </span>
        {level !== 'phase' && (
          <span className="seg kh-topn" role="group" aria-label="Lines per chart">
            {LINE_COUNTS.map((n) => (
              <button key={n} className={topN === n ? 'on' : ''} aria-pressed={topN === n} onClick={() => setTopN(n)}>Worst {n}</button>
            ))}
          </span>
        )}
      </nav>
      <div className="seg kh-tabs" role="tablist" aria-label="Index group">
        {KH_GROUPS.map((g) => (
          <button key={g.key} role="tab" aria-selected={group === g.key} className={group === g.key ? 'on' : ''} onClick={() => setGroup(g.key)}>
            {g.label}
          </button>
        ))}
      </div>
      {!series && <div className="muted kh-loading">Loading trends…</div>}
      <div className={`kh-grid${groupCodes.length === 1 ? ' kh-single' : ''}`}>
        {defs.filter((d) => groupCodes.includes(d.code)).map((d) => {
          const total = scopeValue(d);
          const unit = d.unit === '% of nominal' ? '%' : d.unit;
          const lines = linesFor(d);
          const ranked = rankedFor(d);
          const open = expanded.has(d.code);
          return (
            <div key={d.code} className={`kh-card fk-edge-${tone(d.code, total)}`}>
              <div className="kh-head">
                <div><b className="mono">{d.code}</b><div className="kh-name">{d.name}</div></div>
                <div className={`kh-total mono fk-${tone(d.code, total)}`}>{fmt(total, unit)}<span className="kpi-u"> {unit}</span></div>
              </div>
              <div className="kh-body">
              {series && <MiniLines labels={series.labels} granularity={series.granularity} lines={lines} def={d} unit={unit} />}
              <div className="kh-legend">
                {lines.map((ln) => (
                  <button key={ln.id} onClick={ln.drill} disabled={!ln.drill} title={ln.drill ? `Drill into ${ln.id}` : ''}>
                    <i style={{ background: ln.color }} /><span className="kh-lbl">{ln.label}</span>
                    <b className={`mono fk-${tone(d.code, ln.value)}`}>{fmt(ln.value, unit)}</b>
                  </button>
                ))}
              </div>
              {ranked.length > lines.length && (
                <button className="kh-more" onClick={() => toggleRanking(d.code)} aria-expanded={open}>
                  {open ? 'Hide full ranking' : `Show all ${ranked.length} ${childName}`}
                </button>
              )}
              {open && ranked.length > lines.length && (
                <ol className="kh-rank">
                  {ranked.map((c) => (
                    <li key={c.id}>
                      <button onClick={c.drill} title={`Drill into ${c.id}`}>
                        <span className="kh-lbl">{c.label}</span>
                        <b className={`mono fk-${tone(d.code, c.value)}`}>{fmt(c.value, unit)}</b>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
