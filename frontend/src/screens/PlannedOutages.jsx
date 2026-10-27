// OMS-01 Planned outages: schedule the outage, build and approve the
// switching plan, notify customers, operate control-room steps, issue and
// track work permits, and read the safety log. Every rule is enforced by the
// server (domain/plannedOutage.js); this screen shows what it allows and
// passes on its refusals verbatim. See docs/OMS-01-DESIGN.md.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { plannedApi } from '../lib/plannedApi.js';
import { StatusBadge, hhmm, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';
import { ACTION_TEXT, when, inp, fail, PlanApprovalButtons, PlanEditor, StepList, SafetyLog } from '../components/SwitchingPlan.jsx';

const TOPICS = ['oms.planned.updated', 'oms.planned.crew_report', 'oms.permit.changed', 'oms.switching.confirmed', 'oms.switching.rejected', 'oms.incident.updated', 'crew.job.updated'];
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
// Crew job priority used by the crew app when an outage of this priority is assigned.
const JOB_PRIORITY = { critical: 'Urgent', high: 'Urgent', medium: 'Normal', low: 'Normal' };
// F12: another planned outage overlaps in time at the same substation or
// feeder. Only a warning: the operator decides which takes priority.
const warnOverlaps = (ids) => {
  if (ids?.length) toast(`Warning: overlaps ${ids.length} other planned outage${ids.length > 1 ? 's' : ''} at the same substation/feeder - see the outage for links`, 'err', 12000);
};
const scopeText = (o) => (o.deenergisation === 'partial' ? `Partial - ${o.affected_section || 'section not named'}`
  : o.deenergisation === 'complete' ? 'Complete' : 'not recorded');

export default function PlannedOutages() {
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
          <h3>Planned outages</h3>
          <button className="btn sm primary" onClick={() => { setCreating(true); setSel(null); }}>New</button>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 8 }}>
          {!list.length && <div className="empty"><span className="disp">None scheduled</span>Create one with New.</div>}
          {list.map((p) => (
            <button key={p.id} onClick={() => { setSel(p.id); setCreating(false); }}
              style={{ textAlign: 'left', border: `1px solid ${sel === p.id ? 'var(--navy)' : 'var(--line)'}`, borderRadius: 9, padding: 10, background: 'var(--surface)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <b>{p.zone}</b><span style={{ display: 'inline-flex', gap: 4 }}>{p.severity && p.severity !== 'low' && <span className={`badge-sev sev-${p.severity}`}>{p.severity}</span>}<StatusBadge status={p.status} /></span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{when(p.window_start)} - {hhmm(p.window_end)}</div>
              <div style={{ fontSize: 12, marginTop: 3 }}>
                Plan {p.plan_state} · {p.steps_confirmed}/{p.step_count} steps
                {p.open_permits > 0 && <span style={{ color: 'var(--crit)', fontWeight: 600 }}> · {p.open_permits} permit open</span>}
                {p.pending_delay_reports > 0 && <span style={{ color: 'var(--crit)', fontWeight: 700 }}> · DELAY REPORTED</span>}
                {p.complaint_count > 0 && <span style={{ color: p.complaints_after_window > 0 ? 'var(--crit)' : undefined }}> · {p.complaint_count} complaint{p.complaint_count > 1 ? 's' : ''}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
      {creating && <NewPlannedOutage onCancel={() => setCreating(false)} onCreated={(o) => { setCreating(false); load(); setSel(o.id); }} />}
      {sel && !creating && <OutageDetail key={sel} id={sel} crews={crews} onChanged={load} list={list} onSelect={setSel} />}
      {!sel && !creating && <div className="card"><div className="card-b empty"><span className="disp">Select an outage</span>Its plan, permits and safety log appear here.</div></div>}
    </div>
  );
}

function NewPlannedOutage({ onCancel, onCreated }) {
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
      toast(`Planned outage ${out.outage.incident.id} scheduled`);
      warnOverlaps(out.overlaps);
      onCreated(out.outage);
    } catch (e) { fail(e); setBusy(false); }
  };
  const field = (label, node) => <label style={{ display: 'block' }}><div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>{node}</label>;
  return (
    <div className="card">
      <div className="card-h"><h3>New planned outage</h3></div>
      <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {field('Zone *', <input style={inp} value={f.zone} onChange={set('zone')} placeholder="e.g. Kankhal-2" />)}
        {field('Substation', (
          <select style={inp} value={f.substation} onChange={(e) => setF({ ...f, substation: e.target.value, feeder: '' })}>
            <option value="">(not set)</option>
            {areas.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        ))}
        {field('Feeder (optional; complaints on other feeders still open fault incidents)', (
          <select style={inp} value={f.feeder} onChange={set('feeder')} disabled={!f.substation}>
            <option value="">(whole substation)</option>
            {feeders.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        ))}
        {field('Customers affected (estimate)', <input style={inp} type="number" value={f.customers} onChange={set('customers')} />)}
        {field('Supply off from *', <input style={inp} type="datetime-local" value={f.windowStart} onChange={set('windowStart')} />)}
        {field('Supply back by *', <input style={inp} type="datetime-local" value={f.windowEnd} onChange={set('windowEnd')} />)}
        <div style={{ gridColumn: '1 / -1' }}>{field('Work to be done *', <input style={inp} value={f.workDescription} onChange={set('workDescription')} placeholder="e.g. Replace DT-14 HT bushings" />)}</div>
        {field('Work equipment CIM mRID (for drafting the plan)', <input style={inp} value={f.workMrid} onChange={set('workMrid')} />)}
        {field('Notify customers this many hours before', <input style={inp} type="number" min="0" value={f.noticeHours} onChange={set('noticeHours')} />)}
        {field('Priority *', <select style={inp} value={f.severity} onChange={set('severity')}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>)}
        {field('De-energisation *', (
          <select style={inp} value={f.deenergisation} onChange={set('deenergisation')}>
            <option value="complete">Complete - everything beyond the isolation points</option>
            <option value="partial">Partial - only a named section</option>
          </select>
        ))}
        {f.deenergisation === 'partial' && <div style={{ gridColumn: '1 / -1' }}>{field('Affected section *', <input style={inp} value={f.affectedSection} onChange={set('affectedSection')} placeholder="e.g. LT network of DT-14 only (Ward 7)" />)}</div>}
        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>Window: must start now or later and last at most 72 hours.</div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Scheduling…' : 'Schedule outage'}</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function OutageDetail({ id, crews, onChanged, list = [], onSelect }) {
  const [o, setO] = useState(null);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState('plan');
  const load = () => Promise.all([plannedApi.get(id), plannedApi.safetyLog(id)]).then(([x, l]) => { setO(x); setLog(l); }).catch(fail);
  useEffect(() => { load(); }, [id]); // eslint-disable-line
  useLiveRefresh(TOPICS, load);
  if (!o) return <div className="card"><div className="card-b">Loading…</div></div>;

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
            <b>Overlaps another planned outage</b> at the same substation or feeder:{' '}
            {o.overlaps.map((oid) => {
              const other = list.find((x) => x.id === oid);
              return (
                <button key={oid} className="btn sm" style={{ marginRight: 4 }} onClick={() => onSelect?.(oid)}>
                  {other ? `${other.incident_id} · ${when(other.window_start)}` : oid}
                </button>
              );
            })}
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>Not blocked: decide which takes priority, or reschedule one of them.</div>
          </div>
        )}
        <div className="kv-row"><span className="k">Work</span><span className="v">{o.work_description}</span></div>
        <div className="kv-row"><span className="k">Supply off</span><span className="v mono">{when(o.window_start)} - {when(o.window_end)}</span></div>
        <div className="kv-row"><span className="k">Customers</span><span className="v mono">{(inc.customers || 0).toLocaleString()}</span></div>
        <div className="kv-row"><span className="k">Where</span><span className="v">{inc.substation || 'substation not set'}{inc.feeder ? ` · feeder ${inc.feeder}` : ''}</span></div>
        <div className="kv-row"><span className="k">Customer complaints</span><span className="v mono">{o.complaints?.total || 0}{o.complaints?.last_at ? ` (last ${timeAgo(o.complaints.last_at)})` : ''}</span></div>
        {o.complaints?.after_window > 0 && !['resolved', 'closed', 'cancelled'].includes(inc.status) && (
          <div style={{ background: 'var(--crit-bg, #fdecea)', border: '1px solid var(--crit)', borderRadius: 8, padding: '8px 10px', margin: '6px 0', fontSize: 13 }}>
            <b style={{ color: 'var(--crit)' }}>Complaints are still arriving after the planned window ended</b> ({o.complaints.after_window} since {when(o.window_end)}).
            Restore supply or extend the window and notify customers.
          </div>
        )}
        <div className="kv-row"><span className="k">Priority</span><span className="v">{inc.severity}</span></div>
        <div className="kv-row"><span className="k">De-energisation</span><span className="v">{scopeText(o)}</span></div>
        <div className="kv-row"><span className="k">Customer notice</span><span className="v">
          {o.notice_sent_at ? `sent ${when(o.notice_sent_at)}` : o.notice_skipped_reason ? `skipped: ${o.notice_skipped_reason}` : `due ${when(o.notice_due_at)}`}
        </span></div>
        {o.jobs?.length > 0 && <div className="kv-row"><span className="k">Crew jobs</span><span className="v mono">
          {o.jobs.map((j) => <div key={j.id} style={{ color: j.status === 'Work Complete' ? 'var(--low)' : undefined }}>{j.id} · {j.crew_id} · {j.status}</div>)}
        </span></div>}
        <div className="kv-row"><span className="k">Crew</span><span className="v">{inc.crew_id || <CrewAssign incidentId={inc.id} priority={JOB_PRIORITY[inc.severity] || 'Normal'} crews={crews} onDone={() => { load(); onChanged(); }} />}</span></div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
          <PlanApprovalButtons plan={o.plan} steps={o.steps} act={act} onApprove={() => plannedApi.approve(id)} onUnapprove={() => plannedApi.unapprove(id)} />
          {inc.status === 'scheduled' && <button className="btn sm primary" onClick={() => act(() => plannedApi.notify(id), 'Customers notified')}>Send notice now</button>}
          {inc.status === 'scheduled' && <button className="btn sm" onClick={() => { const r = ask('Why is the customer notice being skipped?'); if (r) act(() => plannedApi.skipNotice(id, r), 'Notice skipped'); }}>Skip notice…</button>}
          {['scheduled', 'notified'].includes(inc.status) && !anyConfirmed && <Reschedule o={o} onDone={() => { load(); onChanged(); }} />}
          {['scheduled', 'notified'].includes(inc.status) && !anyConfirmed && <button className="btn sm danger" onClick={() => { const r = ask('Reason for cancelling this planned outage?'); if (r) act(() => plannedApi.cancel(id, r), 'Cancelled'); }}>Cancel outage…</button>}
          {inc.status === 'resolved' && <button className="btn sm primary" onClick={async () => {
            try { await plannedApi.close(id); toast('Work order closed'); load(); onChanged(); return; } catch (e) { if (e.code !== 'JOBS_OPEN') { fail(e); return; } }
            const reason = ask('Crew jobs on this outage are not complete. Close the work order anyway?\n\nThis is recorded in the safety log. Reason (at least 10 characters):');
            if (reason) act(() => plannedApi.close(id, { force: true, reason }), 'Work order closed with open jobs');
          }}>Close work order</button>}
        </div>

        <CrewReports o={o} act={act} ask={ask} />

        <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--line)', marginBottom: 12 }}>
          {[['plan', 'Switching plan'], ['permits', `Permits (${o.permits.length})`], ['log', `Safety log (${log.length})`]].map(([k, label]) => (
            <button key={k} className="btn sm" style={{ borderBottom: tab === k ? '2px solid var(--navy)' : undefined, borderRadius: '6px 6px 0 0' }} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'plan' && (o.plan.state === 'draft'
          ? <PlanEditor plan={o.plan} steps={o.steps} crews={crews} defaultMrid={o.work_mrid || ''} defaultCrew={inc.crew_id || ''}
              onDraft={(body) => plannedApi.draftFromTrace(o.id, body)} onSave={(steps) => plannedApi.saveSteps(o.id, steps)} onSaved={() => { load(); onChanged(); }} />
          : <StepList plan={o.plan} steps={o.steps} act={act} ask={ask} />)}
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
  }, 'Window extended; customers notified');
  if (!reports.length && !active) return null;
  return (
    <div style={{ margin: '4px 0 12px' }}>
      {pending.map((x) => (
        <div key={x.id} style={{ background: 'var(--crit-bg, #fdecea)', border: '1px solid var(--crit)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontSize: 13 }}>
          <b style={{ color: 'var(--crit)' }}>DELAY REPORTED</b> by crew {x.crew_id} {timeAgo(x.reported_at)}: expects to finish by <b>{when(x.expected_end)}</b> (window ends {when(o.window_end)})
          <div style={{ margin: '3px 0 6px' }}>{x.note}</div>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button className="btn sm primary" onClick={() => open(x.id, x.expected_end, x.note)}>Apply &amp; notify…</button>
            <button className="btn sm" onClick={() => { const r = ask('Dismiss this delay report? Reason:'); if (r) act(() => plannedApi.dismissReport(o.id, x.id, r), 'Delay report dismissed'); }}>Dismiss…</button>
          </span>
        </div>
      ))}
      {active && !form && <button className="btn sm" onClick={() => open(null, new Date(new Date(o.window_end).getTime() + 3600e3), '')}>Extend window…</button>}
      {form && (
        <div style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: 10, display: 'grid', gap: 6, marginTop: 6 }}>
          <div className="eyebrow">{form.reportId ? 'Apply the crew\'s delay' : 'Extend the window'} - customers get an "extended" notice</div>
          <label style={{ fontSize: 12.5 }}>New end <input type="datetime-local" style={{ ...inp, width: 'auto', marginLeft: 6 }} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          <label style={{ fontSize: 12.5 }}>Reason (sent to customers)<input style={inp} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button className="btn sm primary" disabled={!form.reason.trim() || !form.end} onClick={submit}>Apply &amp; notify</button>
            <button className="btn sm" onClick={() => setForm(null)}>Cancel</button>
          </span>
        </div>
      )}
      {others.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12.5 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Crew reports</div>
          {others.map((x) => (
            <div key={x.id} style={{ marginBottom: 3 }}>
              <span className="mono">{when(x.reported_at)}</span> · crew {x.crew_id} · {x.kind === 'delay' ? `delay to ${when(x.expected_end)} (${x.state}${x.resolved_by ? ` by ${x.resolved_by}` : ''})` : 'site report'}: {x.note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CrewAssign({ incidentId, priority, crews, onDone }) {
  const [crewId, setCrewId] = useState('');
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <select style={{ ...inp, width: 'auto', padding: '4px 8px' }} value={crewId} onChange={(e) => setCrewId(e.target.value)}>
        <option value="">Assign crew…</option>
        {crews.map((c) => <option key={c.id} value={c.id}>{c.id} {c.name}</option>)}
      </select>
      <button className="btn sm" disabled={!crewId} onClick={async () => {
        try { await api.assign(incidentId, crewId, priority); toast(`Crew ${crewId} assigned (${priority})`); onDone(); } catch (e) { fail(e); }
      }}>Assign</button>
    </span>
  );
}

function Reschedule({ o, onDone }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(toLocalInput(new Date(o.window_start)));
  const [e, setE] = useState(toLocalInput(new Date(o.window_end)));
  if (!open) return <button className="btn sm" onClick={() => setOpen(true)}>Reschedule…</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="datetime-local" style={{ ...inp, width: 'auto' }} value={s} onChange={(x) => setS(x.target.value)} />
      <input type="datetime-local" style={{ ...inp, width: 'auto' }} value={e} onChange={(x) => setE(x.target.value)} />
      <button className="btn sm primary" onClick={async () => {
        try {
          const out = await plannedApi.reschedule(o.id, { windowStart: new Date(s).toISOString(), windowEnd: new Date(e).toISOString() });
          toast('Rescheduled; customers will be notified again'); warnOverlaps(out.overlaps); setOpen(false); onDone();
        } catch (err) { fail(err); }
      }}>Save</button>
      <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

function Permits({ o, act, ask }) {
  const isolationSummary = o.steps.filter((s) => s.phase === 'isolate' && ['open', 'rack_out'].includes(s.action)).map((s) => `${s.device_label} ${ACTION_TEXT[s.action]}`).join('; ');
  const earthSummary = o.steps.filter((s) => s.phase === 'isolate' && s.action === 'earth_apply').map((s) => `${s.device_label} (${s.location})`).join('; ');
  if (!o.permits.length) return <div className="empty"><span className="disp">No permit requested</span>The crew requests the permit from the app once their isolation steps are done.</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {o.permits.map((p) => (
        <div key={p.id} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b className="mono">{p.permit_no}</b>
            <span className={`badge-st st-${{ requested: 'open', issued: 'in_progress', returned: 'resolved' }[p.state] || 'cancelled'}`}>{p.state}</span>
          </div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>Crew {p.crew_id} · job {p.job_id} · requested by {p.requested_by} {when(p.requested_at)}</div>
          {p.issued_at && <div style={{ fontSize: 12.5 }}>Issued by {p.issued_by} {when(p.issued_at)} · isolation: {p.isolation_points} · earths: {p.earthing_points}</div>}
          {p.returned_at && <div style={{ fontSize: 12.5 }}>Returned by {p.returned_by} {when(p.returned_at)}{p.on_behalf_note ? ` (on behalf: ${p.on_behalf_note})` : ''}</div>}
          {p.refusal_reason && <div style={{ fontSize: 12.5 }}>Refused: {p.refusal_reason}</div>}
          {p.state === 'requested' && <IssueForm p={p} act={act} ask={ask} isolation={isolationSummary} earthing={earthSummary} />}
          {p.state === 'issued' && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => {
              const note = ask(`Record the RETURN of ${p.permit_no} on behalf of crew ${p.crew_id}?\n\nOnly if the crew has confirmed all men withdrawn, all earths removed and tools clear. Enter who confirmed it and how:`);
              if (note) act(() => plannedApi.returnOnBehalf(p.id, { onBehalfNote: note, declaration: { menWithdrawn: true, earthsRemoved: true, toolsClear: true } }), 'Permit returned');
            }}>Record return on behalf…</button>
          )}
        </div>
      ))}
    </div>
  );
}

function IssueForm({ p, act, ask, isolation, earthing }) {
  const [iso, setIso] = useState(isolation);
  const [earth, setEarth] = useState(earthing);
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
      <label><div className="eyebrow">Points of isolation</div><textarea style={inp} rows={2} value={iso} onChange={(e) => setIso(e.target.value)} /></label>
      <label><div className="eyebrow">Earths applied at</div><textarea style={inp} rows={2} value={earth} onChange={(e) => setEarth(e.target.value)} /></label>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm primary" onClick={() => window.confirm(`Issue ${p.permit_no} to crew ${p.crew_id}? Only if the line is isolated and earthed as stated.`)
          && act(() => plannedApi.issuePermit(p.id, { isolationPoints: iso, earthingPoints: earth }), 'Permit issued')}>Issue permit</button>
        <button className="btn sm danger" onClick={() => { const r = ask('Reason for refusing this permit?'); if (r) act(() => plannedApi.refusePermit(p.id, r), 'Permit refused'); }}>Refuse…</button>
      </div>
    </div>
  );
}

