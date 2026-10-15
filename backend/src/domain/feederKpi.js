// PFC feeder-wise power-quality KPIs (O&M requirement, items a-q).
//
// PURE module: no I/O, no database, no clock except what the caller passes in.
// Same rule as indices.js and lifecycle.js, so the maths can be unit-tested
// against hand-worked examples (selftest-feederkpi.js) and never changes when
// the storage layer does.
//
// Input: a time series of per-phase samples for ONE feeder
//   { ts, v_r, v_y, v_b, i_r, i_y, i_b }   volts phase-to-neutral, amps
// Output: every KPI with suffix _R, _Y, _B, _T (except FLIF, which has none).
//
// How a sample becomes "time": each sample holds until the next one, clipped
// to the period end and to maxGapMs. A gap longer than maxGapMs is missing
// data: it adds no duration and it breaks an excursion, so the next breach
// after a gap is a new incident.
//
// Decisions the spec leaves open (all in one place, see docs/FEEDER_KPI.md):
//   * _T for incidents/durations = feeder-level: ANY phase in breach.
//     _T for stress = R+Y+B. _T for max = highest phase, min/sag = lowest phase.
//   * A de-energised feeder (all three phase voltages < DEAD_PCT of nominal) is
//     an interruption, already counted by SAIDI/SAIFI. Those samples are left
//     out of every PQ index, so an outage does not read as "low voltage".
//     Loss of ONE phase is not an interruption and does count as low voltage.
//   * FMXC/FMNC are divided by NOMINAL CURRENT (the source text says "nominal
//     voltage" for these two, which cannot give a percentage of current).
//   * FVSV / FCSV integrate only what is ABOVE THE HIGH LIMIT (v_hi_pct /
//     i_hi_pct of nominal), not above nominal: the source text says "V - Vnom
//     while V > Vnom", but that makes a healthy feeder at 103% pile up
//     millions of V-min a week. Measured from the limit, a feeder inside its
//     band reads 0 and the value is the overvoltage / overload actually seen.
//   * Voltage sag (FVSM): residual voltage between DEAD_PCT and v_sag_pct of
//     nominal (IEC 61000-4-30 sag/interruption thresholds). Reported as the
//     DEEPEST residual voltage in % of nominal. null = no sag in the period.
//   * Current sag (FCSM): a sudden drop of more than i_sag_drop_pct relative to
//     the previous sample (not to zero). Reported as the deepest sagged current
//     in % of nominal. null = no sag.
//   * FLIF: (max phase current / min phase current) x 100 at each instant;
//     the period value is the WORST (highest) instant. Instants with a phase at
//     zero current or a feeder below FLIF_MIN_LOAD_PCT load are skipped.

export const PHASES = ['R', 'Y', 'B'];
export const SUFFIXES = ['R', 'Y', 'B', 'T'];
export const DEAD_PCT = 10;          // below this % of nominal V = no supply
export const FLIF_MIN_LOAD_PCT = 5;  // ignore imbalance on a nearly unloaded feeder

// Defaults for an 11 kV feeder; every value is overridable per feeder.
export const DEFAULT_RATING = Object.freeze({
  v_nominal_v: 6350.85,   // 11 kV / sqrt(3), phase-to-neutral
  i_nominal_a: 200,
  v_hi_pct: 110,
  v_lo_pct: 90,
  i_hi_pct: 100,
  i_lo_pct: 10,
  v_sag_pct: 90,
  i_sag_drop_pct: 30,
});

// Catalogue in the order of the requirement (a..q). `agg` says how daily
// values combine into weekly/monthly/quarterly/yearly values.
export const KPI_DEFS = [
  { item: 'a', code: 'FVHI', name: 'Feeder voltage high incidents', unit: 'Nos', agg: 'sum' },
  { item: 'b', code: 'FVHD', name: 'Feeder voltage high duration', unit: 'min', agg: 'sum' },
  { item: 'c', code: 'FVLI', name: 'Feeder voltage low incidents', unit: 'Nos', agg: 'sum' },
  { item: 'd', code: 'FVLD', name: 'Feeder voltage low duration', unit: 'min', agg: 'sum' },
  { item: 'e', code: 'FCHI', name: 'Feeder current high incidents', unit: 'Nos', agg: 'sum' },
  { item: 'f', code: 'FCHD', name: 'Feeder current high duration', unit: 'min', agg: 'sum' },
  { item: 'g', code: 'FCLI', name: 'Feeder current low incidents', unit: 'Nos', agg: 'sum' },
  { item: 'h', code: 'FCLD', name: 'Feeder current low duration', unit: 'min', agg: 'sum' },
  { item: 'i', code: 'FVSM', name: 'Feeder voltage sag magnitude (24 h)', unit: '% of nominal', agg: 'min' },
  { item: 'j', code: 'FCSM', name: 'Feeder current sag magnitude (24 h)', unit: '% of nominal', agg: 'min' },
  { item: 'k', code: 'FVSV', name: 'Feeder voltage stress value', unit: 'V·min', agg: 'sum' },
  { item: 'l', code: 'FCSV', name: 'Feeder current stress value', unit: 'A·min', agg: 'sum' },
  { item: 'm', code: 'FMXV', name: 'Feeder max voltage', unit: '%', agg: 'max' },
  { item: 'n', code: 'FMNV', name: 'Feeder min voltage', unit: '%', agg: 'min' },
  { item: 'o', code: 'FMXC', name: 'Feeder max current', unit: '%', agg: 'max' },
  { item: 'p', code: 'FMNC', name: 'Feeder min current', unit: '%', agg: 'min' },
  { item: 'q', code: 'FLIF', name: 'Feeder load imbalance factor RYB', unit: '%', agg: 'max', phased: false },
];
const DEF = Object.fromEntries(KPI_DEFS.map((d) => [d.code, d]));

// Every output key, e.g. FVHI_R ... FMNC_T, FLIF.
export const KPI_KEYS = KPI_DEFS.flatMap((d) => (d.phased === false ? [d.code] : SUFFIXES.map((s) => `${d.code}_${s}`)));

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

export function normaliseRating(r = {}) {
  const out = { ...DEFAULT_RATING };
  for (const k of Object.keys(DEFAULT_RATING)) if (num(r[k]) != null) out[k] = Number(r[k]);
  return out;
}

function normSample(s) {
  return {
    t: new Date(s.ts).getTime(),
    v: { R: num(s.v_r), Y: num(s.v_y), B: num(s.v_b) },
    i: { R: num(s.i_r), Y: num(s.i_y), B: num(s.i_b) },
  };
}

// One breach tracker: counts rising edges and accumulates minutes in breach.
function tracker() { return { inExc: false, incidents: 0, minutes: 0 }; }
function step(tr, breach, continuous, dtMin) {
  if (!continuous) tr.inExc = false;
  if (breach) {
    if (!tr.inExc) tr.incidents += 1;
    tr.inExc = true;
    tr.minutes += dtMin;
  } else {
    tr.inExc = false;
  }
}

/**
 * Compute every PFC KPI for one feeder over [from, to).
 * @param samples  per-phase samples (any order); those outside [from,to) are ignored
 * @param rating   feeder rating/thresholds (missing fields fall back to DEFAULT_RATING)
 * @param opts     { from, to, prior?, maxGapMs? }  prior = last sample before `from`,
 *                 so an excursion already running at `from` is not counted again
 */
export function computeFeederKpis(samples, rating, opts) {
  const R = normaliseRating(rating);
  const from = new Date(opts.from).getTime();
  const to = new Date(opts.to).getTime();
  const maxGap = opts.maxGapMs ?? 10 * 60_000;
  const rows = samples.map(normSample).filter((s) => s.t >= from && s.t < to).sort((a, b) => a.t - b.t);
  const prior = opts.prior ? normSample(opts.prior) : null;

  const vHi = R.v_nominal_v * R.v_hi_pct / 100;
  const vLo = R.v_nominal_v * R.v_lo_pct / 100;
  const vSag = R.v_nominal_v * R.v_sag_pct / 100;
  const vDead = R.v_nominal_v * DEAD_PCT / 100;
  const iHi = R.i_nominal_a * R.i_hi_pct / 100;
  const iLo = R.i_nominal_a * R.i_lo_pct / 100;
  const pctV = (x) => (x / R.v_nominal_v) * 100;
  const pctI = (x) => (x / R.i_nominal_a) * 100;

  const isDead = (s) => PHASES.every((p) => s.v[p] != null) && PHASES.every((p) => s.v[p] < vDead);
  const tests = {
    VH: (s, p) => s.v[p] != null && s.v[p] > vHi,
    VL: (s, p) => s.v[p] != null && s.v[p] < vLo,
    CH: (s, p) => s.i[p] != null && s.i[p] > iHi,
    CL: (s, p) => s.i[p] != null && s.i[p] < iLo,
  };
  const trk = {};
  for (const k of Object.keys(tests)) for (const sfx of SUFFIXES) trk[`${k}_${sfx}`] = tracker();
  const breach = (k, s, sfx) => (sfx === 'T' ? PHASES.some((p) => tests[k](s, p)) : tests[k](s, sfx));

  // Seed the trackers from the prior sample: an excursion already running at
  // `from` continues rather than counting as a new incident.
  if (prior && rows.length && rows[0].t - prior.t <= maxGap && !isDead(prior)) {
    for (const k of Object.keys(tests)) for (const sfx of SUFFIXES) trk[`${k}_${sfx}`].inExc = breach(k, prior, sfx);
  }

  const stressV = { R: 0, Y: 0, B: 0 }, stressI = { R: 0, Y: 0, B: 0 };
  const mx = { v: {}, i: {} }, mn = { v: {}, i: {} };
  const sagV = {}, sagI = {};
  let flifMax = null, flifWeighted = 0, flifMinutes = 0;
  let covered = 0, liveMinutes = 0, deadMinutes = 0;

  let prev = prior && rows.length && rows[0].t - prior.t <= maxGap ? prior : null;
  for (let n = 0; n < rows.length; n++) {
    const s = rows[n];
    const next = n + 1 < rows.length ? rows[n + 1].t : to;
    const dtMin = Math.max(0, Math.min(next - s.t, maxGap, to - s.t)) / 60_000;
    const continuous = prev != null && s.t - prev.t <= maxGap;
    covered += dtMin;

    if (isDead(s)) {
      deadMinutes += dtMin;
      for (const tr of Object.values(trk)) tr.inExc = false; // an outage ends any PQ excursion
      prev = s;
      continue;
    }
    liveMinutes += dtMin;

    for (const k of Object.keys(tests)) for (const sfx of SUFFIXES) step(trk[`${k}_${sfx}`], breach(k, s, sfx), continuous, dtMin);

    for (const p of PHASES) {
      const v = s.v[p], i = s.i[p];
      if (v != null) {
        if (v > vHi) stressV[p] += (v - vHi) * dtMin;
        mx.v[p] = Math.max(mx.v[p] ?? -Infinity, pctV(v));
        mn.v[p] = Math.min(mn.v[p] ?? Infinity, pctV(v));
        if (v >= vDead && v < vSag) sagV[p] = Math.min(sagV[p] ?? Infinity, pctV(v));
      }
      if (i != null) {
        if (i > iHi) stressI[p] += (i - iHi) * dtMin;
        mx.i[p] = Math.max(mx.i[p] ?? -Infinity, pctI(i));
        mn.i[p] = Math.min(mn.i[p] ?? Infinity, pctI(i));
        const pi = continuous && !isDead(prev) ? prev.i[p] : null;
        if (pi != null && pi > 0 && i > 0 && i < pi * (1 - R.i_sag_drop_pct / 100)) {
          sagI[p] = Math.min(sagI[p] ?? Infinity, pctI(i));
        }
      }
    }

    const cur = PHASES.map((p) => s.i[p]);
    if (cur.every((x) => x != null && x > 0)) {
      const hi = Math.max(...cur), lo = Math.min(...cur);
      if (pctI(hi) >= FLIF_MIN_LOAD_PCT) {
        const f = (hi / lo) * 100;
        flifMax = Math.max(flifMax ?? -Infinity, f);
        flifWeighted += f * dtMin;
        flifMinutes += dtMin;
      }
    }
    prev = s;
  }

  const k = {};
  const put = (code, perPhase, total) => {
    for (const p of PHASES) k[`${code}_${p}`] = r2(perPhase[p] ?? null);
    k[`${code}_T`] = r2(total);
  };
  const fromTrk = (code, key, field) => put(code, Object.fromEntries(PHASES.map((p) => [p, trk[`${key}_${p}`][field]])), trk[`${key}_T`][field]);
  fromTrk('FVHI', 'VH', 'incidents'); fromTrk('FVHD', 'VH', 'minutes');
  fromTrk('FVLI', 'VL', 'incidents'); fromTrk('FVLD', 'VL', 'minutes');
  fromTrk('FCHI', 'CH', 'incidents'); fromTrk('FCHD', 'CH', 'minutes');
  fromTrk('FCLI', 'CL', 'incidents'); fromTrk('FCLD', 'CL', 'minutes');

  const vals = (o) => PHASES.map((p) => o[p]).filter((x) => x != null && Number.isFinite(x));
  const minOf = (o) => (vals(o).length ? Math.min(...vals(o)) : null);
  const maxOf = (o) => (vals(o).length ? Math.max(...vals(o)) : null);
  const fin = (o) => Object.fromEntries(PHASES.map((p) => [p, Number.isFinite(o[p]) ? o[p] : null]));

  put('FVSM', fin(sagV), minOf(sagV));
  put('FCSM', fin(sagI), minOf(sagI));
  put('FVSV', stressV, stressV.R + stressV.Y + stressV.B);
  put('FCSV', stressI, stressI.R + stressI.Y + stressI.B);
  put('FMXV', fin(mx.v), maxOf(mx.v));
  put('FMNV', fin(mn.v), minOf(mn.v));
  put('FMXC', fin(mx.i), maxOf(mx.i));
  put('FMNC', fin(mn.i), minOf(mn.i));
  k.FLIF = r2(flifMax);

  const periodMinutes = Math.max(0, (to - from) / 60_000);
  return {
    kpis: k,
    extras: { FLIF_AVG: flifMinutes ? r2(flifWeighted / flifMinutes) : null },
    coverage: {
      samples: rows.length,
      periodMinutes: r2(periodMinutes),
      coveredMinutes: r2(covered),
      liveMinutes: r2(liveMinutes),
      deadMinutes: r2(deadMinutes),
      completenessPct: periodMinutes ? r2((covered / periodMinutes) * 100) : null,
    },
  };
}

// Combine per-day results into one value per KPI for a longer period.
// Incidents are additive across days because each day is computed with the
// previous day's last sample as `prior` (an excursion over midnight counts once).
export function aggregateKpis(parts) {
  const kpis = {};
  for (const key of KPI_KEYS) {
    const agg = DEF[key.split('_')[0]].agg;
    const xs = parts.map((p) => p?.kpis?.[key]).filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
    if (agg === 'sum') kpis[key] = r2(xs.reduce((a, b) => a + b, 0));
    else if (!xs.length) kpis[key] = null;
    else kpis[key] = r2(agg === 'max' ? Math.max(...xs) : Math.min(...xs));
  }
  const cov = { samples: 0, periodMinutes: 0, coveredMinutes: 0, liveMinutes: 0, deadMinutes: 0 };
  for (const p of parts) for (const f of Object.keys(cov)) cov[f] += Number(p?.coverage?.[f]) || 0;
  for (const f of Object.keys(cov)) cov[f] = r2(cov[f]);
  cov.completenessPct = cov.periodMinutes ? r2((cov.coveredMinutes / cov.periodMinutes) * 100) : null;
  // Time-weighted average imbalance over the live minutes of each part.
  let w = 0, m = 0;
  for (const p of parts) {
    const a = p?.extras?.FLIF_AVG, lm = Number(p?.coverage?.liveMinutes) || 0;
    if (a != null && lm) { w += a * lm; m += lm; }
  }
  return { kpis, extras: { FLIF_AVG: m ? r2(w / m) : null }, coverage: cov };
}

// ---- Periods (IST, fixed +05:30, no DST) ----
// Daily, weekly (Mon-Sun), monthly, quarterly, yearly, or a custom day range.
// Quarter and year follow the financial year, starting in fyStartMonth
// (4 = April, the Indian FY); set KPI_FY_START_MONTH=1 for calendar years.
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
export const PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];

export const istDay = (date) => new Date(new Date(date).getTime() + IST_MS).toISOString().slice(0, 10);
export const dayStart = (day) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) - IST_MS);
const addDays = (day, n) => new Date(dayStart(day).getTime() + IST_MS + n * DAY_MS).toISOString().slice(0, 10);
const ymd = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); // tolerates month overflow

export function periodRange(period, { date, from, to, fyStartMonth = 4 } = {}) {
  const anchor = date || istDay(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error('date must be YYYY-MM-DD');
  const y = +anchor.slice(0, 4), m = +anchor.slice(5, 7), d = +anchor.slice(8, 10);
  let first, lastExcl, label;
  switch (period) {
    case 'daily': first = anchor; lastExcl = addDays(anchor, 1); label = anchor; break;
    case 'weekly': {
      const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0
      first = addDays(anchor, -dow); lastExcl = addDays(first, 7); label = `Week of ${first}`; break;
    }
    case 'monthly': first = ymd(y, m, 1); lastExcl = ymd(y, m + 1, 1); label = anchor.slice(0, 7); break;
    case 'quarterly': {
      const off = (m - fyStartMonth + 12) % 12;
      const qStartMonth = m - (off % 3);
      first = ymd(y, qStartMonth, 1); lastExcl = ymd(y, qStartMonth + 3, 1);
      label = `Q${Math.floor(off / 3) + 1} FY${fyLabel(first, fyStartMonth)}`; break;
    }
    case 'yearly': {
      const startYear = m >= fyStartMonth ? y : y - 1;
      first = ymd(startYear, fyStartMonth, 1); lastExcl = ymd(startYear + 1, fyStartMonth, 1);
      label = fyStartMonth === 1 ? String(startYear) : `FY ${startYear}-${String(startYear + 1).slice(2)}`; break;
    }
    case 'custom': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new Error('custom period needs from and to as YYYY-MM-DD');
      if (to < from) throw new Error('to is before from');
      first = from; lastExcl = addDays(to, 1); label = `${from} to ${to}`; break;
    }
    default: throw new Error(`period must be one of ${PERIODS.join(', ')}`);
  }
  const days = [];
  for (let dd = first; dd < lastExcl; dd = addDays(dd, 1)) days.push(dd);
  return { period, label, from: dayStart(first), to: dayStart(lastExcl), days };
}

function fyLabel(day, fyStartMonth) {
  if (fyStartMonth === 1) return day.slice(0, 4);
  const y = +day.slice(0, 4), m = +day.slice(5, 7);
  const start = m >= fyStartMonth ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}
