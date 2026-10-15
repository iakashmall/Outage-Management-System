import cron from 'node-cron';
import { repo } from '../infra/repo.js';
import { bus, TOPICS } from '../domain/bus.js';
import { distTx, substations } from '../infra/geo.js';
import {
  computeFeederKpis, aggregateKpis, periodRange, istDay, dayStart, normaliseRating, KPI_KEYS,
} from '../domain/feederKpi.js';

// PFC feeder KPIs: the I/O around domain/feederKpi.js.
//
//   * Past days are read from feeder_kpi_daily (computed once, nightly).
//     A past day with no rollup yet is computed and saved on first request.
//   * Today is always computed live from feeder_telemetry and never saved.
//   * Weekly / monthly / quarterly / yearly / custom = aggregate of days.

const DAY_MS = 86_400_000;
export const maxGapMs = () => (Number(process.env.FEEDER_KPI_MAX_GAP_MIN) || 10) * 60_000;
export const fyStartMonth = () => Number(process.env.KPI_FY_START_MONTH) || 4;

// ---- short-lived result cache ----
// Today's KPIs are computed from raw telemetry, so at a high SCADA rate every
// dashboard load would rescan millions of rows. Results are kept for
// FEEDER_KPI_CACHE_SEC (default 60, 0 = off) - the dashboard itself refreshes
// once a minute - and identical requests in flight share one computation.
// Cleared when stored days are recomputed or a feeder rating changes.
const cacheMs = () => {
  const v = Number(process.env.FEEDER_KPI_CACHE_SEC);
  return (Number.isFinite(v) && v >= 0 ? v : 60) * 1000;
};
const CACHE_MAX = 500;
const cache = new Map(); // key -> { at, promise }
let cacheGen = 0;

function cached(key, fn) {
  const ttl = cacheMs();
  if (!ttl) return fn();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const gen = cacheGen;
  const promise = fn().catch((e) => { if (cache.get(key)?.promise === promise) cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
  // A clear that ran while this was computing makes the result stale.
  promise.then(() => { if (gen !== cacheGen && cache.get(key)?.promise === promise) cache.delete(key); }, () => {});
  return promise;
}

export function clearKpiCache() {
  cacheGen++;
  cache.clear();
}

const queryKey = (q) => `${q.period}|${q.date || ''}|${q.from || ''}|${q.to || ''}`;

// Feeder codes as the GIS model names them (the same codes incidents use).
const codeToSub = new Map(substations.map((s) => [s.code, s.name]));
const CATALOG = (() => {
  const m = new Map();
  for (const d of distTx) if (d.feeder && !m.has(d.feeder)) m.set(d.feeder, codeToSub.get(d.ss) || d.ss || null);
  return [...m.entries()].map(([feeder, substation]) => ({ feeder, substation })).sort((a, b) => a.feeder.localeCompare(b.feeder));
})();
export const feederCatalog = () => CATALOG;

export async function ensureRatings() {
  await repo.ensureFeederRatings(CATALOG);
}

async function ratingsMap() {
  return new Map((await repo.feederRatings()).map((r) => [r.feeder, r]));
}

// All feeders, one IST day (or today up to now).
async function computeDay(day, ratings) {
  const from = dayStart(day);
  const end = new Date(from.getTime() + DAY_MS);
  const to = new Date(Math.min(end.getTime(), Date.now()));
  if (to <= from) return [];
  const [samples, priors] = await Promise.all([
    repo.allFeederTelemetry(from, to),
    repo.feederPriorSamples(from, maxGapMs()),
  ]);
  const byFeeder = new Map();
  for (const s of samples) (byFeeder.get(s.feeder) || byFeeder.set(s.feeder, []).get(s.feeder)).push(s);
  const priorBy = new Map(priors.map((p) => [p.feeder, p]));
  const feeders = new Set([...CATALOG.map((c) => c.feeder), ...byFeeder.keys()]);
  return [...feeders].map((feeder) => {
    const rating = normaliseRating(ratings.get(feeder));
    const r = computeFeederKpis(byFeeder.get(feeder) || [], rating, { from, to, prior: priorBy.get(feeder), maxGapMs: maxGapMs() });
    return { feeder, day, rating, ...blankIfNoData(r) };
  });
}

// A feeder with no samples must read "no data", not "zero incidents".
function blankIfNoData(r) {
  if (r.coverage.coveredMinutes > 0) return r;
  return { ...r, kpis: Object.fromEntries(KPI_KEYS.map((k) => [k, null])), extras: { FLIF_AVG: null } };
}

export async function rollupDay(day) {
  const rows = await computeDay(day, await ratingsMap());
  await repo.saveFeederKpiDaily(rows.map(({ feeder, day: d, kpis, extras, coverage, rating }) => ({ feeder, day: d, kpis, extras, coverage, rating })));
  clearKpiCache();
  return rows.length;
}

/**
 * KPIs for every feeder (or one) over a period.
 * @returns { range, today, feeders: [{ feeder, substation, kpis, extras, coverage, days }] }
 */
export function feederKpisForPeriod(query, onlyFeeder = null) {
  return cached(`period|${queryKey(query)}|${onlyFeeder || ''}`, () => feederKpisForPeriodNow(query, onlyFeeder));
}

async function feederKpisForPeriodNow(query, onlyFeeder) {
  let range;
  try { range = periodRange(query.period, { date: query.date, from: query.from, to: query.to, fyStartMonth: fyStartMonth() }); }
  catch (e) { e.status = 400; throw e; }
  const today = istDay(Date.now());
  const pastDays = range.days.filter((d) => d < today);
  const includesToday = range.days.includes(today);

  // Lazily roll up any past day that has no rollup yet (e.g. the first request
  // after enabling the feature, or a day the nightly job missed).
  if (pastDays.length) {
    const rolled = await repo.feederKpiRolledDays(pastDays[0], pastDays.at(-1));
    for (const d of pastDays) if (!rolled.has(d)) await rollupDay(d);
  }
  const parts = new Map(); // feeder -> [{kpis, extras, coverage}]
  const add = (feeder, p) => (parts.get(feeder) || parts.set(feeder, []).get(feeder)).push(p);
  if (pastDays.length) {
    for (const row of await repo.feederKpiDaily(pastDays[0], pastDays.at(-1), onlyFeeder)) add(row.feeder, row);
  }
  if (includesToday) {
    // Today for all feeders: shared by every period and feeder view for a minute.
    const todayRows = await cached(`today|${today}`, async () => computeDay(today, await ratingsMap()));
    for (const row of todayRows) {
      if (!onlyFeeder || row.feeder === onlyFeeder) add(row.feeder, row);
    }
  }

  const subOf = new Map(CATALOG.map((c) => [c.feeder, c.substation]));
  const feeders = (onlyFeeder ? [onlyFeeder] : [...new Set([...CATALOG.map((c) => c.feeder), ...parts.keys()])]).map((feeder) => {
    const ps = parts.get(feeder) || [];
    const agg = aggregateKpis(ps);
    return { feeder, substation: subOf.get(feeder) || null, ...blankIfNoData(agg), days: ps.length };
  });
  return {
    range: { period: range.period, label: range.label, from: range.from, to: range.to, days: range.days.length, daysElapsed: pastDays.length + (includesToday ? 1 : 0) },
    today,
    feeders,
  };
}

// ---- telemetry ingest (real SCADA) ----
// One sample: { feeder, ts, v_r, v_y, v_b, i_r, i_y, i_b, quality?, source? }
// Volts phase-to-neutral, amps. null = phase not measured.
const NUM_FIELDS = ['v_r', 'v_y', 'v_b', 'i_r', 'i_y', 'i_b'];
const QUALITIES = new Set(['GOOD', 'SUSPECT', 'BAD', 'COMM_FAIL', 'SUBSTITUTED']);
export function validateSample(s) {
  if (!s || typeof s.feeder !== 'string' || !s.feeder.trim()) return 'feeder is required';
  const t = new Date(s.ts).getTime();
  if (!Number.isFinite(t)) return 'ts must be an ISO timestamp';
  if (t > Date.now() + 5 * 60_000) return 'ts is in the future';
  for (const f of NUM_FIELDS) {
    const v = s[f];
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${f} must be a non-negative number or null`;
  }
  if (s.quality && !QUALITIES.has(String(s.quality).toUpperCase())) return `quality must be one of ${[...QUALITIES].join(', ')}`;
  return null;
}
const clean = (s) => ({
  feeder: s.feeder.trim(), ts: new Date(s.ts).toISOString(),
  ...Object.fromEntries(NUM_FIELDS.map((f) => [f, s[f] ?? null])),
  quality: (s.quality || 'GOOD').toUpperCase(), source: s.source || 'SCADA',
});

const dirtyDays = new Set();
let flushTimer = null;
function scheduleDirtyFlush() {
  if (flushTimer || !dirtyDays.size) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const days = [...dirtyDays]; dirtyDays.clear();
    for (const d of days) await rollupDay(d).catch((e) => console.error(`[feeder-kpi] re-rollup ${d} failed:`, e.message));
  }, 30_000);
  flushTimer.unref?.();
}

export async function ingestSamples(samples) {
  const errors = [];
  const good = [];
  samples.forEach((s, n) => { const e = validateSample(s); if (e) errors.push({ index: n, error: e }); else good.push(clean(s)); });
  const inserted = await repo.insertFeederTelemetry(good);
  // Late samples for a day that is already rolled up: recompute that day.
  const today = istDay(Date.now());
  for (const g of good) { const d = istDay(g.ts); if (d < today) dirtyDays.add(d); }
  scheduleDirtyFlush();
  return { received: samples.length, inserted, duplicates: good.length - inserted, rejected: errors.length, errors: errors.slice(0, 20) };
}

// ---- jobs ----
export function startFeederKpiJobs() {
  // Real SCADA adapters publish analog samples here (Kafka in production).
  // Returns the promise so the Kafka bus waits for the insert before
  // committing, and retries / dead-letters the batch if it fails.
  bus.subscribe(TOPICS.FEEDER_ANALOG, (p) => {
    const list = Array.isArray(p?.samples) ? p.samples : [p];
    return ingestSamples(list).then((r) => {
      if (r.rejected) console.warn(`[feeder-kpi] ${r.rejected} of ${r.received} samples rejected, e.g. ${JSON.stringify(r.errors[0])}`);
    });
  });

  // Nightly at 00:20 IST: roll up yesterday and the day before (late samples
  // from a link that was down are folded in on the second pass).
  cron.schedule(process.env.FEEDER_KPI_CRON || '20 0 * * *', async () => {
    const today = istDay(Date.now());
    for (const back of [1, 2]) {
      const d = istDay(dayStart(today).getTime() + 12 * 3600_000 - back * DAY_MS);
      try { await rollupDay(d); } catch (e) { console.error(`[feeder-kpi] rollup ${d} failed:`, e.message); }
    }
    console.log('[feeder-kpi] nightly rollup done');
  }, { timezone: 'Asia/Kolkata' });
  console.log(`[feeder-kpi] ${CATALOG.length} feeders; nightly rollup scheduled; ingest topic ${TOPICS.FEEDER_ANALOG}`);
}
// ---- time series for charts ----
const HOUR_MS = 3_600_000;
const BLANK = Object.fromEntries(KPI_KEYS.map((k) => [k, null]));

async function computeDayOne(day, feeder, rating) {
  const from = dayStart(day);
  const to = new Date(Math.min(from.getTime() + DAY_MS, Date.now()));
  if (to <= from) return null;
  const [samples, priors] = await Promise.all([
    repo.feederTelemetry(feeder, from, to),
    repo.feederPriorSamples(from, maxGapMs()),
  ]);
  return computeFeederKpis(samples, rating, { from, to, prior: priors.find((p) => p.feeder === feeder), maxGapMs: maxGapMs() });
}

export function feederKpiSeries(query, feeder) {
  if (!feeder) { const e = new Error('feeder is required'); e.status = 400; return Promise.reject(e); }
  return cached(`series|${queryKey(query)}|${feeder}`, () => feederKpiSeriesNow(query, feeder));
}

async function feederKpiSeriesNow(query, feeder) {
  let range;
  try { range = periodRange(query.period, { date: query.date, from: query.from, to: query.to, fyStartMonth: fyStartMonth() }); }
  catch (e) { e.status = 400; throw e; }
  const ratingRow = await repo.feederRating(feeder);
  const rating = normaliseRating(ratingRow);
  const today = istDay(Date.now());
  const point = (label, t, r) => ({ label, t, kpis: r && r.coverage.coveredMinutes > 0 ? r.kpis : BLANK });
  let granularity, points = [];

  if (range.period === 'daily') {
    granularity = 'hour';
    const day = range.days[0];
    const from = dayStart(day);
    const nowMs = Date.now();
    const [samples, priors] = await Promise.all([
      repo.feederTelemetry(feeder, from, new Date(from.getTime() + DAY_MS)),
      repo.feederPriorSamples(from, maxGapMs()),
    ]);
    let before = priors.find((p) => p.feeder === feeder) || null;
    for (let h = 0; h < 24; h++) {
      const hFrom = new Date(from.getTime() + h * HOUR_MS);
      if (hFrom.getTime() >= nowMs) break;
      const hTo = new Date(Math.min(hFrom.getTime() + HOUR_MS, nowMs));
      const inHour = samples.filter((s) => new Date(s.ts) >= hFrom && new Date(s.ts) < hTo);
      const r = computeFeederKpis(inHour, rating, { from: hFrom, to: hTo, prior: before, maxGapMs: maxGapMs() });
      if (inHour.length) before = inHour[inHour.length - 1];
      points.push(point(`${String(h).padStart(2, '0')}:00`, hFrom.toISOString(), r));
    }
  } else {
    const past = range.days.filter((d) => d < today);
    const perDay = new Map();
    if (past.length) {
      const rolled = await repo.feederKpiRolledDays(past[0], past.at(-1));
      for (const d of past) if (!rolled.has(d)) await rollupDay(d);
      for (const row of await repo.feederKpiDaily(past[0], past.at(-1), feeder)) perDay.set(row.day, row);
    }
    if (range.days.includes(today)) perDay.set(today, await computeDayOne(today, feeder, rating));
    const weekly = range.days.length > 100;
    granularity = weekly ? 'week' : 'day';
    const step = weekly ? 7 : 1;
    for (let i = 0; i < range.days.length; i += step) {
      const chunk = range.days.slice(i, i + step).map((d) => perDay.get(d)).filter(Boolean);
      const agg = chunk.length ? aggregateKpis(chunk) : null;
      if (range.days[i] > today) break;
      points.push(point(range.days[i], dayStart(range.days[i]).toISOString(), agg));
    }
  }
  return {
    range: { period: range.period, label: range.label, from: range.from, to: range.to },
    feeder, granularity, rating, points,
  };
}
// Trend lines for the hierarchy view: one series per child of a scope.
//   substation = null -> one series per substation (its feeders combined)
//   substation = name -> one series per feeder of that substation
// Children are combined point by point with the same rules as periods.
export function feederKpiChildSeries(query, substation = null) {
  return cached(`children|${queryKey(query)}|${substation || ''}`, () => feederKpiChildSeriesNow(query, substation));
}

async function feederKpiChildSeriesNow(query, substation) {
  const scope = CATALOG.filter((c) => !substation || c.substation === substation);
  const perFeeder = [];
  for (let i = 0; i < scope.length; i += 8) {
    perFeeder.push(...await Promise.all(scope.slice(i, i + 8).map((c) => feederKpiSeries(query, c.feeder))));
  }
  const first = perFeeder[0];
  if (!first) return { range: null, granularity: null, labels: [], children: [] };
  const groups = new Map();
  scope.forEach((c, i) => {
    const id = substation ? c.feeder : (c.substation || 'Unassigned');
    (groups.get(id) || groups.set(id, []).get(id)).push(perFeeder[i]);
  });
  const hasData = (k) => Object.values(k).some((v) => v != null);
  const children = [...groups.entries()].map(([id, series]) => ({
    id,
    points: first.points.map((_, j) => {
      const parts = series.map((s) => s.points[j]).filter((p) => p && hasData(p.kpis));
      return parts.length ? aggregateKpis(parts).kpis : BLANK;
    }),
  }));
  return {
    range: first.range, granularity: first.granularity,
    labels: first.points.map((p) => ({ label: p.label, t: p.t })), children,
  };
}
