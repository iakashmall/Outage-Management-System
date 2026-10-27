import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, timeAgo, useLiveRefresh, toast, RowButton } from '../lib/ui.jsx';
import { useT, t as tt, tOr } from '../lib/i18n.js';

const CATCHIP = { 'No Supply': 'crit', 'Partial Supply': 'major', 'Voltage': 'minor', 'Wire Down': 'crit', 'Meter': 'neutral', 'Other': 'neutral' };
const clean = (n) => (n || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() || '—';

export default function Complaints() {
  const { t } = useT();
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(null);
  const [trace, setTrace] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.complaints().then(setRows);
  useEffect(() => { load(); }, []);
  useLiveRefresh(['oms.incident.created', 'oms.incident.updated'], load);

  const openTrace = async (qid) => {
    setSel(qid); setTrace(null);
    try { setTrace(await api.complaintTrace(qid)); } catch (e) { toast(e.message, 'err'); }
  };
  const simulate = async () => {
    setBusy(true);
    try {
      const r = await api.simulateComplaint();
      toast(r.action === 'merged'
        ? tt('cmp.mergedToast', { q: r.queryId, i: r.incidentId, s: clean(r.substation) })
        : tt('cmp.openedToast', { q: r.queryId, i: r.incidentId, s: clean(r.substation) }),
        r.action === 'merged' ? 'ok' : 'warn');
      await load(); openTrace(r.queryId);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const merged = rows.filter((r) => r.action === 'merged').length;
  const created = rows.filter((r) => r.action === 'created').length;
  const incidents = new Set(rows.map((r) => r.incident_id).filter(Boolean)).size;
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')), [rows]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('cmp.eyebrow')}</div>
          <h2>{t('cmp.title')}</h2>
          <p>{t('cmp.intro')}</p>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={simulate}>
          <Icon name="plus" size={15} /> {busy ? t('cmp.receiving') : t('cmp.simulate')}
        </button>
      </div>

      <div className="grid stat-row" style={{ marginBottom: 16 }}>
        <div className="stat prio-neutral"><div className="stat-n">{rows.length}</div><div className="stat-l">{t('cmp.received')}</div></div>
        <div className="stat prio-minor"><div className="stat-n">{merged}</div><div className="stat-l">{t('cmp.merged')}</div></div>
        <div className="stat prio-major"><div className="stat-n">{created}</div><div className="stat-l">{t('cmp.newOpened')}</div></div>
        <div className="stat prio-crit"><div className="stat-n">{incidents}</div><div className="stat-l">{t('cmp.correlated')}</div></div>
      </div>

      <div className="complaints-layout">
        <div className="card">
          <div className="card-h"><h3>{t('cmp.queue')}</h3><span className="eyebrow">{t('cmp.nComplaints', { n: sorted.length })}</span></div>
          <div className="card-b" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>{t('cmp.colQid')}</th><th>{t('cmp.colExt')}</th><th>{t('cmp.colCustomer')}</th><th>{t('cmp.colCategory')}</th><th>{t('cmp.colSubstation')}</th><th>{t('cmp.colIncident')}</th><th>{t('cmp.colResult')}</th><th>{t('cmp.colReceived')}</th></tr></thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.qid} className={sel === r.qid ? 'row-sel' : ''} onClick={() => openTrace(r.qid)} style={{ cursor: 'pointer' }}>
                    <td className="mono"><RowButton label={t('cmp.showTrace', { id: r.qid })} aria-pressed={sel === r.qid} onActivate={() => openTrace(r.qid)}>{r.qid}</RowButton></td>
                    <td className="mono muted">{r.external_id || '—'}</td>
                    <td>{r.customer || '—'}</td>
                    <td><span className={`chip chip-${CATCHIP[r.category] || 'neutral'}`}>{tOr(`cmp.cat.${r.category}`, r.category)}</span></td>
                    <td className="muted">{clean(r.substation)}</td>
                    <td className="mono muted">{r.incident_id || '—'}</td>
                    <td>{r.action === 'merged'
                      ? <span className="chip chip-merged">{t('cmp.res.merged')}</span>
                      : <span className="chip chip-individual">{t('cmp.res.individual')}</span>}</td>
                    <td className="muted">{timeAgo(r.ts)}</td>
                  </tr>
                ))}
                {!sorted.length && <tr><td colSpan={8} className="empty">{t('cmp.empty')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card trace-card">
          <div className="card-h"><h3>{t('cmp.traceback')}</h3>{sel && <span className="eyebrow mono">{sel}</span>}</div>
          <div className="card-b">
            {!sel && <div className="trace-empty">{t('cmp.selectHint')}</div>}
            {sel && !trace && <div className="trace-empty">{t('cmp.loadingTrace')}</div>}
            {trace && <TraceChain t={trace} />}
          </div>
        </div>
      </div>
    </>
  );
}

function TraceChain({ t: tr }) {
  const { t } = useT();
  const clean2 = (n) => (n || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() || '—';
  return (
    <div className="chain">
      <ChainNode kind={t('cmp.kComplaint')} tone="c1"
        title={tr.complaint.customer || t('cmp.customer')} sub={tOr(`cmp.cat.${tr.complaint.category}`, tr.complaint.category)}
        rows={[[t('cmp.colQid'), tr.complaint.qid], [t('cmp.colExt'), tr.complaint.externalId || '—'], [t('cmp.reported'), timeAgo(tr.complaint.ts)]]} />
      <ChainLink label={tr.complaint.action === 'merged' ? t('cmp.linkMerged') : t('cmp.linkNew')} />
      {tr.incident
        ? <ChainNode kind={t('cmp.kIncidentProblem')} tone="c2" title={tr.incident.id} sub={tOr(`type.${tr.incident.type}`, tr.incident.type)}
            badges={<><SevBadge sev={tr.incident.severity} /><StatusBadge status={tr.incident.status} /></>}
            rows={[[t('cmp.customersAffected'), (tr.incident.customers || 0).toLocaleString()], [t('cmp.grouped'), tr.grouped]]} />
        : <ChainNode kind={t('cmp.kIncident')} tone="c2" title="—" sub={t('cmp.notLinked')} />}
      <ChainLink label={t('cmp.onFeeder')} />
      <ChainNode kind={t('cmp.kFeeder')} tone="c3" title={tr.feeder || '—'} sub={t('cmp.dist11')} />
      <ChainLink label={t('cmp.fedFrom')} />
      <ChainNode kind={t('cmp.kSource')} tone="c4" title={clean2(tr.substation)} sub={tr.substation || '—'} last />
      {tr.grouped > 1 && <div className="chain-note">{t('cmp.correlatedNote', { n: tr.grouped })}<span className="mono">{tr.groupedIds.join(', ')}</span></div>}
    </div>
  );
}

function ChainNode({ kind, title, sub, rows, badges, tone, last }) {
  return (
    <div className={`chain-node ${tone} ${last ? 'last' : ''}`}>
      <div className="chain-kind">{kind}</div>
      <div className="chain-title">{title}</div>
      {sub && <div className="chain-sub">{sub}</div>}
      {badges && <div className="chain-badges">{badges}</div>}
      {rows && <div className="chain-rows">{rows.map(([k, v]) => <div key={k} className="chain-kv"><span>{k}</span><b>{v}</b></div>)}</div>}
    </div>
  );
}
function ChainLink({ label }) {
  return <div className="chain-link"><span className="chain-arrow" /><span className="chain-lbl">{label}</span></div>;
}
