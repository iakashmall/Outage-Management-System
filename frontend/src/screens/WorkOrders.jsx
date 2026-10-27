// OMS-03 daily work orders: every crew's day for one date, read-only. Crews
// start and end their day in the crew app; this screen only reads
// GET /work-orders. A closed day is shown from the crew's own end-of-day
// record (close_snapshot). A day not closed is shown from the jobs as they
// are now, which only describes that day when it is today: for an earlier
// day only the jobs finished on it are shown.
import { useEffect, useRef, useState } from 'react';
import { workOrderApi } from '../lib/workOrderApi.js';
import { keycloak } from '../lib/auth.js';
import { hhmm, useLiveRefresh } from '../lib/ui.jsx';
import { PrioBadge, inp } from './DispatchWorkload.jsx';
import { locale, t, tOr, useT } from '../lib/i18n.js';

// Same values as CARRY_REASONS in the crew app (src/lib/workOrder.js).
const REASON_TEXT = {
  not_reached: 'Not reached', awaiting_permit: 'Waiting for permit / shutdown', material: 'Material not available',
  next_shift: 'Handed to next shift', other: 'Other',
};
// [label, chip class, sort order]: not started first, it is what a dispatcher scans for.
const STATUS = { not_started: ['Not started', 'chip-crit', 0], started: ['In progress', 'chip-minor', 1], closed: ['Day ended', 'chip-ok', 2] };
// Starting / ending a day publishes crew.updated, which also fires on every GPS tick.
const TOPICS = ['crew.updated', 'crew.job.updated'];

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayText = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortId = (id) => (id ? String(id).replace(/^INC-\d{4}-0*/, 'INC-') : '—');

export default function WorkOrders() {
  useT();
  const [today, setToday] = useState(null);   // the server's working day, from the first answer
  const [date, setDate] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const asked = useRef(null);                 // the date of the latest request; older answers are ignored

  // quiet: a background refresh keeps what is on screen if it fails.
  const load = (d, quiet) => {
    asked.current = d;
    if (!quiet) setLoading(true);
    return workOrderApi.day(d)
      .then((out) => {
        if (asked.current !== d) return;
        setData(out);
        setError(null);
        if (!d) { setToday(out.date); setDate(out.date); }
      })
      .catch((e) => { if (asked.current === d && !quiet) setError(e); })
      .finally(() => { if (asked.current === d) setLoading(false); });
  };
  useEffect(() => { load(null); return () => clearTimeout(timer.current); }, []); // eslint-disable-line
  const pick = (d) => {
    if (!d || d === date) return;
    const next = today && d > today ? today : d;
    setDate(next);
    load(next);
  };
  const isToday = !!date && date === today;
  // useLiveRefresh subscribes once, so the handler reads the shown date from a ref.
  const liveDate = useRef(null);
  liveDate.current = isToday ? date : null;
  useLiveRefresh(TOPICS, () => {
    if (!liveDate.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => liveDate.current && load(liveDate.current, true), 400);
  });

  const crews = [...(data?.crews || [])].sort((a, b) =>
    ((STATUS[a.workOrder.status]?.[2] ?? 9) - (STATUS[b.workOrder.status]?.[2] ?? 9)) || String(a.crew.name).localeCompare(String(b.crew.name)));
  const count = (s) => crews.filter((c) => c.workOrder.status === s).length;
  const nobody = crews.length > 0 && count('not_started') === crews.length;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="card-h" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3>{t('wo.title')}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{date ? dayText(date) : t('wo.loading')} · {t('wo.readOnly')}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn sm" onClick={() => pick(addDays(date, -1))} disabled={!date} aria-label={t('wo.prevDay')}>‹</button>
            <input type="date" style={{ ...inp, width: 150 }} value={date || ''} max={today || undefined}
              onChange={(e) => pick(e.target.value)} aria-label={t('wo.workDate')} />
            <button className="btn sm" onClick={() => pick(addDays(date, 1))} disabled={!date || isToday} aria-label={t('wo.nextDay')}>›</button>
            <button className="btn sm" onClick={() => pick(today)} disabled={!today || isToday}>{t('wo.today')}</button>
          </div>
        </div>
        {data && !error && (
          <div className="card-b" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
            <span className="chip chip-crit" style={{ fontWeight: 700 }}>{t('wo.nNotStarted', { n: count('not_started') })}</span>
            <span className="chip chip-minor">{t('wo.nInProgress', { n: count('started') })}</span>
            <span className="chip chip-ok">{t('wo.nDayEnded', { n: count('closed') })}</span>
            <span style={{ color: 'var(--muted)' }}>{t(crews.length === 1 ? 'wo.crewOne' : 'wo.crewMany', { n: crews.length })}</span>
            {nobody && <span style={{ color: 'var(--muted)' }}>{t('wo.nobody')}</span>}
          </div>
        )}
      </div>

      {error ? <ErrorCard error={error} onRetry={() => load(date)} />
        : !data ? <div className="card"><div className="card-b empty">{t('wo.loadingWo')}</div></div>
        : !crews.length ? <div className="card"><div className="card-b empty"><span className="disp">{t('wo.noCrews')}</span>{t('wo.addFromDispatch')}</div></div>
        : (
          <div style={{ display: 'grid', gap: 10, opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }} aria-busy={loading}>
            {crews.map((c) => <CrewDay key={c.crew.id} entry={c} isToday={isToday} />)}
          </div>
        )}
    </div>
  );
}

function ErrorCard({ error, onRetry }) {
  useT();
  let title, text, action;
  if (error.status === 401) {
    title = t('wo.e401t');
    text = t('wo.e401');
    action = <button className="btn primary sm" onClick={() => keycloak.login()}>{t('wo.signIn')}</button>;
  } else if (error.status === 403) {
    title = t('wo.e403t');
    text = t('wo.e403');
  } else if (error.code === 'BAD_DATE') {
    title = t('wo.badDate');
    text = error.message;
  } else {
    title = error.status ? t('wo.eServer', { s: error.status }) : t('wo.eReach');
    text = error.status ? error.message : t('wo.eCheck');
    action = <button className="btn sm" onClick={onRetry}>{t('wo.retry')}</button>;
  }
  return (
    <div className="card" style={{ borderLeft: '3px solid var(--crit)' }} role="alert">
      <div className="card-b" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--crit)' }}>{title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 2 }}>{text}</div>
        </div>
        {action}
      </div>
    </div>
  );
}

// The jobs to list for one crew: [{ key, mark, jobId, incidentId, priority, outcome, done, reason, note }].
function dayRows({ workOrder: w, jobs }, isToday) {
  const prio = new Map([...(jobs?.open || []), ...(jobs?.done || [])].map((j) => [j.id, j.priority]));
  const done = (j) => ({ key: `d-${j.jobId ?? j.id}`, mark: '✓', jobId: j.jobId ?? j.id, incidentId: j.incidentId, priority: prio.get(j.jobId ?? j.id), outcome: 'Done', done: true });
  if (w.status === 'closed') {
    const snap = w.close_snapshot || {};
    return [
      ...(snap.done || []).map(done),
      ...(snap.carriedOver || []).map((c, i) => ({ key: `c-${c.jobId}`, mark: i + 1, jobId: c.jobId, incidentId: c.incidentId, priority: prio.get(c.jobId), outcome: c.status, reason: c.reason, note: c.note, carried: true })),
    ];
  }
  const finished = (jobs?.done || []).map(done);
  if (!isToday) return finished;
  return [...(jobs?.open || []).map((j, i) => ({ key: `o-${j.id}`, mark: i + 1, jobId: j.id, incidentId: j.incidentId, priority: j.priority, outcome: j.status })), ...finished];
}

function CrewDay({ entry, isToday }) {
  const { crew, workOrder: w } = entry;
  useT();
  const [label0, chip] = STATUS[w.status] || [w.status, 'chip-muted'];
  const label = tOr(`wo.st.${w.status}`, label0);
  const notStarted = w.status === 'not_started';
  const closed = w.status === 'closed';
  const rows = dayRows(entry, isToday);
  const members = Array.isArray(w.members) ? w.members : [];

  return (
    <div className="card" style={notStarted ? { borderLeft: '4px solid var(--crit)', background: 'var(--crit-bg)' } : undefined}>
      <div className="card-b" style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <span style={{ fontWeight: 600 }}>{crew.name}</span>
            <span className="mono" style={{ color: 'var(--muted)', fontSize: 11.5, marginLeft: 6 }}>{crew.id}</span>
            <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{t('wo.lead', { name: crew.lead || '—' })}</span>
          </div>
          <span className={`chip ${chip}`} style={{ fontWeight: 700 }}>{label}</span>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', display: 'grid', gap: 2 }}>
          {notStarted ? <div style={{ color: 'var(--crit)', fontWeight: 600 }}>{t('wo.noStart')}</div> : (
            <div>
              {t('wo.started', { t: hhmm(w.started_at) })}{w.started_by ? t('wo.by', { name: w.started_by }) : ''}
              {closed && <>{t('wo.ended', { t: hhmm(w.closed_at) })}</>}
              {closed && <>{t('wo.signedOff')}<b>{w.close_sign_off?.name || '—'}</b></>}
            </div>
          )}
          {members.length > 0 && <div>{t('wo.crew', { list: members.join(', ') })}</div>}
          {w.start_note && <div>{t('wo.startNote', { note: w.start_note })}</div>}
          {!closed && !isToday && <div style={{ color: 'var(--high)', fontWeight: 600 }}>{t('wo.neverClosed')}</div>}
        </div>

        {rows.length ? (
          <table className="tbl" style={{ width: '100%', fontSize: 12.5 }}>
            <thead>
              <tr><th style={{ width: 28 }}>#</th><th>{t('wo.colJob')}</th><th>{t('wo.colIncident')}</th><th>{t('wo.colPriority')}</th><th>{t('wo.colOutcome')}</th>{closed && <th>{t('wo.colCarried')}</th>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="mono" style={{ color: r.done ? 'var(--low)' : 'var(--muted)' }}>{r.mark}</td>
                  <td className="mono">{r.jobId}</td>
                  <td className="mono">{shortId(r.incidentId)}</td>
                  <td>{r.priority ? <PrioBadge priority={r.priority} /> : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td>{r.done ? <span className="chip chip-ok">{t('wo.done')}</span> : tOr(`drw.job.${r.outcome}`, r.outcome)}</td>
                  {closed && (
                    <td>
                      {r.carried ? (r.reason ? tOr(`wo.reason.${r.reason}`, REASON_TEXT[r.reason] || r.reason) : <span style={{ color: 'var(--muted)' }}>{t('wo.noReason')}</span>) : ''}
                      {r.note && <span style={{ color: 'var(--muted)' }}> ({r.note})</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t('wo.noJobs')}</div>}

        {closed && (
          <div style={{ fontSize: 12.5 }}>
            <span className="eyebrow" style={{ marginRight: 6 }}>{t('wo.remarks')}</span>
            {w.close_remarks || <span style={{ color: 'var(--muted)' }}>{t('wo.none')}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
