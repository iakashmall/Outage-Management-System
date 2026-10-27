import { useEffect } from 'react';

// Keyboard "gate" for every data table inside `rootRef` (WCAG 2.1.1, 2.4.3).
// A table with clickable rows would otherwise put every row button in the Tab order,
// so getting past a 50-row list took 50 presses. Instead each table is ONE Tab stop:
//   Tab        lands on the table (or its scrollable region wrapper)
//   Enter      steps inside, focus goes to the first row
//   Tab / ↑↓   move row by row (one stop per row: the row's first control)
//   ← / →      reach the row's other controls, if it has more than one
//   Esc        back out to the table; Tab then continues past it
// Leaving the table (Tab out, click elsewhere) closes it again. Applied from the DOM, so
// tables added later or re-rendered by live updates are covered without per-screen code.
// The Network Map gets the same gate for its markers (Leaflet makes each one a Tab stop);
// on the map itself the arrow keys still pan and +/- zoom.
// Read-only tables (nothing clickable) get the same gate, and inside them each row is
// the stop, so a screen reader reads the row and the keyboard user can still step through.

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [data-tgate-ti]';
const HINT_ID = 'tgate-hint';

const MAP_HINT_ID = 'tgate-map-hint';

function ensureHint(id = HINT_ID, text = 'Press Enter to move into the table, Escape to leave it.') {
  if (document.getElementById(id)) return;
  const el = document.createElement('span');
  el.id = id;
  el.className = 'sr-only';
  el.textContent = text;
  document.body.appendChild(el);
}

// A map gate only holds back its markers; its zoom buttons stay in the normal Tab order.
const MAP_ITEMS = '.leaflet-marker-pane [tabindex], .leaflet-marker-pane [data-tgate-ti]';
const inner = (gate) => [...gate.querySelectorAll(gate.dataset.tgateKind === 'map' ? MAP_ITEMS : FOCUSABLE)].filter((el) => el !== gate && !el.disabled && !el.closest('.sr-only'));

function lock(gate) {
  for (const el of inner(gate)) {
    if (!el.hasAttribute('data-tgate-ti')) el.setAttribute('data-tgate-ti', el.getAttribute('tabindex') ?? '');
    el.tabIndex = -1;
  }
}

// Open: one Tab stop per row - the row's first control - so Tab walks the rows.
function unlockRows(gate) {
  const firsts = new Set();
  for (const el of inner(gate)) {
    const tr = el.closest('tr');
    if (!tr || ![...firsts].some((f) => f.closest('tr') === tr)) firsts.add(el);
  }
  for (const el of inner(gate)) {
    if (firsts.has(el)) restore(el);
    else { if (!el.hasAttribute('data-tgate-ti')) el.setAttribute('data-tgate-ti', el.getAttribute('tabindex') ?? ''); el.tabIndex = -1; }
  }
}

function restore(el) {
  const ti = el.getAttribute('data-tgate-ti');
  if (ti === null) return;
  el.removeAttribute('data-tgate-ti');
  if (ti === '') el.removeAttribute('tabindex'); else el.setAttribute('tabindex', ti);
}


// Read-only table: make each body row a (locked) stop of its own.
function markRows(gate) {
  for (const tr of gate.querySelectorAll('tbody tr')) {
    if (tr.hasAttribute('data-tgate-row')) continue;
    tr.setAttribute('data-tgate-row', '');
    tr.setAttribute('data-tgate-ti', '0');
    tr.tabIndex = -1;
  }
}

function setup(table) {
  // Use an existing scrollable region wrapper as the stop, so it isn't two stops.
  const gate = table.closest('[role="region"][tabindex]') || table;
  if (gate.dataset.tgate) return;
  const hint = gate.dataset.tgateKind === 'map' ? MAP_HINT_ID : HINT_ID;
  if (!inner(gate).length) {
    if (gate.dataset.tgateKind === 'map' || !gate.querySelector('tbody tr')) return; // nothing to step through yet
    gate.dataset.tgateRows = '1';
    markRows(gate);
  }
  gate.dataset.tgate = 'closed';
  gate.tabIndex = 0;
  const desc = gate.getAttribute('aria-describedby');
  if (!desc?.includes(hint)) gate.setAttribute('aria-describedby', desc ? `${desc} ${hint}` : hint);
  lock(gate);
}

const open = (gate) => { if (gate.dataset.tgate !== 'open') { gate.dataset.tgate = 'open'; unlockRows(gate); } };
const close = (gate) => { if (gate.dataset.tgate !== 'closed') { gate.dataset.tgate = 'closed'; lock(gate); } };

function moveRow(from, dir) {
  if (from.hasAttribute('data-tgate-row')) {
    let row = from;
    while ((row = dir > 0 ? row.nextElementSibling : row.previousElementSibling)) {
      if (row.hasAttribute('data-tgate-row')) { row.focus(); row.scrollIntoView?.({ block: 'nearest' }); return true; }
    }
    return true;
  }
  const td = from.closest('td, th');
  const tr = from.closest('tr');
  if (!td || !tr) return false;
  const col = [...tr.children].indexOf(td);
  let row = tr;
  while ((row = dir > 0 ? row.nextElementSibling : row.previousElementSibling)) {
    const cell = row.children[col];
    const target = (cell && cell.querySelector(FOCUSABLE)) || row.querySelector(FOCUSABLE);
    if (target) { target.focus(); target.scrollIntoView?.({ block: 'nearest' }); return true; }
  }
  return true; // at the edge: swallow the key so the page doesn't scroll
}

export function useTableGates(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    ensureHint();
    ensureHint(MAP_HINT_ID, 'Press Enter to Tab through the markers, Escape to leave them.');

    const scan = () => {
      root.querySelectorAll('table:not(.sr-only)').forEach(setup);
      // Leaflet makes every marker a Tab stop; the map gets the same Enter-to-enter gate.
      root.querySelectorAll('.leaflet-container').forEach((m) => { m.dataset.tgateKind = 'map'; setup(m); });
      // New rows rendered into a table must follow its current mode.
      root.querySelectorAll('[data-tgate-rows]').forEach(markRows);
      root.querySelectorAll('[data-tgate="closed"]').forEach(lock);
      root.querySelectorAll('[data-tgate="open"]').forEach(unlockRows);
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });

    const onKeyDown = (e) => {
      const gate = e.target.closest?.('[data-tgate]');
      if (!gate) return;
      if (e.target === gate) {
        if (e.key === 'Enter') {
          e.preventDefault();
          open(gate);
          inner(gate)[0]?.focus();
        }
        return;
      }
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault(); // stops App's Esc-to-rail
        close(gate);
        gate.focus();
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.target.closest('input, select, textarea, [role="combobox"]')) {
        if (moveRow(e.target, e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
      }
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest('input, select, textarea, [role="combobox"]')) {
        const tr = e.target.closest('tr');
        if (!tr) return;
        const items = inner(tr);
        const next = items[items.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : -1)];
        if (next) { e.preventDefault(); next.focus(); }
      }
    };
    // Focus arriving inside a closed table (mouse click, focus restored after a drawer) opens it.
    const onFocusIn = (e) => {
      const gate = e.target.closest?.('[data-tgate]');
      if (gate && e.target !== gate) open(gate);
    };
    const onFocusOut = (e) => {
      const gate = e.target.closest?.('[data-tgate="open"]');
      if (gate && !gate.contains(e.relatedTarget)) close(gate);
    };
    // NVDA in browse mode turns Enter into a click on the focused element, so a click on the
    // table itself (not on a row inside it) must open it as well.
    const onClick = (e) => {
      const gate = e.target.closest?.('[data-tgate]');
      if (gate && e.target === gate && gate.dataset.tgate === 'closed' && gate.dataset.tgateKind !== 'map') { open(gate); inner(gate)[0]?.focus(); }
    };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      mo.disconnect();
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [rootRef]);
}
