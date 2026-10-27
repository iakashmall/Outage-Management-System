// A switching plan's editor, step list, approval buttons and safety log --
// shared by a planned outage (screens/PlannedOutages.jsx) and a fault
// incident's own plan (screens/Incidents.jsx, OMS-05). The server enforces
// every rule (domain/plannedOutage.js); these show what it allows and pass
// its refusals on verbatim. Who owns the plan only changes which API calls
// the caller passes in.
import { useEffect, useState } from 'react';
import { plannedApi } from '../lib/plannedApi.js';
import { hhmm, timeAgo, toast } from '../lib/ui.jsx';

export const ACTION_TEXT = {
  open: 'OPEN', close: 'CLOSE', rack_out: 'Rack out', rack_in: 'Rack in', test_dead: 'Test dead',
  earth_apply: 'Apply earth', earth_remove: 'Remove earth', tag_apply: 'Apply danger tag', tag_remove: 'Remove danger tag',
};
const ACTIONS = Object.keys(ACTION_TEXT);
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13 };
export const fail = (e) => toast(e.code ? `${e.message} (${e.code})` : e.message, 'err', 9000);

// Approve / return-to-draft, shown in the caller's own row of actions.
export function PlanApprovalButtons({ plan, steps, act, onApprove, onUnapprove }) {
  const anyConfirmed = steps.some((s) => s.state === 'confirmed');
  return (
    <>
      {plan.state === 'draft' && <button className="btn sm primary" onClick={() => window.confirm('Approve this switching plan? You take responsibility for the order and content of every step.') && act(onApprove, 'Plan approved')}>Approve plan</button>}
      {plan.state === 'approved' && !anyConfirmed && <button className="btn sm" onClick={() => act(onUnapprove, 'Plan back to draft')}>Return plan to draft</button>}
    </>
  );
}

// Draft plan: an editable ordered list per phase. Order on screen = seq.
// onDraft({ workMrid, crewId }) builds a draft from the network trace;
// onSave(steps) saves the operator's steps.
export function PlanEditor({ plan, steps, crews, defaultMrid = '', defaultCrew = '', onDraft, onSave, onSaved }) {
  const fromServer = (s) => ({ phase: s.phase, action: s.action, device_label: s.device_label, location: s.location, device_mrid: s.device_mrid, assignee: s.assignee, assignee_crew_id: s.assignee_crew_id || '' });
  const [rows, setRows] = useState(steps.map(fromServer));
  const [mrid, setMrid] = useState(defaultMrid);
  const [traceCrew, setTraceCrew] = useState(defaultCrew);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(steps.map(fromServer)); }, [steps.map((s) => s.id).join()]); // eslint-disable-line

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
    const out = ['isolate', 'restore'].flatMap((phase) => rows.filter((r) => r.phase === phase).map((r, i) => ({
      ...r, seq: i + 1, assignee_crew_id: r.assignee === 'crew' ? r.assignee_crew_id : null,
    })));
    setBusy(true);
    try { await onSave(out); toast('Plan saved'); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };
  const draft = async () => {
    setBusy(true);
    try { await onDraft({ workMrid: mrid, crewId: traceCrew }); toast('Draft built from the network trace - review every step'); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };

  return (
    <div>
      {plan?.trace_caveat && <Caveat text={plan.trace_caveat} />}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5 }}>
        <span className="eyebrow">Draft from network trace</span>
        <input style={{ ...inp, width: 180 }} placeholder="work equipment mRID" value={mrid} onChange={(e) => setMrid(e.target.value)} />
        <select style={{ ...inp, width: 'auto' }} value={traceCrew} onChange={(e) => setTraceCrew(e.target.value)}>
          <option value="">crew for line steps…</option>
          {crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
        <button className="btn sm" disabled={busy || !mrid || !traceCrew} onClick={draft}>Build draft</button>
      </div>
      {['isolate', 'restore'].map((phase) => (
        <div key={phase} style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>{phase === 'isolate' ? 'Isolate (in this order)' : 'Restore (in this order)'}</div>
          {rows.map((r, i) => r.phase !== phase ? null : (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '24px 120px 1fr 1fr 130px 90px 64px', gap: 6, alignItems: 'center', marginBottom: 5 }}>
              <span className="mono" style={{ color: 'var(--muted)' }}>{rows.slice(0, i + 1).filter((x) => x.phase === phase).length}</span>
              <select style={inp} value={r.action} onChange={(e) => upd(i, 'action', e.target.value)}>{ACTIONS.map((a) => <option key={a} value={a}>{ACTION_TEXT[a]}</option>)}</select>
              <input style={inp} placeholder="device" value={r.device_label} onChange={(e) => upd(i, 'device_label', e.target.value)} />
              <input style={inp} placeholder="location" value={r.location} onChange={(e) => upd(i, 'location', e.target.value)} />
              <select style={inp} value={r.assignee} onChange={(e) => upd(i, 'assignee', e.target.value)}>
                <option value="control_room">Control room</option><option value="crew">Crew</option>
              </select>
              {r.assignee === 'crew'
                ? <select style={inp} value={r.assignee_crew_id} onChange={(e) => upd(i, 'assignee_crew_id', e.target.value)}><option value="">crew…</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
                : <span />}
              <span style={{ display: 'flex', gap: 2 }}>
                <button className="btn sm" title="Move up" onClick={() => move(i, -1)}>↑</button>
                <button className="btn sm" title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
              </span>
            </div>
          ))}
          <button className="btn sm" onClick={() => add(phase)}>+ {phase} step</button>
        </div>
      ))}
      <button className="btn primary" disabled={busy} onClick={save}>Save plan</button>
    </div>
  );
}

export function Caveat({ text }) {
  return (
    <div style={{ background: 'var(--high-bg)', color: 'var(--ink)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, marginBottom: 12 }}>
      <b>Drafted from the network trace.</b> {text} Check every step's device, order and earthing before approving.
    </div>
  );
}

// Approved plan: steps in order. Only the next step of a phase can be
// confirmed; the server refuses anything else and the refusal is shown.
// The confirm route is the same for every plan owner.
export function StepList({ plan, steps, act, ask }) {
  const nextOf = (phase) => steps.find((s) => s.phase === phase && s.state !== 'confirmed');
  const confirmStep = (s) => {
    const what = `${ACTION_TEXT[s.action]} ${s.device_label} at ${s.location}`;
    if (s.assignee === 'crew') {
      const note = ask(`Crew step: ${what}\n\nRecord it ON BEHALF of crew ${s.assignee_crew_id}? Enter who reported it and how (e.g. "crew03 lead by radio 14:05"):`);
      if (note) act(() => plannedApi.confirmStep(s.id, { onBehalfNote: note }), 'Crew step recorded');
    } else if (window.confirm(`Confirm DONE: ${what}?\n\nOnly confirm after the operation has actually been carried out.`)) {
      act(() => plannedApi.confirmStep(s.id, {}), 'Step confirmed');
    }
  };
  return (
    <div>
      {plan.trace_caveat && <Caveat text={plan.trace_caveat} />}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Approved by {plan.approved_by} {timeAgo(plan.approved_at)}</div>
      {['isolate', 'restore'].map((phase) => {
        const next = nextOf(phase);
        return (
          <div key={phase} style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{phase === 'isolate' ? 'Isolate' : 'Restore'}</div>
            {steps.filter((s) => s.phase === phase).map((s) => (
              <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 8, alignItems: 'center', padding: '7px 9px', marginBottom: 4, borderRadius: 7,
                border: `1px solid ${next?.id === s.id ? 'var(--navy)' : 'var(--line)'}`, background: s.state === 'confirmed' ? 'var(--low-bg)' : 'var(--surface)' }}>
                <span className="mono">{s.seq}</span>
                <span>
                  <b>{ACTION_TEXT[s.action]}</b> {s.device_label} <span style={{ color: 'var(--muted)' }}>· {s.location}</span>
                  <span style={{ marginLeft: 6, fontSize: 11, border: '1px solid var(--line-2)', borderRadius: 4, padding: '0 5px' }}>{s.assignee === 'crew' ? `Crew ${s.assignee_crew_id}` : 'Control room'}</span>
                  {s.state === 'confirmed' && (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      ✓ {s.confirmed_by} · done {when(s.performed_at)}{s.received_at && Math.abs(new Date(s.received_at) - new Date(s.performed_at)) > 60000 ? ` (received ${hhmm(s.received_at)})` : ''}
                      {s.on_behalf_note && ` · on behalf: ${s.on_behalf_note}`}
                    </div>
                  )}
                </span>
                {s.state !== 'confirmed' && next?.id === s.id
                  ? <button className="btn sm primary" onClick={() => confirmStep(s)}>{s.assignee === 'crew' ? 'Record on behalf…' : 'Confirm done'}</button>
                  : <span style={{ fontSize: 12, color: s.state === 'confirmed' ? 'var(--low)' : 'var(--muted)' }}>{s.state === 'confirmed' ? 'Confirmed' : 'Pending'}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function SafetyLog({ log }) {
  if (!log.length) return <div className="empty">Nothing recorded yet.</div>;
  return (
    <div style={{ maxHeight: 420, overflow: 'auto' }}>
      <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Change</th><th>Detail</th></tr></thead>
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
