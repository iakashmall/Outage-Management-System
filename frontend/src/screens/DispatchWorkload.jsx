// OMS-03 workload balancing panels for the Dispatch tab: per-crew load bars
// with crew controls, the settings editor, the open rebalance proposal
// (approve & apply / reject) and the reassignment history. Data comes from
// lib/dispatchApi.js; the Dispatch screen owns loading and live refresh.
import { useState } from 'react';
import { dispatchApi } from '../lib/dispatchApi.js';
import { CrewDot, Icon, timeAgo, toast } from '../lib/ui.jsx';
import { getLang, t, tOr, useT } from '../lib/i18n.js';

export const PRIORITIES = ['Critical', 'VIP', 'Urgent', 'Normal']; // high -> low
const PRIO_CHIP = { Critical: 'chip-crit', VIP: 'chip-major', Urgent: 'chip-minor', Normal: 'chip-muted' };

export const PrioBadge = ({ priority, medical }) => (useT(),
  <>
    <span className={`chip ${PRIO_CHIP[priority] || 'chip-muted'}`}>{tOr(`wl.prio.${priority}`, priority)}</span>
    {medical && <span className="chip chip-crit" style={{ marginLeft: 4 }} title={t('wl.medicalTitle')}>{t('wl.medical')}</span>}
  </>
);

const TRIGGER_TEXT = {
  manual: 'Manual rebalance', crew_added: 'Crew added', crew_off_shift: 'Crew went off shift',
  crew_on_shift: 'Crew back on shift', capacity_changed: 'Capacity changed', crew_updated: 'Crew area or skills changed',
};
const REASON_TEXT = { overload: 'Overload', crew_off_shift: 'Crew off shift', flagged_reassign: 'Was unassigned', manual_assign: 'Manual assign' };
const STATUS_CHIP = { applied: 'chip-ok', rejected: 'chip-crit', stale: 'chip-major', superseded: 'chip-muted', proposed: 'chip-minor' };

const pct = (load) => `${Math.round((load || 0) * 100)}%`;
const when = (iso) => (iso ? new Date(iso).toLocaleString(getLang() === 'hi' ? 'hi-IN' : [], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const shortId = (id) => (id ? String(id).replace(/^INC-\d{4}-0*/, 'INC-') : '—');

export const inp = { width: '100%', padding: '7px 9px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13, background: 'var(--surface)', color: 'var(--ink)' };
export const Field = ({ label, children, span }) => (
  <label style={{ display: 'block', gridColumn: span ? '1 / -1' : undefined }}>
    <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>{children}
  </label>
);

// A crew change answers with the rebalance it triggered (never applied).
export function reportRebalance(rb) {
  if (rb?.proposal) toast(t('dsp.proposalReady'));
  else if (rb?.reason === 'balanced') toast(t('dsp.balanced'));
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
      <span title={t('wl.thresholdTitle', { p: pct(threshold) })}
        style={{ position: 'absolute', left: `${(threshold / scale) * 100}%`, top: -4, bottom: -4, width: 2, marginLeft: -1, background: 'var(--ink-2)', borderRadius: 1 }} />
    </div>
  );
}

// ---------- workload ----------

export function WorkloadPanel({ data, areas, onChanged }) {
  useT();
  const [editing, setEditing] = useState(null);
  const T = data.settings.overloadThreshold;
  const scale = barScale(T, data.crews.map((c) => c.load));
  const over = data.crews.filter((c) => c.over && c.on_shift).length;

  const setShift = async (c, on_shift) => {
    try {
      const out = await dispatchApi.updateCrew(c.id, { on_shift });
      toast(t(on_shift ? 'wl.backOnShift' : 'wl.wentOffShift', { name: c.name }));
      reportRebalance(out.rebalance);
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span>{t('wl.loadFormula')}</span>
        <span><span style={{ display: 'inline-block', width: 2, height: 10, background: 'var(--ink-2)', verticalAlign: 'middle', marginRight: 5 }} />{t('wl.threshold', { p: pct(T) })}</span>
        {over > 0 && <span style={{ color: 'var(--crit)', fontWeight: 600 }}>{t(over > 1 ? 'wl.overMany' : 'wl.overOne', { n: over })}</span>}
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
                {c.aor?.length ? t('wl.aor', { list: c.aor.join(', ') }) : t('wl.aorAll')}
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                <span className="mono" style={{ fontWeight: 600, color: c.over ? 'var(--crit)' : 'var(--ink)' }}>{pct(c.load)}</span>
                <span className="mono" style={{ color: 'var(--muted)' }}>{c.weight} / {c.capacity ?? data.settings.defaultCapacity} h · {t(c.jobs.length === 1 ? 'wl.jobOne' : 'wl.jobMany', { n: c.jobs.length })}</span>
              </div>
              <LoadBar load={c.load} threshold={T} scale={scale} />
              {c.jobs.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                  {c.jobs.map((j) => (
                    <span key={j.id} title={`${j.id} · ${tOr(`drw.job.${j.status}`, j.status)} · ${t('wl.jobTitleWeight', { w: j.weight })}${j.required_skill ? ` · ${t('wl.jobTitleNeeds', { s: j.required_skill })}` : ''}${j.movable ? '' : ` · ${t('wl.cannotMove')}`}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px 1px 4px', background: 'var(--surface)' }}>
                      <PrioBadge priority={j.effectivePriority} medical={j.medical} />
                      <span className="mono">{j.id}</span>
                      {!j.movable && <span style={{ color: 'var(--muted)' }}>· {j.planned ? t('wl.planned') : tOr(`drw.job.${j.status}`, j.status)}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div className="seg" role="group" aria-label={t('wl.shiftAria', { name: c.name })}>
                <button className={c.on_shift ? 'on' : ''} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => !c.on_shift && setShift(c, true)}>{t('wl.onShift')}</button>
                <button className={c.on_shift ? '' : 'on'} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => c.on_shift && setShift(c, false)}>{t('wl.off')}</button>
              </div>
              <button className="btn sm" onClick={() => setEditing(editing === c.id ? null : c.id)}>{editing === c.id ? t('wl.close') : t('wl.edit')}</button>
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
  useT();
  const set = new Set(value);
  const toggle = (v) => onChange(set.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div style={{ ...inp, maxHeight: 132, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '2px 10px' }}>
      {areas.map((a) => (
        <label key={a.value} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={set.has(a.value)} onChange={() => toggle(a.value)} />{a.label || a.value}
        </label>
      ))}
      {!areas.length && <span style={{ color: 'var(--muted)' }}>{t('wl.noAreas')}</span>}
    </div>
  );
}

function CrewEditor({ crew, areas, onDone }) {
  useT();
  const [f, setF] = useState({ capacity: String(crew.capacity ?? ''), skills: (crew.skills || []).join(', '), aor: crew.aor || [] });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const patch = {};
    const cap = Number(f.capacity);
    if (!(cap > 0)) { toast(t('wl.capPositive'), 'err'); return; }
    if (cap !== Number(crew.capacity)) patch.capacity = cap;
    const skills = f.skills.split(',').map((s) => s.trim()).filter(Boolean);
    if (skills.join(',') !== (crew.skills || []).join(',')) patch.skills = skills;
    const aorChanged = f.aor.length !== (crew.aor || []).length || f.aor.some((a) => !(crew.aor || []).includes(a));
    if (aorChanged) patch.aor = f.aor.length ? f.aor : null;
    if (!Object.keys(patch).length) { onDone(); return; }
    setBusy(true);
    try {
      const out = await dispatchApi.updateCrew(crew.id, patch);
      toast(t('wl.updated', { name: crew.name }));
      reportRebalance(out.rebalance);
      onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
      <Field label={t('wl.capacity')}><input style={inp} type="number" min="0.5" max="100" step="0.5" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
      <Field label={t('wl.skills')}><input style={inp} value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} placeholder={t('wl.skillsPh')} /></Field>
      <Field label={t('wl.aorField')} span><AreaPicker areas={areas} value={f.aor} onChange={(aor) => setF({ ...f, aor })} /></Field>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm" onClick={onDone} disabled={busy}>{t('wl.cancel')}</button>
        <button className="btn primary sm" onClick={save} disabled={busy}><Icon name="check" size={14} /> {t('wl.save')}</button>
      </div>
    </div>
  );
}

export function AddCrewForm({ areas, defaultCapacity, onDone }) {
  useT();
  const [f, setF] = useState({ name: '', lead: '', id: '', skills: '', capacity: String(defaultCapacity ?? ''), lat: '', lon: '', aor: [] });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.name.trim()) { toast(t('wl.nameReq'), 'err'); return; }
    const body = { name: f.name.trim(), lead: f.lead.trim() || undefined, skills: f.skills, aor: f.aor.length ? f.aor : null };
    if (f.id.trim()) body.id = f.id.trim();
    if (f.capacity !== '') body.capacity = Number(f.capacity);
    // Both or neither: a lone coordinate would otherwise be stored with 0 for the other.
    if ((f.lat === '') !== (f.lon === '')) { toast(t('wl.bothCoords'), 'err'); return; }
    if (f.lat !== '') {
      const lat = Number(f.lat), lon = Number(f.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast(t('wl.badCoords'), 'err'); return; }
      body.lat = lat; body.lon = lon;
    }
    setBusy(true);
    try {
      const out = await dispatchApi.addCrew(body);
      toast(t('wl.crewAdded', { id: out.crew.id }));
      reportRebalance(out.rebalance);
      onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      <Field label={t('wl.name')}><input style={inp} maxLength={100} value={f.name} onChange={set('name')} placeholder={t('wl.namePh')} /></Field>
      <Field label={t('wl.lead')}><input style={inp} maxLength={100} value={f.lead} onChange={set('lead')} /></Field>
      <Field label={t('wl.idOpt')}><input style={inp} value={f.id} onChange={set('id')} placeholder={t('wl.idPh')} /></Field>
      <Field label={t('wl.capacity')}><input style={inp} type="number" min="0.5" max="100" step="0.5" value={f.capacity} onChange={set('capacity')} /></Field>
      <div style={{ gridColumn: 'span 2' }}><Field label={t('wl.skills')}><input style={inp} value={f.skills} onChange={set('skills')} placeholder={t('wl.skillsPh')} /></Field></div>
      <Field label={t('wl.baseLat')}><input style={inp} type="number" min="-90" max="90" step="any" value={f.lat} onChange={set('lat')} /></Field>
      <Field label={t('wl.baseLon')}><input style={inp} type="number" min="-180" max="180" step="any" value={f.lon} onChange={set('lon')} /></Field>
      <Field label={t('wl.aorField')} span><AreaPicker areas={areas} value={f.aor} onChange={(aor) => setF({ ...f, aor })} /></Field>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm" onClick={onDone} disabled={busy}>{t('wl.cancel')}</button>
        <button className="btn primary sm" onClick={submit} disabled={busy}><Icon name="plus" size={14} /> {t('wl.addCrew')}</button>
      </div>
    </div>
  );
}

export function SettingsEditor({ settings, onDone }) {
  useT();
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
      toast(t('wl.settingsSaved'));
      onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {PRIORITIES.map((p) => (
          <Field key={p} label={t('wl.weight', { p: tOr(`wl.prio.${p}`, p) })}><input style={inp} type="number" min="0.1" max="100" step="0.1" value={f[p]} onChange={set(p)} /></Field>
        ))}
        <Field label={t('wl.thresholdPct')}><input style={inp} type="number" min="10" max="500" step="5" value={f.threshold} onChange={set('threshold')} /></Field>
        <Field label={t('wl.defDuration')}><input style={inp} type="number" min="1" max="10080" value={f.duration} onChange={set('duration')} /></Field>
        <Field label={t('wl.defCapacity')}><input style={inp} type="number" min="0.5" max="100" step="0.5" value={f.capacity} onChange={set('capacity')} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('wl.weightNote')}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn sm" onClick={onDone} disabled={busy}>{t('wl.cancel')}</button>
          <button className="btn primary sm" onClick={save} disabled={busy}><Icon name="check" size={14} /> {t('wl.saveSettings')}</button>
        </span>
      </div>
    </div>
  );
}

// ---------- proposal ----------

export function ProposalCard({ proposal, crewName, onDone, onStale }) {
  const [busy, setBusy] = useState(false);
  useT();
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
      toast(t(out.moved === 1 ? 'wl.appliedMsgOne' : 'wl.appliedMsg', { n: out.moved }) + (out.unassigned ? t('wl.leftUnassigned', { n: out.unassigned }) : ''));
      onDone();
    } catch (e) {
      if (e.code === 'STALE_PROPOSAL') { onStale({ id: proposal.id, message: e.message, problems: e.problems || [] }); onDone(); }
      else toast(e.message, 'err');
    } finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await dispatchApi.reject(proposal.id, note.trim() || undefined); toast(t('wl.rejected')); onDone(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--med)' }}>
      <div className="card-h">
        <h3>{t('wl.proposal')} <span className="mono" style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>{proposal.id}</span></h3>
        <span className="eyebrow">{t('wl.awaiting')}</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 16 }}>
        <div style={{ fontSize: 13 }}>
          <b>{tOr(`wl.trig.${proposal.trigger}`, TRIGGER_TEXT[proposal.trigger] || proposal.trigger)}</b>
          {proposal.trigger_detail && <span style={{ color: 'var(--ink-2)' }}> · {proposal.trigger_detail}</span>}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{t('wl.proposedBy', { by: proposal.created_by || t('wl.system'), when: when(proposal.created_at), ago: timeAgo(proposal.created_at) })}</div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{t('wl.beforeAfter')}</div>
          <div style={{ display: 'grid', gap: 9 }}>
            {rows.map(({ b, a }) => (
              <div key={b.crewId} style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, 200px) 1fr 110px', gap: 12, alignItems: 'center' }}>
                <div style={{ fontSize: 12.5 }}>
                  {crewName(b.crewId)} <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>{b.crewId}</span>
                  {!b.onShift && <span className="chip chip-muted" style={{ marginLeft: 5 }}>{t('wl.offShift')}</span>}
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
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{t('wl.barLegend')}</div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>{t('wl.moves', { n: moves.length })}</div>
          {moves.length ? (
            <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
              <thead><tr><th>{t('wl.colJob')}</th><th>{t('wl.colIncident')}</th><th>{t('wl.colPriority')}</th><th>{t('wl.colFromTo')}</th><th>{t('wl.colReason')}</th><th style={{ textAlign: 'right' }}>{t('wl.colDistance')}</th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.jobId}>
                    <td className="mono">{m.jobId}</td>
                    <td className="mono">{shortId(m.incidentId)}</td>
                    <td><PrioBadge priority={m.priority} medical={m.medical} /></td>
                    <td>{m.fromCrew ? crewName(m.fromCrew) : <i style={{ color: 'var(--muted)' }}>{t('wl.unassigned')}</i>} → <b>{crewName(m.toCrew)}</b></td>
                    <td>{tOr(`wl.reason.${m.reason}`, REASON_TEXT[m.reason] || m.reason)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{m.distanceKm == null ? '—' : `${m.distanceKm} km`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t('wl.noMoves')}</div>}
        </div>

        {unassigned.length > 0 && (
          <div style={{ background: 'var(--crit-bg)', border: '1px solid var(--crit)', borderRadius: 9, padding: '10px 12px' }}>
            <div style={{ fontWeight: 600, color: 'var(--crit)', fontSize: 13, marginBottom: 6 }}>
              {t(unassigned.length > 1 ? 'wl.uncoveredMany' : 'wl.uncoveredOne', { n: unassigned.length })}
            </div>
            {unassigned.map((u) => (
              <div key={u.jobId} style={{ fontSize: 12.5 }}>
                <span className="mono">{u.jobId}</span> {t('wl.fromCrew', { name: crewName(u.fromCrew) })} {u.reason}
              </div>
            ))}
          </div>
        )}

        {notes.length > 0 && (
          <div style={{ background: 'var(--high-bg)', borderRadius: 9, padding: '10px 12px', fontSize: 12.5, color: 'var(--ink-2)' }}>
            <div style={{ fontWeight: 600, color: 'var(--high)', marginBottom: 4 }}>{t('wl.leftAsIs')}</div>
            {notes.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          {rejecting && <input style={{ ...inp, width: 280 }} placeholder={t('wl.rejectPh')} value={note} onChange={(e) => setNote(e.target.value)} autoFocus /* eslint-disable-line jsx-a11y/no-autofocus -- opened by the user's own click */ />}
          {rejecting
            ? <><button className="btn sm" onClick={() => setRejecting(false)} disabled={busy}>{t('wl.cancel')}</button>
                <button className="btn danger sm" onClick={reject} disabled={busy}><Icon name="x" size={14} /> {t('wl.confirmReject')}</button></>
            : <button className="btn danger sm" onClick={() => setRejecting(true)} disabled={busy}><Icon name="x" size={14} /> {t('wl.reject')}</button>}
          <button className="btn primary sm" onClick={apply} disabled={busy || rejecting}><Icon name="check" size={14} /> {t('wl.approve')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- history ----------

export function HistoryCard({ history, crewName }) {
  useT();
  const [tab, setTab] = useState('reassignments');
  const { proposals = [], reassignments = [] } = history || {};
  return (
    <div className="card">
      <div className="card-h">
        <h3>{t('wl.history')}</h3>
        <div className="seg">
          <button className={tab === 'reassignments' ? 'on' : ''} onClick={() => setTab('reassignments')}>{t('wl.reassignments', { n: reassignments.length })}</button>
          <button className={tab === 'proposals' ? 'on' : ''} onClick={() => setTab('proposals')}>{t('wl.proposals', { n: proposals.length })}</button>
        </div>
      </div>
      <div className="card-b" style={{ maxHeight: 380, overflow: 'auto' }}>
        {tab === 'reassignments' && (reassignments.length ? (
          <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>{t('wl.colWhen')}</th><th>{t('wl.colJob')}</th><th>{t('wl.colIncident')}</th><th>{t('wl.colFrom')}</th><th>{t('wl.colTo')}</th><th>{t('wl.colReason')}</th><th>{t('wl.colBy')}</th><th>{t('wl.colProposal')}</th></tr></thead>
            <tbody>
              {reassignments.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{when(r.ts)}</td>
                  <td className="mono">{r.job_id}</td>
                  <td className="mono">{shortId(r.incident_id)}</td>
                  <td>{r.from_crew ? crewName(r.from_crew) : '—'}</td>
                  <td>{r.to_crew ? crewName(r.to_crew) : <span className="chip chip-crit">{t('wl.unassigned')}</span>}</td>
                  <td style={{ maxWidth: 280 }}>{tOr(`wl.reason.${r.reason}`, REASON_TEXT[r.reason] || r.reason)}</td>
                  <td>{r.actor}</td>
                  <td className="mono" style={{ color: 'var(--muted)' }}>{r.proposal_id || t('wl.manual')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">{t('wl.noReassign')}</div>)}
        {tab === 'proposals' && (proposals.length ? (
          <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
            <thead><tr><th>{t('wl.colDecided')}</th><th>{t('wl.colProposal')}</th><th>{t('wl.colTrigger')}</th><th>{t('wl.colOutcome')}</th><th>{t('wl.colMoves')}</th><th>{t('wl.colUnassigned')}</th><th>{t('wl.colBy')}</th><th>{t('wl.colNote')}</th></tr></thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{when(p.decided_at || p.created_at)}</td>
                  <td className="mono">{p.id}</td>
                  <td>{tOr(`wl.trig.${p.trigger}`, TRIGGER_TEXT[p.trigger] || p.trigger)}</td>
                  <td><span className={`chip ${STATUS_CHIP[p.status] || 'chip-muted'}`}>{tOr(`wl.pst.${p.status}`, p.status)}</span></td>
                  <td className="mono">{p.result?.moves?.length ?? 0}</td>
                  <td className="mono">{p.result?.unassigned?.length ?? 0}</td>
                  <td>{p.decided_by || '—'}</td>
                  <td style={{ maxWidth: 300, color: 'var(--ink-2)' }}>{p.decision_note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">{t('wl.noProposals')}</div>)}
      </div>
    </div>
  );
}
