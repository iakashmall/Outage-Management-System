// A switching plan's editor, step list, approval buttons and safety log --
// shared by a planned outage (screens/PlannedOutages.jsx) and a fault
// incident's own plan (screens/Incidents.jsx, OMS-05). The server enforces
// every rule (domain/plannedOutage.js); these show what it allows and pass
// its refusals on verbatim. Who owns the plan only changes which API calls
// the caller passes in.
import { useEffect, useState } from 'react';
import { plannedApi } from '../lib/plannedApi.js';
import { hhmm, timeAgo, toast } from '../lib/ui.jsx';
import { useT, t, locale } from '../lib/i18n.js';

export const ACTION_TEXT = {
  open: 'OPEN', close: 'CLOSE', rack_out: 'Rack out', rack_in: 'Rack in', test_dead: 'Test dead',
  earth_apply: 'Apply earth', earth_remove: 'Remove earth', tag_apply: 'Apply danger tag', tag_remove: 'Remove danger tag',
};
const ACTIONS = Object.keys(ACTION_TEXT);
export const when = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '-');
export const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13 };
export const fail = (e) => toast(e.code ? `${e.message} (${e.code})` : e.message, 'err', 9000);

// Approve / return-to-draft, shown in the caller's own row of actions.
export function PlanApprovalButtons({ plan, steps, act, onApprove, onUnapprove }) {
  useT();
  const anyConfirmed = steps.some((s) => s.state === 'confirmed');
  return (
    <>
      {plan.state === 'draft' && <button className="btn sm primary" onClick={() => window.confirm(t('po.approveConfirm')) && act(onApprove, t('po.planApproved'))}>{t('po.approvePlan')}</button>}
      {plan.state === 'approved' && !anyConfirmed && <button className="btn sm" onClick={() => act(onUnapprove, t('po.planToDraft'))}>{t('po.returnToDraft')}</button>}
    </>
  );
}

// Draft plan: an editable ordered list per phase. Order on screen = seq.
// onDraft({ workMrid, crewId }) builds a draft from the network trace;
// onSave(steps) saves the operator's steps.
export function PlanEditor({ plan, steps, crews, defaultMrid = '', defaultCrew = '', onDraft, onSave, onSaved }) {
  useT();
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
    try { await onSave(out); toast(t('po.planSaved')); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };
  const draft = async () => {
    setBusy(true);
    try { await onDraft({ workMrid: mrid, crewId: traceCrew }); toast(t('po.draftBuilt')); onSaved(); } catch (e) { fail(e); }
    setBusy(false);
  };

  return (
    <div>
      {plan?.trace_caveat && <Caveat text={plan.trace_caveat} />}
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

export function Caveat({ text }) {
  useT();
  return (
    <div style={{ background: 'var(--high-bg)', color: 'var(--ink)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, marginBottom: 12 }}>
      <b>{t('po.caveatTitle')}</b> {text} {t('po.caveatCheck')}
    </div>
  );
}

// Approved plan: steps in order. Only the next step of a phase can be
// confirmed; the server refuses anything else and the refusal is shown.
// The confirm route is the same for every plan owner.
export function StepList({ plan, steps, act, ask }) {
  useT();
  const nextOf = (phase) => steps.find((s) => s.phase === phase && s.state !== 'confirmed');
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
      {plan.trace_caveat && <Caveat text={plan.trace_caveat} />}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{t('po.approvedBy', { who: plan.approved_by, ago: timeAgo(plan.approved_at) })}</div>
      {['isolate', 'restore'].map((phase) => {
        const next = nextOf(phase);
        return (
          <div key={phase} style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{t(`po.phase.${phase}`)}</div>
            {steps.filter((s) => s.phase === phase).map((s) => (
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

export function SafetyLog({ log }) {
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
