import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/ui.jsx';

// Per-feeder ratings and limits behind the PFC feeder KPIs (Admin screen).
// Saving a row changes today's live values within a minute; stored past days
// keep their old values until "Recalculate past days" is run for them.
// The server checks roles: system_admin / oms_operator / configuration_engineer
// may save; system_admin / oms_operator may recalculate.

const FIELDS = [
  { key: 'v_nominal_v', label: 'V nominal', unit: 'V' },
  { key: 'i_nominal_a', label: 'I nominal', unit: 'A' },
  { key: 'v_hi_pct', label: 'V high', unit: '%' },
  { key: 'v_lo_pct', label: 'V low', unit: '%' },
  { key: 'i_hi_pct', label: 'I high', unit: '%' },
  { key: 'i_lo_pct', label: 'I low', unit: '%' },
  { key: 'v_sag_pct', label: 'V sag below', unit: '%' },
  { key: 'i_sag_drop_pct', label: 'I sag drop', unit: '%' },
];
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);

export default function FeederRatingsCard() {
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({}); // feeder -> { field: text }
  const [msg, setMsg] = useState(null); // { feeder?, ok, text }
  const [busy, setBusy] = useState(null);
  const [filter, setFilter] = useState('');
  const [range, setRange] = useState({ from: daysAgo(7), to: daysAgo(1) });

  const load = () => api.feederKpiRatings().then(setRows).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => `${r.feeder} ${r.substation || ''}`.toLowerCase().includes(q)) : rows;
  }, [rows, filter]);

  const value = (r, k) => edits[r.feeder]?.[k] ?? String(Number(r[k]));
  const dirty = (r) => FIELDS.some((f) => edits[r.feeder]?.[f.key] != null && Number(edits[r.feeder][f.key]) !== Number(r[f.key]));
  const edit = (feeder, k, v) => setEdits((e) => ({ ...e, [feeder]: { ...e[feeder], [k]: v } }));

  const save = async (r) => {
    const patch = {};
    for (const f of FIELDS) {
      const t = edits[r.feeder]?.[f.key];
      if (t == null || Number(t) === Number(r[f.key])) continue;
      const n = Number(t);
      if (t.trim() === '' || !Number.isFinite(n) || n <= 0) return setMsg({ feeder: r.feeder, ok: false, text: `${f.label} must be a positive number` });
      patch[f.key] = n;
    }
    setBusy(r.feeder);
    try {
      const row = await api.updateFeederKpiRating(r.feeder, patch);
      setRows((rs) => rs.map((x) => (x.feeder === r.feeder ? row : x)));
      setEdits((e) => { const n = { ...e }; delete n[r.feeder]; return n; });
      setMsg({ feeder: r.feeder, ok: true, text: 'Saved. Recalculate past days to apply it to them.' });
    } catch (e) {
      setMsg({ feeder: r.feeder, ok: false, text: e.status === 403 ? 'Your role cannot change ratings.' : e.message });
    } finally { setBusy(null); }
  };

  const recalc = async () => {
    setBusy('rollup');
    try {
      const r = await api.feederKpiRollup(range);
      setMsg({ ok: true, text: `Recalculated ${r.recomputed} day(s).` });
    } catch (e) {
      setMsg({ ok: false, text: e.status === 403 ? 'Your role cannot recalculate past days.' : e.message });
    } finally { setBusy(null); }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <h3>Feeder KPI ratings &amp; limits</h3>
        <input className="fr-filter" placeholder="Filter feeder or substation" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter feeders" />
      </div>
      <div className="card-b fr-bar">
        <span className="muted">Limits are % of the feeder's nominal. Stress (FVSV / FCSV) counts only what is above the high limit.</span>
        <span className="fr-recalc">
          Recalculate past days
          <input type="date" value={range.from} max={todayIst()} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} aria-label="From" />
          to
          <input type="date" value={range.to} max={todayIst()} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} aria-label="To" />
          <button className="btn sm" disabled={busy === 'rollup' || !range.from || !range.to || range.to < range.from} onClick={recalc}>
            {busy === 'rollup' ? 'Recalculating…' : 'Recalculate'}
          </button>
        </span>
        {msg && !msg.feeder && <span className={msg.ok ? 'fr-ok' : 'fr-err'}>{msg.text}</span>}
      </div>
      <div className="card-b fr-scroll" style={{ padding: 0 }}>
        <table className="tbl fr-tbl">
          <thead>
            <tr>
              <th>Feeder</th><th>Substation</th>
              {FIELDS.map((f) => <th key={f.key} className="fk-num">{f.label} <span className="muted">{f.unit}</span></th>)}
              <th>Updated</th><th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.feeder}>
                <td className="mono">{r.feeder}</td>
                <td className="muted">{r.substation || '—'}</td>
                {FIELDS.map((f) => (
                  <td key={f.key}>
                    <input className="fr-in mono" inputMode="decimal" value={value(r, f.key)}
                      onChange={(e) => edit(r.feeder, f.key, e.target.value)} aria-label={`${r.feeder} ${f.label}`} />
                  </td>
                ))}
                <td className="muted">{r.updated_by ? `${r.updated_by}, ${timeAgo(r.updated_at)}` : 'default'}</td>
                <td>
                  <button className="btn sm" disabled={!dirty(r) || busy === r.feeder} onClick={() => save(r)}>Save</button>
                  {msg?.feeder === r.feeder && <div className={msg.ok ? 'fr-ok' : 'fr-err'}>{msg.text}</div>}
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={FIELDS.length + 4} className="empty">No feeders match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
