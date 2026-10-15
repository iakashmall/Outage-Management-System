// Hand-worked checks for domain/feederKpi.js. Pure: no DB, no network.
// Run: node src/selftest-feederkpi.js
import assert from 'node:assert/strict';
import { computeFeederKpis, aggregateKpis, periodRange, KPI_KEYS, istDay } from './domain/feederKpi.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}

// Round numbers make the arithmetic checkable by hand.
const RATING = { v_nominal_v: 1000, i_nominal_a: 100, v_hi_pct: 110, v_lo_pct: 90, i_hi_pct: 100, i_lo_pct: 10, v_sag_pct: 90, i_sag_drop_pct: 30 };
const T0 = Date.parse('2026-10-01T00:00:00Z');
const MIN = 60_000;
// One sample per minute; `f(n)` overrides fields of sample n.
function series(count, f = () => ({})) {
  return Array.from({ length: count }, (_, n) => ({
    ts: new Date(T0 + n * MIN).toISOString(),
    v_r: 1000, v_y: 1000, v_b: 1000, i_r: 50, i_y: 50, i_b: 50, ...f(n),
  }));
}
const run = (s, extra = {}) => computeFeederKpis(s, RATING, { from: new Date(T0), to: new Date(T0 + s.length * MIN), maxGapMs: 5 * MIN, ...extra });

console.log('\nPFC feeder KPI self-test\n');

t('nominal feeder: zero incidents, 100% max/min, FLIF 100', () => {
  const { kpis, coverage } = run(series(60));
  assert.equal(kpis.FVHI_T, 0); assert.equal(kpis.FVLD_T, 0); assert.equal(kpis.FCHI_T, 0);
  assert.equal(kpis.FMXV_R, 100); assert.equal(kpis.FMNV_T, 100);
  assert.equal(kpis.FMXC_T, 50); assert.equal(kpis.FMNC_T, 50);
  assert.equal(kpis.FLIF, 100);
  assert.equal(kpis.FVSM_T, null); assert.equal(kpis.FCSM_T, null);
  assert.equal(coverage.completenessPct, 100);
});

t('every key present with the right suffixes (16 x 4 + FLIF = 65)', () => {
  const { kpis } = run(series(5));
  assert.equal(KPI_KEYS.length, 65);
  for (const k of KPI_KEYS) assert.ok(k in kpis, k);
  assert.ok(!('FLIF_T' in kpis));
});

t('voltage high: two excursions on R (3 min + 2 min), stress = sum of (V-Vhi) x minutes', () => {
  // R at 1120 V for minutes 10-12 and 1150 V for 20-21
  const s = series(30, (n) => (n >= 10 && n <= 12 ? { v_r: 1120 } : n >= 20 && n <= 21 ? { v_r: 1150 } : {}));
  const { kpis } = run(s);
  assert.equal(kpis.FVHI_R, 2); assert.equal(kpis.FVHD_R, 5);
  assert.equal(kpis.FVHI_Y, 0); assert.equal(kpis.FVHI_T, 2); assert.equal(kpis.FVHD_T, 5);
  assert.equal(kpis.FVSV_R, 20 * 3 + 50 * 2); // 160 V-min above the 1100 V limit
  assert.equal(kpis.FVSV_T, 160);
  assert.equal(kpis.FMXV_R, 115); assert.equal(kpis.FMXV_T, 115);
});

t('_T is feeder-level: overlapping R and B breaches are ONE incident', () => {
  // R low 5-9, B low 8-12 -> union 5-12 = 8 min, one incident
  const s = series(20, (n) => ({ ...(n >= 5 && n <= 9 ? { v_r: 850 } : {}), ...(n >= 8 && n <= 12 ? { v_b: 880 } : {}) }));
  const { kpis } = run(s);
  assert.equal(kpis.FVLI_R, 1); assert.equal(kpis.FVLD_R, 5);
  assert.equal(kpis.FVLI_B, 1); assert.equal(kpis.FVLD_B, 5);
  assert.equal(kpis.FVLI_T, 1); assert.equal(kpis.FVLD_T, 8);
  assert.equal(kpis.FMNV_T, 85);
});

t('de-energised feeder is NOT low voltage (it is an interruption)', () => {
  const s = series(20, (n) => (n >= 5 && n < 15 ? { v_r: 0, v_y: 0, v_b: 0, i_r: 0, i_y: 0, i_b: 0 } : {}));
  const { kpis, coverage } = run(s);
  assert.equal(kpis.FVLI_T, 0); assert.equal(kpis.FCLI_T, 0);
  assert.equal(kpis.FMNV_T, 100);
  assert.equal(coverage.deadMinutes, 10);
});

t('loss of one phase IS low voltage on that phase', () => {
  const s = series(20, (n) => (n >= 5 && n < 9 ? { v_y: 0, i_y: 0 } : {}));
  const { kpis } = run(s);
  assert.equal(kpis.FVLI_Y, 1); assert.equal(kpis.FVLD_Y, 4); assert.equal(kpis.FMNV_Y, 0);
  assert.equal(kpis.FCLI_Y, 1);
});

t('data gap longer than maxGap breaks an excursion; time stops at maxGap', () => {
  // high at 0-2, gap (no samples 3-12), high again 13-14
  const s = series(15, (n) => (n <= 2 || n >= 13 ? { v_r: 1200 } : {})).filter((_, n) => n <= 2 || n >= 13);
  const { kpis, coverage } = run(s, { to: new Date(T0 + 15 * MIN) });
  assert.equal(kpis.FVHI_R, 2);
  assert.equal(kpis.FVHD_R, 1 + 1 + 5 + 1 + 1); // sample 2 holds maxGap (5 min) into the gap
  assert.ok(coverage.completenessPct < 100);
});

t('excursion running at period start (prior sample) is not counted again', () => {
  const s = series(10, (n) => (n < 3 ? { i_b: 130 } : {}));
  const prior = { ts: new Date(T0 - MIN).toISOString(), v_r: 1000, v_y: 1000, v_b: 1000, i_r: 50, i_y: 50, i_b: 130 };
  assert.equal(run(s).kpis.FCHI_B, 1);
  const { kpis } = run(s, { prior });
  assert.equal(kpis.FCHI_B, 0); assert.equal(kpis.FCHD_B, 3);
  assert.equal(kpis.FCSV_B, 30 * 3);
  assert.equal(kpis.FMXC_B, 130);
});

t('voltage sag: deepest residual between 10% and 90% of nominal', () => {
  const s = series(10, (n) => (n === 4 ? { v_y: 700 } : n === 6 ? { v_y: 820, v_r: 880 } : {}));
  const { kpis } = run(s);
  assert.equal(kpis.FVSM_Y, 70); assert.equal(kpis.FVSM_R, 88); assert.equal(kpis.FVSM_B, null);
  assert.equal(kpis.FVSM_T, 70);
});

t('current sag: sudden drop > 30% of previous sample', () => {
  // R: 50 -> 30 (40% drop, sag at 30%) ; Y: 50 -> 40 (20% drop, not a sag)
  const s = series(6, (n) => (n === 3 ? { i_r: 30, i_y: 40 } : {}));
  const { kpis } = run(s);
  assert.equal(kpis.FCSM_R, 30); assert.equal(kpis.FCSM_Y, null); assert.equal(kpis.FCSM_T, 30);
});

t('FLIF = worst instant of max/min phase current x 100', () => {
  const s = series(10, (n) => (n === 5 ? { i_r: 80, i_y: 40, i_b: 50 } : {}));
  const { kpis, extras } = run(s);
  assert.equal(kpis.FLIF, 200);
  assert.equal(extras.FLIF_AVG, 110); // (9 x 100 + 1 x 200) / 10
});

t('FLIF ignores a nearly unloaded feeder (< 5% of nominal)', () => {
  const s = series(5, () => ({ i_r: 4, i_y: 1, i_b: 2 }));
  assert.equal(run(s).kpis.FLIF, null);
});

t('stress: a feeder above nominal but inside its band reads 0', () => {
  const s = series(30, () => ({ v_r: 1080, v_y: 1080, v_b: 1080, i_r: 95, i_y: 95, i_b: 95 }));
  const { kpis } = run(s);
  assert.equal(kpis.FVSV_T, 0); assert.equal(kpis.FCSV_T, 0);
});

t('aggregate: sums incidents/durations/stress, max of max, min of min/sag', () => {
  const a = run(series(30, (n) => (n < 2 ? { v_r: 1150 } : n === 10 ? { v_b: 700 } : {})));
  const b = run(series(30, (n) => (n < 3 ? { v_r: 1200 } : {})));
  const g = aggregateKpis([a, b]);
  assert.equal(g.kpis.FVHI_R, 2); assert.equal(g.kpis.FVHD_R, 5);
  assert.equal(g.kpis.FVSV_R, 50 * 2 + 100 * 3);
  assert.equal(g.kpis.FMXV_R, 120); assert.equal(g.kpis.FMNV_B, 70);
  assert.equal(g.kpis.FVSM_T, 70);
  assert.equal(g.coverage.periodMinutes, 60);
});

t('periods: IST day boundaries, Monday weeks, Indian FY quarter/year', () => {
  const d = periodRange('daily', { date: '2026-10-14' });
  assert.equal(d.from.toISOString(), '2026-10-13T18:30:00.000Z');
  assert.equal(d.days.length, 1);
  const w = periodRange('weekly', { date: '2026-10-14' }); // a Wednesday
  assert.equal(w.days[0], '2026-10-12'); assert.equal(w.days.length, 7);
  const m = periodRange('monthly', { date: '2026-02-10' });
  assert.equal(m.days.length, 28);
  const q = periodRange('quarterly', { date: '2026-02-10' });
  assert.equal(q.days[0], '2026-01-01'); assert.equal(q.label, 'Q4 FY2025-26');
  const y = periodRange('yearly', { date: '2026-10-14' });
  assert.equal(y.days[0], '2026-04-01'); assert.equal(y.days.length, 365); assert.equal(y.label, 'FY 2026-27');
  const yc = periodRange('yearly', { date: '2026-10-14', fyStartMonth: 1 });
  assert.equal(yc.days[0], '2026-01-01');
  const c = periodRange('custom', { from: '2026-10-01', to: '2026-10-03' });
  assert.equal(c.days.length, 3);
  assert.equal(istDay('2026-10-13T19:00:00Z'), '2026-10-14');
  assert.throws(() => periodRange('custom', { from: '2026-10-05', to: '2026-10-01' }));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
