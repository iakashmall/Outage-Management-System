import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.jsx';
import { useT, tOr, locale } from '../lib/i18n.js';

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
  if (type === 'date') return new Date(v).toLocaleString(locale(), { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (type === 'number') return Number(v).toLocaleString(locale());
  return String(v);
};

// Enumerated values the API returns in English (cause category, severity...) display translated;
// everything else (names, IDs, numbers, dates) is data and shown as is.
const VALUE_KEYS = { cause_category: 'sr.cat.', severity: 'sev.', status: 'st.', type: 'type.', sla_result: 'rb.sla.' };
const cellText = (key, v, type) => (VALUE_KEYS[key] && v != null && v !== '' ? tOr(VALUE_KEYS[key] + v, String(v)) : fmt(v, type));

export default function ReportBuilder() {
  const { t } = useT();
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
  const label = (k) => tOr(`rb.field.${k}`, byKey[k]?.label || k);
  const colLabel = (c) => {
    if (result?.grouped && c.key === 'outages') return tOr('rb.col.outages', c.label);
    if (result?.grouped && c.key !== result.columns[0]?.key && byKey[c.key]?.type === 'number') return t(byKey[c.key].agg === 'avg' ? 'rb.avgOf' : 'rb.totalOf', { f: label(c.key).toLowerCase() });
    return tOr(`rb.field.${c.key}`, c.label);
  };
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
    if (!columns.length) { setResult(null); setErr(t('rb.needCol')); return undefined; }
    let live = true;
    const tm = setTimeout(() => {
      setBusy(true);
      api.runReport(spec)
        .then((r) => { if (live) { setResult(r); setErr(''); } })
        .catch((e) => { if (live) setErr(e.message); })
        .finally(() => { if (live) setBusy(false); });
    }, 300);
    return () => { live = false; clearTimeout(tm); };
  }, [specKey, fields.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const announce = (s) => setSaid(s);
  const addColumn = (key, at = columns.length) => {
    if (columns.includes(key)) return;
    setColumns((c) => [...c.slice(0, at), key, ...c.slice(at)]);
    announce(t('rb.added', { f: label(key) }));
  };
  const removeColumn = (key) => { setColumns((c) => c.filter((k) => k !== key)); announce(t('rb.removed', { f: label(key) })); };
  const moveColumn = (key, to) => {
    setColumns((c) => {
      const rest = c.filter((k) => k !== key);
      const at = Math.max(0, Math.min(rest.length, to));
      return [...rest.slice(0, at), key, ...rest.slice(at)];
    });
    announce(t('rb.moved', { f: label(key), n: Math.max(1, Math.min(columns.length, to + 1)) }));
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
    if (byKey[d.key]?.type === 'number') toast(t('rb.groupNum'), 'err');
    else { setGroupBy(d.key); announce(t('rb.groupedBy', { f: label(d.key) })); }
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
    announce(t('rb.loaded', { name: r.name }));
  };
  const save = async () => {
    if (!name.trim()) { toast(t('rb.needName'), 'err'); return; }
    try { await api.saveReport(name.trim(), spec); toast(t('rb.saved', { name: name.trim() })); loadSaved(); } catch (e) { toast(e.message, 'err'); }
  };
  const del = async () => {
    const r = saved.find((x) => x.name.toLowerCase() === name.trim().toLowerCase()); if (!r) return;
    if (!window.confirm(t('rb.confirmDel', { name: r.name }))) return;
    try { await api.deleteReport(r.id); toast(t('rb.deleted', { name: r.name })); loadSaved(); } catch (e) { toast(e.message, 'err'); }
  };
  const sms = async () => {
    const n = result?.feeders?.length || 0;
    if (!n) { toast(t('rb.noFeeders'), 'err'); return; }
    if (!window.confirm(t(n === 1 ? 'rb.confirmSms1' : 'rb.confirmSmsN', { n }))) return;
    try {
      const r = await api.smsReport(name.trim() || 'Custom report', spec);
      toast(t(r.sent.length === 1 ? 'rb.smsSent1' : 'rb.smsSentN', { n: r.sent.length }) + (r.noManager.length ? t(r.noManager.length === 1 ? 'rb.noMgr1' : 'rb.noMgrN', { n: r.noManager.length }) : ''), r.sent.length ? 'ok' : 'err', 7000);
    } catch (e) { toast(e.message, 'err'); }
  };
  const exportCsv = () => api.exportBuiltReport(spec, name.trim() || 'Custom report').catch((e) => toast(t('sr.exportFailed', { e: e.message }), 'err'));

  const unused = fields.filter((f) => !columns.includes(f.key));
  const isSaved = saved.some((x) => x.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <div className="fk rb">
      <p className="sr-about">{t('rb.about1')}<b>{t('rb.columns')}</b>{t('rb.about2')}</p>
      <div className="sr-only" role="status" aria-live="polite">{said}</div>

      <div className="sr-filters">
        <div className="sr-field">
          <label className="sr-label" htmlFor="rb-saved">{t('rb.savedReports')}</label>
          <select id="rb-saved" value="" onChange={(e) => load(e.target.value)}>
            <option value="">{saved.length ? t('rb.openSaved', { n: saved.length }) : t('rb.noSaved')}</option>
            {saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="sr-field">
          <label className="sr-label" htmlFor="rb-name">{t('rb.name')}</label>
          <input id="rb-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t('rb.namePh')} className="rb-name" />
        </div>
        <button className="btn sm" onClick={save}>{isSaved ? t('rb.update') : t('rb.save')}</button>
        {isSaved && <button className="btn sm" onClick={del}>{t('rb.delete')}</button>}
        <div className="grow" />
        <button className="btn sm" onClick={exportCsv} disabled={!result}>{t('sr.exportCsv')}</button>
        <button className="btn sm" onClick={sms} disabled={!result}>{t('rb.sms')}</button>
      </div>

      <div className="rb-grid">
        <section className="rb-panel" aria-labelledby="rb-fields-h">
          <h4 id="rb-fields-h">{t('rb.fields')}</h4>
          <ul className="rb-chips rb-source">
            {unused.map((f) => (
              <li key={f.key} className={`rb-chip t-${f.type}`} draggable onDragStart={onDragStart(f.key, 'fields')} onDragEnd={onDragEnd}>
                <span>{label(f.key)}</span>
                <button className="rb-x" onClick={() => addColumn(f.key)} aria-label={t('rb.addTo', { f: label(f.key) })} title={t('rb.addToT')}>+</button>
              </li>
            ))}
            {!unused.length && <li className="muted">{t('rb.allUsed')}</li>}
          </ul>
          <p className="rb-key"><span className="rb-dot t-number" /> {t('rb.number')} <span className="rb-dot t-date" /> {t('rb.date')} <span className="rb-dot t-text" /> {t('rb.text')}</p>
        </section>

        <div className="rb-main">
          <section className="rb-panel" aria-labelledby="rb-cols-h">
            <h4 id="rb-cols-h">{t('rb.columns')} <span className="muted">· {columns.length}</span></h4>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop target; every action also has a button */}
            <ol className={`rb-chips rb-drop${drag.current ? ' armed' : ''}`} onDragOver={(e) => { e.preventDefault(); if (e.target === e.currentTarget) setDropAt(columns.length); }} onDrop={dropColumns}>
              {columns.map((k, i) => (
                <li key={k} className={`rb-chip on t-${byKey[k]?.type}${dropAt === i ? ' before' : ''}${dropAt === i + 1 && i === columns.length - 1 ? ' after' : ''}`}
                  draggable onDragStart={onDragStart(k, i)} onDragEnd={onDragEnd} onDragOver={overColumn(i)}>
                  <span>{label(k)}</span>
                  <button className="rb-x" onClick={() => moveColumn(k, i - 1)} disabled={i === 0} aria-label={t('rb.left', { f: label(k) })}>←</button>
                  <button className="rb-x" onClick={() => moveColumn(k, i + 1)} disabled={i === columns.length - 1} aria-label={t('rb.right', { f: label(k) })}>→</button>
                  <button className="rb-x" onClick={() => removeColumn(k)} aria-label={t('rb.remove', { f: label(k) })}>✕</button>
                </li>
              ))}
              {!columns.length && <li className="muted rb-hint">{t('rb.dropHere')}</li>}
            </ol>
          </section>

          <div className="rb-row2">
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop target; the select does the same */}
            <section className={`rb-panel rb-group${drag.current ? ' armed' : ''}`} aria-labelledby="rb-group-h" onDragOver={(e) => e.preventDefault()} onDrop={dropGroup}>
              <h4 id="rb-group-h">{t('rb.groupBy')} <span className="muted">{t('rb.groupHint')}</span></h4>
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-labelledby="rb-group-h">
                <option value="">{t('rb.noGroup')}</option>
                {fields.filter((f) => f.type !== 'number').map((f) => <option key={f.key} value={f.key}>{label(f.key)}</option>)}
              </select>
              {groupBy && <p className="muted rb-note">{t('rb.groupNote', { f: label(groupBy).toLowerCase() })}</p>}
            </section>

            <section className="rb-panel" aria-labelledby="rb-period-h">
              <h4 id="rb-period-h">{t('sr.period')}</h4>
              <div className="sr-row">
                <div className="seg" role="group" aria-labelledby="rb-period-h">
                  {PRESETS.map(([p, l]) => <button key={p} aria-pressed={preset === p} className={preset === p ? 'on' : ''} onClick={() => pickPreset(p)}>{tOr(`sr.p${p}`, l)}</button>)}
                </div>
                <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPreset(''); }} aria-label={t('sr.fromDate')} />
                <span className="muted">{t('sr.to')}</span>
                <input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPreset(''); }} aria-label={t('sr.toDate')} />
              </div>
            </section>
          </div>

          <section className="rb-panel" aria-labelledby="rb-filters-h">
            <h4 id="rb-filters-h">{t('rb.filters')} <span className="muted">{t('rb.allMatch')}</span></h4>
            {filters.map((f, i) => (
              <div key={i} className="sr-row rb-filter">
                <select value={f.field} onChange={(e) => setFilter(i, { field: e.target.value })} aria-label={t('rb.fField', { n: i + 1 })}>
                  {fields.map((x) => <option key={x.key} value={x.key}>{label(x.key)}</option>)}
                </select>
                <select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value })} aria-label={t('rb.fCond', { n: i + 1 })}>
                  {Object.entries(ops).filter(([o]) => byKey[f.field]?.type !== 'text' || ['eq', 'neq', 'contains'].includes(o)).map(([o, l]) => <option key={o} value={o}>{tOr(`rb.op.${o}`, l)}</option>)}
                </select>
                <input value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} aria-label={t('rb.fValue', { n: i + 1 })}
                  type={byKey[f.field]?.type === 'number' ? 'number' : byKey[f.field]?.type === 'date' ? 'date' : 'text'} placeholder={t('rb.valuePh')} />
                <button className="rb-x" onClick={() => setFilters((fs) => fs.filter((_, n) => n !== i))} aria-label={t('rb.fRemove', { n: i + 1 })}>✕</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => setFilters((fs) => [...fs, { field: 'zone', op: 'eq', value: '' }])} disabled={filters.length >= 10}>{t('rb.addFilter')}</button>
          </section>
        </div>
      </div>

      <div className="fk-range" role="status">
        <b>{name.trim() || t('rb.custom')}</b>
        {result && <span className="muted"> · {t(result.outages === 1 ? 'rb.outages1' : 'rb.outagesN', { n: result.outages })}{result.grouped ? t(result.total === 1 ? 'rb.groups1' : 'rb.groupsN', { n: result.total }) : ''} · {t(result.feeders.length === 1 ? 'rb.feeders1' : 'rb.feedersN', { n: result.feeders.length })}</span>}
        {busy && <span className="muted">{t('sr.updating')}</span>}
        {err && <span className="fk-err"> {err}</span>}
        {result?.truncated && <span className="muted">{t('rb.truncated')}</span>}
      </div>

      {result && (
        <div className="fk-scroll" style={{ maxHeight: 520, overflow: 'auto' }}>
          <table className="tbl fk-tbl" aria-label={t('rb.preview')}>
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort?.field === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <button className="rb-sort" onClick={() => sortBy(c.key)}>{colLabel(c)}{sort?.field === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 300).map((r, n) => (
                <tr key={n}>{result.columns.map((c) => <td key={c.key} className={c.type === 'number' ? 'fk-num' : undefined}>{cellText(c.key, r[c.key], c.type)}</td>)}</tr>
              ))}
            </tbody>
            {result.totals && (
              <tfoot><tr className="rb-total">{result.columns.map((c) => <td key={c.key} className={c.type === 'number' ? 'fk-num' : undefined}><b>{fmt(result.totals[c.key], c.type)}</b></td>)}</tr></tfoot>
            )}
          </table>
          {!result.rows.length && <div className="muted" style={{ padding: 14 }}>{t('rb.noMatch')}</div>}
          {result.rows.length > 300 && <div className="muted" style={{ padding: 10 }}>{t('rb.showing', { n: result.rows.length })}</div>}
        </div>
      )}
    </div>
  );
}
