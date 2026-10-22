// Analytics.jsx — Enhanced OMS Analytics Dashboard
// New features:
//   • PFC Feeder KPIs: FVHI/FVHD/FVLI/FVLD/FCHI/FCHD/FCLI/FCLD/FVSM/FCSM/FVSV/FCSV/FMXV/FMNV/FMXC/FMNC/FLIF
//   • Per-phase (R/Y/B/Total) values with _R/_Y/_B/_T suffix
//   • Configurable time periods: daily/weekly/monthly/quarterly/yearly + user-defined
//   • SAIDI/SAIFI split: Planned / Unplanned / Total
//   • Operator availability tracker — 3-shift mode
//   • SMS gateway dispatch for linemen & officers
//   • Escalation tracker (next-level if not restored in time)
//   • Role-based view: Management / CE / Functional
//   • Map indication placeholder (WFM integration hook)

import { useEffect, useMemo, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useLiveRefresh } from '../lib/ui.jsx';
import FeederKpiPanel from '../components/FeederKpiPanel.jsx';
// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MONTHS = ['Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan'];

const PERIODS = [
  { key: 'daily',     label: 'Today' },
  { key: 'weekly',    label: 'This week' },
  { key: 'monthly',   label: 'This month' },
  { key: 'quarterly', label: 'This quarter' },
  { key: 'yearly',    label: 'This year' },
  { key: 'custom',    label: 'Custom range' },
];

const ROLES = [
  { key: 'management', label: 'Management' },
  { key: 'ce',         label: 'CE / SE' },
  { key: 'functional', label: 'Functional / AE' },
];

const PHASES = ['R', 'Y', 'B', 'T'];

const SHIFTS = [
  { key: 'morning',   label: 'Morning',   time: '06:00–14:00' },
  { key: 'afternoon', label: 'Afternoon', time: '14:00–22:00' },
  { key: 'night',     label: 'Night',     time: '22:00–06:00' },
];

// ─────────────────────────────────────────────────────────────
// Simulated feeder KPI data (production: replace with api.feederKPIs(feeder, period, from, to))
// ─────────────────────────────────────────────────────────────
function generateFeederKPIs(feederName, period) {
  const seed = feederName ? feederName.charCodeAt(0) + feederName.length : 42;
  const rng = (base, spread, s = seed) => +(base + (((s * 9301 + 49297) % 233280) / 233280) * spread).toFixed(2);

  const phases = {};
  PHASES.forEach((p, i) => {
    const ps = seed + i * 17;
    phases[p] = {
      FVHI: Math.floor(rng(2, 8, ps)),
      FVHD: Math.floor(rng(15, 120, ps + 1)),
      FVLI: Math.floor(rng(1, 6, ps + 2)),
      FVLD: Math.floor(rng(10, 90, ps + 3)),
      FCHI: Math.floor(rng(3, 10, ps + 4)),
      FCHD: Math.floor(rng(20, 150, ps + 5)),
      FCLI: Math.floor(rng(1, 5, ps + 6)),
      FCLD: Math.floor(rng(8, 60, ps + 7)),
      FVSM: +rng(2.1, 8.5, ps + 8).toFixed(1),   // % sag
      FCSM: +rng(1.8, 7.2, ps + 9).toFixed(1),
      FVSV: Math.floor(rng(150, 800, ps + 10)),   // volt-minutes
      FCSV: Math.floor(rng(100, 600, ps + 11)),   // amp-minutes
      FMXV: +rng(103, 8, ps + 12).toFixed(1),    // % of nominal
      FMNV: +rng(87, 8, ps + 13).toFixed(1),
      FMXC: +rng(85, 30, ps + 14).toFixed(1),
      FMNC: +rng(15, 25, ps + 15).toFixed(1),
    };
  });
  // FLIF is a single RYB value (no per-phase breakdown per spec item q)
  const loadMax = Math.max(phases.R.FMXC, phases.Y.FMXC, phases.B.FMXC);
  const loadMin = Math.min(phases.R.FMNC, phases.Y.FMNC, phases.B.FMNC) || 1;
  const FLIF = +((loadMax / loadMin) * 100).toFixed(1);

  return { phases, FLIF };
}

// ─────────────────────────────────────────────────────────────
// Simulated operator availability (production: replace with api.operatorAvailability())
// ─────────────────────────────────────────────────────────────
const SAMPLE_OPERATORS = [
  { id: 1, name: 'Ravi Kumar',       role: 'SCADA Operator',    shift: 'morning',   status: 'on_duty',   zone: 'Haridwar' },
  { id: 2, name: 'Priya Sharma',     role: 'OMS Dispatcher',    shift: 'morning',   status: 'on_duty',   zone: 'Haridwar' },
  { id: 3, name: 'Anil Verma',       role: 'SCADA Operator',    shift: 'afternoon', status: 'standby',   zone: 'Rishikesh' },
  { id: 4, name: 'Sunita Rawat',     role: 'OMS Dispatcher',    shift: 'afternoon', status: 'on_duty',   zone: 'Rishikesh' },
  { id: 5, name: 'Deepak Singh',     role: 'Control Engineer',  shift: 'night',     status: 'on_duty',   zone: 'Dehradun' },
  { id: 6, name: 'Meena Bisht',      role: 'SCADA Operator',    shift: 'night',     status: 'on_leave',  zone: 'Dehradun' },
  { id: 7, name: 'Rajesh Negi',      role: 'Field Coordinator', shift: 'morning',   status: 'on_duty',   zone: 'Haridwar' },
  { id: 8, name: 'Kavita Pandey',    role: 'Field Coordinator', shift: 'afternoon', status: 'on_duty',   zone: 'Rishikesh' },
  { id: 9, name: 'Vikram Joshi',     role: 'Field Coordinator', shift: 'night',     status: 'standby',   zone: 'Dehradun' },
];

// Simulated SMS/escalation data
const SAMPLE_SMS = [
  { id: 1, ts: '10:42', feeder: 'MYP-01', recipient: 'Lineman B2 – Ram Lal', phone: '98765xxxxx', message: 'Fault on MYP-01 near pole 47. Attend immediately.', status: 'delivered', incidentId: 'INC-0041' },
  { id: 2, ts: '10:45', feeder: 'MYP-01', recipient: 'AE Haridwar – S. Rawat', phone: '97564xxxxx', message: 'OMS INC-0041: feeder MYP-01 tripped, 320 customers affected.', status: 'delivered', incidentId: 'INC-0041' },
  { id: 3, ts: '11:00', feeder: 'BWN-03', recipient: 'Lineman C1 – D. Kumar', phone: '96123xxxxx', message: 'Voltage sag alert: BWN-03. Investigate capacitor bank.', status: 'sent', incidentId: 'INC-0038' },
  { id: 4, ts: '11:22', feeder: 'MYP-01', recipient: 'SE Haridwar – A. Gupta', phone: '99001xxxxx', message: 'ESCALATION: INC-0041 unresolved >90 min. Restoration SLA breached.', status: 'delivered', incidentId: 'INC-0041', escalation: true },
];

const SAMPLE_ESCALATIONS = [
  { id: 1, incidentId: 'INC-0041', feeder: 'MYP-01', openedMin: 97, slaMin: 90, level: 'AE → SE', status: 'escalated', customers: 320 },
  { id: 2, incidentId: 'INC-0038', feeder: 'BWN-03', openedMin: 45, slaMin: 90, level: 'Lineman → AE', status: 'pending', customers: 140 },
  { id: 3, incidentId: 'INC-0035', feeder: 'LJW-02', openedMin: 155, slaMin: 90, level: 'SE → CE', status: 'escalated', customers: 510 },
];

// ─────────────────────────────────────────────────────────────
// KPI metadata registry
// ─────────────────────────────────────────────────────────────
const KPI_META = [
  { key: 'FVHI', label: 'Voltage High Incidents',  unit: 'Nos',           phases: true,  group: 'voltage_events' },
  { key: 'FVHD', label: 'Voltage High Duration',   unit: 'min',           phases: true,  group: 'voltage_events' },
  { key: 'FVLI', label: 'Voltage Low Incidents',   unit: 'Nos',           phases: true,  group: 'voltage_events' },
  { key: 'FVLD', label: 'Voltage Low Duration',    unit: 'min',           phases: true,  group: 'voltage_events' },
  { key: 'FCHI', label: 'Current High Incidents',  unit: 'Nos',           phases: true,  group: 'current_events' },
  { key: 'FCHD', label: 'Current High Duration',   unit: 'min',           phases: true,  group: 'current_events' },
  { key: 'FCLI', label: 'Current Low Incidents',   unit: 'Nos',           phases: true,  group: 'current_events' },
  { key: 'FCLD', label: 'Current Low Duration',    unit: 'min',           phases: true,  group: 'current_events' },
  { key: 'FVSM', label: 'Voltage Sag Magnitude',   unit: '% of nominal',  phases: true,  group: 'sag_stress' },
  { key: 'FCSM', label: 'Current Sag Magnitude',   unit: '% of nominal',  phases: true,  group: 'sag_stress' },
  { key: 'FVSV', label: 'Voltage Stress Value',    unit: 'V·min',         phases: true,  group: 'sag_stress' },
  { key: 'FCSV', label: 'Current Stress Value',    unit: 'A·min',         phases: true,  group: 'sag_stress' },
  { key: 'FMXV', label: 'Feeder Max Voltage',      unit: '% nominal',     phases: true,  group: 'extremes' },
  { key: 'FMNV', label: 'Feeder Min Voltage',      unit: '% nominal',     phases: true,  group: 'extremes' },
  { key: 'FMXC', label: 'Feeder Max Current',      unit: '% rated',       phases: true,  group: 'extremes' },
  { key: 'FMNC', label: 'Feeder Min Current',      unit: '% rated',       phases: true,  group: 'extremes' },
  { key: 'FLIF', label: 'Load Imbalance Factor',   unit: '% (RYB)',       phases: false, group: 'imbalance' },
];

const KPI_GROUPS = {
  voltage_events: { label: 'Voltage Events', color: '#3b82f6' },
  current_events: { label: 'Current Events', color: '#ef9021' },
  sag_stress:     { label: 'Sag & Stress',   color: '#8b5cf6' },
  extremes:       { label: 'Extremes',       color: '#0fb39d' },
  imbalance:      { label: 'Imbalance',      color: '#e23b2e' },
};

// Threshold for colour-coding
function kpiStatus(key, val) {
  if (key === 'FVHI' || key === 'FVLI') return val > 5 ? 'warn' : val > 2 ? 'med' : 'ok';
  if (key === 'FCHI' || key === 'FCLI') return val > 8 ? 'warn' : val > 4 ? 'med' : 'ok';
  if (key === 'FVHD' || key === 'FVLD' || key === 'FCHD' || key === 'FCLD') return val > 100 ? 'warn' : val > 50 ? 'med' : 'ok';
  if (key === 'FVSM' || key === 'FCSM') return val > 7 ? 'warn' : val > 4 ? 'med' : 'ok';
  if (key === 'FMXV') return val > 110 ? 'warn' : val > 106 ? 'med' : 'ok';
  if (key === 'FMNV') return val < 85 ? 'warn' : val < 90 ? 'med' : 'ok';
  if (key === 'FLIF') return val > 150 ? 'warn' : val > 120 ? 'med' : 'ok';
  return 'ok';
}

// ─────────────────────────────────────────────────────────────
// Small chart: Sparkbars
// ─────────────────────────────────────────────────────────────
function Sparkbars({ data }) {
  const max = Math.max(...data, 1);
  const W = 640, H = 180, pad = 28, bw = (W - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Monthly SAIDI trend">
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1={pad} x2={W - pad} y1={H - pad - (H - pad * 2) * g} y2={H - pad - (H - pad * 2) * g} stroke="var(--line-2)" strokeWidth={0.5} />
      ))}
      {data.map((v, i) => {
        const h = (H - pad * 2) * (v / max);
        const x = pad + i * bw + bw * 0.18, w = bw * 0.64, y = H - pad - h;
        const last = i === data.length - 1;
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx={3}
              fill={last ? '#3b82f6' : 'var(--faint)'}
              opacity={last ? 1 : 0.7}
            />
            <text x={x + w / 2} y={H - pad + 14} fontSize={9} textAnchor="middle" fill="var(--muted)">{MONTHS[i]}</text>
            {last && <text x={x + w / 2} y={y - 6} fontSize={10} textAnchor="middle" fill="#3b82f6" fontWeight="600">{v}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// Phase badge
// ─────────────────────────────────────────────────────────────
const PHASE_COLORS = { R: '#e23b2e', Y: '#d1a017', B: '#3b82f6', T: '#22b06b' };
function PhasePill({ ph }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 22, height: 22, borderRadius: 4, fontSize: 11, fontWeight: 700,
      background: PHASE_COLORS[ph] + '22', color: PHASE_COLORS[ph], border: `1px solid ${PHASE_COLORS[ph]}44`,
    }}>{ph}</span>
  );
}

// ─────────────────────────────────────────────────────────────
// Status dot
// ─────────────────────────────────────────────────────────────
function StatusDot({ s }) {
  const c = { on_duty: '#22b06b', standby: '#d1a017', on_leave: '#9fb0c4', off: '#9fb0c4' }[s] || '#9fb0c4';
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />;
}

// ─────────────────────────────────────────────────────────────
// KPI value cell with colour coding
// ─────────────────────────────────────────────────────────────
function KPICell({ kpiKey, value, unit }) {
  const st = kpiStatus(kpiKey, value);
  const c = { warn: '#e23b2e', med: '#ef9021', ok: 'var(--fg)' }[st];
  return (
    <td style={{ color: c, fontWeight: st !== 'ok' ? 600 : 400, fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
      {value}<span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 2 }}>{unit}</span>
    </td>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────
export default function Analytics() {
  const [ind, setInd] = useState(null);
  const [monthly, setMonthly] = useState([]);
  const [inc, setInc] = useState([]);
  const [mttr, setMttr] = useState([]);
  const [sla, setSla] = useState(null);
  const [crewProd, setCrewProd] = useState([]);
  const [outageFreq, setOutageFreq] = useState([]);
  const [drillZone, setDrillZone] = useState(null);

  // New state
  const [activeTab, setActiveTab] = useState('kpi');
  const [role, setRole] = useState('management');
  const [period, setPeriod] = useState('monthly');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [selectedFeeder, setSelectedFeeder] = useState('All feeders');
  const [activePhase, setActivePhase] = useState('T');
  const [activeKpiGroup, setActiveKpiGroup] = useState('voltage_events');
  const [smsLog] = useState(SAMPLE_SMS);
  const [escalations] = useState(SAMPLE_ESCALATIONS);
  const [operators] = useState(SAMPLE_OPERATORS);
  const [smsComposeOpen, setSmsComposeOpen] = useState(false);
  const [smsDraft, setSmsDraft] = useState({ recipient: '', message: '', feeder: '' });

  const load = () => {
    api.indicators().then(setInd);
    api.monthly().then((m) => setMonthly(m.saidi || []));
    api.incidents().then(setInc);
    api.mttr().then(setMttr);
    api.slaCompliance().then(setSla);
    api.crewProductivity().then(setCrewProd);
    api.outageFrequency().then(setOutageFreq);
  };
  useEffect(() => { load(); }, []);
  useLiveRefresh(['oms.indices.updated', 'oms.incident.updated', 'oms.incident.created'], load);

  const feeders = useMemo(() => {
    const map = {};
    for (const i of inc) {
      const k = i.feeder || 'Unknown';
      map[k] = map[k] || { feeder: k, zone: i.zone, count: 0, customers: 0, open: 0 };
      map[k].count++; map[k].customers += i.customers || 0;
      if (!['resolved', 'closed'].includes(i.status)) map[k].open++;
    }
    return Object.values(map).sort((a, b) => b.customers - a.customers);
  }, [inc]);

  const feederList = useMemo(() => ['All feeders', ...feeders.map(f => f.feeder)], [feeders]);

  const feederKPIs = useMemo(() => {
    return generateFeederKPIs(selectedFeeder === 'All feeders' ? '' : selectedFeeder, period);
  }, [selectedFeeder, period]);

  // SAIDI/SAIFI split
  const saidiPlanned = ind?.planned?.saidi ?? 0;
  const saifiPlanned = ind?.planned?.saifi ?? 0;
  const saidiUnplanned = ind?.saidi ?? 0;
  const saifiUnplanned = ind?.saifi ?? 0;
  const saidiTotal = +(saidiPlanned + saidiUnplanned).toFixed(2);
  const saifiTotal = +(saifiPlanned + saidiUnplanned / (ind?.caidi || 1)).toFixed(3);

  // Operator shift summary
  const shiftSummary = useMemo(() => SHIFTS.map(s => ({
    ...s,
    operators: operators.filter(o => o.shift === s.key),
    onDuty: operators.filter(o => o.shift === s.key && o.status === 'on_duty').length,
    standby: operators.filter(o => o.shift === s.key && o.status === 'standby').length,
    onLeave: operators.filter(o => o.shift === s.key && o.status === 'on_leave').length,
  })), [operators]);

  const sendSMS = useCallback((e) => {
    e.preventDefault();
    alert(`SMS dispatched to ${smsDraft.recipient} for feeder ${smsDraft.feeder || 'N/A'}.\n\n"${smsDraft.message}"\n\n(Integration: Twilio gateway — FR-OMS-021)`);
    setSmsComposeOpen(false);
    setSmsDraft({ recipient: '', message: '', feeder: '' });
  }, [smsDraft]);

  // Role-based visibility
  const showManagement = ['management', 'ce', 'functional'].includes(role);
  const showCE = ['ce', 'functional'].includes(role);
  const showFunctional = role === 'functional';

  const TABS = [
    { key: 'kpi',        label: 'Feeder KPIs (PFC)', show: true },
    { key: 'saidi',      label: 'SAIDI/SAIFI', show: true },
    { key: 'sms',        label: 'SMS & Escalation', show: true },
    { key: 'operators',  label: 'Operator Availability', show: true },
    { key: 'feeders',    label: 'Feeder breakdown', show: showCE || showFunctional },
    { key: 'mttr',       label: 'MTTR by zone', show: showManagement },
    { key: 'sla',        label: 'SLA compliance', show: showManagement },
    { key: 'crew',       label: 'Crew productivity', show: showCE || showFunctional },
    { key: 'freq',       label: 'Outage frequency', show: showManagement },
    { key: 'pfc',        label: 'Feeder PQ KPIs (PFC)', show: true },
  ].filter(t => t.show);

  // Make sure active tab is valid for current role
  useEffect(() => {
    if (!TABS.find(t => t.key === activeTab)) setActiveTab(TABS[0]?.key || 'kpi');
  }, [role]);

  return (
    <>
      {/* ── Page header ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>Reporting</div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Reliability &amp; Feeder Analytics</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
              IEEE 1366 · PFC feeder KPIs · RDSS — {ind?.customersServed?.toLocaleString() || '-'} customers served
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Role selector */}
            <div style={{ display: 'flex', gap: 2, background: 'var(--surface-2,#f0f2f6)', borderRadius: 8, padding: 2 }}>
              {ROLES.map(r => (
                <button key={r.key} onClick={() => setRole(r.key)} style={{
                  padding: '5px 12px', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: role === r.key ? '#0f2847' : 'transparent',
                  color: role === r.key ? '#fff' : 'var(--muted)',
                }}>{r.label}</button>
              ))}
            </div>
            <button className="btn" onClick={() => api.exportReliabilityReport('csv').catch(e => alert('Export failed: ' + e.message))}>Export CSV</button>
            <button className="btn" onClick={() => api.exportReliabilityReport('pdf').catch(e => alert('Export failed: ' + e.message))}>Export PDF</button>
          </div>
        </div>

        {/* Period selector */}
        <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={{
              padding: '4px 12px', border: `1.5px solid ${period === p.key ? '#3b82f6' : 'var(--line-2)'}`,
              borderRadius: 20, fontSize: 12, fontWeight: period === p.key ? 600 : 400,
              background: period === p.key ? '#3b82f620' : 'transparent',
              color: period === p.key ? '#3b82f6' : 'var(--fg)', cursor: 'pointer',
            }}>{p.label}</button>
          ))}
          {period === 'custom' && (
            <>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ padding: '3px 8px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 12 }} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ padding: '3px 8px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 12 }} />
            </>
          )}
        </div>
      </div>

      {/* ── Summary KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { k: 'SAIDI', v: ind?.saidi, u: 'min/cust', tgt: ind?.saidiTarget, hint: 'Unplanned only' },
          { k: 'SAIFI', v: ind?.saifi, u: 'int/cust', tgt: ind?.saifiTarget, hint: 'Unplanned only' },
          { k: 'CAIDI', v: ind?.caidi, u: 'min', tgt: null, hint: 'Avg restoration time' },
          { k: 'MAIFI', v: ind?.maifi, u: 'events', tgt: null, hint: 'Momentary (< 5 min)' },
        ].map(c => {
          const over = c.tgt != null && c.v > c.tgt;
          return (
            <div key={c.k} style={{
              background: 'var(--surface)', border: '1px solid var(--line-2)', borderRadius: 10, padding: '14px 16px',
              borderLeft: `3px solid ${over ? '#e23b2e' : '#3b82f6'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{c.k}</span>
                {c.tgt != null && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10,
                    background: over ? '#e23b2e22' : '#22b06b22', color: over ? '#e23b2e' : '#22b06b',
                  }}>{over ? 'OVER' : 'OK'}</span>
                )}
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                {c.v ?? '—'}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 3 }}>{c.u}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{c.hint}{c.tgt ? ` · target ${c.tgt}` : ''}</div>
            </div>
          );
        })}
      </div>

      {/* ── Tab strip ── */}
      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', borderBottom: '2px solid var(--line-2)', marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
            padding: '8px 14px', border: 'none', borderBottom: `2px solid ${activeTab === t.key ? '#3b82f6' : 'transparent'}`,
            marginBottom: -2, background: 'transparent', fontWeight: activeTab === t.key ? 700 : 400,
            fontSize: 13, cursor: 'pointer', color: activeTab === t.key ? '#3b82f6' : 'var(--fg)',
            borderRadius: '4px 4px 0 0',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          TAB: PFC Feeder KPIs
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'kpi' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Feeder selector */}
            <select value={selectedFeeder} onChange={e => setSelectedFeeder(e.target.value)}
              style={{ padding: '6px 12px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, background: 'var(--surface)' }}>
              {feederList.map(f => <option key={f}>{f}</option>)}
            </select>

            {/* Phase selector */}
            <div style={{ display: 'flex', gap: 4 }}>
              {PHASES.map(ph => (
                <button key={ph} onClick={() => setActivePhase(ph)} style={{
                  width: 32, height: 32, borderRadius: 6, border: `2px solid ${activePhase === ph ? PHASE_COLORS[ph] : 'var(--line-2)'}`,
                  background: activePhase === ph ? PHASE_COLORS[ph] + '22' : 'var(--surface)',
                  fontWeight: 700, fontSize: 12, cursor: 'pointer', color: activePhase === ph ? PHASE_COLORS[ph] : 'var(--muted)',
                }}>{ph}</button>
              ))}
            </div>

            {/* Group filter */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {Object.entries(KPI_GROUPS).map(([gk, gv]) => (
                <button key={gk} onClick={() => setActiveKpiGroup(gk)} style={{
                  padding: '4px 10px', borderRadius: 16, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${activeKpiGroup === gk ? gv.color : 'var(--line-2)'}`,
                  background: activeKpiGroup === gk ? gv.color + '18' : 'transparent',
                  color: activeKpiGroup === gk ? gv.color : 'var(--muted)',
                }}>{gv.label}</button>
              ))}
            </div>
          </div>

          {/* KPI cards for current phase + group */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
            {KPI_META.filter(k => k.group === activeKpiGroup).map(meta => {
              if (!meta.phases && meta.key === 'FLIF') {
                const st = kpiStatus('FLIF', feederKPIs.FLIF);
                const c = { warn: '#e23b2e', med: '#ef9021', ok: '#22b06b' }[st];
                return (
                  <div key={meta.key} style={{
                    background: 'var(--surface)', border: `1px solid ${c}44`, borderRadius: 10, padding: '14px 16px',
                    borderLeft: `3px solid ${c}`,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>FLIF · {meta.label}</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: c }}>
                      {feederKPIs.FLIF}<span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 3 }}>{meta.unit}</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>Phase RYB at given time</div>
                  </div>
                );
              }
              const val = feederKPIs.phases?.[activePhase]?.[meta.key];
              const st = kpiStatus(meta.key, val);
              const c = { warn: '#e23b2e', med: '#ef9021', ok: '#22b06b' }[st];
              const gc = KPI_GROUPS[meta.group]?.color || '#3b82f6';
              return (
                <div key={meta.key} style={{
                  background: 'var(--surface)', border: `1px solid var(--line-2)`, borderRadius: 10, padding: '14px 16px',
                  borderLeft: `3px solid ${gc}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: gc }}>{meta.key}_{activePhase}</span>
                    <PhasePill ph={activePhase} />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: c, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
                    {val ?? '—'}<span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 3 }}>{meta.unit}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{meta.label}</div>
                </div>
              );
            })}
          </div>

          {/* Full phase × KPI table */}
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', fontWeight: 700, fontSize: 14 }}>
              All phases — {KPI_GROUPS[activeKpiGroup]?.label} · {selectedFeeder}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)' }}>KPI</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)', color: 'var(--muted)' }}>Unit</th>
                    {PHASES.map(ph => (
                      <th key={ph} style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: 12, borderBottom: '1px solid var(--line-2)', color: PHASE_COLORS[ph] }}>
                        {ph === 'T' ? '∑ Total' : `Phase ${ph}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {KPI_META.filter(k => k.group === activeKpiGroup && k.phases).map((meta, ri) => (
                    <tr key={meta.key} style={{ background: ri % 2 === 0 ? 'transparent' : 'var(--surface-2, #f8fafc)' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 600, fontSize: 12 }}>
                        <span style={{ color: KPI_GROUPS[meta.group]?.color }}>{meta.key}</span>
                        <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>{meta.label}</span>
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--muted)', fontSize: 11 }}>{meta.unit}</td>
                      {PHASES.map(ph => (
                        <td key={ph} style={{ padding: '9px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {(() => {
                            const val = feederKPIs.phases?.[ph]?.[meta.key];
                            const st = kpiStatus(meta.key, val);
                            const c = { warn: '#e23b2e', med: '#ef9021', ok: 'var(--fg)' }[st];
                            return <span style={{ color: c, fontWeight: st !== 'ok' ? 700 : 400 }}>{val}</span>;
                          })()}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {activeKpiGroup === 'imbalance' && (
                    <tr>
                      <td style={{ padding: '9px 14px', fontWeight: 600, fontSize: 12 }}>
                        <span style={{ color: '#e23b2e' }}>FLIF</span>
                        <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>Load Imbalance Factor</span>
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--muted)', fontSize: 11 }}>% (RYB)</td>
                      <td colSpan={4} style={{ padding: '9px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: kpiStatus('FLIF', feederKPIs.FLIF) === 'warn' ? '#e23b2e' : 'var(--fg)' }}>
                        {feederKPIs.FLIF}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: SAIDI / SAIFI split
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'saidi' && (
        <div>
          {/* Three-column: Planned / Unplanned / Total */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
            {[
              { label: 'Planned',   saidi: saidiPlanned,   saifi: saifiPlanned,   color: '#0fb39d', badge: 'PLANNED' },
              { label: 'Unplanned', saidi: saidiUnplanned, saifi: saifiUnplanned, color: '#ef9021', badge: 'UNPLANNED' },
              { label: 'Total',     saidi: saidiTotal,     saifi: saifiTotal,     color: '#3b82f6', badge: 'TOTAL' },
            ].map(col => (
              <div key={col.label} style={{
                background: 'var(--surface)', border: `1px solid ${col.color}44`,
                borderRadius: 12, padding: '18px 20px', borderTop: `4px solid ${col.color}`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: col.color, letterSpacing: '0.06em', marginBottom: 12 }}>{col.badge}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {[['SAIDI', col.saidi, 'min/cust'], ['SAIFI', col.saifi, 'int/cust']].map(([k, v, u]) => (
                    <div key={k}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{k}</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: col.color, fontVariantNumeric: 'tabular-nums' }}>{v ?? '—'}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>{u}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
            <div className="card">
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>SAIDI trend — trailing 12 months</h3>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>min/customer</span>
              </div>
              <div style={{ padding: '12px 16px' }}>
                {monthly.length ? <Sparkbars data={monthly} /> : <div style={{ color: 'var(--muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>Loading…</div>}
              </div>
            </div>

            <div className="card">
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)' }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>Network impact</h3>
              </div>
              <div style={{ padding: '16px' }}>
                <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                  <div style={{ fontSize: 36, fontWeight: 800 }}>{(ind?.customersAffected || 0).toLocaleString()}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>customers currently interrupted</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>of {ind?.customersServed?.toLocaleString() || '-'} served</div>
                </div>
                <div style={{ height: 8, background: 'var(--faint)', borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
                  <div style={{
                    height: '100%', borderRadius: 4,
                    width: `${Math.min(100, ((ind?.customersAffected || 0) / (ind?.customersServed || 1)) * 100).toFixed(1)}%`,
                    background: '#e23b2e',
                  }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                  {(((ind?.customersAffected || 0) / (ind?.customersServed || 1)) * 100).toFixed(2)}% of network currently interrupted
                </div>
                <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div style={{ background: 'var(--surface-2, #f5f7fb)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>CAIDI</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{ind?.caidi ?? '—'}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>min avg duration</div>
                  </div>
                  <div style={{ background: 'var(--surface-2, #f5f7fb)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>MAIFI</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{ind?.maifi ?? '—'}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>momentary events</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: SMS & Escalation
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'sms' && (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* Escalation tracker */}
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Escalation tracker</h3>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Auto-escalate if SLA &gt; 90 min</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    {['Incident', 'Feeder', 'Open (min)', 'SLA (min)', 'Breach', 'Customers', 'Escalation level', 'Status'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {escalations.map((e, i) => {
                    const breached = e.openedMin > e.slaMin;
                    return (
                      <tr key={e.id} style={{ background: i % 2 ? 'var(--surface-2, #f8fafc)' : 'transparent', borderBottom: '1px solid var(--line-2)' }}>
                        <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12 }}>{e.incidentId}</td>
                        <td style={{ padding: '9px 14px', fontWeight: 600 }}>{e.feeder}</td>
                        <td style={{ padding: '9px 14px', fontVariantNumeric: 'tabular-nums', color: breached ? '#e23b2e' : 'var(--fg)', fontWeight: breached ? 700 : 400 }}>{e.openedMin}</td>
                        <td style={{ padding: '9px 14px', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{e.slaMin}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: breached ? '#e23b2e22' : '#22b06b22', color: breached ? '#e23b2e' : '#22b06b' }}>
                            {breached ? `+${e.openedMin - e.slaMin} min` : 'Within SLA'}
                          </span>
                        </td>
                        <td style={{ padding: '9px 14px', fontVariantNumeric: 'tabular-nums' }}>{e.customers.toLocaleString()}</td>
                        <td style={{ padding: '9px 14px', fontSize: 12 }}>{e.level}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                            background: e.status === 'escalated' ? '#ef902122' : '#3b82f622',
                            color: e.status === 'escalated' ? '#ef9021' : '#3b82f6' }}>
                            {e.status === 'escalated' ? '⬆ Escalated' : '⏳ Pending'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* SMS gateway */}
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 14 }}>SMS gateway — linemen &amp; officers</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>Via Twilio · FR-OMS-021 · WFM map indication on dispatch</p>
              </div>
              <button onClick={() => setSmsComposeOpen(!smsComposeOpen)}
                style={{ padding: '6px 14px', background: '#0f2847', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                + Compose SMS
              </button>
            </div>

            {smsComposeOpen && (
              <div style={{ padding: '16px', borderBottom: '1px solid var(--line-2)', background: '#3b82f608' }}>
                <form onSubmit={sendSMS} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr auto', gap: 10, alignItems: 'flex-end' }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-recipient">Recipient / Role</label>
                    <input id="sms-recipient" value={smsDraft.recipient} onChange={e => setSmsDraft(d => ({ ...d, recipient: e.target.value }))} placeholder="Lineman / AE / SE …"
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-feeder">Feeder</label>
                    <select id="sms-feeder" value={smsDraft.feeder} onChange={e => setSmsDraft(d => ({ ...d, feeder: e.target.value }))}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: 'var(--surface)' }}>
                      {feederList.map(f => <option key={f}>{f}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-message">Message</label>
                    <input id="sms-message" value={smsDraft.message} onChange={e => setSmsDraft(d => ({ ...d, message: e.target.value }))} placeholder="Alert text …"
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <button type="submit" style={{ padding: '8px 16px', background: '#22b06b', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Send
                  </button>
                </form>
                <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                  ↳ On dispatch, crew location will be indicated on the WFM map (INT-004/005).
                </p>
              </div>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    {['Time', 'Incident', 'Feeder', 'Recipient', 'Message preview', 'Status'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {smsLog.map((s, i) => (
                    <tr key={s.id} style={{ background: i % 2 ? 'var(--surface-2, #f8fafc)' : 'transparent', borderBottom: '1px solid var(--line-2)' }}>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)' }}>{s.ts}</td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12 }}>
                        {s.incidentId}
                        {s.escalation && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, background: '#ef902122', color: '#ef9021', borderRadius: 8, padding: '1px 5px' }}>ESCALATION</span>}
                      </td>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>{s.feeder}</td>
                      <td style={{ padding: '9px 14px', fontSize: 12 }}>{s.recipient}</td>
                      <td style={{ padding: '9px 14px', fontSize: 12, color: 'var(--muted)', maxWidth: 280 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.message}</span>
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                          background: s.status === 'delivered' ? '#22b06b22' : '#3b82f622',
                          color: s.status === 'delivered' ? '#22b06b' : '#3b82f6',
                        }}>{s.status === 'delivered' ? '✓ Delivered' : '→ Sent'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: Operator Availability (3-shift)
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'operators' && (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* Shift summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {shiftSummary.map(sh => (
              <div key={sh.key} style={{ background: 'var(--surface)', border: '1px solid var(--line-2)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{sh.label} shift</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{sh.time}</div>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>{sh.operators.length}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 10, background: '#22b06b22', color: '#22b06b', fontWeight: 600 }}>
                    {sh.onDuty} on duty
                  </span>
                  {sh.standby > 0 && (
                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 10, background: '#d1a01722', color: '#d1a017', fontWeight: 600 }}>
                      {sh.standby} standby
                    </span>
                  )}
                  {sh.onLeave > 0 && (
                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 10, background: 'var(--faint)', color: 'var(--muted)', fontWeight: 600 }}>
                      {sh.onLeave} leave
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Operator roster */}
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)' }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Operator roster</h3>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    {['', 'Name', 'Role', 'Shift', 'Shift time', 'Zone', 'Status'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {operators.map((op, i) => {
                    const sh = SHIFTS.find(s => s.key === op.shift);
                    const statusLabel = { on_duty: 'On duty', standby: 'Standby', on_leave: 'On leave', off: 'Off' }[op.status] || op.status;
                    const statusColor = { on_duty: '#22b06b', standby: '#d1a017', on_leave: 'var(--muted)', off: 'var(--muted)' }[op.status] || 'var(--muted)';
                    return (
                      <tr key={op.id} style={{ background: i % 2 ? 'var(--surface-2, #f8fafc)' : 'transparent', borderBottom: '1px solid var(--line-2)' }}>
                        <td style={{ padding: '9px 14px' }}><StatusDot s={op.status} /></td>
                        <td style={{ padding: '9px 14px', fontWeight: 600 }}>{op.name}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--muted)', fontSize: 12 }}>{op.role}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: 'var(--faint)' }}>{sh?.label}</span>
                        </td>
                        <td style={{ padding: '9px 14px', fontSize: 12, color: 'var(--muted)', fontFamily: 'monospace' }}>{sh?.time}</td>
                        <td style={{ padding: '9px 14px', fontSize: 12 }}>{op.zone}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: Feeder breakdown (CE / Functional only)
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'feeders' && (
        <div className="card">
          <div style={{ padding: '0 0 0 0', overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Feeder</th><th>Zone</th><th>Incidents</th><th>Open</th><th>Customers affected</th></tr></thead>
              <tbody>
                {feeders.map((f) => (
                  <tr key={f.feeder}>
                    <td className="mono">{f.feeder}</td>
                    <td>{f.zone}</td>
                    <td>{f.count}</td>
                    <td>{f.open ? <span className="chip chip-crit">{f.open}</span> : <span className="muted">0</span>}</td>
                    <td>{f.customers.toLocaleString()}</td>
                  </tr>
                ))}
                {!feeders.length && <tr><td colSpan={5} className="empty">No incident data.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: MTTR by zone
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'mttr' && (
        <div className="card">
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Zone</th><th>MTTR (min)</th><th>Incidents resolved</th></tr></thead>
              <tbody>
                {mttr.map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td>{z.zone}</td><td className="mono">{z.mttrMinutes}</td><td>{z.incidentCount}</td>
                  </tr>
                ))}
                {!mttr.length && <tr><td colSpan={3} className="empty">No resolved incidents yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: SLA compliance
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'sla' && (
        <div className="card">
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Zone</th><th>Compliant</th><th>Breached</th><th>At risk</th></tr></thead>
              <tbody>
                {(sla?.byZone || []).map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td>{z.zone}</td>
                    <td>{z.compliant}</td>
                    <td>{z.breached ? <span className="chip chip-crit">{z.breached}</span> : <span className="muted">0</span>}</td>
                    <td>{z.atRisk ? <span className="chip chip-crit">{z.atRisk}</span> : <span className="muted">0</span>}</td>
                  </tr>
                ))}
                {!sla?.byZone?.length && <tr><td colSpan={4} className="empty">No SLA data yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: Crew productivity (CE / Functional)
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'crew' && (
        <div className="card">
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Crew</th><th>Jobs total</th><th>Jobs completed</th><th>Avg min/job</th></tr></thead>
              <tbody>
                {crewProd.map((c) => (
                  <tr key={c.crewId}>
                    <td>{c.crewName}</td><td>{c.jobsTotal}</td><td>{c.jobsCompleted}</td>
                    <td className="mono">{c.avgMinutesPerJob ?? '—'}</td>
                  </tr>
                ))}
                {!crewProd.length && <tr><td colSpan={4} className="empty">No job data yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB: Outage frequency
      ══════════════════════════════════════════════════════ */}
      {activeTab === 'freq' && (
        <div className="card">
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Zone</th><th>Total</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th></tr></thead>
              <tbody>
                {outageFreq.map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td>{z.zone}</td><td>{z.total}</td>
                    <td>{z.critical || 0}</td><td>{z.high || 0}</td><td>{z.medium || 0}</td><td>{z.low || 0}</td>
                  </tr>
                ))}
                {!outageFreq.length && <tr><td colSpan={6} className="empty">No outage data yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {activeTab === 'pfc' && <FeederKpiPanel />} 

      {/* Drill-down panel (shared) */}
      {drillZone && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Incidents in {drillZone}</h3>
            <button className="btn sm" onClick={() => setDrillZone(null)}>Close</button>
          </div>
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>ID</th><th>Severity</th><th>Status</th><th>Cause</th><th>Customers</th></tr></thead>
              <tbody>
                {inc.filter((i) => i.zone === drillZone).map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td><td>{i.severity}</td>
                    <td>{i.status}</td><td>{i.cause}</td><td>{i.customers}</td>
                  </tr>
                ))}
                {!inc.filter((i) => i.zone === drillZone).length && <tr><td colSpan={5} className="empty">No incidents found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}