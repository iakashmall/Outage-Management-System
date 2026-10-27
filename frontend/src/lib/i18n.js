import { useSyncExternalStore } from 'react';
import { en as coreEn, hi as coreHi } from './locales.js';

// Core strings live in locales.js; each screen keeps its own in lib/locales/<screen>.js
// (export const en = {...}, hi = {...}), merged here at build time.
const parts = Object.values(import.meta.glob('./locales/*.js', { eager: true }));
const en = Object.assign({}, coreEn, ...parts.map((m) => m.en || {}));
const hi = Object.assign({}, coreHi, ...parts.map((m) => m.hi || {}));

// P8.7c localisation. A tiny store, no library:
//   const { t, lang } = useT();   t('nav.dashboard'), t('dash.nCritical', { n: 3 })
// Missing Hindi keys fall back to English, missing English keys to the key itself,
// so a half-translated screen still reads. The choice is per browser (localStorage)
// and sets <html lang>, which screen readers use to pick the voice (WCAG 3.1.1).
export const LANGS = [['en', 'English'], ['hi', 'हिन्दी']];
const DICTS = { en, hi };
const KEY = 'gridq.lang';

const initial = () => {
  try { const v = localStorage.getItem(KEY); if (DICTS[v]) return v; } catch { /* storage blocked */ }
  return 'en';
};
let lang = initial();
const subs = new Set();
const apply = () => { if (typeof document !== 'undefined') document.documentElement.lang = lang; };
apply();

export function setLang(next) {
  if (!DICTS[next] || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
  apply();
  subs.forEach((f) => f());
}
export const getLang = () => lang;
export const locale = () => (lang === 'hi' ? 'hi-IN' : 'en-IN');

// Plain function for code outside components (toasts, helpers); components use useT()
// so they re-render when the language changes.
export function t(key, vars) {
  const s = DICTS[lang][key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s;
}

// For data values (incident type, status...) that may have no translation: show the value itself.
export const tOr = (key, fallback) => { const s = t(key); return s === key ? fallback : s; };

const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
export function useT() {
  const current = useSyncExternalStore(subscribe, getLang);
  return { t, lang: current };
}
