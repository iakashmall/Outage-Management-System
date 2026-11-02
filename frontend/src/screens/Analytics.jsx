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

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { api } from '../lib/api.js';
import { useLiveRefresh, toast, SrTable, RowButton, focusAfter } from '../lib/ui.jsx';
import FeederKpiPanel from '../components/FeederKpiPanel.jsx';
import StandardReports from '../components/StandardReports.jsx';
import ReportBuilder from '../components/ReportBuilder.jsx';
import { useT, tOr, locale, t as tr } from '../lib/i18n.js';
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
// SMS log status / kind display (FR-OMS-021). 'logged' = recorded but no SMS
// gateway is configured yet (SMS_DRIVER=console on the backend).
const SMS_STATUS = {
  sent: { label: '✓ Sent', color: '#177648' },
  logged: { label: '● Logged (no gateway)', color: '#0a5de4' },
  sending: { label: '→ Sending', color: '#0a5de4' },
  failed: { label: '✕ Failed', color: '#c4271b' },
};
const SMS_KIND = { feeder_manager: ['FEEDER MGR', '#b4235a'], escalation: ['ESCALATION', '#9a580b'], officer: ['OFFICER', '#6366f1'], callback: ['CALLBACK', '#0d9488'], customer: ['CUSTOMER', '#5e6d82'] };
const fmtMinutes = (m) => (m < 60 ? tr('an.fmtM', { m }) : m < 1440 ? tr('an.fmtHM', { h: Math.floor(m / 60), m: m % 60 }) : tr('an.fmtDH', { d: Math.floor(m / 1440), h: Math.floor((m % 1440) / 60) }));
const fmtTs = (ts) => new Date(ts).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const EMPTY_SMS = { recipient: '', phone: '', message: '', feeder: '', incidentId: '' };

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
  voltage_events: { label: 'Voltage Events', color: '#0a5de4' },
  current_events: { label: 'Current Events', color: '#9a580b' },
  sag_stress:     { label: 'Sag & Stress',   color: '#8b5cf6' },
  extremes:       { label: 'Extremes',       color: '#0fb39d' },
  imbalance:      { label: 'Imbalance',      color: '#c4271b' },
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
  const { t } = useT();
  const mon = (i) => t(`an.mon.${MONTHS[i]}`);
  const max = Math.max(...data, 1);
  const W = 640, H = 180, pad = 28, bw = (W - pad * 2) / data.length;
  return (
    <>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label={t('an.saidiTrendAria')}>
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
              fill={last ? '#0a5de4' : 'var(--faint)'}
              opacity={last ? 1 : 0.7}
            />
            <text x={x + w / 2} y={H - pad + 14} fontSize={9} textAnchor="middle" fill="var(--muted)">{mon(i)}</text>
            {last && <text x={x + w / 2} y={y - 6} fontSize={10} textAnchor="middle" fill="#0a5de4" fontWeight="600">{v}</text>}
          </g>
        );
      })}
    </svg>
    <SrTable caption={t('an.monthlySaidi')} head={[t('an.month'), 'SAIDI']} rows={data.map((v, i) => [mon(i), v])} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Phase badge
// ─────────────────────────────────────────────────────────────
const PHASE_COLORS = { R: '#c4271b', Y: '#83640e', B: '#0a5de4', T: '#177648' };
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
  const c = { on_duty: '#177648', standby: '#83640e', on_leave: '#9fb0c4', off: '#9fb0c4' }[s] || '#9fb0c4';
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />;
}

// ─────────────────────────────────────────────────────────────
// KPI value cell with colour coding
// ─────────────────────────────────────────────────────────────
function KPICell({ kpiKey, value, unit }) {
  const st = kpiStatus(kpiKey, value);
  const c = { warn: '#c4271b', med: '#9a580b', ok: 'var(--fg)' }[st];
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
  const { t } = useT();
  const kpiLabel = (k) => t(`an.kpi.${k}`);
  const unitLabel = (u) => tOr(`an.unit.${u}`, u);
  const feederLabel = (f) => (f === 'All feeders' ? t('an.allFeeders') : f);
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
  const viewStripRef = useRef(null);
  const openView = (k) => { setActiveTab(k); focusAfter(viewStripRef.current); };
  const [role, setRole] = useState('management');
  const [period, setPeriod] = useState('monthly');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [selectedFeeder, setSelectedFeeder] = useState('All feeders');
  const [activePhase, setActivePhase] = useState('T');
  const [activeKpiGroup, setActiveKpiGroup] = useState('voltage_events');
  const [smsLog, setSmsLog] = useState([]);
  const [smsDriver, setSmsDriver] = useState('');
  const [escalations, setEscalations] = useState([]);
  const [smsSending, setSmsSending] = useState(false);
  const [operators] = useState(SAMPLE_OPERATORS);
  const [smsComposeOpen, setSmsComposeOpen] = useState(false);
  const [smsDraft, setSmsDraft] = useState(EMPTY_SMS);

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

  const loadSms = useCallback(() => {
    api.smsLog().then((d) => { setSmsLog(d.rows); setSmsDriver(d.driver); }).catch(() => {});
    api.escalations().then(setEscalations).catch(() => {});
  }, []);
  useEffect(() => {
    if (activeTab !== 'sms') return undefined;
    loadSms();
    const t = setInterval(loadSms, 60000); // SLA clocks tick even without events
    return () => clearInterval(t);
  }, [activeTab, loadSms]);
  useLiveRefresh(['oms.sms.logged', 'oms.incident.created', 'oms.incident.updated'], () => { if (activeTab === 'sms') loadSms(); });

  const sendSMS = useCallback(async (e) => {
    e.preventDefault();
    setSmsSending(true);
    try {
      const feeder = smsDraft.feeder === 'All feeders' ? '' : smsDraft.feeder;
      const r = await api.sendSms({ ...smsDraft, feeder });
      toast(t(r.status === 'failed' ? 'an.toastFailed' : r.status === 'sent' ? 'an.toastSent' : 'an.toastLogged', { who: r.recipient }));
      setSmsComposeOpen(false);
      setSmsDraft(EMPTY_SMS);
      loadSms();
    } catch (err) {
      toast(err.message || t('an.toastErr'));
    } finally {
      setSmsSending(false);
    }
  }, [smsDraft, loadSms, t]);

  // Role-based visibility
  const showManagement = ['management', 'ce', 'functional'].includes(role);
  const showCE = ['ce', 'functional'].includes(role);
  const showFunctional = role === 'functional';

  const TABS = [
    { key: 'reports',    label: t('an.tab.reports'), show: true },
    { key: 'builder',    label: t('an.tab.builder'), show: true },
    { key: 'kpi',        label: t('an.tab.kpi'), show: true },
    { key: 'saidi',      label: t('an.tab.saidi'), show: true },
    { key: 'sms',        label: t('an.tab.sms'), show: true },
    { key: 'operators',  label: t('an.tab.operators'), show: true },
    { key: 'feeders',    label: t('an.tab.feeders'), show: showCE || showFunctional },
    { key: 'mttr',       label: t('an.tab.mttr'), show: showManagement },
    { key: 'sla',        label: t('an.tab.sla'), show: showManagement },
    { key: 'crew',       label: t('an.tab.crew'), show: showCE || showFunctional },
    { key: 'freq',       label: t('an.tab.freq'), show: showManagement },
    { key: 'pfc',        label: t('an.tab.pfc'), show: true },
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
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>{t('an.eyebrow')}</div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('an.title')}</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
              {t('an.subtitle', { n: ind?.customersServed?.toLocaleString(locale()) || '-' })}
              {ind && ind.customersServedAssumed !== false && (
                <span className="chip chip-soft" title={t('an.servedAssumedTip')} style={{ marginLeft: 8 }}>{t('an.servedAssumed')}</span>
              )}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Role selector */}
            <div role="group" aria-label={t('an.roleAria')} style={{ display: 'flex', gap: 2, background: 'var(--surface-2,#f0f2f6)', borderRadius: 8, padding: 2 }}>
              {ROLES.map(r => (
                <button key={r.key} aria-pressed={role === r.key} onClick={() => setRole(r.key)} style={{
                  padding: '5px 12px', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: role === r.key ? '#0f2847' : 'transparent',
                  color: role === r.key ? '#fff' : 'var(--muted)',
                }}>{t(`an.role.${r.key}`)}</button>
              ))}
            </div>
            <button className="btn" onClick={() => api.exportReliabilityReport('csv').catch(e => alert(t('an.exportFailed') + e.message))}>{t('an.exportCsv')}</button>
            <button className="btn" onClick={() => api.exportReliabilityReport('pdf').catch(e => alert(t('an.exportFailed') + e.message))}>{t('an.exportPdf')}</button>
          </div>
        </div>

        {/* Period selector */}
        <div role="group" aria-label={t('an.periodAria')} style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {PERIODS.map(p => (
            <button key={p.key} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)} style={{
              padding: '4px 12px', border: `1.5px solid ${period === p.key ? '#0a5de4' : 'var(--line-2)'}`,
              borderRadius: 20, fontSize: 12, fontWeight: period === p.key ? 600 : 400,
              background: period === p.key ? '#0a5de420' : 'transparent',
              color: period === p.key ? '#0a5de4' : 'var(--fg)', cursor: 'pointer',
            }}>{t(`an.period.${p.key}`)}</button>
          ))}
          {period === 'custom' && (
            <>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ padding: '3px 8px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 12 }} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('an.to')}</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ padding: '3px 8px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 12 }} />
            </>
          )}
        </div>
      </div>

      {/* ── Summary KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { k: 'SAIDI', v: ind?.saidi, u: t('an.minCust'), tgt: ind?.saidiTarget, hint: t('an.unplannedOnly') },
          { k: 'SAIFI', v: ind?.saifi, u: t('an.intCust'), tgt: ind?.saifiTarget, hint: t('an.unplannedOnly') },
          { k: 'CAIDI', v: ind?.caidi, u: t('an.min'), tgt: null, hint: t('an.avgRestore') },
          { k: 'MAIFI', v: ind?.maifi, u: t('an.events'), tgt: null, hint: t('an.momentary') },
        ].map(c => {
          const over = c.tgt != null && c.v > c.tgt;
          return (
            <div key={c.k} style={{
              background: 'var(--surface)', border: '1px solid var(--line-2)', borderRadius: 10, padding: '14px 16px',
              borderLeft: `3px solid ${over ? '#c4271b' : '#0a5de4'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{c.k}</span>
                {c.tgt != null && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10,
                    background: over ? '#c4271b22' : '#17764822', color: over ? '#c4271b' : '#177648',
                  }}>{over ? t('an.over') : t('an.ok')}</span>
                )}
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                {c.v ?? '—'}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 3 }}>{c.u}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{c.hint}{c.tgt ? ` · ${t('an.target')} ${c.tgt}` : ''}</div>
            </div>
          );
        })}
      </div>

      {/* ── Tab strip ── */}
      {/* Selection was shown by colour only; aria-pressed lets NVDA say which view is on (WCAG 1.3.1, 4.1.2). */}
      {/* Choosing a view moves focus into it (focusAfter), so Tab continues in the view, not along the strip. */}
      <div role="group" aria-label={t('an.viewAria')} ref={viewStripRef} style={{ display: 'flex', gap: 2, flexWrap: 'wrap', borderBottom: '2px solid var(--line-2)', marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.key} aria-pressed={activeTab === t.key} onClick={() => openView(t.key)} style={{
            padding: '8px 14px', border: 'none', borderBottom: `2px solid ${activeTab === t.key ? '#0a5de4' : 'transparent'}`,
            marginBottom: -2, background: 'transparent', fontWeight: activeTab === t.key ? 700 : 400,
            fontSize: 13, cursor: 'pointer', color: activeTab === t.key ? '#0a5de4' : 'var(--fg)',
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
            <select aria-label={t('col.feeder')} value={selectedFeeder} onChange={e => setSelectedFeeder(e.target.value)}
              style={{ padding: '6px 12px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, background: 'var(--surface)' }}>
              {feederList.map(f => <option key={f} value={f}>{feederLabel(f)}</option>)}
            </select>

            {/* Phase selector */}
            <div role="group" aria-label={t('an.phaseAria')} style={{ display: 'flex', gap: 4 }}>
              {PHASES.map(ph => (
                <button key={ph} aria-pressed={activePhase === ph} onClick={() => setActivePhase(ph)} style={{
                  width: 32, height: 32, borderRadius: 6, border: `2px solid ${activePhase === ph ? PHASE_COLORS[ph] : 'var(--line-2)'}`,
                  background: activePhase === ph ? PHASE_COLORS[ph] + '22' : 'var(--surface)',
                  fontWeight: 700, fontSize: 12, cursor: 'pointer', color: activePhase === ph ? PHASE_COLORS[ph] : 'var(--muted)',
                }}>{ph}</button>
              ))}
            </div>

            {/* Group filter */}
            <div role="group" aria-label={t('an.kpiGroupAria')} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {Object.entries(KPI_GROUPS).map(([gk, gv]) => (
                <button key={gk} aria-pressed={activeKpiGroup === gk} onClick={() => setActiveKpiGroup(gk)} style={{
                  padding: '4px 10px', borderRadius: 16, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${activeKpiGroup === gk ? gv.color : 'var(--line-2)'}`,
                  background: activeKpiGroup === gk ? gv.color + '18' : 'transparent',
                  color: activeKpiGroup === gk ? gv.color : 'var(--muted)',
                }}>{t(`an.grp.${gk}`)}</button>
              ))}
            </div>
          </div>

          {/* KPI cards for current phase + group */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
            {KPI_META.filter(k => k.group === activeKpiGroup).map(meta => {
              if (!meta.phases && meta.key === 'FLIF') {
                const st = kpiStatus('FLIF', feederKPIs.FLIF);
                const c = { warn: '#c4271b', med: '#9a580b', ok: '#177648' }[st];
                return (
                  <div key={meta.key} style={{
                    background: 'var(--surface)', border: `1px solid ${c}44`, borderRadius: 10, padding: '14px 16px',
                    borderLeft: `3px solid ${c}`,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>FLIF · {kpiLabel(meta.key)}</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: c }}>
                      {feederKPIs.FLIF}<span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 3 }}>{unitLabel(meta.unit)}</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>{t('an.flifHint')}</div>
                  </div>
                );
              }
              const val = feederKPIs.phases?.[activePhase]?.[meta.key];
              const st = kpiStatus(meta.key, val);
              const c = { warn: '#c4271b', med: '#9a580b', ok: '#177648' }[st];
              const gc = KPI_GROUPS[meta.group]?.color || '#0a5de4';
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
                    {val ?? '—'}<span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 3 }}>{unitLabel(meta.unit)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{kpiLabel(meta.key)}</div>
                </div>
              );
            })}
          </div>

          {/* Full phase × KPI table */}
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', fontWeight: 700, fontSize: 14 }}>
              {t('an.allPhases')} — {t(`an.grp.${activeKpiGroup}`)} · {feederLabel(selectedFeeder)}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)' }}>{t('an.kpiCol')}</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)', color: 'var(--muted)' }}>{t('an.unitCol')}</th>
                    {PHASES.map(ph => (
                      <th key={ph} style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: 12, borderBottom: '1px solid var(--line-2)', color: PHASE_COLORS[ph] }}>
                        {ph === 'T' ? `∑ ${t('an.total')}` : t('an.phaseN', { ph })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {KPI_META.filter(k => k.group === activeKpiGroup && k.phases).map((meta, ri) => (
                    <tr key={meta.key} style={{ background: ri % 2 === 0 ? 'transparent' : 'var(--surface-2, #f8fafc)' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 600, fontSize: 12 }}>
                        <span style={{ color: KPI_GROUPS[meta.group]?.color }}>{meta.key}</span>
                        <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>{kpiLabel(meta.key)}</span>
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--muted)', fontSize: 11 }}>{unitLabel(meta.unit)}</td>
                      {PHASES.map(ph => (
                        <td key={ph} style={{ padding: '9px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {(() => {
                            const val = feederKPIs.phases?.[ph]?.[meta.key];
                            const st = kpiStatus(meta.key, val);
                            const c = { warn: '#c4271b', med: '#9a580b', ok: 'var(--fg)' }[st];
                            return <span style={{ color: c, fontWeight: st !== 'ok' ? 700 : 400 }}>{val}</span>;
                          })()}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {activeKpiGroup === 'imbalance' && (
                    <tr>
                      <td style={{ padding: '9px 14px', fontWeight: 600, fontSize: 12 }}>
                        <span style={{ color: '#c4271b' }}>FLIF</span>
                        <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>{kpiLabel('FLIF')}</span>
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--muted)', fontSize: 11 }}>{unitLabel('% (RYB)')}</td>
                      <td colSpan={4} style={{ padding: '9px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: kpiStatus('FLIF', feederKPIs.FLIF) === 'warn' ? '#c4271b' : 'var(--fg)' }}>
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
              { label: 'Planned',   saidi: saidiPlanned,   saifi: saifiPlanned,   color: '#0fb39d', badge: t('an.planned') },
              { label: 'Unplanned', saidi: saidiUnplanned, saifi: saifiUnplanned, color: '#9a580b', badge: t('an.unplanned') },
              { label: 'Total',     saidi: saidiTotal,     saifi: saifiTotal,     color: '#0a5de4', badge: t('an.totalBadge') },
            ].map(col => (
              <div key={col.label} style={{
                background: 'var(--surface)', border: `1px solid ${col.color}44`,
                borderRadius: 12, padding: '18px 20px', borderTop: `4px solid ${col.color}`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: col.color, letterSpacing: '0.06em', marginBottom: 12 }}>{col.badge}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {[['SAIDI', col.saidi, t('an.minCust')], ['SAIFI', col.saifi, t('an.intCust')]].map(([k, v, u]) => (
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
                <h3 style={{ margin: 0, fontSize: 14 }}>{t('an.saidiTrend')}</h3>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('an.minCustomer')}</span>
              </div>
              <div style={{ padding: '12px 16px' }}>
                {monthly.length ? <Sparkbars data={monthly} /> : <div style={{ color: 'var(--muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>{t('an.loading')}</div>}
              </div>
            </div>

            <div className="card">
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)' }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>{t('an.networkImpact')}</h3>
              </div>
              <div style={{ padding: '16px' }}>
                <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                  <div style={{ fontSize: 36, fontWeight: 800 }}>{(ind?.customersAffected || 0).toLocaleString(locale())}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>{t('an.custInterrupted')}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{t('an.ofServed', { n: ind?.customersServed?.toLocaleString(locale()) || '-' })}{ind && ind.customersServedAssumed !== false ? ` (${t('an.servedAssumed')})` : ''}</div>
                </div>
                <div style={{ height: 8, background: 'var(--faint)', borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
                  <div style={{
                    height: '100%', borderRadius: 4,
                    width: `${Math.min(100, ((ind?.customersAffected || 0) / (ind?.customersServed || 1)) * 100).toFixed(1)}%`,
                    background: '#c4271b',
                  }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                  {t('an.pctInterrupted', { p: (((ind?.customersAffected || 0) / (ind?.customersServed || 1)) * 100).toFixed(2) })}
                </div>
                <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div style={{ background: 'var(--surface-2, #f5f7fb)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>CAIDI</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{ind?.caidi ?? '—'}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>{t('an.minAvgDur')}</div>
                  </div>
                  <div style={{ background: 'var(--surface-2, #f5f7fb)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>MAIFI</div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{ind?.maifi ?? '—'}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>{t('an.momentaryEvents')}</div>
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
          {/* Escalation tracker (live: active incidents with an SLA clock) */}
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>{t('an.escTracker')}</h3>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('an.escLadder')}</span>
            </div>
            {/* Scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1). */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <div tabIndex={0} role="region" aria-label={t('an.escTracker')} style={{ overflowX: 'auto', maxHeight: 360 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    {[t('an.h.incident'), t('col.feeder'), t('an.h.open'), 'SLA', t('an.h.breach'), t('col.customers'), t('an.h.escLevel'), t('col.status')].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {escalations.length === 0 && <tr><td colSpan={8} style={{ padding: '16px 14px', color: 'var(--muted)', fontSize: 13 }}>{t('an.noEsc')}</td></tr>}
                  {escalations.map((e, i) => {
                    const breached = e.overMin > 0;
                    const st = { escalated: [`⬆ ${t('an.esc.escalated')}`, '#9a580b'], due: [`⚠ ${t('an.esc.due')}`, '#c4271b'], pending: [`⏳ ${t('an.withinSla')}`, '#0a5de4'] }[e.status];
                    return (
                      <tr key={e.incidentId} style={{ background: i % 2 ? 'var(--surface-2, #f8fafc)' : 'transparent', borderBottom: '1px solid var(--line-2)' }}>
                        <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12 }}>{e.incidentId}</td>
                        <td style={{ padding: '9px 14px', fontWeight: 600 }}>{e.feeder}</td>
                        <td style={{ padding: '9px 14px', fontVariantNumeric: 'tabular-nums', color: breached ? '#c4271b' : 'var(--fg)', fontWeight: breached ? 700 : 400, whiteSpace: 'nowrap' }}>{fmtMinutes(e.openedMin)}</td>
                        <td style={{ padding: '9px 14px', fontVariantNumeric: 'tabular-nums', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtMinutes(e.slaMin)}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: breached ? '#c4271b22' : '#17764822', color: breached ? '#c4271b' : '#177648', whiteSpace: 'nowrap' }}>{breached ? `+${fmtMinutes(e.overMin)}` : t('an.withinSla')}</span>
                        </td>
                        <td style={{ padding: '9px 14px', fontVariantNumeric: 'tabular-nums' }}>{e.customers.toLocaleString(locale())}</td>
                        <td style={{ padding: '9px 14px', fontSize: 12 }}>{e.level}</td>
                        <td style={{ padding: '9px 14px' }}><span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: `${st[1]}22`, color: st[1], whiteSpace: 'nowrap' }}>{st[0]}</span></td>
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
                <h3 style={{ margin: 0, fontSize: 14 }}>{t('an.smsTitle')}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                  FR-OMS-021 · {t('an.gateway')}: {smsDriver === 'console' ? t('an.noGateway') : smsDriver || '…'}
                </p>
              </div>
              <button onClick={() => setSmsComposeOpen(!smsComposeOpen)}
                style={{ padding: '6px 14px', background: '#0f2847', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                + {t('an.compose')}
              </button>
            </div>

            {smsComposeOpen && (
              <div style={{ padding: '16px', borderBottom: '1px solid var(--line-2)', background: '#0a5de408' }}>
                <form onSubmit={sendSMS} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, alignItems: 'flex-end' }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-recipient">{t('an.f.recipient')} *</label>
                    <input id="sms-recipient" required maxLength={80} value={smsDraft.recipient} onChange={e => setSmsDraft(d => ({ ...d, recipient: e.target.value }))} placeholder={t('an.ph.recipient')}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-phone">{t('an.f.phone')} *</label>
                    <input id="sms-phone" required type="tel" inputMode="tel" autoComplete="off" value={smsDraft.phone} onChange={e => setSmsDraft(d => ({ ...d, phone: e.target.value }))} placeholder="+91 98xxxxxxxx"
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-feeder">{t('col.feeder')}</label>
                    <select id="sms-feeder" value={smsDraft.feeder} onChange={e => setSmsDraft(d => ({ ...d, feeder: e.target.value }))}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: 'var(--surface)' }}>
                      {feederList.map(f => <option key={f} value={f}>{feederLabel(f)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-incident">{t('an.f.incident')}</label>
                    <input id="sms-incident" value={smsDraft.incidentId} onChange={e => setSmsDraft(d => ({ ...d, incidentId: e.target.value }))} placeholder="INC-2026-…"
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }} htmlFor="sms-message">{t('an.f.message')}</label>
                    <input id="sms-message" required minLength={3} maxLength={500} value={smsDraft.message} onChange={e => setSmsDraft(d => ({ ...d, message: e.target.value }))} placeholder={t('an.ph.message')}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line-2)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <button type="submit" disabled={smsSending} style={{ padding: '8px 16px', background: '#177648', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: smsSending ? 'wait' : 'pointer', whiteSpace: 'nowrap', justifySelf: 'start' }}>
                    {smsSending ? t('an.sending') : t('an.send')}
                  </button>
                </form>
                <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                  ↳ {t('an.linkedNote')}
                </p>
              </div>
            )}

            {/* Scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1). */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <div tabIndex={0} role="region" aria-label={t('an.smsLog')} style={{ overflowX: 'auto', maxHeight: 420 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    {[t('an.h.time'), t('an.h.incident'), t('col.feeder'), t('an.h.recipient'), t('an.h.message'), t('col.status')].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {smsLog.length === 0 && <tr><td colSpan={6} style={{ padding: '16px 14px', color: 'var(--muted)', fontSize: 13 }}>{t('an.noSms')}</td></tr>}
                  {smsLog.map((s, i) => {
                    const st = SMS_STATUS[s.status] ? { ...SMS_STATUS[s.status], label: t(`an.sms.${s.status}`) } : { label: `– ${s.status.replace(/^skipped-/, `${t('an.skipped')}: `).replace(/-/g, ' ')}`, color: '#5e6d82' };
                    const kindKey = SMS_KIND[s.kind] ? s.kind : 'customer';
                    const [, kindColor] = SMS_KIND[kindKey];
                    const kind = t(`an.kind.${kindKey}`);
                    return (
                      <tr key={s.id} style={{ background: i % 2 ? 'var(--surface-2, #f8fafc)' : 'transparent', borderBottom: '1px solid var(--line-2)' }}>
                        <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtTs(s.ts)}</td>
                        <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {s.incident_id || '—'}
                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, background: `${kindColor}22`, color: kindColor, borderRadius: 8, padding: '1px 5px' }}>{kind}</span>
                        </td>
                        <td style={{ padding: '9px 14px', fontWeight: 600 }}>{s.feeder || '—'}</td>
                        <td style={{ padding: '9px 14px', fontSize: 12 }}>{s.recipient || '—'}</td>
                        <td style={{ padding: '9px 14px', fontSize: 12, color: 'var(--muted)', maxWidth: 320 }}>
                          <span title={s.body} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.body}</span>
                        </td>
                        <td style={{ padding: '9px 14px' }} title={s.error || undefined}><span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: `${st.color}22`, color: st.color, whiteSpace: 'nowrap' }}>{st.label}</span></td>
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
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{t('an.shiftN', { s: t(`an.shift.${sh.key}`) })}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{sh.time}</div>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>{sh.operators.length}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 10, background: '#17764822', color: '#177648', fontWeight: 600 }}>
                    {t('an.nOnDuty', { n: sh.onDuty })}
                  </span>
                  {sh.standby > 0 && (
                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 10, background: '#83640e22', color: '#83640e', fontWeight: 600 }}>
                      {t('an.nStandby', { n: sh.standby })}
                    </span>
                  )}
                  {sh.onLeave > 0 && (
                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 10, background: 'var(--faint)', color: 'var(--muted)', fontWeight: 600 }}>
                      {t('an.nLeave', { n: sh.onLeave })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Operator roster */}
          <div className="card">
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)' }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>{t('an.roster')}</h3>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f5f7fb)' }}>
                    {['', t('an.h.name'), t('an.h.role'), t('an.h.shift'), t('an.h.shiftTime'), t('col.zone'), t('col.status')].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line-2)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {operators.map((op, i) => {
                    const sh = SHIFTS.find(s => s.key === op.shift);
                    const statusLabel = tOr(`an.op.${op.status}`, op.status);
                    const statusColor = { on_duty: '#177648', standby: '#83640e', on_leave: 'var(--muted)', off: 'var(--muted)' }[op.status] || 'var(--muted)';
                    return (
                      <tr key={op.id} style={{ background: i % 2 ? 'var(--surface-2, #f8fafc)' : 'transparent', borderBottom: '1px solid var(--line-2)' }}>
                        <td style={{ padding: '9px 14px' }}><StatusDot s={op.status} /></td>
                        <td style={{ padding: '9px 14px', fontWeight: 600 }}>{op.name}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--muted)', fontSize: 12 }}>{tOr(`an.oprole.${op.role}`, op.role)}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: 'var(--faint)' }}>{sh && t(`an.shift.${sh.key}`)}</span>
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
              <thead><tr><th>{t('col.feeder')}</th><th>{t('col.zone')}</th><th>{t('an.h.incidents')}</th><th>{t('an.h.open')}</th><th>{t('an.h.custAffected')}</th></tr></thead>
              <tbody>
                {feeders.map((f) => (
                  <tr key={f.feeder}>
                    <td className="mono">{f.feeder}</td>
                    <td>{f.zone}</td>
                    <td>{f.count}</td>
                    <td>{f.open ? <span className="chip chip-crit">{f.open}</span> : <span className="muted">0</span>}</td>
                    <td>{f.customers.toLocaleString(locale())}</td>
                  </tr>
                ))}
                {!feeders.length && <tr><td colSpan={5} className="empty">{t('an.noIncData')}</td></tr>}
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
              <thead><tr><th>{t('col.zone')}</th><th>{t('an.h.mttrMin')}</th><th>{t('an.h.resolved')}</th></tr></thead>
              <tbody>
                {mttr.map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td><RowButton label={t('an.drill', { z: z.zone })} aria-expanded={drillZone === z.zone} onActivate={() => setDrillZone(drillZone === z.zone ? null : z.zone)}>{z.zone}</RowButton></td><td className="mono">{z.mttrMinutes}</td><td>{z.incidentCount}</td>
                  </tr>
                ))}
                {!mttr.length && <tr><td colSpan={3} className="empty">{t('an.noResolved')}</td></tr>}
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
              <thead><tr><th>{t('col.zone')}</th><th>{t('an.h.compliant')}</th><th>{t('an.h.breached')}</th><th>{t('an.h.atRisk')}</th></tr></thead>
              <tbody>
                {(sla?.byZone || []).map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td><RowButton label={t('an.drill', { z: z.zone })} aria-expanded={drillZone === z.zone} onActivate={() => setDrillZone(drillZone === z.zone ? null : z.zone)}>{z.zone}</RowButton></td>
                    <td>{z.compliant}</td>
                    <td>{z.breached ? <span className="chip chip-crit">{z.breached}</span> : <span className="muted">0</span>}</td>
                    <td>{z.atRisk ? <span className="chip chip-crit">{z.atRisk}</span> : <span className="muted">0</span>}</td>
                  </tr>
                ))}
                {!sla?.byZone?.length && <tr><td colSpan={4} className="empty">{t('an.noSla')}</td></tr>}
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
              <thead><tr><th>{t('an.h.crew')}</th><th>{t('an.h.jobsTotal')}</th><th>{t('an.h.jobsDone')}</th><th>{t('an.h.avgMinJob')}</th></tr></thead>
              <tbody>
                {crewProd.map((c) => (
                  <tr key={c.crewId}>
                    <td>{c.crewName}</td><td>{c.jobsTotal}</td><td>{c.jobsCompleted}</td>
                    <td className="mono">{c.avgMinutesPerJob ?? '—'}</td>
                  </tr>
                ))}
                {!crewProd.length && <tr><td colSpan={4} className="empty">{t('an.noJobs')}</td></tr>}
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
              <thead><tr><th>{t('col.zone')}</th><th>{t('an.total')}</th><th>{t('sev.critical')}</th><th>{t('sev.high')}</th><th>{t('sev.medium')}</th><th>{t('sev.low')}</th></tr></thead>
              <tbody>
                {outageFreq.map((z) => (
                  <tr key={z.zone} onClick={() => setDrillZone(drillZone === z.zone ? null : z.zone)} style={{ cursor: 'pointer' }}>
                    <td><RowButton label={t('an.drill', { z: z.zone })} aria-expanded={drillZone === z.zone} onActivate={() => setDrillZone(drillZone === z.zone ? null : z.zone)}>{z.zone}</RowButton></td><td>{z.total}</td>
                    <td>{z.critical || 0}</td><td>{z.high || 0}</td><td>{z.medium || 0}</td><td>{z.low || 0}</td>
                  </tr>
                ))}
                {!outageFreq.length && <tr><td colSpan={6} className="empty">{t('an.noOutage')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {activeTab === 'reports' && <StandardReports />}
      {activeTab === 'builder' && <ReportBuilder />}
      {activeTab === 'pfc' && <FeederKpiPanel />} 

      {/* Drill-down panel (shared) */}
      {drillZone && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>{t('an.incidentsIn', { z: drillZone })}</h3>
            <button className="btn sm" onClick={() => setDrillZone(null)}>{t('an.close')}</button>
          </div>
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>{t('col.id')}</th><th>{t('col.severity')}</th><th>{t('col.status')}</th><th>{t('an.h.cause')}</th><th>{t('col.customers')}</th></tr></thead>
              <tbody>
                {inc.filter((i) => i.zone === drillZone).map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td><td>{tOr(`sev.${i.severity}`, i.severity)}</td>
                    <td>{tOr(`st.${i.status}`, i.status)}</td><td>{i.cause}</td><td>{i.customers}</td>
                  </tr>
                ))}
                {!inc.filter((i) => i.zone === drillZone).length && <tr><td colSpan={5} className="empty">{t('an.noIncidents')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}