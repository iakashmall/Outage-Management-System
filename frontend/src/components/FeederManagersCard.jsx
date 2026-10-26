import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/ui.jsx';

// Admin -> Feeder managers: who gets each feeder's outage / restoration SMS and
// report-builder summaries. Phones come back masked; editing a manager can leave
// the phone blank to keep the stored number.
const EMPTY = { feeder: '', name: '', phone: '', active: true };

export default function FeederManagersCard() {
  const [data, setData] = useState({ managers: [], feeders: [] });
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // feeder being edited, or null when adding
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.feederManagers().then(setData).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const startEdit = (m) => { setEditing(m.feeder); setForm({ feeder: m.feeder, name: m.name, phone: '', active: m.active }); setMsg(null); };
  const cancel = () => { setEditing(null); setForm(EMPTY); };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api.setFeederManager(form.feeder, { name: form.name, phone: form.phone, active: form.active });
      setMsg({ ok: true, text: `Saved manager for ${form.feeder}.` });
      cancel(); load();
    } catch (err) {
      setMsg({ ok: false, text: err.status === 403 ? 'Your role cannot change feeder managers.' : err.message });
    } finally { setBusy(false); }
  };

  const remove = async (m) => {
    if (!window.confirm(`Remove ${m.name} as manager of ${m.feeder}? They will stop getting this feeder's SMS.`)) return;
    try { await api.removeFeederManager(m.feeder); setMsg({ ok: true, text: `Removed manager of ${m.feeder}.` }); load(); }
    catch (err) { setMsg({ ok: false, text: err.message }); }
  };

  const taken = new Set(data.managers.map((m) => m.feeder));
  const free = data.feeders.filter((f) => !taken.has(f));

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <h3>Feeder managers</h3>
        <span className="eyebrow">{data.managers.filter((m) => m.active).length} active · {free.length} feeders without one</span>
      </div>
      <div className="card-b">
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
          Each feeder's manager gets an SMS when an outage opens on the feeder and when it is restored, can be messaged from an incident,
          and receives report-builder summaries. Numbers are shown masked.
        </p>
        <form className="fm-form" onSubmit={save}>
          <label className="fm-field">
            <span className="sr-label">Feeder</span>
            {editing ? <input value={form.feeder} readOnly className="mono" /> : (
              <select value={form.feeder} onChange={set('feeder')} required>
                <option value="">Choose a feeder…</option>
                {free.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
          </label>
          <label className="fm-field">
            <span className="sr-label">Manager name</span>
            <input value={form.name} onChange={set('name')} required maxLength={80} placeholder="e.g. R. Negi (JE)" />
          </label>
          <label className="fm-field">
            <span className="sr-label">Mobile number</span>
            <input value={form.phone} onChange={set('phone')} inputMode="tel" required={!editing} placeholder={editing ? 'Leave blank to keep' : '+91 98xxxxxxxx'} />
          </label>
          <label className="fm-check"><input type="checkbox" checked={form.active} onChange={set('active')} /> Active</label>
          <button className="btn sm" type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add manager'}</button>
          {editing && <button className="btn sm" type="button" onClick={cancel}>Cancel</button>}
          {msg && <span role="status" className={msg.ok ? 'fr-ok' : 'fr-err'}>{msg.text}</span>}
        </form>
      </div>
      <div className="card-b" style={{ padding: 0 }}>
        <table className="tbl">
          <thead><tr><th>Feeder</th><th>Manager</th><th>Mobile</th><th>Status</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {data.managers.map((m) => (
              <tr key={m.feeder}>
                <td className="mono">{m.feeder}</td><td>{m.name}</td><td className="mono">{m.phone}</td>
                <td>{m.active ? 'Active' : <span className="muted">Inactive</span>}</td>
                <td className="muted">{timeAgo(m.updated_at)}{m.updated_by ? ` · ${m.updated_by}` : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => startEdit(m)} aria-label={`Edit manager of ${m.feeder}`}>Edit</button>{' '}
                  <button className="btn sm" onClick={() => remove(m)} aria-label={`Remove manager of ${m.feeder}`}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.managers.length && <div className="muted" style={{ padding: 14 }}>No feeder managers yet. Add one above.</div>}
      </div>
    </div>
  );
}
