// D1 self-test (4 Nov 2026; load test results section 8.2 and 8.4): startup
// without DDL, and ID counters that never go back. Scratch database only:
//   DATABASE_URL=<scratch db> node src/selftest-startup.js
//   D1-1  migrate() writes a schema version; a second call is a no-op
//   D1-2  with the version current, an api and a worker start while another
//         session holds the locks traffic holds: both healthy, ZERO DDL
//         statements (an event trigger records every one), counters unchanged
//   D1-3  version older + a conflicting lock held: the migration step fails on
//         lock_timeout, is retried with a delay, and succeeds once the lock goes
//   D1-4  a startup step that keeps failing exits with code 1, not 0
//   D1-5  syncIdSequences() moving the counter while 8 sessions call
//         nextval(): no value is handed out twice (section 8.4 found 2,320)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-startup: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';

const { db, migrate, expectedSchemaVersion, currentSchemaVersion, syncIdSequences } = await import('./infra/db.js');
const { seed } = await import('./infra/seed.js');

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(everyMs); }
  return null;
}
const freePort = () => new Promise((r) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

const procs = [];
async function start(role, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ROLE: role, PORT: String(port), SIMULATOR: 'off', FEEDER_TELEMETRY_SIM: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exitInfo = null;
  child.exited = new Promise((r) => child.once('exit', (code, signal) => { child.exitInfo = { code, signal }; r(child.exitInfo); }));
  child.base = `http://127.0.0.1:${port}`;
  procs.push(child);
  return child;
}
const healthy = (p, timeoutMs = 60000) => waitUntil(async () => !p.exitInfo && (await fetch(p.base + '/api/health')).ok, timeoutMs, 250);
async function stop(p) { if (!p.exitInfo) { p.kill('SIGKILL'); await p.exited; } }
const counters = () => db.one(`SELECT (SELECT last_value FROM incident_id_seq)::text || '/' || (SELECT is_called FROM incident_id_seq) AS inc,
  (SELECT last_value FROM complaint_qid_seq)::text || '/' || (SELECT is_called FROM complaint_qid_seq) AS qry`);

// A second session that holds locks like live traffic does (or a conflicting one).
async function holdLocks(sql) {
  const c = await db.connect();
  await c.none('BEGIN');
  await c.none(sql);
  return { release: async () => { await c.none('COMMIT'); c.done(); } };
}

try {
  // ---------------------------------------------------------------- D1-1
  {
    const r1 = await migrate();
    const r2 = await migrate();
    const want = await expectedSchemaVersion();
    check('D1-1: migrate() records the schema version; a second call runs no migration',
      r2.migrated === false && (await currentSchemaVersion()) === want, `(first migrated=${r1.migrated}, second migrated=${r2.migrated}, version ${want})`);
    await seed({ force: true });
  }

  // ---------------------------------------------------------------- D1-2
  {
    await db.none(`
      CREATE TABLE IF NOT EXISTS selftest_ddl_log (at TIMESTAMPTZ NOT NULL DEFAULT now(), tag TEXT, pid INT);
      CREATE OR REPLACE FUNCTION selftest_log_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO selftest_ddl_log (tag, pid) VALUES (tg_tag, pg_backend_pid()); END $$;
      DROP EVENT TRIGGER IF EXISTS selftest_ddl_trg;
      CREATE EVENT TRIGGER selftest_ddl_trg ON ddl_command_start EXECUTE FUNCTION selftest_log_ddl();`);
    await db.none('DELETE FROM selftest_ddl_log');
    const before = await counters();
    // what traffic holds: ROW EXCLUSIVE on the tables the intake writes
    const traffic = await holdLocks('LOCK TABLE alarms, incidents, complaints, incident_events, intake_queue, audit_log IN ROW EXCLUSIVE MODE');
    const t0 = Date.now();
    const [api, worker] = await Promise.all([start('api'), start('worker')]);
    const [apiUp, workerUp] = await Promise.all([healthy(api, 30000), healthy(worker, 30000)]);
    const startMs = Date.now() - t0;
    await traffic.release();
    const ddl = await db.any('SELECT tag, count(*)::int n FROM selftest_ddl_log GROUP BY tag ORDER BY tag');
    const after = await counters();
    const noFatal = !/\[fatal\]/.test(api.output + worker.output);
    check('D1-2: api and worker start while another session holds the row locks traffic holds (version current)',
      !!apiUp && !!workerUp && noFatal, `(api=${!!apiUp}, worker=${!!workerUp}, both healthy within ${startMs} ms, [fatal] lines ${noFatal ? 0 : 'found'})`);
    check('D1-2: ... and they ran no DDL at all (event trigger on ddl_command_start)', ddl.length === 0,
      `(${ddl.length ? ddl.map((d) => `${d.tag} x${d.n}`).join(', ') : '0 statements'})`);
    check('D1-2: ... and no setval: both ID counters unchanged', before.inc === after.inc && before.qry === after.qry,
      `(incident ${before.inc} -> ${after.inc}, complaint ${before.qry} -> ${after.qry})`);
    check('D1-2: ... each says its schema version is current', /\[schema\] version \w+ is current: no DDL/.test(api.output) && /\[schema\] version \w+ is current: no DDL/.test(worker.output));
    if (!apiUp || !workerUp) console.log(api.output.slice(-1500), '\n----\n', worker.output.slice(-1500));
    await stop(api); await stop(worker);
    await db.none('DROP EVENT TRIGGER IF EXISTS selftest_ddl_trg; DROP FUNCTION IF EXISTS selftest_log_ddl(); DROP TABLE IF EXISTS selftest_ddl_log;');
  }

  // ---------------------------------------------------------------- D1-3
  {
    await db.none("UPDATE oms_schema_version SET version = 'older-for-selftest'");
    // ALTER TABLE alarms (in the intake queue migration) needs ACCESS EXCLUSIVE; this conflicts
    const blocker = await holdLocks('LOCK TABLE alarms IN ROW EXCLUSIVE MODE');
    const w = await start('worker', { MIGRATION_LOCK_TIMEOUT_MS: '500', STARTUP_RETRY_DELAY_MS: '300', STARTUP_RETRY_ATTEMPTS: '30' });
    const retried = await waitUntil(() => /\[startup\] step "schema" failed \(attempt 1\/30\): [^\n]*lock timeout[^\n]*; retrying in 300 ms/.test(w.output), 20000);
    const stillUpBeforeRelease = !w.exitInfo;
    await blocker.release();
    const up = await healthy(w, 60000);
    const want = await expectedSchemaVersion();
    check('D1-3: older version + a conflicting lock: the migration stops at lock_timeout and is retried with a delay',
      !!retried && stillUpBeforeRelease, `(${(w.output.match(/\[startup\] step "schema" failed[^\n]*/) || ['no retry line'])[0].slice(0, 160)})`);
    check('D1-3: ... once the lock is gone the same process migrates and becomes healthy, no [fatal]',
      !!up && /\[schema\] migrated older-for-selftest -> /.test(w.output) && (await currentSchemaVersion()) === want && !/\[fatal\]/.test(w.output),
      `(healthy=${!!up}, version now ${await currentSchemaVersion()})`);
    await stop(w);
  }

  // ---------------------------------------------------------------- D1-4
  {
    await db.none("UPDATE oms_schema_version SET version = 'older-for-selftest'");
    const blocker = await holdLocks('LOCK TABLE alarms IN ROW EXCLUSIVE MODE');
    const w = await start('worker', { MIGRATION_LOCK_TIMEOUT_MS: '300', STARTUP_RETRY_DELAY_MS: '200', STARTUP_RETRY_ATTEMPTS: '2' });
    const exit = await Promise.race([w.exited, sleep(30000).then(() => null)]);
    await blocker.release();
    check('D1-4: a startup step that keeps failing exits with code 1 (not 0, not hanging)',
      exit?.code === 1 && /\[fatal\] startup step "schema" failed 2 time\(s\)/.test(w.output), `(exit ${JSON.stringify(exit)})`);
    await stop(w);
    await migrate(); // back to the current version for what follows
  }

  // ---------------------------------------------------------------- D1-5
  {
    const takers = 8, ms = 8000;
    const got = [];
    let running = true;
    const loops = Array.from({ length: takers }, async () => {
      while (running) got.push(Number((await db.one("SELECT nextval('complaint_qid_seq') AS n")).n));
    });
    // Put a hand-written qid ahead of the counter (as a seed or a restored dump does),
    // then sync: the counter must jump past it while the takers keep calling nextval().
    let syncs = 0, jumps = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const { v } = await db.one('SELECT last_value::bigint AS v FROM complaint_qid_seq');
      const ahead = Number(v) + 400;
      await db.none(`INSERT INTO complaints (qid, external_id, customer, category, ts) VALUES ($1, $2, 'D1-5', 'No Supply', now())`,
        [`QRY-2026-${String(ahead).padStart(6, '0')}`, `D1-5-${syncs}`]);
      await syncIdSequences();
      const { v: v2 } = await db.one('SELECT last_value::bigint AS v FROM complaint_qid_seq');
      if (Number(v2) >= ahead) jumps++;
      syncs++;
    }
    running = false;
    await Promise.all(loops);
    const seen = new Map();
    for (const n of got) seen.set(n, (seen.get(n) || 0) + 1);
    const twice = [...seen.values()].filter((c) => c > 1).length;
    check('D1-5: counter sync while 8 sessions call nextval(): no value handed out twice',
      twice === 0 && jumps > 0 && got.length > 1000, `(${got.length} nextval calls, ${seen.size} distinct, ${twice} handed out twice; ${syncs} syncs, ${jumps} moved the counter forward)`);
    await db.none("DELETE FROM complaints WHERE external_id LIKE 'D1-5-%'");
  }
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
} finally {
  for (const p of procs) await stop(p).catch(() => {});
}
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
await db.$pool.end().catch(() => {});
process.exit(fails ? 1 : 0);
