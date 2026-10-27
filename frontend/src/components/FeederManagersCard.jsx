import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/ui.jsx';
import { useT, t as tr } from '../lib/i18n.js';

// Admin -> Feeder managers: who gets each feeder's outage / restoration SMS and
// report-builder summaries. Phones come back masked; editing a manager can leave
// the phone blank to keep the stored number.
const EMPTY = { feeder: '', name: '', phone: '', active: true };

export default function FeederManagersCard() {
  useT();
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
      setMsg({ ok: true, text: tr('fm.saved', { f: form.feeder }) });
      cancel(); load();
    } catch (err) {
      setMsg({ ok: false, text: err.status === 403 ? tr('fm.noRole') : err.message });
    } finally { setBusy(false); }
  };

  const remove = async (m) => {
    if (!window.confirm(tr('fm.confirmRemove', { n: m.name, f: m.feeder }))) return;
    try { await api.removeFeederManager(m.feeder); setMsg({ ok: true, text: tr('fm.removed', { f: m.feeder }) }); load(); }
    catch (err) { setMsg({ ok: false, text: err.message }); }
  };

  const taken = new Set(data.managers.map((m) => m.feeder));
  const free = data.feeders.filter((f) => !taken.has(f));

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <h3>{tr('fm.title')}</h3>
        <span className="eyebrow">{tr('fm.counts', { a: data.managers.filter((m) => m.active).length, f: free.length })}</span>
      </div>
      <div className="card-b">
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
          {tr('fm.intro')}
        </p>
        <form className="fm-form" onSubmit={save}>
          <label className="fm-field">
            <span className="sr-label">{tr('col.feeder')}</span>
            {editing ? <input value={form.feeder} readOnly className="mono" /> : (
              <select value={form.feeder} onChange={set('feeder')} required>
                <option value="">{tr('fm.choose')}</option>
                {free.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
          </label>
          <label className="fm-field">
            <span className="sr-label">{tr('fm.name')}</span>
            <input value={form.name} onChange={set('name')} required maxLength={80} placeholder={tr('fm.namePh')} />
          </label>
          <label className="fm-field">
            <span className="sr-label">{tr('fm.mobileNo')}</span>
            <input value={form.phone} onChange={set('phone')} inputMode="tel" required={!editing} placeholder={editing ? tr('fm.keep') : '+91 98xxxxxxxx'} />
          </label>
          <label className="fm-check"><input type="checkbox" checked={form.active} onChange={set('active')} /> {tr('fm.Active')}</label>
          <button className="btn sm" type="submit" disabled={busy}>{busy ? tr('fm.saving') : editing ? tr('fm.saveChanges') : tr('fm.add')}</button>
          {editing && <button className="btn sm" type="button" onClick={cancel}>{tr('drw.cancel')}</button>}
          {msg && <span role="status" className={msg.ok ? 'fr-ok' : 'fr-err'}>{msg.text}</span>}
        </form>
      </div>
      <div className="card-b" style={{ padding: 0 }}>
        <table className="tbl">
          <thead><tr><th>{tr('col.feeder')}</th><th>{tr('fm.manager')}</th><th>{tr('fm.mobile')}</th><th>{tr('col.status')}</th><th>{tr('fm.updated')}</th><th><span className="sr-only">{tr('fm.actions')}</span></th></tr></thead>
          <tbody>
            {data.managers.map((m) => (
              <tr key={m.feeder}>
                <td className="mono">{m.feeder}</td><td>{m.name}</td><td className="mono">{m.phone}</td>
                <td>{m.active ? tr('fm.Active') : <span className="muted">{tr('fm.inactive')}</span>}</td>
                <td className="muted">{timeAgo(m.updated_at)}{m.updated_by ? ` · ${m.updated_by}` : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm" onClick={() => startEdit(m)} aria-label={tr('fm.editAria', { f: m.feeder })}>{tr('fm.edit')}</button>{' '}
                  <button className="btn sm" onClick={() => remove(m)} aria-label={tr('fm.removeAria', { f: m.feeder })}>{tr('fm.remove')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.managers.length && <div className="muted" style={{ padding: 14 }}>{tr('fm.none')}</div>}
      </div>
    </div>
  );
}
