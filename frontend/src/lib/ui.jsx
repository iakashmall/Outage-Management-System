import { useEffect, useState, useCallback, useRef } from 'react';
import { useT, t as tr, tOr } from './i18n.js';
import { socket } from './api.js';

// Text alternative for a chart (WCAG 1.1.1 / 1.3.1): the same numbers as a
// table that only assistive technology sees. The SVG itself stays role="img".
// Clickable table rows are mouse-only (a <tr> can't take focus). Put one of these
// in the row's first cell: same action, reachable by Tab, named for screen readers
// (WCAG 2.1.1). It stops propagation so the row's own click doesn't fire twice.
// After a view button opens its view, move focus to the first control of that view
// (the first focusable after `anchor`), so the next Tab goes on into the view instead of
// through the remaining view buttons (WCAG 2.4.3). Runs after the view has rendered.
export function focusAfter(anchor) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!anchor) return;
    const root = anchor.closest('main') || document;
    const next = [...root.querySelectorAll(sel)].find((el) => !anchor.contains(el) && anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !el.closest('.sr-only'));
    next?.focus();
  }));
}

export function RowButton({ label, onActivate, children, ...rest }) {
  return (
    <button type="button" className="row-open" aria-label={label}
      onClick={(e) => { e.stopPropagation(); onActivate(); }} {...rest}>{children}</button>
  );
}

export function SrTable({ caption, head, rows }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
    </table>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Modal behaviour for hand-rolled overlays/drawers (WCAG 2.1.1, 2.1.2, 2.4.3):
// Escape closes (backdrop click is mouse-only), Tab / Shift+Tab cycle inside
// the dialog instead of escaping to the page behind, focus moves in on open
// (unless a field already took it via autoFocus) and returns to the opener on
// close. Pass onClose = null while the dialog is not shown.
export function useDialog(ref, onClose) {
  const close = useRef(onClose);
  close.current = onClose;
  const open = !!onClose;
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector(FOCUSABLE);
      (first || el).focus();
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { close.current?.(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, [open, ref]);
}

// minimal inline icon set (stroke, 20x20)
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
export const Icon = ({ name, size = 20 }) => {
  const paths = {
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" {...P} /><rect x="14" y="3" width="7" height="5" rx="1.5" {...P} /><rect x="14" y="12" width="7" height="9" rx="1.5" {...P} /><rect x="3" y="16" width="7" height="5" rx="1.5" {...P} /></>,
    map: <><path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2Z" {...P} /><path d="M9 3v16M15 5v16" {...P} /></>,
    bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" {...P} />,
    users: <><circle cx="9" cy="8" r="3.2" {...P} /><path d="M3 20a6 6 0 0 1 12 0" {...P} /><path d="M16 5.5a3 3 0 0 1 0 5.5M18 20a6 6 0 0 0-3-5" {...P} /></>,
    bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" {...P} /><path d="M10 20a2 2 0 0 0 4 0" {...P} /></>,
    phone: <path d="M6 3h3l1.5 5-2 1.5a12 12 0 0 0 5 5l1.5-2 5 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2Z" {...P} />,
    chart: <><path d="M4 20V4M4 20h16" {...P} /><rect x="7" y="12" width="3" height="5" {...P} /><rect x="12" y="8" width="3" height="9" {...P} /><rect x="17" y="5" width="3" height="12" {...P} /></>,
    gear: <><circle cx="12" cy="12" r="3" {...P} /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" {...P} /></>,
    x: <path d="M6 6l12 12M18 6 6 18" {...P} />,
    check: <path d="M4 12l5 5L20 6" {...P} />,
    plus: <path d="M12 5v14M5 12h14" {...P} />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" {...P} />,
    pin: <><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11Z" {...P} /><circle cx="12" cy="10" r="2.4" {...P} /></>,
    clock: <><circle cx="12" cy="12" r="8.5" {...P} /><path d="M12 7v5l3 2" {...P} /></>,
    clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" {...P} /><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h4" {...P} /></>,
    inbox: <><path d="M3 13h5l1.5 3h5L16 13h5" {...P} /><path d="M4 13 6 5h12l2 8v6a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19Z" {...P} /></>,
  };
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">{paths[name]}</svg>;
};

// Labels translate (P8.7c); the class keeps the data value so colours don't change.
export const SevBadge = ({ sev }) => { useT(); return <span className={`badge-sev sev-${sev}`}>{tOr(`sev.${sev}`, sev)}</span>; };
export const StatusBadge = ({ status }) => {
  const { t } = useT();
  const key = `st.${status}`;
  const label = t(key) !== key ? t(key) : status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
  return <span className={`badge-st st-${status}`}>{label}</span>;
};

// Crew status dot shared by the roster views. Off shift is drawn as a hollow
// ring so it reads differently from a crew that is merely on a break.
const CREW_STATUS_COLOR = { available: 'var(--live)', in_service: 'var(--med)', in_transit: 'var(--high)', on_break: 'var(--faint)' };
export const CrewDot = ({ status, size = 9 }) => { useT(); return (
  status === 'off_shift'
    ? <span title={tr('crew.dot.off_shift')} style={{ width: size, height: size, borderRadius: '50%', flex: '0 0 auto', boxSizing: 'border-box', border: '2px solid var(--muted)' }} />
    : <span title={tOr(`crew.dot.${status}`, status)} style={{ width: size, height: size, borderRadius: '50%', flex: '0 0 auto', background: CREW_STATUS_COLOR[status] || 'var(--faint)' }} />
); };

// OMS-03: a crew offered for assignment may already be working (GET
// /incidents/:id/nearest-crews lists every on-shift crew): " · on site · 2 jobs".
const CREW_STATUS_TEXT = { in_transit: 'en route', in_service: 'on site', on_break: 'on break' };
export const crewBusyText = (c) => {
  if (c.status === 'available' && !c.active_jobs) return '';
  const st = CREW_STATUS_TEXT[c.status] ? tr(`crew.busy.${c.status}`) : (c.status === 'available' ? '' : tOr(`crew.lc.${c.status}`, c.status));
  const jobs = c.active_jobs ? tr(c.active_jobs === 1 ? 'crew.job1' : 'crew.jobs', { n: c.active_jobs }) : '';
  return [st, jobs].filter(Boolean).map((s) => ` · ${s}`).join('');
};

export const timeAgo = (iso) => {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return tr('ago.s', { n: s });
  if (s < 3600) return tr('ago.m', { n: Math.floor(s / 60) });
  if (s < 86400) return tr('ago.h', { n: Math.floor(s / 3600) });
  return tr('ago.d', { n: Math.floor(s / 86400) });
};
export const hhmm = (iso) => iso ? new Date(iso).toTimeString().slice(0, 5) : '—';

// subscribe to one or more socket topics; re-runs cb on any of them
export function useLiveRefresh(topics, cb) {
  useEffect(() => {
    const h = () => cb();
    topics.forEach((t) => socket.on(t, h));
    return () => topics.forEach((t) => socket.off(t, h));
  }, topics); // eslint-disable-line
}

export function useConnection() {
  const [up, setUp] = useState(socket.connected);
  useEffect(() => {
    const on = () => setUp(true), off = () => setUp(false);
    socket.on('connect', on); socket.on('disconnect', off);
    return () => { socket.off('connect', on); socket.off('disconnect', off); };
  }, []);
  return up;
}

// toast system
let pushExternal = () => {};
export function useToasts() {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'ok', ms = 3200) => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), ms);
  }, []);
  useEffect(() => { pushExternal = push; }, [push]);
  return { items, push };
}
export const toast = (msg, kind, ms) => pushExternal(msg, kind, ms);
