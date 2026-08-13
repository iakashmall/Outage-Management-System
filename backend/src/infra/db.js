import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

// node:sqlite is built into Node (>=22.5) — no native compiler or prebuilt
// binary required. It prints one experimental-feature warning; silence just that.
const _emit = process.emitWarning;
process.emitWarning = (w, ...a) =>
  String(w).includes('SQLite is an experimental') ? undefined : _emit.call(process, w, ...a);

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

// Real embedded SQL database, persisted to backend/data/oms.db.
// Swap this one module for a Postgres/Prisma adapter (see docs/ARCHITECTURE.md)
// and nothing else in the domain layer changes.
const _raw = new DatabaseSync(join(dataDir, 'oms.db'));
_raw.exec('PRAGMA journal_mode = WAL');
_raw.exec('PRAGMA foreign_keys = ON');

// Thin adapter presenting the same tiny interface the rest of the app already
// uses (prepare().run/get/all, exec). Bare named parameters (@id -> { id })
// are enabled so existing queries work unchanged.
export const db = {
  prepare(sql) {
    const stmt = _raw.prepare(sql);
    if (stmt.setAllowBareNamedParameters) stmt.setAllowBareNamedParameters(true);
    return stmt;
  },
  exec(sql) { return _raw.exec(sql); },
  // Mirrors better-sqlite3: returns a function that runs `fn` inside a
  // transaction, rolling back if it throws.
  transaction(fn) {
    return (...args) => {
      _raw.exec('BEGIN');
      try { const r = fn(...args); _raw.exec('COMMIT'); return r; }
      catch (e) { _raw.exec('ROLLBACK'); throw e; }
    };
  },
};

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    severity      TEXT NOT NULL,
    status        TEXT NOT NULL,
    zone          TEXT,
    feeder        TEXT,
    customers     INTEGER DEFAULT 0,
    cause         TEXT,
    lat           REAL,
    lon           REAL,
    crew_id       TEXT,
    opened_at     TEXT NOT NULL,
    ert           TEXT,
    sla_due_at    TEXT,
    source        TEXT DEFAULT 'SCADA',
    substation    TEXT
  );
  CREATE TABLE IF NOT EXISTS complaints (
    qid          TEXT PRIMARY KEY,
    external_id  TEXT,
    customer     TEXT,
    phone        TEXT,
    address      TEXT,
    category     TEXT,
    lat          REAL,
    lon          REAL,
    dt_id        TEXT,
    feeder       TEXT,
    substation   TEXT,
    incident_id  TEXT,
    action       TEXT,
    ts           TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS incident_events (
    id         TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    ts         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    note       TEXT
  );
  CREATE TABLE IF NOT EXISTS crews (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    lead      TEXT,
    status    TEXT NOT NULL,
    location  TEXT,
    job_id    TEXT,
    lat       REAL,
    lon       REAL,
    skills    TEXT
  );
  CREATE TABLE IF NOT EXISTS alarms (
    id        TEXT PRIMARY KEY,
    tag       TEXT NOT NULL,
    condition TEXT NOT NULL,
    limit_val TEXT,
    priority  INTEGER,
    message   TEXT,
    ts        TEXT NOT NULL,
    ack       INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS trouble_calls (
    id        TEXT PRIMARY KEY,
    customer  TEXT,
    phone     TEXT,
    address   TEXT,
    category  TEXT,
    status    TEXT,
    linked_id TEXT,
    ts        TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    incident_id  TEXT REFERENCES incidents(id),
    crew_id      TEXT REFERENCES crews(id),
    priority     TEXT DEFAULT 'Normal',
    status       TEXT DEFAULT 'Acknowledged',
    address      TEXT,
    updated_at   TEXT
  );
  CREATE TABLE IF NOT EXISTS job_updates (
    id      TEXT PRIMARY KEY,
    job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status  TEXT NOT NULL,
    lat     REAL, lon REAL,
    note    TEXT,
    ts      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id     TEXT PRIMARY KEY,
    ts     TEXT NOT NULL,
    actor  TEXT,
    action TEXT,
    target TEXT
  );
  `);
}
