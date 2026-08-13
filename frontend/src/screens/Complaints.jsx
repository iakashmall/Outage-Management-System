import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';

const CATCHIP = { 'No Supply': 'crit', 'Partial Supply': 'major', 'Voltage': 'minor', 'Wire Down': 'crit', 'Meter': 'neutral', 'Other': 'neutral' };
const clean = (n) => (n || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() || '—';

export default function Complaints() {
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
        ? `${r.queryId} merged into ${r.incidentId} · ${clean(r.substation)}`
        : `${r.queryId} opened new incident ${r.incidentId} · ${clean(r.substation)}`,
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
          <div className="eyebrow">Customer Interface · REST intake</div>
          <h2>Consumer complaints</h2>
          <p>Complaints arrive from the external service with their own reference. Each is assigned an internal query ID, resolved to a substation, then deduplicated — merged into the matching open incident or opened as a new one.</p>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={simulate}>
          <Icon name="plus" size={15} /> {busy ? 'Receiving…' : 'Simulate incoming complaint'}
        </button>
      </div>

      <div className="grid stat-row" style={{ marginBottom: 16 }}>
        <div className="stat prio-neutral"><div className="stat-n">{rows.length}</div><div className="stat-l">Complaints received</div></div>
        <div className="stat prio-minor"><div className="stat-n">{merged}</div><div className="stat-l">Merged (deduplicated)</div></div>
        <div className="stat prio-major"><div className="stat-n">{created}</div><div className="stat-l">New incidents opened</div></div>
        <div className="stat prio-crit"><div className="stat-n">{incidents}</div><div className="stat-l">Incidents correlated</div></div>
      </div>

      <div className="complaints-layout">
        <div className="card">
          <div className="card-h"><h3>Complaint queue</h3><span className="eyebrow">{sorted.length} complaints</span></div>
          <div className="card-b" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>Query ID</th><th>External ref</th><th>Customer</th><th>Category</th><th>Substation</th><th>Incident</th><th>Result</th><th>Received</th></tr></thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.qid} className={sel === r.qid ? 'row-sel' : ''} onClick={() => openTrace(r.qid)} style={{ cursor: 'pointer' }}>
                    <td className="mono">{r.qid}</td>
                    <td className="mono muted">{r.external_id || '—'}</td>
                    <td>{r.customer || '—'}</td>
                    <td><span className={`chip chip-${CATCHIP[r.category] || 'neutral'}`}>{r.category}</span></td>
                    <td className="muted">{clean(r.substation)}</td>
                    <td className="mono muted">{r.incident_id || '—'}</td>
                    <td>{r.action === 'merged'
                      ? <span className="chip chip-merged">merged</span>
                      : <span className="chip chip-individual">individual</span>}</td>
                    <td className="muted">{timeAgo(r.ts)}</td>
                  </tr>
                ))}
                {!sorted.length && <tr><td colSpan={8} className="empty">No complaints received yet. Use “Simulate incoming complaint”.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card trace-card">
          <div className="card-h"><h3>Traceback</h3>{sel && <span className="eyebrow mono">{sel}</span>}</div>
          <div className="card-b">
            {!sel && <div className="trace-empty">Select a complaint to trace it back through the query and incident to the source substation.</div>}
            {sel && !trace && <div className="trace-empty">Loading trace…</div>}
            {trace && <TraceChain t={trace} />}
          </div>
        </div>
      </div>
    </>
  );
}

function TraceChain({ t }) {
  const clean2 = (n) => (n || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() || '—';
  return (
    <div className="chain">
      <ChainNode kind="Complaint" tone="c1"
        title={t.complaint.customer || 'Customer'} sub={t.complaint.category}
        rows={[['Query ID', t.complaint.qid], ['External ref', t.complaint.externalId || '—'], ['Reported', timeAgo(t.complaint.ts)]]} />
      <ChainLink label={t.complaint.action === 'merged' ? 'deduplicated → merged' : 'no match → new incident'} />
      {t.incident
        ? <ChainNode kind="Incident / problem" tone="c2" title={t.incident.id} sub={t.incident.type}
            badges={<><SevBadge sev={t.incident.severity} /><StatusBadge status={t.incident.status} /></>}
            rows={[['Customers affected', (t.incident.customers || 0).toLocaleString()], ['Complaints grouped', t.grouped]]} />
        : <ChainNode kind="Incident" tone="c2" title="—" sub="not linked" />}
      <ChainLink label="on feeder" />
      <ChainNode kind="Feeder" tone="c3" title={t.feeder || '—'} sub="11 kV distribution" />
      <ChainLink label="fed from" />
      <ChainNode kind="Source substation" tone="c4" title={clean2(t.substation)} sub={t.substation || '—'} last />
      {t.grouped > 1 && <div className="chain-note">{t.grouped} complaints correlated to this incident: <span className="mono">{t.groupedIds.join(', ')}</span></div>}
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
