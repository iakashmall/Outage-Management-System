import { useMemo, useState } from 'react';
import { SrTable } from '../lib/ui.jsx';
import { t, useT, locale } from '../lib/i18n.js';

// Charts for the PFC feeder KPI panel. Hand-drawn SVG, no chart library,
// same approach as the SAIDI bars in screens/Analytics.jsx.
//   TrendChart  one index over time for one feeder: lines R / Y / B / Total
//   WorstBars   one index across feeders: the N worst, click to open a feeder

const COLORS = { R: '#d7382a', Y: '#d99a14', B: '#2f6fd6', T: '#0f2847' };
const NAMES = { R: 'R', Y: 'Y', B: 'B', T: 'Total' };
const nm = (p) => (p === 'T' ? t('kc.total') : NAMES[p]);
// Which rating field draws the dashed limit line for an index.
const LIMIT = { FMXV: 'v_hi_pct', FMNV: 'v_lo_pct', FVSM: 'v_sag_pct', FMXC: 'i_hi_pct', FMNC: 'i_lo_pct' };

const W = 900, H = 300, ML = 54, MR = 18, MT = 14, MB = 34;

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortLabel = (label, granularity) => (granularity === 'hour' ? label : `${+label.slice(8, 10)} ${t(`kc.m${+label.slice(5, 7) - 1}`) || MONTHS[+label.slice(5, 7) - 1]}`);

const numFmt = (v) => (v == null ? '—' : Math.abs(v) >= 10000 ? Math.round(v).toLocaleString(locale()) : String(Math.round(v * 10) / 10));

// Counts, durations and stress that are 0 everywhere: say so in words, since a
// flat line at 0 reads like missing data. (null for anything else.)
export function allZeroMessage(def, values, granularity) {
  if (def.agg !== 'sum') return null;
  const xs = values.filter((v) => v != null);
  if (!xs.length || xs.some((v) => v !== 0)) return null;
  const what = def.name.replace(/^Feeder\s+/i, '').replace(/\s*\(.*\)$/, '');
  const when = t(granularity === 'hour' ? 'kc.onDay' : 'kc.inPeriod');
  if (/incidents$/i.test(what)) return t('kc.zeroInc', { what, when });
  if (/duration$/i.test(what)) return t('kc.zeroDur', { what: what.replace(/\s*duration$/i, ''), when });
  return t('kc.zero', { what, when });
}

export function TrendChart({ points, def, granularity, rating }) {
  useT();
  const [hover, setHover] = useState(null);
  const phases = def.phased === false ? [null] : ['R', 'Y', 'B', 'T'];
  const keyOf = (p) => (p ? `${def.code}_${p}` : def.code);
  const isSum = def.agg === 'sum'; // counts, durations, stress: totals per bucket -> bars

  const m = useMemo(() => {
    const vals = [];
    for (const pt of points) for (const p of phases) { const v = pt.kpis[keyOf(p)]; if (v != null) vals.push(v); }
    const limitField = LIMIT[def.code];
    const limit = limitField && rating ? rating[limitField] : null;
    if (limit != null) vals.push(limit);
    if (!vals.length) return null;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (def.agg === 'sum' || lo > 0 && hi - lo > lo * 2) lo = Math.min(lo, 0);
    else { const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.12; lo -= pad; hi += pad; }
    const ticks = niceTicks(lo, hi);
    return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks, limit };
  }, [points, def, rating]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m) return <div className="empty">{t('kc.noData')}</div>;
  const zero = allZeroMessage(def, points.flatMap((pt) => phases.map((p) => pt.kpis[keyOf(p)])), granularity);
  if (zero) return <div className="empty kh-zero">{zero}</div>;

  const n = points.length;
  const x = (i) => ML + (n === 1 ? (W - ML - MR) / 2 : (i * (W - ML - MR)) / (n - 1));
  const y = (v) => MT + (1 - (v - m.lo) / (m.hi - m.lo)) * (H - MT - MB);

  const pathFor = (p) => {
    let d = '', pen = false;
    points.forEach((pt, i) => {
      const v = pt.kpis[keyOf(p)];
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };

  const labelEvery = Math.max(1, Math.ceil(n / 9));
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - ML) / (W - ML - MR)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, n === 1 ? 0 : i)));
  };
  const hp = hover != null ? points[hover] : null;

  return (
    <div className="fk-chartwrap">
      <div className="fk-legend">
        {phases.map((p) => (
          <span key={p || 'one'}><i style={{ background: COLORS[p || 'T'], opacity: isSum && p === 'T' ? 0.35 : 1 }} />{p ? nm(p) : def.code}</span>
        ))}
        {m.limit != null && <span className="fk-lim"><i className="dash" />{t('kc.limit')} {m.limit}%</span>}
        <span className="muted fk-unit">{def.unit}{' · '}{t(granularity === 'hour' ? 'kc.perHour' : granularity === 'week' ? 'kc.perWeek' : 'kc.perDay')}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="fk-svg" role="img" aria-label={t('kc.trend', { name: def.name })}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {m.ticks.map((t) => (
          <g key={t}>
            <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} className="grid-line" />
            <text x={ML - 8} y={y(t) + 4} className="fk-ytick">{numFmt(t)}</text>
          </g>
        ))}
        {points.map((pt, i) => (i % labelEvery === 0 ? (
          <text key={pt.t} x={x(i)} y={H - 12} className="fk-xtick">{shortLabel(pt.label, granularity)}</text>
        ) : null))}
        {m.limit != null && <line x1={ML} x2={W - MR} y1={y(m.limit)} y2={y(m.limit)} className="fk-limit" />}
        {isSum && points.map((pt, i) => {
          const v = pt.kpis[keyOf('T')];
          if (v == null) return null;
          const bw = Math.min(30, ((W - ML - MR) / Math.max(n, 1)) * 0.6);
          return <rect key={pt.t} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(0, y(Math.max(m.lo, 0)) - y(v))} rx={2} fill={COLORS.T} opacity={0.22} />;
        })}
        {phases.map((p) => {
          const color = COLORS[p || 'T'];
          if (isSum && p === 'T') return null; // drawn as bars above
          return (
            <g key={p || 'one'}>
              <path d={pathFor(p)} fill="none" stroke={color} strokeWidth={p === 'T' || !p ? 2.4 : 1.6}
                opacity={p === 'T' || !p ? 1 : 0.85} strokeLinejoin="round" />
              {n <= 32 && points.map((pt, i) => {
                const v = pt.kpis[keyOf(p)];
                return v == null ? null : <circle key={pt.t} cx={x(i)} cy={y(v)} r={p === 'T' || !p ? 3 : 2.2} fill={color} />;
              })}
            </g>
          );
        })}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={MT} y2={H - MB} className="fk-cross" />}
      </svg>
      <SrTable caption={t('kc.values', { name: def.name })} head={[t('kc.period'), ...phases.map((p) => (p ? nm(p) : def.code))]}
        rows={points.map((pt) => [shortLabel(pt.label, granularity), ...phases.map((p) => pt.kpis[keyOf(p)] ?? '–')])} />
      {hp && (
        <div className="fk-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{shortLabel(hp.label, granularity)}</b>
          {phases.map((p) => (
            <div key={p || 'one'}><i style={{ background: COLORS[p || 'T'] }} />{p ? nm(p) : def.code}<span>{numFmt(hp.kpis[keyOf(p)])}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorstBars({ rows, unit, toneOf, onPick }) {
  useT();
  if (!rows.length) return <div className="empty">{t('kc.noData')}</div>;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  return (
    <div className="fk-bars" role="list">
      {rows.map((r) => (
        <div key={r.feeder} role="listitem">
          <button className="fk-bar-row" onClick={() => onPick(r.feeder)} title={t('kc.openFeeder')}>
            <span className="fk-bar-name mono">{r.feeder}</span>
            <span className="fk-bar-track"><span className={`fk-bar-fill fk-fill-${toneOf(r.value) || 'ok'}`} style={{ width: `${Math.max(1.5, (Math.abs(r.value) / max) * 100)}%` }} /></span>
            <span className="fk-bar-val mono">{numFmt(r.value)}<small> {unit === 'Nos' ? '' : unit}</small></span>
          </button>
        </div>
      ))}
    </div>
  );
}