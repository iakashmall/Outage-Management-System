import { db } from './db.js';

// Tables for the PFC feeder KPIs (docs/FEEDER_KPI.md). Called from migrate().
//
//   feeder_ratings    nominal V/I and thresholds per feeder (editable in Admin)
//   feeder_telemetry  per-phase V/I samples - a TimescaleDB hypertable when
//                     the extension is installed (docker-compose image has it)
//   feeder_kpi_daily  one row per feeder per IST day: all 65 KPI values,
//                     computed by the nightly rollup; weekly..yearly are built
//                     from these rows, never from raw samples
export async function migrateFeederKpi() {
  await db.none(`
    CREATE TABLE IF NOT EXISTS feeder_ratings (
      feeder          TEXT PRIMARY KEY,
      substation      TEXT,
      v_nominal_v     DOUBLE PRECISION NOT NULL DEFAULT 6350.85,
      i_nominal_a     DOUBLE PRECISION NOT NULL DEFAULT 200,
      v_hi_pct        DOUBLE PRECISION NOT NULL DEFAULT 110,
      v_lo_pct        DOUBLE PRECISION NOT NULL DEFAULT 90,
      i_hi_pct        DOUBLE PRECISION NOT NULL DEFAULT 100,
      i_lo_pct        DOUBLE PRECISION NOT NULL DEFAULT 10,
      v_sag_pct       DOUBLE PRECISION NOT NULL DEFAULT 90,
      i_sag_drop_pct  DOUBLE PRECISION NOT NULL DEFAULT 30,
      updated_by      TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (v_nominal_v > 0 AND i_nominal_a > 0),
      CHECK (v_lo_pct < v_hi_pct AND i_lo_pct < i_hi_pct)
    );

    CREATE TABLE IF NOT EXISTS feeder_telemetry (
      feeder   TEXT NOT NULL,
      ts       TIMESTAMPTZ NOT NULL,
      v_r      DOUBLE PRECISION,
      v_y      DOUBLE PRECISION,
      v_b      DOUBLE PRECISION,
      i_r      DOUBLE PRECISION,
      i_y      DOUBLE PRECISION,
      i_b      DOUBLE PRECISION,
      quality  TEXT NOT NULL DEFAULT 'GOOD',
      source   TEXT NOT NULL DEFAULT 'SCADA',
      PRIMARY KEY (feeder, ts)
    );

    CREATE TABLE IF NOT EXISTS feeder_kpi_daily (
      feeder       TEXT NOT NULL,
      day          DATE NOT NULL,
      kpis         JSONB NOT NULL,
      extras       JSONB NOT NULL DEFAULT '{}'::jsonb,
      coverage     JSONB NOT NULL,
      rating       JSONB NOT NULL,
      computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (feeder, day)
    );
    CREATE INDEX IF NOT EXISTS feeder_kpi_daily_day_idx ON feeder_kpi_daily(day);
  `);

  const ts = await db.oneOrNone("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
  if (ts) {
    await db.any(`SELECT create_hypertable('feeder_telemetry', 'ts', chunk_time_interval => INTERVAL '1 day',
                                            if_not_exists => TRUE, migrate_data => TRUE)`);
    // Raw samples are only needed until their day is rolled up and audited;
    // FEEDER_TELEMETRY_RETENTION_DAYS (default 400) keeps a year plus margin.
    const days = Number(process.env.FEEDER_TELEMETRY_RETENTION_DAYS) || 400;
    await db.any(`SELECT add_retention_policy('feeder_telemetry', INTERVAL '${days} days', if_not_exists => TRUE)`)
      .catch((e) => console.warn('[feeder-kpi] retention policy not set:', e.message));
  } else {
    await db.none('CREATE INDEX IF NOT EXISTS feeder_telemetry_ts_idx ON feeder_telemetry(ts)');
  }
}
