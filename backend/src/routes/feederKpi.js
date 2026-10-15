import { Router } from 'express';
import { requireRole } from './auth.js';
import { repo } from '../infra/repo.js';
import { KPI_DEFS, PERIODS, SUFFIXES } from '../domain/feederKpi.js';
import { buildFeederKpiPdf } from '../domain/feederKpiPdf.js';
import { feederKpisForPeriod, feederKpiSeries, feederKpiChildSeries, ingestSamples, rollupDay, clearKpiCache, feederCatalog, maxGapMs, fyStartMonth } from '../realtime/feederKpi.js';

// PFC feeder-wise KPIs (FVHI ... FLIF). Mounted on the authenticated /api router.
//
//   GET  /analytics/feeder-kpi/defs                  catalogue + feeder list
//   GET  /analytics/feeder-kpi?period=&date=[&from&to][&feeder=]
//   GET  /analytics/feeder-kpi/series?period=&date=[&from&to][&feeder=]
//   GET  /analytics/feeder-kpi/child-series?period=&date=[&from&to][&substation=]
//   GET  /analytics/feeder-kpi/export?...&format=csv
//   GET  /analytics/feeder-kpi/export.pdf?feeders=A,B  summary + trend charts per feeder (max 25)
//   GET  /analytics/feeder-kpi/ratings
//   PUT  /analytics/feeder-kpi/ratings/:feeder       system_admin, oms_operator, configuration_engineer
//   POST /analytics/feeder-kpi/rollup {from,to}      system_admin   (recompute stored days)
//   POST /telemetry/feeders {samples:[...]}          scada_operator, system_admin
export const feederKpiRoutes = Router();
// Express 4 does not catch async errors; forward them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const who = (req) => req.user?.username || 'unknown';

const periodQuery = (q) => ({ period: q.period || 'daily', date: q.date, from: q.from, to: q.to });
const bad = (res, e) => res.status(400).json({ error: e.message });

feederKpiRoutes.get('/analytics/feeder-kpi/defs', (req, res) => {
  res.json({ defs: KPI_DEFS, suffixes: SUFFIXES, periods: PERIODS, feeders: feederCatalog(),
    maxGapMinutes: maxGapMs() / 60_000, fyStartMonth: fyStartMonth() });
});

feederKpiRoutes.get('/analytics/feeder-kpi', wrap(async (req, res, next) => {
  let out;
  try { out = await feederKpisForPeriod(periodQuery(req.query), req.query.feeder || null); }
  catch (e) { return e.status === 400 ? bad(res, e) : next(e); }
  res.json(out);
}));
feederKpiRoutes.get('/analytics/feeder-kpi/series', wrap(async (req, res, next) => {
  let out;
  try { out = await feederKpiSeries(periodQuery(req.query), req.query.feeder || null); }
  catch (e) { return e.status === 400 ? bad(res, e) : next(e); }
  res.json(out);
}));
feederKpiRoutes.get('/analytics/feeder-kpi/child-series', wrap(async (req, res, next) => {
  let out;
  try { out = await feederKpiChildSeries(periodQuery(req.query), req.query.substation || null); }
  catch (e) { return e.status === 400 ? bad(res, e) : next(e); }
  res.json(out);
}));
feederKpiRoutes.get('/analytics/feeder-kpi/export', wrap(async (req, res, next) => {
  let out;
  try { out = await feederKpisForPeriod(periodQuery(req.query), req.query.feeder || null); }
  catch (e) { return e.status === 400 ? bad(res, e) : next(e); }
  // One row per feeder; one column per KPI key, in requirement order (a..q).
  const keys = KPI_DEFS.flatMap((d) => (d.phased === false ? [d.code] : SUFFIXES.map((s) => `${d.code}_${s}`)));
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [
    `# PFC feeder KPIs - ${out.range.label} (${out.range.period}) - generated ${new Date().toISOString()}`,
    ['feeder', 'substation', 'data_completeness_pct', ...keys].join(','),
    ...out.feeders.map((f) => [f.feeder, f.substation, f.coverage.completenessPct, ...keys.map((k) => f.kpis[k])].map(esc).join(',')),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="feeder-kpi-${out.range.period}-${out.range.label.replace(/[^\w-]+/g, '_')}.csv"`);
  res.send(lines.join('\n'));
}));

// PDF: summary table + a trend chart per index, for each requested feeder.
//   GET /analytics/feeder-kpi/export.pdf?period=...&feeders=UPCL-AN-A,UPCL-AN-B
const PDF_MAX_FEEDERS = 25;
feederKpiRoutes.get('/analytics/feeder-kpi/export.pdf', wrap(async (req, res, next) => {
  const known = new Set(feederCatalog().map((c) => c.feeder));
  const list = [...new Set(String(req.query.feeders || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!list.length) return res.status(400).json({ error: 'feeders is required (comma-separated feeder codes)' });
  if (list.length > PDF_MAX_FEEDERS) return res.status(400).json({ error: `at most ${PDF_MAX_FEEDERS} feeders per PDF` });
  const unknown = list.filter((f) => !known.has(f));
  if (unknown.length) return res.status(400).json({ error: `unknown feeder: ${unknown.join(', ')}` });
  const q = periodQuery(req.query);
  let feeders, range;
  try {
    feeders = [];
    for (const f of list) {
      const [period, series] = await Promise.all([feederKpisForPeriod(q, f), feederKpiSeries(q, f)]);
      range = period.range;
      const row = period.feeders[0] || {};
      feeders.push({ feeder: f, substation: row.substation, kpis: row.kpis, coverage: row.coverage, rating: series.rating, granularity: series.granularity, points: series.points });
    }
  } catch (e) { return e.status === 400 ? bad(res, e) : next(e); }
  const pdf = await buildFeederKpiPdf({ range, defs: KPI_DEFS, feeders, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' });
  const name = `feeder-kpi-${list.length === 1 ? list[0] : `${list.length}-feeders`}-${range.label.replace(/[^\w-]+/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(pdf);
}));

feederKpiRoutes.get('/analytics/feeder-kpi/ratings', wrap(async (req, res) => res.json(await repo.feederRatings())));

feederKpiRoutes.put('/analytics/feeder-kpi/ratings/:feeder', requireRole('system_admin', 'oms_operator', 'configuration_engineer'), wrap(async (req, res) => {
  const patch = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (k === 'substation') { patch[k] = v; continue; }
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return res.status(400).json({ error: `${k} must be a positive number` });
    patch[k] = v;
  }
  try {
    const row = await repo.updateFeederRating(req.params.feeder, patch, who(req));
    if (!row) return res.status(404).json({ error: 'feeder not found' });
    await repo.audit(who(req), 'feeder_kpi.rating.update', req.params.feeder);
    clearKpiCache(); // today's live values use the rating
    res.json(row);
  } catch (e) {
    if (e.code === '23514') return res.status(400).json({ error: 'low threshold must be below high threshold' });
    throw e; // -> wrap -> error handler
  }
}));

// Thresholds changed, or late data loaded by hand: recompute stored days.
feederKpiRoutes.post('/analytics/feeder-kpi/rollup', requireRole('system_admin', 'oms_operator'), wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || to < from) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD, from <= to) are required' });
  }
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d = new Date(d.getTime() + 86_400_000)) days.push(d.toISOString().slice(0, 10));
  if (days.length > 400) return res.status(400).json({ error: 'at most 400 days per call' });
  for (const d of days) await rollupDay(d);
  await repo.audit(who(req), 'feeder_kpi.rollup', `${from}..${to}`);
  res.json({ recomputed: days.length });
}));

feederKpiRoutes.post('/telemetry/feeders', requireRole('scada_operator', 'system_admin'), wrap(async (req, res) => {
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : null;
  if (!samples) return res.status(400).json({ error: 'body must be { samples: [...] }' });
  if (samples.length > 50_000) return res.status(413).json({ error: 'at most 50000 samples per call' });
  const r = await ingestSamples(samples);
  res.status(r.rejected && !r.inserted && !r.duplicates ? 400 : 202).json(r);
}));
