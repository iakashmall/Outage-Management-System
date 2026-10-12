// OMS-03 workload balancing panels for the Dispatch tab: per-crew load bars
// with crew controls, the settings editor, the open rebalance proposal
// (approve & apply / reject) and the reassignment history. Data comes from
// lib/dispatchApi.js; the Dispatch screen owns loading and live refresh.
import { useState } from 'react';
import { dispatchApi } from '../lib/dispatchApi.js';
import { CrewDot, Icon, timeAgo, toast } from '../lib/ui.jsx';

export const PRIORITIES = ['Critical', 'VIP', 'Urgent', 'Normal']; // high -> low
const PRIO_CHIP = { Critical: 'chip-crit', VIP: 'chip-major', Urgent: 'chip-minor', Normal: 'chip-muted' };

export const PrioBadge = ({ priority, medical }) => (
  <>
    <span className={`chip ${PRIO_CHIP[priority] || 'chip-muted'}`}>{priority}</span>
    {medical && <span className="chip chip-crit" style={{ marginLeft: 4 }} title="A linked trouble call is a medical emergency">Medical</span>}
  </>
);

const TRIGGER_TEXT = {
  manual: 'Manual rebalance', crew_added: 'Crew added', crew_off_shift: 'Crew went off shift',
  crew_on_shift: 'Crew back on shift', capacity_changed: 'Capacity changed', crew_updated: 'Crew area or skills changed',
};
const REASON_TEXT = { overload: 'Overload', crew_off_shift: 'Crew off shift', flagged_reassign: 'Was unassigned', manual_assign: 'Manual assign' };
const STATUS_CHIP = { applied: 'chip-ok', rejected: 'chip-crit', stale: 'chip-major', superseded: 'chip-muted', proposed: 'chip-minor' };

const pct = (load) => `${Math.round((load || 0) * 100)}%`;
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const shortId = (id) => (id ? String(id).replace(/^INC-\d{4}-0*/, 'INC-') : '—');

export const inp = { width: '100%', padding: '7px 9px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13, background: 'var(--surface)', color: 'var(--ink)' };
export const Field = ({ label, children, span }) => (
  <label style={{ display: 'block', gridColumn: span ? '1 / -1' : undefined }}>
    <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>{children}
  </label>
);

// A crew change answers with the rebalance it triggered (never applied).
export function reportRebalance(rb) {
  if (rb?.proposal) toast('Rebalance proposal ready for review');
  else if (rb?.reason === 'balanced') toast('Workload is balanced: nothing to move');
}

// Bar scale: room above the threshold so overload is visible, not clipped.
export const barScale = (threshold, loads) => Math.max(threshold * 1.5, 1, ...loads.map((l) => l || 0));

// Load bar with a threshold marker; red when over.
export function LoadBar({ load, threshold, scale, ghost }) {
  const over = load > threshold + 1e-9;
  const color = ghost ? 'var(--faint)' : over ? 'var(--crit)' : load > threshold * 0.85 ? 'var(--high)' : 'var(--live)';
  return (
    <div className="bar" style={{ position: 'relative', overflow: 'visible', height: 9 }}>
      <i style={{ width: `${Math.min(load / scale, 1) * 100}%`, background: color }} />
      <span title={`Overload threshold ${pct(threshold)}`}
        style={{ position: 'absolute', left: `${(threshold / scale) * 100}%`, top: -4, bottom: -4, width: 2, marginLeft: -1, background: 'var(--ink-2)', borderRadius: 1 }} />
    </div>
  );
}

// ---------- workload ----------

export function WorkloadPanel({ data, areas, onChanged }) {
  const [editing, setEditing] = useState(null);
  const T = data.settings.overloadThreshold;
  const scale = barScale(T, data.crews.map((c) => c.load));
  const over = data.crews.filter((c) => c.over && c.on_shift).length;

  const setShift = async (c, on_shift) => {
    try {
      const out = await dispatchApi.updateCrew(c.id, { on_shift });
      toast(`${c.name} ${on_shift ? 'back on shift' : 'off shift'}`);
      reportRebalance(out.rebalance);
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span>Load = weighted job hours / crew capacity</span>
        <span><span style={{ display: 'inline-block', width: 2, height: 10, background: 'var(--ink-2)', verticalAlign: 'middle', marginRight: 5 }} />threshold {pct(T)}</span>
        {over > 0 && <span style={{ color: 'var(--crit)', fontWeight: 600 }}>{over} crew{over > 1 ? 's' : ''} over threshold</span>}
      </div>
      {data.crews.map((c) => (
        <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px', background: c.on_shift ? undefined : 'var(--paper)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 210px) 1fr auto', gap: 14, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 500 }}>
                <CrewDot status={c.status} />{c.name}
                <span className="mono" style={{ color: 'var(--muted)', fontSize: 11.5, fontWeight: 400 }}>{c.id}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={(c.aor || []).join(', ')}>
                {c.aor?.length ? `AoR: ${c.aor.join(', ')}` : 'AoR: unrestricted'}
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                <span className="mono" style={{ fontWeight: 600, color: c.over ? 'var(--crit)' : 'var(--ink)' }}>{pct(c.load)}</span>
                <span className="mono" style={{ color: 'var(--muted)' }}>{c.weight} / {c.capacity ?? data.settings.defaultCapacity} h · {c.jobs.length} job{c.jobs.length === 1 ? '' : 's'}</span>
              </div>
              <LoadBar load={c.load} threshold={T} scale={scale} />
              {c.jobs.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                  {c.jobs.map((j) => (
                    <span key={j.id} title={`${j.id} · ${j.status} · weight ${j.weight}${j.required_skill ? ` · needs ${j.required_skill}` : ''}${j.movable ? '' : ' · cannot move'}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px 1px 4px', background: 'var(--surface)' }}>
                      <PrioBadge priority={j.effectivePriority} medical={j.medical} />
                      <span className="mono">{j.id}</span>
                      {!j.movable && <span style={{ color: 'var(--muted)' }}>· {j.planned ? 'planned' : j.status}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div className="seg" role="group" aria-label={`${c.name} shift`}>
                <button className={c.on_shift ? 'on' : ''} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => !c.on_shift && setShift(c, true)}>On shift</button>
                <button className={c.on_shift ? '' : 'on'} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => c.on_shift && setShift(c, false)}>Off</button>
              </div>
              <button className="btn sm" onClick={() => setEditing(editing === c.id ? null : c.id)}>{editing === c.id ? 'Close' : 'Edit'}</button>
            </div>
          </div>
          {editing === c.id && <CrewEditor crew={c} areas={areas} onDone={() => { setEditing(null); onChanged(); }} />}
        </div>
      ))}
    </div>
  );
}

// Substation checklist, values as GET /calls/areas gives them.
function AreaPicker({ areas, value, onChange }) {
  const set = new Set(value);
  const toggle = (v) => onChange(set.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div style={{ ...inp, maxHeight: 132, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '2px 10px' }}>
      {areas.map((a) => (
        <label key={a.value} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={set.has(a.value)} onChange={() => toggle(a.value)} />{a.label || a.value}
        </label>
      ))}
      {!areas.length && <span style={{ color: 'var(--muted)' }}>No areas loaded</span>}
    </div>
  );
}

function CrewEditor({ crew, areas, onDone }) {
  const [f, setF] = useState({ capacity: String(crew.capacity ?? ''), skills: (crew.skills || []).join(', '), aor: crew.aor || [] });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const patch = {};
    const cap = Number(f.capacity);
    if (!(cap > 0)) { toast('Capacity must be a positive number', 'err'); return; }
    if (cap !== Number(crew.capacity)) patch.capacity = cap;
    const skills = f.skills.split(',').map((s) => s.trim()).filter(Boolean);
    if (skills.join(',') !== (crew.skills || []).join(',')) patch.skills = skills;
    const aorChanged = f.aor.length !== (crew.aor || []).length || f.aor.some((a) => !(crew.aor || []).includes(a));
    if (aorChanged) patch.aor = f.aor.length ? f.aor : null;
    if (!Object.keys(patch).length) { onDone(); return; }
    setBusy(true);
    try {
      const out = await dispatchApi.updateCrew(crew.id, patch);
      toast(`${crew.name} updated`);
      reportRebalance(out.rebalance);
      onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
      <Field label="Capacity (h)"><input style={inp} type="number" min="0.5" step="0.5" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
      <Field label="Skills (comma separated)"><input style={inp} value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} placeholder="e.g. HT, LT, Cable" /></Field>
      <Field label="Area of responsibility (none ticked = unrestricted)" span><AreaPicker areas={areas} value={f.aor} onChange={(aor) => setF({ ...f, aor })} /></Field>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm" onClick={onDone} disabled={busy}>Cancel</button>
        <button className="btn primary sm" onClick={save} disabled={busy}><Icon name="check" size={14} /> Save</button>
      </div>
    </div>
  );
}

export function AddCrewForm({ areas, defaultCapacity, onDone }) {
  const [f, setF] = useState({ name: '', lead: '', id: '', skills: '', capacity: String(defaultCapacity ?? ''), lat: '', lon: '', aor: [] });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.name.trim()) { toast('Crew name is required', 'err'); return; }
    const body = { name: f.name.trim(), lead: f.lead.trim() || undefined, skills: f.skills, aor: f.aor.length ? f.aor : null };
    if (f.id.trim()) body.id = f.id.trim();
    if (f.capacity !== '') body.capacity = Number(f.capacity);
    // Both or neither: a lone coordinate would otherwise be stored with 0 for the other.
    if ((f.lat === '') !== (f.lon === '')) { toast('Enter both base latitude and longitude, or neither', 'err'); return; }
    if (f.lat !== '') {
      const lat = Number(f.lat), lon = Number(f.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('Base latitude/longitude are not valid', 'err'); return; }
      body.lat = lat; body.lon = lon;
    }
    setBusy(true);
    try {
      const out = await dispatchApi.addCrew(body);
      toast(`Crew ${out.crew.id} added`);
      reportRebalance(out.rebalance);
      onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      <Field label="Name *"><input style={inp} value={f.name} onChange={set('name')} placeholder="e.g. Line Crew Golf" /></Field>
      <Field label="Lead"><input style={inp} value={f.lead} onChange={set('lead')} /></Field>
      <Field label="Id (optional)"><input style={inp} value={f.id} onChange={set('id')} placeholder="next Cnnn" /></Field>
      <Field label="Capacity (h)"><input style={inp} type="number" min="0.5" step="0.5" value={f.capacity} onChange={set('capacity')} /></Field>
      <div style={{ gridColumn: 'span 2' }}><Field label="Skills (comma separated)"><input style={inp} value={f.skills} onChange={set('skills')} placeholder="e.g. HT, LT, Cable" /></Field></div>
      <Field label="Base latitude"><input style={inp} type="number" step="any" value={f.lat} onChange={set('lat')} /></Field>
      <Field label="Base longitude"><input style={inp} type="number" step="any" value={f.lon} onChange={set('lon')} /></Field>
      <Field label="Area of responsibility (none ticked = unrestricted)" span><AreaPicker areas={areas} value={f.aor} onChange={(aor) => setF({ ...f, aor })} /></Field>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm" onClick={onDone} disabled={busy}>Cancel</button>
        <button className="btn primary sm" onClick={submit} disabled={busy}><Icon name="plus" size={14} /> Add crew</button>
      </div>
    </div>
  );
}

export function SettingsEditor({ settings, onDone }) {
  const [f, setF] = useState({
    ...Object.fromEntries(PRIORITIES.map((p) => [p, String(settings.priorityWeights[p])])),
    threshold: String(Math.round(settings.overloadThreshold * 100)),
    duration: String(settings.defaultDurationMin), capacity: String(settings.defaultCapacity),
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      await dispatchApi.saveSettings({
        priorityWeights: Object.fromEntries(PRIORITIES.map((p) => [p, Number(f[p])])),
        overloadThreshold: Number(f.threshold) / 100,
        defaultDurationMin: Number(f.duration), defaultCapacity: Number(f.capacity),
      });
      toast('Workload settings saved');
      onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {PRIORITIES.map((p) => (
          <Field key={p} label={`${p} weight`}><input style={inp} type="number" min="0.1" step="0.1" value={f[p]} onChange={set(p)} /></Field>
        ))}
        <Field label="Overload threshold (%)"><input style={inp} type="number" min="10" max="500" step="5" value={f.threshold} onChange={set('threshold')} /></Field>
        <Field label="Default job duration (min)"><input style={inp} type="number" min="1" value={f.duration} onChange={set('duration')} /></Field>
        <Field label="Default crew capacity (h)"><input style={inp} type="number" min="0.5" step="0.5" value={f.capacity} onChange={set('capacity')} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Job weight = priority weight × duration (h). Saving does not rebalance by itself.</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn sm" onClick={onDone} disabled={busy}>Cancel</button>
          <button className="btn primary sm" onClick={save} disabled={busy}><Icon name="check" size={14} /> Save settings</button>
        </span>
      </div>
    </div>
  );
}

// ---------- proposal ----------

export function ProposalCard({ proposal, crewName, onDone, onStale }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const res = proposal.result || {};
  const T = proposal.settings?.overloadThreshold ?? 1;
  const after = new Map((res.after || []).map((a) => [a.crewId, a]));
  const rows = (res.before || []).map((b) => ({ b, a: after.get(b.crewId) || b }));
  const scale = barScale(T, rows.flatMap(({ a, b }) => [a.load, b.load]));
  const moves = res.moves || [];
  const unassigned = res.unassigned || [];
  const notes = [...(res.warnings || [])];

  const apply = async () => {
    setBusy(true);
    try {
      const out = await dispatchApi.apply(proposal.id);
      toast(`Applied: ${out.moved} job${out.moved === 1 ? '' : 's'} moved${out.unassigned ? `, ${out.unassigned} left unassigned` : ''}`);
      onDone();
    } catch (e) {
      if (e.code === 'STALE_PROPOSAL') { onStale({ id: proposal.id, message: e.message, problems: e.problems || [] }); onDone(); }
      else toast(e.message, 'err');
    } finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await dispatchApi.reject(proposal.id, note.trim() || undefined); toast('Proposal rejected'); onDone(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--med)' }}>
      <div className="card-h">
        <h3>Rebalance proposal <span className="mono" style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>{proposal.id}</span></h3>
        <span className="eyebrow">awaiting approval</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 16 }}>
        <div style={{ fontSize: 13 }}>
          <b>{TRIGGER_TEXT[proposal.trigger] || proposal.trigger}</b>
          {proposal.trigger_detail && <span style={{ color: 'var(--ink-2)' }}> · {proposal.trigger_detail}</span>}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Proposed by {proposal.created_by || 'system'} · {when(proposal.created_at)} ({timeAgo(proposal.created_at)}). Nothing moves until it is applied.</div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Load before → after</div>
          <div style={{ display: 'grid', gap: 9 }}>
            {rows.map(({ b, a }) => (
              <div key={b.crewId} style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, 200px) 1fr 110px', gap: 12, alignItems: 'center' }}>
                <div style={{ fontSize: 12.5 }}>
                  {crewName(b.crewId)} <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>{b.crewId}</span>
                  {!b.onShift && <span className="chip chip-muted" style={{ marginLeft: 5 }}>off shift</span>}
                </div>
                <div style={{ display: 'grid', gap: 3 }}>
                  <LoadBar load={b.load} threshold={T} scale={scale} ghost />
                  <LoadBar load={a.load} threshold={T} scale={scale} />
                </div>
                <div className="mono" style={{ fontSize: 12, textAlign: 'right' }}>
                  <span style={{ color: b.over ? 'var(--crit)' : 'var(--muted)' }}>{pct(b.load)}</span>
                  {' → '}
                  <b style={{ color: a.over ? 'var(--crit)' : 'var(--ink)' }}>{pct(a.load)}</b>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Grey bar: now. Coloured bar: after applying.</div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Moves ({moves.length})</div>
          {moves.length ? (
            <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
              <thead><tr><th>Job</th><th>Incident</th><th>Priority</th><th>From → to</th><th>Reason</th><th style={{ textAlign: 'right' }}>Distance</th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.jobId}>
                    <td className="mono">{m.jobId}</td>
                    <td className="mono">{shortId(m.incidentId)}</td>
                    <td><PrioBadge priority={m.priority} medical={m.medical} /></td>
                    <td>{m.fromCrew ? crewName(m.fromCrew) : <i style={{ color: 'var(--muted)' }}>unassigned</i>} → <b>{crewName(m.toCrew)}</b></td>
                    <td>{REASON_TEXT[m.reason] || m.reason}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{m.distanceKm == null ? '—' : `${m.distanceKm} km`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No jobs move.</div>}
        </div>

        {unassigned.length > 0 && (
          <div style={{ background: 'var(--crit-bg)', border: '1px solid var(--crit)', borderRadius: 9, padding: '10px 12px' }}>
            <div style={{ fontWeight: 600, color: 'var(--crit)', fontSize: 13, marginBottom: 6 }}>
              {unassigned.length} job{unassigned.length > 1 ? 's' : ''} cannot be covered and will be left unassigned
            </div>
            {unassigned.map((u) => (
              <div key={u.jobId} style={{ fontSize: 12.5 }}>
                <span className="mono">{u.jobId}</span> from {crewName(u.fromCrew)}: {u.reason}
              </div>
            ))}
          </div>
        )}

        {notes.length > 0 && (
          <div style={{ background: 'var(--high-bg)', borderRadius: 9, padding: '10px 12px', fontSize: 12.5, color: 'var(--ink-2)' }}>
            <div style={{ fontWeight: 600, color: 'var(--high)', marginBottom: 4 }}>Left as is</div>
            {notes.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          {rejecting && <input style={{ ...inp, width: 280 }} placeholder="Reason for rejecting (optional)" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}
          {rejecting
            ? <><button className="btn sm" onClick={() => setRejecting(false)} disabled={busy}>Cancel</button>
                <button className="btn danger sm" onClick={reject} disabled={busy}><Icon name="x" size={14} /> Confirm reject</button></>
            : <button className="btn danger sm" onClick={() => setRejecting(true)} disabled={busy}><Icon name="x" size={14} /> Reject</button>}
          <button className="btn primary sm" onClick={apply} disabled={busy || rejecting}><Icon name="check" size={14} /> Approve &amp; apply</button>
        </div>
      </div>
    </div>
  );
}

// ---------- history ----------

export function HistoryCard({ history, crewName }) {
  const [tab, setTab] = useState('reassignments');
  const { proposals = [], reassignments = [] } = history || {};
  return (
    <div className="card">
      <div className="card-h">
        <h3>Rebalance history</h3>
        <div className="seg">
          <button className={tab === 'reassignments' ? 'on' : ''} onClick={() => setTab('reassignments')}>Reassignments ({reassignments.length})</button>
          <button className={tab === 'proposals' ? 'on' : ''} onClick={() => setTab('proposals')}>Proposals ({proposals.length})</button>
        </div>
      </div>
      <div className="card-b" style={{ maxHeight: 380, overflow: 'auto' }}>
        {tab === 'reassignments' && (reassignments.length ? (
          <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>When</th><th>Job</th><th>Incident</th><th>From</th><th>To</th><th>Reason</th><th>By</th><th>Proposal</th></tr></thead>
            <tbody>
              {reassignments.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{when(r.ts)}</td>
                  <td className="mono">{r.job_id}</td>
                  <td className="mono">{shortId(r.incident_id)}</td>
                  <td>{r.from_crew ? crewName(r.from_crew) : '—'}</td>
                  <td>{r.to_crew ? crewName(r.to_crew) : <span className="chip chip-crit">unassigned</span>}</td>
                  <td style={{ maxWidth: 280 }}>{REASON_TEXT[r.reason] || r.reason}</td>
                  <td>{r.actor}</td>
                  <td className="mono" style={{ color: 'var(--muted)' }}>{r.proposal_id || 'manual'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">No reassignments yet.</div>)}
        {tab === 'proposals' && (proposals.length ? (
          <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>Decided</th><th>Proposal</th><th>Trigger</th><th>Outcome</th><th>Moves</th><th>Unassigned</th><th>By</th><th>Note</th></tr></thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{when(p.decided_at || p.created_at)}</td>
                  <td className="mono">{p.id}</td>
                  <td>{TRIGGER_TEXT[p.trigger] || p.trigger}</td>
                  <td><span className={`chip ${STATUS_CHIP[p.status] || 'chip-muted'}`}>{p.status}</span></td>
                  <td className="mono">{p.result?.moves?.length ?? 0}</td>
                  <td className="mono">{p.result?.unassigned?.length ?? 0}</td>
                  <td>{p.decided_by || '—'}</td>
                  <td style={{ maxWidth: 300, color: 'var(--ink-2)' }}>{p.decision_note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">No decided proposals yet.</div>)}
      </div>
    </div>
  );
}
