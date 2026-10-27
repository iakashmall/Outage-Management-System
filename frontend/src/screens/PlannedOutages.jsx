// OMS-01 Planned outages: schedule the outage, build and approve the
// switching plan, notify customers, operate control-room steps, issue and
// track work permits, and read the safety log. Every rule is enforced by the
// server (domain/plannedOutage.js); this screen shows what it allows and
// passes on its refusals verbatim. See docs/OMS-01-DESIGN.md.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { plannedApi } from '../lib/plannedApi.js';
import { StatusBadge, hhmm, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';
import { useT, t, tOr, locale } from '../lib/i18n.js';

const TOPICS = ['oms.planned.updated', 'oms.planned.crew_report', 'oms.permit.changed', 'oms.switching.confirmed', 'oms.switching.rejected', 'oms.incident.updated', 'crew.job.updated'];
const ACTION_TEXT = {
  open: 'OPEN', close: 'CLOSE', rack_out: 'Rack out', rack_in: 'Rack in', test_dead: 'Test dead',
  earth_apply: 'Apply earth', earth_remove: 'Remove earth', tag_apply: 'Apply danger tag', tag_remove: 'Remove danger tag',
};
const ACTIONS = Object.keys(ACTION_TEXT);
const when = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13 };
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fail = (e) => toast(e.code ? `${e.message} (${e.code})` : e.message, 'err', 9000);
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
// Crew job priority used by the crew app when an outage of this priority is assigned.
const JOB_PRIORITY = { critical: 'Urgent', high: 'Urgent', medium: 'Normal', low: 'Normal' };
// F12: another planned outage overlaps in time at the same substation or
// feeder. Only a warning: the operator decides which takes priority.
const warnOverlaps = (ids) => {
  if (ids?.length) toast(t(ids.length > 1 ? 'po.overlapWarnN' : 'po.overlapWarn1', { n: ids.length }), 'err', 12000);
};
const scopeText = (o) => (o.deenergisation === 'partial' ? t('po.scopePartial', { s: o.affected_section || t('po.sectionNotNamed') })
  : o.deenergisation === 'complete' ? t('po.scopeComplete') : t('po.notRecorded'));

export default function PlannedOutages() {
  useT();
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const [crews, setCrews] = useState([]);

  const load = () => plannedApi.list().then(setList).catch(fail);
  useEffect(() => { load(); api.crews().then(setCrews).catch(() => {}); }, []);
  useLiveRefresh(TOPICS, load);

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
      <div className="card">
        <div className="card-h">
          <h3>{t('po.title')}</h3>
          <button className="btn sm primary" onClick={() => { setCreating(true); setSel(null); }}>{t('po.new')}</button>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 8 }}>
          {!list.length && <div className="empty"><span className="disp">{t('po.noneScheduled')}</span>{t('po.createWithNew')}</div>}
          {list.map((p) => (
            <button key={p.id} onClick={() => { setSel(p.id); setCreating(false); }}
              style={{ textAlign: 'left', border: `1px solid ${sel === p.id ? 'var(--navy)' : 'var(--line)'}`, borderRadius: 9, padding: 10, background: 'var(--surface)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <b>{p.zone}</b><span style={{ display: 'inline-flex', gap: 4 }}>{p.severity && p.severity !== 'low' && <span className={`badge-sev sev-${p.severity}`}>{t(`sev.${p.severity}`)}</span>}<StatusBadge status={p.status} /></span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{when(p.window_start)} - {hhmm(p.window_end)}</div>
              <div style={{ fontSize: 12, marginTop: 3 }}>
                {t('po.planSteps', { state: tOr(`po.plan.${p.plan_state}`, p.plan_state), done: p.steps_confirmed, total: p.step_count })}
                {p.open_permits > 0 && <span style={{ color: 'var(--crit)', fontWeight: 600 }}>{t('po.permitOpen', { n: p.open_permits })}</span>}
                {p.pending_delay_reports > 0 && <span style={{ color: 'var(--crit)', fontWeight: 700 }}> · {t('po.delayReported')}</span>}
                {p.complaint_count > 0 && <span style={{ color: p.complaints_after_window > 0 ? 'var(--crit)' : undefined }}>{t(p.complaint_count > 1 ? 'po.complaintN' : 'po.complaint1', { n: p.complaint_count })}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
      {creating && <NewPlannedOutage onCancel={() => setCreating(false)} onCreated={(o) => { setCreating(false); load(); setSel(o.id); }} />}
      {sel && !creating && <OutageDetail key={sel} id={sel} crews={crews} onChanged={load} list={list} onSelect={setSel} />}
      {!sel && !creating && <div className="card"><div className="card-b empty"><span className="disp">{t('po.selectOutage')}</span>{t('po.selectHint')}</div></div>}
    </div>
  );
}

function NewPlannedOutage({ onCancel, onCreated }) {
  useT();
  const start = new Date(Date.now() + 2 * 86400e3); start.setMinutes(0, 0, 0);
  const [f, setF] = useState({
    zone: '', substation: '', feeder: '', customers: 100, workDescription: '', workMrid: '',
    windowStart: toLocalInput(start), windowEnd: toLocalInput(new Date(start.getTime() + 4 * 3600e3)), noticeHours: 24,
    severity: 'low', deenergisation: 'complete', affectedSection: '',
  });
  const [busy, setBusy] = useState(false);
  const [areas, setAreas] = useState([]);
  useEffect(() => { plannedApi.areas().then(setAreas).catch(fail); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const feeders = areas.find((a) => a.value === f.substation)?.feeders || [];
  const submit = async () => {
    setBusy(true);
    try {
      const out = await plannedApi.create({
        zone: f.zone, substation: f.substation || null, feeder: f.feeder || null, customers: Number(f.customers) || 0,
        workDescription: f.workDescription, workMrid: f.workMrid || null,
        windowStart: new Date(f.windowStart).toISOString(), windowEnd: new Date(f.windowEnd).toISOString(),
        noticeLeadMinutes: Math.round(Number(f.noticeHours) * 60),
        severity: f.severity, deenergisation: f.deenergisation,
        affectedSection: f.deenergisation === 'partial' ? f.affectedSection : null,
      });
      toast(t('po.scheduled', { id: out.outage.incident.id }));
      warnOverlaps(out.overlaps);
      onCreated(out.outage);
    } catch (e) { fail(e); setBusy(false); }
  };
  const field = (label, node) => <label style={{ display: 'block' }}><div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>{node}</label>;
  return (
    <div className="card">
      <div className="card-h"><h3>{t('po.newTitle')}</h3></div>
      <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {field(t('po.fZone'), <input style={inp} value={f.zone} onChange={set('zone')} placeholder={t('po.fZonePh')} />)}
        {field(t('po.fSubstation'), (
          <select style={inp} value={f.substation} onChange={(e) => setF({ ...f, substation: e.target.value, feeder: '' })}>
            <option value="">{t('po.notSet')}</option>
            {areas.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        ))}
        {field(t('po.fFeeder'), (
          <select style={inp} value={f.feeder} onChange={set('feeder')} disabled={!f.substation}>
            <option value="">{t('po.wholeSubstation')}</option>
            {feeders.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        ))}
        {field(t('po.fCustomers'), <input style={inp} type="number" value={f.customers} onChange={set('customers')} />)}
        {field(t('po.fOffFrom'), <input style={inp} type="datetime-local" value={f.windowStart} onChange={set('windowStart')} />)}
        {field(t('po.fBackBy'), <input style={inp} type="datetime-local" value={f.windowEnd} onChange={set('windowEnd')} />)}
        <div style={{ gridColumn: '1 / -1' }}>{field(t('po.fWork'), <input style={inp} value={f.workDescription} onChange={set('workDescription')} placeholder={t('po.fWorkPh')} />)}</div>
        {field(t('po.fMrid'), <input style={inp} value={f.workMrid} onChange={set('workMrid')} />)}
        {field(t('po.fNotice'), <input style={inp} type="number" min="0" value={f.noticeHours} onChange={set('noticeHours')} />)}
        {field(t('po.fPriority'), <select style={inp} value={f.severity} onChange={set('severity')}>{PRIORITIES.map((p) => <option key={p} value={p}>{t(`sev.${p}`)}</option>)}</select>)}
        {field(t('po.fDeenergisation'), (
          <select style={inp} value={f.deenergisation} onChange={set('deenergisation')}>
            <option value="complete">{t('po.optComplete')}</option>
            <option value="partial">{t('po.optPartial')}</option>
          </select>
        ))}
        {f.deenergisation === 'partial' && <div style={{ gridColumn: '1 / -1' }}>{field(t('po.fSection'), <input style={inp} value={f.affectedSection} onChange={set('affectedSection')} placeholder={t('po.fSectionPh')} />)}</div>}
        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>{t('po.windowRule')}</div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? t('po.scheduling') : t('po.schedule')}</button>
          <button className="btn" onClick={onCancel}>{t('po.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

function OutageDetail({ id, crews, onChanged, list = [], onSelect }) {
  useT();
  const [o, setO] = useState(null);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState('plan');
  const load = () => Promise.all([plannedApi.get(id), plannedApi.safetyLog(id)]).then(([x, l]) => { setO(x); setLog(l); }).catch(fail);
  useEffect(() => { load(); }, [id]); // eslint-disable-line
  useLiveRefresh(TOPICS, load);
  if (!o) return <div className="card"><div className="card-b">{t('po.loading')}</div></div>;

  const inc = o.incident;
  const anyConfirmed = o.steps.some((s) => s.state === 'confirmed');
  // Every action reloads from the server afterwards: the screen never
  // assumes an action worked.
  const act = async (fn, ok) => {
    try { await fn(); if (ok) toast(ok); } catch (e) { fail(e); }
    load(); onChanged();
  };
  const ask = (q) => { const v = window.prompt(q); return v && v.trim() ? v.trim() : null; };

  return (
    <div className="card">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3>{inc.zone} <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13 }}>{inc.id}</span></h3>
        <StatusBadge status={inc.status} />
      </div>
      <div className="card-b">
        {o.overlaps?.length > 0 && (
          <div style={{ background: 'var(--high-bg)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 13 }}>
            <b>{t('po.overlapsTitle')}</b>{t('po.overlapsAt')}{' '}
            {o.overlaps.map((oid) => {
              const other = list.find((x) => x.id === oid);
              return (
                <button key={oid} className="btn sm" style={{ marginRight: 4 }} onClick={() => onSelect?.(oid)}>
                  {other ? `${other.incident_id} · ${when(other.window_start)}` : oid}
                </button>
              );
            })}
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{t('po.notBlocked')}</div>
          </div>
        )}
        <div className="kv-row"><span className="k">{t('po.kWork')}</span><span className="v">{o.work_description}</span></div>
        <div className="kv-row"><span className="k">{t('po.kSupplyOff')}</span><span className="v mono">{when(o.window_start)} - {when(o.window_end)}</span></div>
        <div className="kv-row"><span className="k">{t('po.kCustomers')}</span><span className="v mono">{(inc.customers || 0).toLocaleString()}</span></div>
        <div className="kv-row"><span className="k">{t('po.kWhere')}</span><span className="v">{inc.substation || t('po.substationNotSet')}{inc.feeder ? t('po.feederX', { f: inc.feeder }) : ''}</span></div>
        <div className="kv-row"><span className="k">{t('po.kComplaints')}</span><span className="v mono">{o.complaints?.total || 0}{o.complaints?.last_at ? t('po.lastAgo', { ago: timeAgo(o.complaints.last_at) }) : ''}</span></div>
        {o.complaints?.after_window > 0 && !['resolved', 'closed', 'cancelled'].includes(inc.status) && (
          <div style={{ background: 'var(--crit-bg, #fdecea)', border: '1px solid var(--crit)', borderRadius: 8, padding: '8px 10px', margin: '6px 0', fontSize: 13 }}>
            <b style={{ color: 'var(--crit)' }}>{t('po.lateComplaints')}</b>{t('po.lateSince', { n: o.complaints.after_window, when: when(o.window_end) })}
            {' '}{t('po.lateAdvice')}
          </div>
        )}
        <div className="kv-row"><span className="k">{t('po.kPriority')}</span><span className="v">{tOr(`sev.${inc.severity}`, inc.severity)}</span></div>
        <div className="kv-row"><span className="k">{t('po.kDeenergisation')}</span><span className="v">{scopeText(o)}</span></div>
        <div className="kv-row"><span className="k">{t('po.kNotice')}</span><span className="v">
          {o.notice_sent_at ? t('po.noticeSent', { when: when(o.notice_sent_at) }) : o.notice_skipped_reason ? t('po.noticeSkipped', { r: o.notice_skipped_reason }) : t('po.noticeDue', { when: when(o.notice_due_at) })}
        </span></div>
        {o.jobs?.length > 0 && <div className="kv-row"><span className="k">{t('po.kCrewJobs')}</span><span className="v mono">
          {o.jobs.map((j) => <div key={j.id} style={{ color: j.status === 'Work Complete' ? 'var(--low)' : undefined }}>{j.id} · {j.crew_id} · {tOr(`po.job.${j.status}`, j.status)}</div>)}
        </span></div>}
        <div className="kv-row"><span className="k">{t('po.kCrew')}</span><span className="v">{inc.crew_id || <CrewAssign incidentId={inc.id} priority={JOB_PRIORITY[inc.severity] || 'Normal'} crews={crews} onDone={() => { load(); onChanged(); }} />}</span></div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
          {o.plan.state === 'draft' && <button className="btn sm primary" onClick={() => window.confirm(t('po.approveConfirm')) && act(() => plannedApi.approve(id), t('po.planApproved'))}>{t('po.approvePlan')}</button>}
          {o.plan.state === 'approved' && !anyConfirmed && <button className="btn sm" onClick={() => act(() => plannedApi.unapprove(id), t('po.planToDraft'))}>{t('po.returnToDraft')}</button>}
          {inc.status === 'scheduled' && <button className="btn sm primary" onClick={() => act(() => plannedApi.notify(id), t('po.customersNotified'))}>{t('po.sendNotice')}</button>}
          {inc.status === 'scheduled' && <button className="btn sm" onClick={() => { const r = ask(t('po.skipWhy')); if (r) act(() => plannedApi.skipNotice(id, r), t('po.noticeSkippedToast')); }}>{t('po.skipNotice')}</button>}
          {['scheduled', 'notified'].includes(inc.status) && !anyConfirmed && <Reschedule o={o} onDone={() => { load(); onChanged(); }} />}
          {['scheduled', 'notified'].includes(inc.status) && !anyConfirmed && <button className="btn sm danger" onClick={() => { const r = ask(t('po.cancelWhy')); if (r) act(() => plannedApi.cancel(id, r), t('po.cancelled')); }}>{t('po.cancelOutage')}</button>}
          {inc.status === 'resolved' && <button className="btn sm primary" onClick={async () => {
            try { await plannedApi.close(id); toast(t('po.woClosed')); load(); onChanged(); return; } catch (e) { if (e.code !== 'JOBS_OPEN') { fail(e); return; } }
            const reason = ask(t('po.closeAnyway'));
            if (reason) act(() => plannedApi.close(id, { force: true, reason }), t('po.woClosedOpenJobs'));
          }}>{t('po.closeWo')}</button>}
        </div>

        <CrewReports o={o} act={act} ask={ask} />

        <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--line)', marginBottom: 12 }}>
          {[['plan', t('po.tabPlan')], ['permits', t('po.tabPermits', { n: o.permits.length })], ['log', t('po.tabLog', { n: log.length })]].map(([k, label]) => (
            <button key={k} className="btn sm" style={{ borderBottom: tab === k ? '2px solid var(--navy)' : undefined, borderRadius: '6px 6px 0 0' }} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'plan' && (o.plan.state === 'draft'
          ? <PlanEditor o={o} crews={crews} onSaved={() => { load(); onChanged(); }} />
          : <StepList o={o} act={act} ask={ask} />)}
        {tab === 'permits' && <Permits o={o} act={act} ask={ask} />}
        {tab === 'log' && <SafetyLog log={log} />}
      </div>
    </div>
  );
}

const DELAY_STATES = ['notified', 'isolating', 'in_progress', 'restoring'];

// Crew site reports and delay reports. A pending delay report changes
// nothing until the control room applies it here ("Apply & notify") or
// dismisses it. The control room may also extend the window directly.
function CrewReports({ o, act, ask }) {
  useT();
  const [form, setForm] = useState(null); // { reportId?, end, reason }
  const reports = o.reports || [];
  const pending = reports.filter((x) => x.state === 'pending');
  const others = reports.filter((x) => x.state !== 'pending');
  const active = DELAY_STATES.includes(o.incident.status);
  const open = (reportId, end, reason) => setForm({ reportId, end: toLocalInput(new Date(end)), reason: reason || '' });
  // The form closes only if the server accepted it.
  const submit = () => act(async () => {
    await plannedApi.delay(o.id, { newWindowEnd: new Date(form.end).toISOString(), reason: form.reason, reportId: form.reportId || undefined });
    setForm(null);
  }, t('po.windowExtended'));
  if (!reports.length && !active) return null;
  return (
    <div style={{ margin: '4px 0 12px' }}>
      {pending.map((x) => (
        <div key={x.id} style={{ background: 'var(--crit-bg, #fdecea)', border: '1px solid var(--crit)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontSize: 13 }}>
          <b style={{ color: 'var(--crit)' }}>{t('po.delayReported')}</b>{t('po.delayBy', { crew: x.crew_id, ago: timeAgo(x.reported_at) })}<b>{when(x.expected_end)}</b>{t('po.windowEnds', { when: when(o.window_end) })}
          <div style={{ margin: '3px 0 6px' }}>{x.note}</div>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button className="btn sm primary" onClick={() => open(x.id, x.expected_end, x.note)}>{t('po.applyNotifyDots')}</button>
            <button className="btn sm" onClick={() => { const r = ask(t('po.dismissWhy')); if (r) act(() => plannedApi.dismissReport(o.id, x.id, r), t('po.delayDismissed')); }}>{t('po.dismiss')}</button>
          </span>
        </div>
      ))}
      {active && !form && <button className="btn sm" onClick={() => open(null, new Date(new Date(o.window_end).getTime() + 3600e3), '')}>{t('po.extendWindowBtn')}</button>}
      {form && (
        <div style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: 10, display: 'grid', gap: 6, marginTop: 6 }}>
          <div className="eyebrow">{form.reportId ? t('po.applyDelay') : t('po.extendWindow')}{t('po.extendedNotice')}</div>
          <label style={{ fontSize: 12.5 }}>{t('po.newEnd')} <input type="datetime-local" style={{ ...inp, width: 'auto', marginLeft: 6 }} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          <label style={{ fontSize: 12.5 }}>{t('po.reasonToCustomers')}<input style={inp} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button className="btn sm primary" disabled={!form.reason.trim() || !form.end} onClick={submit}>{t('po.applyNotify')}</button>
            <button className="btn sm" onClick={() => setForm(null)}>{t('po.cancel')}</button>
          </span>
        </div>
      )}
      {others.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12.5 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>{t('po.crewReports')}</div>
          {others.map((x) => (
            <div key={x.id} style={{ marginBottom: 3 }}>
              <span className="mono">{when(x.reported_at)}</span> · {t('po.crewX', { c: x.crew_id })} · {x.kind === 'delay' ? t('po.delayTo', { when: when(x.expected_end), state: tOr(`po.rep.${x.state}`, x.state), by: x.resolved_by ? t('po.byX', { who: x.resolved_by }) : '' }) : t('po.siteReport')}: {x.note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CrewAssign({ incidentId, priority, crews, onDone }) {
  useT();
  const [crewId, setCrewId] = useState('');
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <select style={{ ...inp, width: 'auto', padding: '4px 8px' }} value={crewId} onChange={(e) => setCrewId(e.target.value)}>
        <option value="">{t('po.assignCrew')}</option>
        {crews.map((c) => <option key={c.id} value={c.id}>{c.id} {c.name}</option>)}
      </select>
      <button className="btn sm" disabled={!crewId} onClick={async () => {
        try { await api.assign(incidentId, crewId, priority); toast(t('po.crewAssigned', { c: crewId, p: priority })); onDone(); } catch (e) { fail(e); }
      }}>{t('po.assign')}</button>
    </span>
  );
}

function Reschedule({ o, onDone }) {
  useT();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(toLocalInput(new Date(o.window_start)));
  const [e, setE] = useState(toLocalInput(new Date(o.window_end)));
  if (!open) return <button className="btn sm" onClick={() => setOpen(true)}>{t('po.reschedule')}</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="datetime-local" style={{ ...inp, width: 'auto' }} value={s} onChange={(x) => setS(x.target.value)} />
      <input type="datetime-local" style={{ ...inp, width: 'auto' }} value={e} onChange={(x) => setE(x.target.value)} />
      <button className="btn sm primary" onClick={async () => {
        try {
          const out = await plannedApi.reschedule(o.id, { windowStart: new Date(s).toISOString(), windowEnd: new Date(e).toISOString() });
          toast(t('po.rescheduled')); warnOverlaps(out.overlaps); setOpen(false); onDone();
        } catch (err) { fail(err); }
      }}>{t('po.save')}</button>
      <button className="btn sm" onClick={() => setOpen(false)}>{t('po.cancel')}</button>
    </span>
  );
}

// Draft plan: an editable ordered list per phase. Order on screen = seq.
function PlanEditor({ o, crews, onSaved }) {
  useT();
  const fromServer = (s) => ({ phase: s.phase, action: s.action, device_label: s.device_label, location: s.location, device_mrid: s.device_mrid, assignee: s.assignee, assignee_crew_id: s.assignee_crew_id || '' });
  const [rows, setRows] = useState(o.steps.map(fromServer));
  const [mrid, setMrid] = useState(o.work_mrid || '');
  const [traceCrew, setTraceCrew] = useState(o.incident.crew_id || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(o.steps.map(fromServer)); }, [o.steps.map((s) => s.id).join()]); // eslint-disable-line

  const upd = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rows.length || rows[j].phase !== rows[i].phase) return;
    const next = [...rows]; [next[i], next[j]] = [next[j], next[i]]; setRows(next);
  };
  const add = (phase) => {
    const step = { phase, action: phase === 'isolate' ? 'open' : 'close', device_label: '', location: '', device_mrid: null, assignee: 'control_room', assignee_crew_id: '' };
    const lastOfPhase = rows.map((r) => r.phase).lastIndexOf(phase);
    const at = lastOfPhase >= 0 ? lastOfPhase + 1 : (phase === 'isolate' ? 0 : rows.length);
    setRows([...rows.slice(0, at), step, ...rows.slice(at)]);
  };
  const save = async () => {
    const steps = ['isolate', 'restore'].flatMap((phase) => rows.filter((r) => r.phase === phase).map((r, i) => ({
      ...r, seq: i + 1, assignee_crew_id: r.assignee === 'crew' ? r.assignee_crew_id : null,
    })));
    setBusy(true);
    try { await plannedApi.saveSteps(o.id, steps); toast(t('po.planSaved')); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };
  const draft = async () => {
    setBusy(true);
    try { await plannedApi.draftFromTrace(o.id, { workMrid: mrid, crewId: traceCrew }); toast(t('po.draftBuilt')); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };

  return (
    <div>
      {o.plan.trace_caveat && <Caveat text={o.plan.trace_caveat} />}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5 }}>
        <span className="eyebrow">{t('po.draftFromTrace')}</span>
        <input style={{ ...inp, width: 180 }} placeholder={t('po.mridPh')} value={mrid} onChange={(e) => setMrid(e.target.value)} />
        <select style={{ ...inp, width: 'auto' }} value={traceCrew} onChange={(e) => setTraceCrew(e.target.value)}>
          <option value="">{t('po.crewForLine')}</option>
          {crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
        <button className="btn sm" disabled={busy || !mrid || !traceCrew} onClick={draft}>{t('po.buildDraft')}</button>
      </div>
      {['isolate', 'restore'].map((phase) => (
        <div key={phase} style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>{phase === 'isolate' ? t('po.isolateOrder') : t('po.restoreOrder')}</div>
          {rows.map((r, i) => r.phase !== phase ? null : (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '24px 120px 1fr 1fr 130px 90px 64px', gap: 6, alignItems: 'center', marginBottom: 5 }}>
              <span className="mono" style={{ color: 'var(--muted)' }}>{rows.slice(0, i + 1).filter((x) => x.phase === phase).length}</span>
              <select style={inp} value={r.action} onChange={(e) => upd(i, 'action', e.target.value)}>{ACTIONS.map((a) => <option key={a} value={a}>{t(`po.act.${a}`)}</option>)}</select>
              <input style={inp} placeholder={t('po.devicePh')} value={r.device_label} onChange={(e) => upd(i, 'device_label', e.target.value)} />
              <input style={inp} placeholder={t('po.locationPh')} value={r.location} onChange={(e) => upd(i, 'location', e.target.value)} />
              <select style={inp} value={r.assignee} onChange={(e) => upd(i, 'assignee', e.target.value)}>
                <option value="control_room">{t('po.controlRoom')}</option><option value="crew">{t('po.crew')}</option>
              </select>
              {r.assignee === 'crew'
                ? <select style={inp} value={r.assignee_crew_id} onChange={(e) => upd(i, 'assignee_crew_id', e.target.value)}><option value="">{t('po.crewPh')}</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
                : <span />}
              <span style={{ display: 'flex', gap: 2 }}>
                <button className="btn sm" title={t('po.moveUp')} onClick={() => move(i, -1)}>↑</button>
                <button className="btn sm" title={t('po.remove')} onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
              </span>
            </div>
          ))}
          <button className="btn sm" onClick={() => add(phase)}>{t('po.addStep', { phase: t(`po.phase.${phase}`) })}</button>
        </div>
      ))}
      <button className="btn primary" disabled={busy} onClick={save}>{t('po.savePlan')}</button>
    </div>
  );
}

function Caveat({ text }) {
  useT();
  return (
    <div style={{ background: 'var(--high-bg)', color: 'var(--ink)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, marginBottom: 12 }}>
      <b>{t('po.caveatTitle')}</b> {text} {t('po.caveatCheck')}
    </div>
  );
}

// Approved plan: steps in order. Only the next step of a phase can be
// confirmed; the server refuses anything else and the refusal is shown.
function StepList({ o, act, ask }) {
  useT();
  const nextOf = (phase) => o.steps.find((s) => s.phase === phase && s.state !== 'confirmed');
  const confirmStep = (s) => {
    const what = t('po.stepWhat', { action: t(`po.act.${s.action}`), device: s.device_label, loc: s.location });
    if (s.assignee === 'crew') {
      const note = ask(t('po.crewStepAsk', { what, crew: s.assignee_crew_id }));
      if (note) act(() => plannedApi.confirmStep(s.id, { onBehalfNote: note }), t('po.crewStepRecorded'));
    } else if (window.confirm(t('po.confirmDoneAsk', { what }))) {
      act(() => plannedApi.confirmStep(s.id, {}), t('po.stepConfirmed'));
    }
  };
  return (
    <div>
      {o.plan.trace_caveat && <Caveat text={o.plan.trace_caveat} />}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{t('po.approvedBy', { who: o.plan.approved_by, ago: timeAgo(o.plan.approved_at) })}</div>
      {['isolate', 'restore'].map((phase) => {
        const next = nextOf(phase);
        return (
          <div key={phase} style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{t(`po.phase.${phase}`)}</div>
            {o.steps.filter((s) => s.phase === phase).map((s) => (
              <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 8, alignItems: 'center', padding: '7px 9px', marginBottom: 4, borderRadius: 7,
                border: `1px solid ${next?.id === s.id ? 'var(--navy)' : 'var(--line)'}`, background: s.state === 'confirmed' ? 'var(--low-bg)' : 'var(--surface)' }}>
                <span className="mono">{s.seq}</span>
                <span>
                  <b>{t(`po.act.${s.action}`)}</b> {s.device_label} <span style={{ color: 'var(--muted)' }}>· {s.location}</span>
                  <span style={{ marginLeft: 6, fontSize: 11, border: '1px solid var(--line-2)', borderRadius: 4, padding: '0 5px' }}>{s.assignee === 'crew' ? t('po.crewN', { c: s.assignee_crew_id }) : t('po.controlRoom')}</span>
                  {s.state === 'confirmed' && (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      ✓ {s.confirmed_by} · {t('po.done', { when: when(s.performed_at) })}{s.received_at && Math.abs(new Date(s.received_at) - new Date(s.performed_at)) > 60000 ? t('po.received', { t: hhmm(s.received_at) }) : ''}
                      {s.on_behalf_note && t('po.onBehalf', { n: s.on_behalf_note })}
                    </div>
                  )}
                </span>
                {s.state !== 'confirmed' && next?.id === s.id
                  ? <button className="btn sm primary" onClick={() => confirmStep(s)}>{s.assignee === 'crew' ? t('po.recordOnBehalf') : t('po.confirmDone')}</button>
                  : <span style={{ fontSize: 12, color: s.state === 'confirmed' ? 'var(--low)' : 'var(--muted)' }}>{s.state === 'confirmed' ? t('po.confirmed') : t('po.pending')}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Permits({ o, act, ask }) {
  useT();
  const isolationSummary = o.steps.filter((s) => s.phase === 'isolate' && ['open', 'rack_out'].includes(s.action)).map((s) => `${s.device_label} ${ACTION_TEXT[s.action]}`).join('; ');
  const earthSummary = o.steps.filter((s) => s.phase === 'isolate' && s.action === 'earth_apply').map((s) => `${s.device_label} (${s.location})`).join('; ');
  if (!o.permits.length) return <div className="empty"><span className="disp">{t('po.noPermit')}</span>{t('po.noPermitHint')}</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {o.permits.map((p) => (
        <div key={p.id} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b className="mono">{p.permit_no}</b>
            <span className={`badge-st st-${{ requested: 'open', issued: 'in_progress', returned: 'resolved' }[p.state] || 'cancelled'}`}>{tOr(`po.permit.${p.state}`, p.state)}</span>
          </div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>{t('po.permitRequested', { c: p.crew_id, j: p.job_id, who: p.requested_by, when: when(p.requested_at) })}</div>
          {p.issued_at && <div style={{ fontSize: 12.5 }}>{t('po.permitIssued', { who: p.issued_by, when: when(p.issued_at), iso: p.isolation_points, earth: p.earthing_points })}</div>}
          {p.returned_at && <div style={{ fontSize: 12.5 }}>{t('po.permitReturned', { who: p.returned_by, when: when(p.returned_at) })}{p.on_behalf_note ? t('po.onBehalfParen', { n: p.on_behalf_note }) : ''}</div>}
          {p.refusal_reason && <div style={{ fontSize: 12.5 }}>{t('po.refused', { r: p.refusal_reason })}</div>}
          {p.state === 'requested' && <IssueForm p={p} act={act} ask={ask} isolation={isolationSummary} earthing={earthSummary} />}
          {p.state === 'issued' && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => {
              const note = ask(t('po.returnAsk', { no: p.permit_no, c: p.crew_id }));
              if (note) act(() => plannedApi.returnOnBehalf(p.id, { onBehalfNote: note, declaration: { menWithdrawn: true, earthsRemoved: true, toolsClear: true } }), t('po.permitReturnedToast'));
            }}>{t('po.recordReturn')}</button>
          )}
        </div>
      ))}
    </div>
  );
}

function IssueForm({ p, act, ask, isolation, earthing }) {
  useT();
  const [iso, setIso] = useState(isolation);
  const [earth, setEarth] = useState(earthing);
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
      <label><div className="eyebrow">{t('po.isoPoints')}</div><textarea style={inp} rows={2} value={iso} onChange={(e) => setIso(e.target.value)} /></label>
      <label><div className="eyebrow">{t('po.earthsAt')}</div><textarea style={inp} rows={2} value={earth} onChange={(e) => setEarth(e.target.value)} /></label>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm primary" onClick={() => window.confirm(t('po.issueAsk', { no: p.permit_no, c: p.crew_id }))
          && act(() => plannedApi.issuePermit(p.id, { isolationPoints: iso, earthingPoints: earth }), t('po.permitIssuedToast'))}>{t('po.issuePermit')}</button>
        <button className="btn sm danger" onClick={() => { const r = ask(t('po.refuseWhy')); if (r) act(() => plannedApi.refusePermit(p.id, r), t('po.permitRefused')); }}>{t('po.refuse')}</button>
      </div>
    </div>
  );
}

function SafetyLog({ log }) {
  useT();
  if (!log.length) return <div className="empty">{t('po.nothingYet')}</div>;
  return (
    <div style={{ maxHeight: 420, overflow: 'auto' }}>
      <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
        <thead><tr><th>{t('po.colWhen')}</th><th>{t('po.colWho')}</th><th>{t('po.colAction')}</th><th>{t('po.colChange')}</th><th>{t('po.colDetail')}</th></tr></thead>
        <tbody>
          {log.map((l) => (
            <tr key={l.id} style={l.action.endsWith('.rejected') ? { color: 'var(--crit)' } : undefined}>
              <td className="mono">{when(l.occurred_at || l.ts)}</td>
              <td>{l.actor}<div style={{ color: 'var(--muted)', fontSize: 11 }}>{l.actor_role}</div></td>
              <td>{l.action}</td>
              <td>{l.from_state || l.to_state ? `${l.from_state || '-'} → ${l.to_state || '-'}` : ''}</td>
              <td style={{ maxWidth: 260 }}>{l.details?.code ? `${l.details.code}: ${l.details.message}` : l.details?.device ? `${l.details.phase} ${l.details.seq} ${l.details.device}` : l.details?.permitNo || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
