import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useT, t as tr, tOr } from '../lib/i18n.js';

// Reuses the exact .ms-box / .ms-results / .ms-item CSS already proven by
// NetworkMap's own place search (see index.css) — a plain, reliable
// position:absolute dropdown under a position:relative wrapper, rather
// than the third-party kokonutui command-palette component this replaced.
// That component was built as a full-screen modal search overlay (its own
// JS-calculated position:fixed coordinates kept landing in the wrong place
// once dropped into a small 260px header slot), not an inline header
// search box — fighting its internals wasn't worth it when this app
// already has a working pattern for exactly this UI.
// White tag text on these must reach 4.5:1 (WCAG 1.4.3); high/low/fallback match the --high/--low/--muted tokens.
const SEV_COLOR = { critical: '#c73a3a', high: '#9a5f15', medium: '#2f6fd6', low: '#217b48' };

export default function IncidentSearch({ onOpen }) {
  useT();
  const [all, setAll] = useState([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef(null);

  useEffect(() => { api.incidents().then(setAll); }, []);

  // close on outside click
  useEffect(() => {
    const onDocClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const query = q.trim().toLowerCase();
  const results = (query
    ? all.filter((i) =>
        i.id.toLowerCase().includes(query) ||
        (i.zone || '').toLowerCase().includes(query) ||
        (i.feeder || '').toLowerCase().includes(query)
      )
    : all
  ).slice(0, 12);

  // Combobox pattern (WCAG 2.1.1, 4.1.2): focusing the box does not open the list, so Tab passes
  // straight through. Enter / ↓ / typing opens it; ↑↓ move, Enter opens, Esc or Tab closes.
  // Results are not tab stops; aria-activedescendant tells the screen reader which one is active.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); setActive(-1); return; }
    if (e.key === 'Tab') { setOpen(false); setActive(-1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { setOpen(true); setActive(0); } else setActive((a) => Math.min(a + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && results[active]) select(results[active]);
      else { setOpen(true); setActive(0); }
    }
  };

  const select = (inc) => {
    setOpen(false);
    setActive(-1);
    setQ('');
    if (onOpen) onOpen(inc);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <div className="ms-box">
        <Search size={15} />
        <input
          role="combobox"
          aria-label={tr('srch.aria')}
          aria-expanded={open}
          aria-controls="incident-search-list"
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 && results[active] ? `isr-${results[active].id}` : undefined}
          placeholder={tr('srch.ph')}
          value={q}
          onClick={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
          onKeyDown={onKeyDown}
        />
        {q && (
          <button className="ms-clear" tabIndex={-1} aria-label={tr('srch.clear')} onMouseDown={(e) => e.preventDefault()} onClick={() => setQ('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="ms-results" id="incident-search-list" role="listbox" aria-label={tr('srch.matching')} style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 2100, marginTop: 0 }}>
          {!results.length && <div className="ms-empty">{query ? tr('srch.noMatch', { q }) : tr('srch.none')}</div>}
          {results.map((i, idx) => (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard handled on the combobox input
            <div
              key={i.id}
              id={`isr-${i.id}`}
              role="option"
              aria-selected={idx === active}
              className={`ms-item${idx === active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(idx)}
              onClick={() => select(i)}
            >
              <span className="ms-tag" style={{ background: SEV_COLOR[i.severity] || '#5e6d82' }}>{tOr(`sev.${i.severity}`, i.severity)}</span>
              <span className="ms-label">{i.zone} · {i.id}</span>
              <span className="ms-sub">{tOr(`crew.lcst.${i.status}`, i.status.replace('_', ' '))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}