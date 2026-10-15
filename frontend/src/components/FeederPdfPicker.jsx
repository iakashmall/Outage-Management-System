import { useEffect, useMemo, useRef, useState } from 'react';

// "Export PDF" button with a feeder picker: tick feeders (or whole substations),
// then download one PDF with a summary table and every KPI trend chart per feeder.
const MAX = 25; // the server's limit per PDF

const shortSub = (s) => s.replace(/^33\/11 kV\s*/i, '').replace(/\s*S\/s$/i, '');

export default function FeederPdfPicker({ feeders, initial = [], onExport, disabled }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const boxRef = useRef(null);

  // Opening starts from the feeder(s) currently in view.
  const toggleOpen = () => {
    if (!open) { setPicked(new Set(initial)); setErr(null); setQ(''); }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const groups = useMemo(() => {
    const m = new Map();
    const needle = q.trim().toLowerCase();
    for (const f of feeders) {
      const s = f.substation || 'Unassigned';
      if (needle && !`${f.feeder} ${s}`.toLowerCase().includes(needle)) continue;
      (m.get(s) || m.set(s, []).get(s)).push(f.feeder);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([s, fs]) => [s, fs.sort()]);
  }, [feeders, q]);

  const flip = (ids, on) => setPicked((p) => {
    const n = new Set(p);
    for (const id of ids) { if (on) n.add(id); else n.delete(id); }
    return n;
  });
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onExport([...picked].sort()); setOpen(false); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <span className="fp" ref={boxRef}>
      <button className="btn sm" onClick={toggleOpen} disabled={disabled} aria-expanded={open}>Export PDF</button>
      {open && (
        <div className="fp-pop" role="dialog" aria-label="Feeders to export">
          <div className="fp-head">
            <b>Feeders in the PDF</b>
            <span className={picked.size > MAX ? 'fp-over' : 'muted'}>{picked.size} selected{picked.size > MAX ? ` · max ${MAX}` : ''}</span>
          </div>
          <input className="fp-search" placeholder="Search feeder or substation" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="fp-list">
            {groups.map(([s, fs]) => {
              const all = fs.every((f) => picked.has(f));
              return (
                <div key={s} className="fp-group">
                  <label className="fp-sub">
                    <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = !all && fs.some((f) => picked.has(f)); }}
                      onChange={() => flip(fs, !all)} />
                    {shortSub(s)} <span className="muted">({fs.length})</span>
                  </label>
                  {fs.map((f) => (
                    <label key={f} className="fp-item">
                      <input type="checkbox" checked={picked.has(f)} onChange={(e) => flip([f], e.target.checked)} />
                      <span className="mono">{f}</span>
                    </label>
                  ))}
                </div>
              );
            })}
            {!groups.length && <div className="muted fp-none">No feeders match.</div>}
          </div>
          {err && <div className="fp-err">{err}</div>}
          <div className="fp-foot">
            <button className="btn sm" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</button>
            <span className="muted">4 pages per feeder</span>
            <button className="btn sm primary" onClick={go} disabled={busy || !picked.size || picked.size > MAX}>
              {busy ? 'Building PDF…' : 'Download PDF'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
