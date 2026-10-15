import { db } from './db.js';

// SQL for the PFC feeder KPIs. Spread into `repo` (repo.js), so routes and
// jobs still only ever call repo.*.
const pgp = db.$config.pgp;
const TELEMETRY_COLS = new pgp.helpers.ColumnSet(
  ['feeder', 'ts', 'v_r', 'v_y', 'v_b', 'i_r', 'i_y', 'i_b',
    { name: 'quality', def: 'GOOD' }, { name: 'source', def: 'SCADA' }],
  { table: 'feeder_telemetry' });
const RATING_FIELDS = ['substation', 'v_nominal_v', 'i_nominal_a', 'v_hi_pct', 'v_lo_pct', 'i_hi_pct', 'i_lo_pct', 'v_sag_pct', 'i_sag_drop_pct'];
const SAMPLE = 'feeder, ts, v_r, v_y, v_b, i_r, i_y, i_b';

export const feederKpiRepo = {
  // ---- ratings ----
  ensureFeederRatings: async (feeders) => {
    if (!feeders.length) return;
    const cs = new pgp.helpers.ColumnSet(['feeder', 'substation'], { table: 'feeder_ratings' });
    await db.none(pgp.helpers.insert(feeders, cs) + ' ON CONFLICT (feeder) DO NOTHING');
  },
  feederRatings: () => db.any('SELECT * FROM feeder_ratings ORDER BY feeder'),
  feederRating: (feeder) => db.oneOrNone('SELECT * FROM feeder_ratings WHERE feeder=$1', [feeder]),
  updateFeederRating: (feeder, patch, actor) => {
    const fields = RATING_FIELDS.filter((f) => patch[f] !== undefined);
    if (!fields.length) return db.oneOrNone('SELECT * FROM feeder_ratings WHERE feeder=$1', [feeder]);
    const set = fields.map((f) => `${f}=$/${f}/`).join(', ');
    return db.oneOrNone(`UPDATE feeder_ratings SET ${set}, updated_by=$/actor/, updated_at=now()
                         WHERE feeder=$/feeder/ RETURNING *`, { ...patch, feeder, actor });
  },

  // ---- telemetry ----
  // Idempotent: a re-sent sample (same feeder + ts) is ignored.
  insertFeederTelemetry: async (rows) => {
    if (!rows.length) return 0;
    let n = 0;
    for (let k = 0; k < rows.length; k += 2000) {
      const chunk = rows.slice(k, k + 2000);
      const r = await db.result(pgp.helpers.insert(chunk, TELEMETRY_COLS) + ' ON CONFLICT (feeder, ts) DO NOTHING');
      n += r.rowCount;
    }
    return n;
  },
  feederTelemetry: (feeder, from, to) => db.any(
    `SELECT ${SAMPLE} FROM feeder_telemetry WHERE feeder=$1 AND ts >= $2 AND ts < $3
       AND quality IN ('GOOD','SUBSTITUTED') ORDER BY ts`, [feeder, from, to]),
  allFeederTelemetry: (from, to) => db.any(
    `SELECT ${SAMPLE} FROM feeder_telemetry WHERE ts >= $1 AND ts < $2
       AND quality IN ('GOOD','SUBSTITUTED') ORDER BY feeder, ts`, [from, to]),
  // Last good sample of each feeder in [before - lookbackMs, before).
  feederPriorSamples: (before, lookbackMs) => db.any(
    `SELECT DISTINCT ON (feeder) ${SAMPLE} FROM feeder_telemetry
      WHERE ts < $1 AND ts >= $1::timestamptz - ($2 || ' milliseconds')::interval
        AND quality IN ('GOOD','SUBSTITUTED')
      ORDER BY feeder, ts DESC`, [before, String(lookbackMs)]),
  latestFeederTelemetryTs: () => db.oneOrNone('SELECT max(ts) AS ts FROM feeder_telemetry').then((r) => r?.ts || null),
  feederTelemetryDays: (fromDay, toDayExcl) => db.any(
    `SELECT DISTINCT (ts AT TIME ZONE 'Asia/Kolkata')::date::text AS day FROM feeder_telemetry
      WHERE ts >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND ts <  ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')`, [fromDay, toDayExcl]).then((r) => r.map((x) => x.day)),

  // ---- daily rollups ----
  saveFeederKpiDaily: async (rows) => {
    if (!rows.length) return;
    const cs = new pgp.helpers.ColumnSet(['feeder', 'day',
      { name: 'kpis', mod: ':json' }, { name: 'extras', mod: ':json' },
      { name: 'coverage', mod: ':json' }, { name: 'rating', mod: ':json' }], { table: 'feeder_kpi_daily' });
    await db.none(pgp.helpers.insert(rows, cs) + ` ON CONFLICT (feeder, day) DO UPDATE SET
      kpis=EXCLUDED.kpis, extras=EXCLUDED.extras, coverage=EXCLUDED.coverage,
      rating=EXCLUDED.rating, computed_at=now()`);
  },
  feederKpiDaily: (fromDay, toDay, feeder = null) => db.any(
    `SELECT feeder, day::text AS day, kpis, extras, coverage FROM feeder_kpi_daily
      WHERE day >= $1 AND day <= $2 AND ($3::text IS NULL OR feeder = $3) ORDER BY feeder, day`,
    [fromDay, toDay, feeder]),
  feederKpiRolledDays: (fromDay, toDay) => db.any(
    'SELECT DISTINCT day::text AS day FROM feeder_kpi_daily WHERE day >= $1 AND day <= $2', [fromDay, toDay])
    .then((r) => new Set(r.map((x) => x.day))),
};
