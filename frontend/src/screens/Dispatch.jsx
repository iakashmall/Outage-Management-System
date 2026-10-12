import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { dispatchApi } from '../lib/dispatchApi.js';
import { CrewDot, Icon, SevBadge, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';
import { AddCrewForm, Field, HistoryCard, PRIORITIES, ProposalCard, SettingsEditor, WorkloadPanel, inp } from './DispatchWorkload.jsx';

// Why a crew's continuous tracking is off (reported by the crew app).
const TRACKING_OFF_TEXT = {
  permission_denied: 'location permission was denied',
  background_permission_denied: 'background location ("Allow all the time") was denied',
  turned_off: 'the crew turned tracking off',
};

const TOPICS = ['oms.incident.updated', 'oms.incident.created', 'crew.updated', 'crew.job.updated', 'crew.tracking.changed', 'oms.dispatch.rebalance'];

export default function Dispatch() {
  const [inc, setInc] = useState([]);
  const [crews, setCrews] = useState([]);
  const [wl, setWl] = useState(null);          // GET /dispatch/workload
  const [history, setHistory] = useState(null);
  const [areas, setAreas] = useState([]);
  const [pick, setPick] = useState({});
  const [opts, setOpts] = useState({});        // per incident: { priority, duration, skill }
  const [panel, setPanel] = useState(null);    // 'settings' | 'addCrew' | null
  const [stale, setStale] = useState(null);    // last apply refused as STALE_PROPOSAL
  const [proposing, setProposing] = useState(false);

  const wlErr = useRef(null);
  const refreshTimer = useRef(null);
  // quiet: background refreshes only toast a workload error when it is a new one.
  const loadWorkload = (quiet) => dispatchApi.workload()
    .then((w) => { setWl(w); wlErr.current = null; })
    .catch((e) => { if (!quiet || wlErr.current !== e.message) toast(`Workload: ${e.message}`, 'err'); wlErr.current = e.message; });
  const loadHistory = () => dispatchApi.history().then(setHistory).catch(() => {});
  const loadLive = (quiet) => { api.incidents().then(setInc); api.crews().then(setCrews); loadWorkload(quiet); };
  const load = () => { loadLive(false); loadHistory(); };
  // crew.updated fires on every GPS tick, so coalesce bursts into one refresh.
  const refreshSoon = () => { clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => loadLive(true), 400); };
  useEffect(() => {
    load(); api.callAreas().then(setAreas).catch(() => setAreas([]));
    return () => clearTimeout(refreshTimer.current);
  }, []); // eslint-disable-line
  useLiveRefresh(TOPICS, refreshSoon);
  // History only changes when a proposal is applied or rejected.
  useLiveRefresh(['oms.dispatch.rebalance'], loadHistory);

  const wlCrews = wl?.crews || [];
  const crewName = (id) => wlCrews.find((c) => c.id === id)?.name || crews.find((c) => c.id === id)?.name || id;
  const offShift = new Set(wlCrews.filter((c) => !c.on_shift).map((c) => c.id));
  // Jobs a rebalance left without a crew, keyed by incident.
  const flagged = new Map((wl?.unassigned || []).map((j) => [j.incident_id, j]));
  const unassigned = inc.filter((i) => !i.crew_id && (['open', 'dispatched'].includes(i.status) || flagged.has(i.id)));
  const available = crews.filter((c) => c.status === 'available');

  const optFor = (i) => {
    const j = flagged.get(i.id);
    return opts[i.id] || {
      priority: PRIORITIES.includes(j?.priority) ? j.priority : 'Normal',
      duration: j?.estimated_duration_min ? String(j.estimated_duration_min) : '',
      skill: j?.required_skill || '',
    };
  };
  const setOpt = (i, k, v) => setOpts((o) => ({ ...o, [i.id]: { ...optFor(i), [k]: v } }));

  const assign = async (i) => {
    const crewId = pick[i.id];
    if (!crewId) { toast('No crew selected', 'err'); return; }
    const o = optFor(i);
    const extra = { requiredSkill: o.skill.trim() || null };
    if (o.duration !== '') {
      const d = Number(o.duration);
      if (!Number.isInteger(d) || d <= 0) { toast('Duration must be a whole number of minutes', 'err'); return; }
      extra.estimatedDurationMin = d;
    }
    try { await api.assign(i.id, crewId, o.priority, extra); toast(`${crewName(crewId)} dispatched`); load(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const propose = async () => {
    setProposing(true);
    try {
      const out = await dispatchApi.propose();
      setStale(null);
      if (out.proposal) toast('Rebalance proposal ready for review');
      else toast(out.result?.warnings?.length ? `Nothing can move: ${out.result.warnings[0]}` : 'Workload is balanced: nothing to move', out.result?.warnings?.length ? 'err' : 'ok', 5000);
      load();
    } catch (e) { toast(e.message, 'err'); } finally { setProposing(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Field Operations</div><h2>Dispatch console</h2>
          <p>Match unassigned outages to crews by location, skill and availability, and keep crew workload balanced.</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn sm" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} disabled={!wl}><Icon name="gear" size={14} /> Workload settings</button>
          <button className="btn sm" onClick={() => setPanel(panel === 'addCrew' ? null : 'addCrew')} disabled={!wl}><Icon name="plus" size={14} /> Add crew</button>
          <button className="btn primary sm" onClick={propose} disabled={proposing}><Icon name="users" size={14} /> Rebalance</button>
        </div>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        {stale && (
          <div className="card" style={{ borderLeft: '3px solid var(--high)' }}>
            <div className="card-b" style={{ display: 'flex', gap: 14, alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13 }}>
                <b>Proposal {stale.id} was not applied:</b> {stale.message}
                {stale.problems.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--ink-2)', fontSize: 12.5 }}>{stale.problems.map((p, k) => <li key={k}>{p}</li>)}</ul>}
              </div>
              <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
                <button className="btn sm" onClick={() => setStale(null)}>Dismiss</button>
                <button className="btn primary sm" onClick={propose} disabled={proposing}>Propose again</button>
              </div>
            </div>
          </div>
        )}

        {wl?.openProposal && (
          <ProposalCard key={wl.openProposal.id} proposal={wl.openProposal} crewName={crewName} onDone={load} onStale={setStale} />
        )}

        {panel === 'settings' && wl && (
          <div className="card">
            <div className="card-h"><h3>Workload settings</h3><span className="eyebrow">weights, threshold, defaults</span></div>
            <div className="card-b"><SettingsEditor settings={wl.settings} onDone={() => { setPanel(null); load(); }} /></div>
          </div>
        )}
        {panel === 'addCrew' && wl && (
          <div className="card">
            <div className="card-h"><h3>Add crew</h3><span className="eyebrow">starts on shift and available</span></div>
            <div className="card-b"><AddCrewForm areas={areas} defaultCapacity={wl.settings.defaultCapacity} onDone={() => { setPanel(null); load(); }} /></div>
          </div>
        )}

        <div className="card">
          <div className="card-h"><h3>Crew workload</h3><span className="eyebrow">{wlCrews.filter((c) => c.on_shift).length} on shift · {wlCrews.length} crews</span></div>
          <div className="card-b">
            {wl ? <WorkloadPanel data={wl} areas={areas} onChanged={load} /> : <div className="empty">Loading workload…</div>}
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="card">
            <div className="card-h"><h3>Unassigned jobs</h3><span className="eyebrow">{unassigned.length} waiting</span></div>
            <div className="card-b" style={{ display: 'grid', gap: 10 }}>
              {unassigned.map((i) => {
                const f = flagged.get(i.id);
                const o = optFor(i);
                return (
                  <div key={i.id} style={{ border: `1px solid ${f ? 'var(--crit)' : 'var(--line)'}`, borderRadius: 9, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <SevBadge sev={i.severity} />
                          <span className="id-cell">{i.id.slice(-6)}</span>
                          {f && <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{f.id}</span>}
                        </div>
                        <div style={{ fontWeight: 500, marginTop: 5 }}>{i.zone}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{i.feeder || 'no feeder'} · {(i.customers || 0).toLocaleString()} customers · {timeAgo(i.opened_at)}</div>
                      </div>
                    </div>
                    {f?.flagged_reason && (
                      <div style={{ marginTop: 9, background: 'var(--crit-bg)', color: 'var(--crit)', borderRadius: 7, padding: '6px 9px', fontSize: 12.5 }}>
                        <b>Unassigned by rebalance:</b> {f.flagged_reason}{f.flagged_at && <span style={{ color: 'var(--ink-2)' }}> · {timeAgo(f.flagged_at)}</span>}
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 1fr', gap: 8, marginTop: 11 }}>
                      <Field label="Priority">
                        <select style={inp} value={o.priority} onChange={(e) => setOpt(i, 'priority', e.target.value)}>
                          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </Field>
                      <Field label="Est. minutes"><input style={inp} type="number" min="1" step="1" placeholder="default" value={o.duration} onChange={(e) => setOpt(i, 'duration', e.target.value)} /></Field>
                      <Field label="Required skill"><input style={inp} placeholder="any" value={o.skill} onChange={(e) => setOpt(i, 'skill', e.target.value)} /></Field>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <NearestCrewPicker incId={i.id} area={i.substation} skill={o.skill} pick={pick} setPick={setPick}
                        offShift={offShift} fallback={available} wlCrews={wlCrews} />
                      <button className="btn primary sm" disabled={!pick[i.id] || offShift.has(pick[i.id])} onClick={() => assign(i)}>
                        <Icon name="arrow" size={14} /> Dispatch
                      </button>
                    </div>
                  </div>
                );
              })}
              {!unassigned.length && <div className="empty"><span className="disp">Queue clear</span>Every open incident has a crew.</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Crew roster</h3><span className="eyebrow">{available.length} available</span></div>
            <div className="card-b" style={{ display: 'grid', gap: 10 }}>
              {crews.map((c) => (
                <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
                  <CrewDot status={c.status} size={10} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>
                      {c.name} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>· {c.lead}</span>
                      {c.status === 'off_shift' && <span className="chip chip-muted" style={{ marginLeft: 6 }}>Off shift</span>}
                      {c.tracking_state === 'off' && TRACKING_OFF_TEXT[c.tracking_reason] && (
                        <span title={`${TRACKING_OFF_TEXT[c.tracking_reason]}, ${timeAgo(c.tracking_changed_at)}`} style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: 'var(--crit)', background: 'var(--crit-bg)', borderRadius: 4, padding: '1px 6px' }}>Tracking off</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Icon name="pin" size={13} />{c.location}{c.job_id && ` · on ${c.job_id.slice(-6)}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 130 }}>
                    {c.skills.map((s) => <span key={s} style={{ fontSize: 10.5, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 4, padding: '1px 6px', color: 'var(--ink-2)' }}>{s}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {history && <HistoryCard history={history} crewName={crewName} />}
      </div>
    </>
  );
}

// Why a crew does not fit the job (skill / AoR), as a hint only: dispatchers may still override.
function misfit(crew, area, skill) {
  if (!crew) return [];
  const out = [];
  const need = (skill || '').trim().toLowerCase();
  if (need && need !== 'any' && !(crew.skills || []).some((s) => s.trim().toLowerCase() === need)) out.push(`no ${skill.trim()}`);
  if (area && crew.aor?.length && !crew.aor.includes(area)) out.push('outside AoR');
  return out;
}

function NearestCrewPicker({ incId, area, skill, pick, setPick, offShift, fallback, wlCrews }) {
  const [nearest, setNearest] = useState(null); // null while loading
  useEffect(() => { api.nearestCrews(incId).then(setNearest).catch(() => setNearest([])); }, [incId]);
  // nearest-crews needs PostGIS and coordinates on both the incident and the crew;
  // without a result, offer every available crew so the job can still be dispatched.
  const list = nearest?.length ? nearest : nearest ? fallback : [];
  const byId = new Map(wlCrews.map((c) => [c.id, c]));
  const usable = list.filter((c) => !offShift.has(c.id));
  const cur = pick[incId];
  const listKey = list.map((c) => c.id).join();
  const offKey = [...offShift].join();
  // Auto-pick (best fitting crew first) when nothing is picked, or when the picked crew went off shift / left the list.
  useEffect(() => {
    if (nearest === null) return;
    if (cur && !offShift.has(cur) && list.some((c) => c.id === cur)) return;
    const best = usable.find((c) => !misfit(byId.get(c.id), area, skill).length) || usable[0];
    const next = best?.id || '';
    if (next !== (cur || '')) setPick((p) => ({ ...p, [incId]: next }));
  }, [nearest, listKey, offKey]); // eslint-disable-line
  const dist = (m) => (m == null ? '' : m < 1000 ? ` · ${Math.round(m)} m` : ` · ${(m / 1000).toFixed(1)} km`);
  return (
    <select className="btn sm" style={{ flex: 1 }} aria-label="Select nearest crew to assign" value={cur || ''} onChange={(e) => setPick({ ...pick, [incId]: e.target.value })}>
      <option value="">{nearest === null ? 'Loading crews…' : usable.length ? 'Select crew…' : 'No crews available'}</option>
      {list.map((c) => {
        const off = offShift.has(c.id);
        const why = misfit(byId.get(c.id), area, skill);
        return (
          <option key={c.id} value={c.id} disabled={off}>
            {c.name}{dist(c.meters_away)}{off ? ' (off shift)' : ''}{why.length ? ` (${why.join(', ')})` : ''}
          </option>
        );
      })}
    </select>
  );
}
