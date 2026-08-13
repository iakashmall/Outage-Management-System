import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';

const CAT = { Critical: 'crit', Medical: 'major', Normal: 'minor' };
const LINKED = new Set(['incident', 'assigned', 'completed', 'outage']);

export default function TCS() {
  const [calls, setCalls] = useState([]);
  const [busy, setBusy] = useState(null);

  const load = () => api.calls().then(setCalls);
  useEffect(() => { load(); }, []);
  useLiveRefresh(['tcs.call.received', 'oms.incident.created'], load);

  const rows = useMemo(
    () => [...calls].sort((a, b) => {
      const un = (c) => (c.status === 'unassigned' ? 0 : 1);
      return (un(a) - un(b)) || (b.ts || '').localeCompare(a.ts || '');
    }),
    [calls]
  );
  const unassigned = calls.filter((c) => c.status === 'unassigned').length;
  const medical = calls.filter((c) => c.category === 'Medical' && c.status === 'unassigned').length;

  const promote = async (id) => {
    setBusy(id);
    try { const r = await api.callToIncident(id); toast(`Incident ${r.id || 'created'} raised from call`); load(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(null); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Customer Interface</div>
          <h2>Trouble call system</h2>
          <p>Inbound customer-reported outages from IVR, portal and call centre. Correlate and promote calls into tracked incidents.</p>
        </div>
      </div>

      <div className="grid stat-row" style={{ marginBottom: 16 }}>
        <div className="stat prio-crit"><div className="stat-n">{unassigned}</div><div className="stat-l">Unassigned</div></div>
        <div className="stat prio-major"><div className="stat-n">{medical}</div><div className="stat-l">Medical priority</div></div>
        <div className="stat prio-neutral"><div className="stat-n">{calls.length}</div><div className="stat-l">Calls today</div></div>
        <div className="stat prio-minor"><div className="stat-n">{calls.filter((c) => LINKED.has(c.status)).length}</div><div className="stat-l">Linked to incident</div></div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Call queue</h3><span className="eyebrow">{rows.length} calls</span></div>
        <div className="card-b" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr><th>Priority</th><th>Customer</th><th>Phone</th><th>Address</th><th>Status</th><th>Received</th><th></th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={c.status === 'unassigned' ? 'row-hot' : ''}>
                  <td><span className={`chip chip-${CAT[c.category] || 'minor'}`}>{c.category}</span></td>
                  <td>{c.customer}</td>
                  <td className="mono">{c.phone}</td>
                  <td style={{ maxWidth: 260 }} className="muted">{c.address}</td>
                  <td>{c.linked_id
                    ? <span className="mono muted">{c.linked_id}</span>
                    : <span className="chip chip-crit">unassigned</span>}</td>
                  <td className="muted">{timeAgo(c.ts)}</td>
                  <td>{!c.linked_id && (
                    <button className="btn btn-sm btn-primary" disabled={busy === c.id} onClick={() => promote(c.id)}>
                      <Icon name="plus" size={14} /> Raise incident
                    </button>
                  )}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="empty">No calls in queue.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
