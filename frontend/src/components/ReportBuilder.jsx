import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.jsx';

// Analytics -> Report builder. Drag fields into "Columns" (or press their + button),
// reorder by dragging or with the ← → buttons, add filters, optionally group with
// totals; the preview reruns on every change. Reports can be saved by name, exported
// as CSV, and sent as a per-feeder SMS summary to the feeder managers (Admin).
// Backend: domain/reportBuilder.js. Every drag action has a keyboard button too.
const DEFAULT_COLUMNS = ['id', 'opened_at', 'zone', 'feeder', 'cause_category', 'customers', 'duration_min'];
const PRESETS = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']];
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const fmt = (v, type) => {
  if (v == null || v === '') return '—';
  if (type === 'date') return new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (type === 'number') return Number(v).toLocaleString('en-IN');
  return String(v);
};

export default function ReportBuilder() {
  const [fields, setFields] = useState([]);
  const [ops, setOps] = useState({});
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [filters, setFilters] = useState([]);
  const [groupBy, setGroupBy] = useState('');
  const [sort, setSort] = useState(null);
  const [preset, setPreset] = useState('30');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(iso(new Date()));
  const [name, setName] = useState('');
  const [saved, setSaved] = useState([]);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(''); // screen-reader confirmation of drag / button actions
  const [dropAt, setDropAt] = useState(null); // index the dragged field would land at
  const drag = useRef(null); // { key, from: 'fields' | index }

  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const label = (k) => byKey[k]?.label || k;
  const spec = { columns, filters: filters.filter((f) => f.field && f.op && f.value !== ''), groupBy: groupBy || null, sort, from, to: to ? `${to}T23:59:59` : '' };
  const specKey = JSON.stringify(spec);

  useEffect(() => {
    api.reportFields().then((r) => { setFields(r.fields); setOps(r.ops); }).catch((e) => setErr(e.message));
    loadSaved();
  }, []);
  const loadSaved = () => api.savedReports().then(setSaved).catch(() => {});

  // Rerun the preview shortly after the last change.
  useEffect(() => {
    if (!fields.length) return undefined;
    if (!columns.length) { setResult(null); setErr('Add at least one column.'); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      setBusy(true);
      api.runReport(spec)
        .then((r) => { if (live) { setResult(r); setErr(''); } })
        .catch((e) => { if (live) setErr(e.message); })
        .finally(() => { if (live) setBusy(false); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [specKey, fields.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const announce = (t) => setSaid(t);
  const addColumn = (key, at = columns.length) => {
    if (columns.includes(key)) return;
    setColumns((c) => [...c.slice(0, at), key, ...c.slice(at)]);
    announce(`${label(key)} added to columns`);
  };
  const removeColumn = (key) => { setColumns((c) => c.filter((k) => k !== key)); announce(`${label(key)} removed`); };
  const moveColumn = (key, to) => {
    setColumns((c) => {
      const rest = c.filter((k) => k !== key);
      const at = Math.max(0, Math.min(rest.length, to));
      return [...rest.slice(0, at), key, ...rest.slice(at)];
    });
    announce(`${label(key)} moved to position ${Math.max(1, Math.min(columns.length, to + 1))}`);
  };

  // HTML5 drag and drop: fields -> columns, and reordering within columns.
  const onDragStart = (key, origin) => (e) => { drag.current = { key, origin }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); };
  const onDragEnd = () => { drag.current = null; setDropAt(null); };
  const overColumn = (i) => (e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDropAt(e.clientX > r.left + r.width / 2 ? i + 1 : i); };
  const dropColumns = (e) => {
    e.preventDefault();
    const d = drag.current; if (!d) return;
    const at = dropAt ?? columns.length;
    if (d.origin === 'fields') addColumn(d.key, at);
    else moveColumn(d.key, at > d.origin ? at - 1 : at);
    onDragEnd();
  };
  const dropGroup = (e) => {
    e.preventDefault();
    const d = drag.current; if (!d) return;
    if (byKey[d.key]?.type === 'number') toast('Group by a text or date field, not a number', 'err');
    else { setGroupBy(d.key); announce(`Grouped by ${label(d.key)}`); }
    onDragEnd();
  };

  const setFilter = (i, patch) => setFilters((fs) => fs.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  const pickPreset = (p) => { setPreset(p); setFrom(daysAgo(Number(p))); setTo(iso(new Date())); };
  const sortBy = (key) => setSort((s) => (s?.field === key ? { field: key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field: key, dir: 'desc' }));

  const load = (id) => {
    const r = saved.find((x) => x.id === id); if (!r) return;
    const s = r.spec;
    setColumns(s.columns); setFilters(s.filters || []); setGroupBy(s.groupBy || ''); setSort(s.sort || null); setName(r.name);
    if (s.from) { setFrom(s.from.slice(0, 10)); setPreset(''); }
    if (s.to) setTo(s.to.slice(0, 10));
    announce(`Loaded ${r.name}`);
  };
  const save = async () => {
    if (!name.trim()) { toast('Give the report a name first', 'err'); return; }
    try { await api.saveReport(name.trim(), spec); toast(`Saved "${name.trim()}"`); loadSaved(); } catch (e) { toast(e.message, 'err'); }
  };
  const del = async () => {
    const r = saved.find((x) => x.name.toLowerCase() === name.trim().toLowerCase()); if (!r) return;
    if (!window.confirm(`Delete the saved report "${r.name}"?`)) return;
    try { await api.deleteReport(r.id); toast(`Deleted "${r.name}"`); loadSaved(); } catch (e) { toast(e.message, 'err'); }
  };
  const sms = async () => {
    const n = result?.feeders?.length || 0;
    if (!n) { toast('No feeders in this report', 'err'); return; }
    if (!window.confirm(`Send each feeder manager an SMS summary of their feeder in this report? (${n} feeder${n === 1 ? '' : 's'})`)) return;
    try {
      const r = await api.smsReport(name.trim() || 'Custom report', spec);
      toast(`SMS sent to ${r.sent.length} feeder manager${r.sent.length === 1 ? '' : 's'}` + (r.noManager.length ? `; ${r.noManager.length} feeder${r.noManager.length === 1 ? ' has' : 's have'} no manager (Admin → Feeder managers)` : ''), r.sent.length ? 'ok' : 'err', 7000);
    } catch (e) { toast(e.message, 'err'); }
  };
  const exportCsv = () => api.exportBuiltReport(spec, name.trim() || 'Custom report').catch((e) => toast(`Export failed: ${e.message}`, 'err'));

  const unused = fields.filter((f) => !columns.includes(f.key));
  const isSaved = saved.some((x) => x.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <div className="fk rb">
      <p className="sr-about">Drag fields into <b>Columns</b> (or use their + button), drag to reorder, add filters, and optionally group to get totals. The preview updates as you build.</p>
      <div className="sr-only" role="status" aria-live="polite">{said}</div>

      <div className="sr-filters">
        <div className="sr-field">
          <label className="sr-label" htmlFor="rb-saved">Saved reports</label>
          <select id="rb-saved" value="" onChange={(e) => load(e.target.value)}>
            <option value="">{saved.length ? `Open a saved report (${saved.length})…` : 'No saved reports yet'}</option>
            {saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="sr-field">
          <label className="sr-label" htmlFor="rb-name">Report name</label>
          <input id="rb-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Weekly feeder outages" className="rb-name" />
        </div>
        <button className="btn sm" onClick={save}>{isSaved ? 'Update saved' : 'Save'}</button>
        {isSaved && <button className="btn sm" onClick={del}>Delete</button>}
        <div className="grow" />
        <button className="btn sm" onClick={exportCsv} disabled={!result}>Export CSV</button>
        <button className="btn sm" onClick={sms} disabled={!result}>SMS feeder managers</button>
      </div>

      <div className="rb-grid">
        <section className="rb-panel" aria-labelledby="rb-fields-h">
          <h4 id="rb-fields-h">Fields</h4>
          <ul className="rb-chips rb-source">
            {unused.map((f) => (
              <li key={f.key} className={`rb-chip t-${f.type}`} draggable onDragStart={onDragStart(f.key, 'fields')} onDragEnd={onDragEnd}>
                <span>{f.label}</span>
                <button className="rb-x" onClick={() => addColumn(f.key)} aria-label={`Add ${f.label} to columns`} title="Add to columns">+</button>
              </li>
            ))}
            {!unused.length && <li className="muted">All fields are in use.</li>}
          </ul>
          <p className="rb-key"><span className="rb-dot t-number" /> number <span className="rb-dot t-date" /> date <span className="rb-dot t-text" /> text</p>
        </section>

        <div className="rb-main">
          <section className="rb-panel" aria-labelledby="rb-cols-h">
            <h4 id="rb-cols-h">Columns <span className="muted">· {columns.length}</span></h4>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop target; every action also has a button */}
            <ol className={`rb-chips rb-drop${drag.current ? ' armed' : ''}`} onDragOver={(e) => { e.preventDefault(); if (e.target === e.currentTarget) setDropAt(columns.length); }} onDrop={dropColumns}>
              {columns.map((k, i) => (
                <li key={k} className={`rb-chip on t-${byKey[k]?.type}${dropAt === i ? ' before' : ''}${dropAt === i + 1 && i === columns.length - 1 ? ' after' : ''}`}
                  draggable onDragStart={onDragStart(k, i)} onDragEnd={onDragEnd} onDragOver={overColumn(i)}>
                  <span>{label(k)}</span>
                  <button className="rb-x" onClick={() => moveColumn(k, i - 1)} disabled={i === 0} aria-label={`Move ${label(k)} left`}>←</button>
                  <button className="rb-x" onClick={() => moveColumn(k, i + 1)} disabled={i === columns.length - 1} aria-label={`Move ${label(k)} right`}>→</button>
                  <button className="rb-x" onClick={() => removeColumn(k)} aria-label={`Remove ${label(k)}`}>✕</button>
                </li>
              ))}
              {!columns.length && <li className="muted rb-hint">Drop fields here</li>}
            </ol>
          </section>

          <div className="rb-row2">
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop target; the select does the same */}
            <section className={`rb-panel rb-group${drag.current ? ' armed' : ''}`} aria-labelledby="rb-group-h" onDragOver={(e) => e.preventDefault()} onDrop={dropGroup}>
              <h4 id="rb-group-h">Group by <span className="muted">(drop a field, or choose)</span></h4>
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-labelledby="rb-group-h">
                <option value="">No grouping (one row per outage)</option>
                {fields.filter((f) => f.type !== 'number').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              {groupBy && <p className="muted rb-note">Shows one row per {label(groupBy).toLowerCase()} with the outage count, totals of number columns (averages for duration) and a total row.</p>}
            </section>

            <section className="rb-panel" aria-labelledby="rb-period-h">
              <h4 id="rb-period-h">Period</h4>
              <div className="sr-row">
                <div className="seg" role="group" aria-labelledby="rb-period-h">
                  {PRESETS.map(([p, l]) => <button key={p} aria-pressed={preset === p} className={preset === p ? 'on' : ''} onClick={() => pickPreset(p)}>{l}</button>)}
                </div>
                <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPreset(''); }} aria-label="From date" />
                <span className="muted">to</span>
                <input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPreset(''); }} aria-label="To date" />
              </div>
            </section>
          </div>

          <section className="rb-panel" aria-labelledby="rb-filters-h">
            <h4 id="rb-filters-h">Filters <span className="muted">· all must match</span></h4>
            {filters.map((f, i) => (
              <div key={i} className="sr-row rb-filter">
                <select value={f.field} onChange={(e) => setFilter(i, { field: e.target.value })} aria-label={`Filter ${i + 1} field`}>
                  {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value })} aria-label={`Filter ${i + 1} condition`}>
                  {Object.entries(ops).filter(([o]) => byKey[f.field]?.type !== 'text' || ['eq', 'neq', 'contains'].includes(o)).map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                </select>
                <input value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} aria-label={`Filter ${i + 1} value`}
                  type={byKey[f.field]?.type === 'number' ? 'number' : byKey[f.field]?.type === 'date' ? 'date' : 'text'} placeholder="value" />
                <button className="rb-x" onClick={() => setFilters((fs) => fs.filter((_, n) => n !== i))} aria-label={`Remove filter ${i + 1}`}>✕</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => setFilters((fs) => [...fs, { field: 'zone', op: 'eq', value: '' }])} disabled={filters.length >= 10}>+ Add filter</button>
          </section>
        </div>
      </div>

      <div className="fk-range" role="status">
        <b>{name.trim() || 'Custom report'}</b>
        {result && <span className="muted"> · {result.outages} outage{result.outages === 1 ? '' : 's'}{result.grouped ? ` in ${result.total} group${result.total === 1 ? '' : 's'}` : ''} · {result.feeders.length} feeder{result.feeders.length === 1 ? '' : 's'}</span>}
        {busy && <span className="muted"> · updating…</span>}
        {err && <span className="fk-err"> {err}</span>}
        {result?.truncated && <span className="muted"> · preview shows the first 1,000 rows; Export CSV has them all</span>}
      </div>

      {result && (
        <div className="fk-scroll" style={{ maxHeight: 520, overflow: 'auto' }}>
          <table className="tbl fk-tbl" aria-label="Report preview">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort?.field === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <button className="rb-sort" onClick={() => sortBy(c.key)}>{c.label}{sort?.field === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 300).map((r, n) => (
                <tr key={n}>{result.columns.map((c) => <td key={c.key} className={c.type === 'number' ? 'fk-num' : undefined}>{fmt(r[c.key], c.type)}</td>)}</tr>
              ))}
            </tbody>
            {result.totals && (
              <tfoot><tr className="rb-total">{result.columns.map((c) => <td key={c.key} className={c.type === 'number' ? 'fk-num' : undefined}><b>{fmt(result.totals[c.key], c.type)}</b></td>)}</tr></tfoot>
            )}
          </table>
          {!result.rows.length && <div className="muted" style={{ padding: 14 }}>No outages match.</div>}
          {result.rows.length > 300 && <div className="muted" style={{ padding: 10 }}>Showing 300 of {result.rows.length} rows here; Export CSV includes all.</div>}
        </div>
      )}
    </div>
  );
}
