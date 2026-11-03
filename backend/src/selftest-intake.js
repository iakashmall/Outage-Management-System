// Burst-safe intake self-test (runbook v2, WP1 gates G1-G5). Needs a scratch
// PostGIS database (pgcrypto available); it reseeds it:
//   DATABASE_URL=<scratch db> node src/selftest-intake.js
//   G1  200 concurrent SCADA events on one feeder -> exactly 1 incident
//   G2  1,000 concurrent complaints on one feeder -> 1 incident, customers = distinct complaints
//   G3  the same external_id posted 50 times at once -> 1 complaint
//   G4  one injected database error is retried; the event is processed exactly once
//   G5  a forced failure after the incident insert rolls back incident and complaint
import 'express-async-errors';
import express from 'express';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-intake: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
process.env.INTAKE_RETRY_BASE_MS = process.env.INTAKE_RETRY_BASE_MS || '20';

const { db, migrate } = await import('./infra/db.js');
const { seed } = await import('./infra/seed.js');
const { initBus } = await import('./domain/bus.js');
const { repo } = await import('./infra/repo.js');
const { distTx, resolve: resolveAsset } = await import('./infra/geo.js');
const { handleScadaEvent } = await import('./realtime/scada.js');
const { ingestComplaint } = await import('./realtime/complaintIntake.js');
const { intakeTestHooks } = await import('./infra/intake.js');
const { refreshNetworkIdentity } = await import('./infra/networkIdentity.js');
const { api } = await import('./routes/api.js');
const { startIntakeWorker } = await import('./realtime/intakeWorker.js');
const { closeListener } = await import('./infra/intakeQueue.js');

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

// migrate() alone sets up everything intake needs (pgcrypto, safe_decrypt_text,
// the encrypted phone column, the identity tables): no manual db/migrations here.
await migrate();
await seed({ force: true });
await initBus();
const worker = startIntakeWorker({ pollMs: 50 }); // POST /complaints (G3) goes through the intake queue (WP2)
const ms = (t0) => `${Date.now() - t0} ms`;
const count = async (sql, params) => (await db.one(sql, params)).n;

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { username: 'intake-test', roles: ['system_admin', 'oms_operator'] }; next(); });
app.use('/api', api);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

// Distribution transformers that resolve to their own feeder, at substations
// with no live planned outage (a complaint there would attach to it, OMS-01).
// A, B, C, D: one feeder each, at four different substations. G9 uses a fifth
// substation with two feeders (F1, F2). Everything open there is closed first.
const usable = [];
for (const d of distTx) {
  const at = resolveAsset(d.lat, d.lon);
  if (!d.feeder || at.feeder !== d.feeder || (await repo.plannedOutagesForComplaint(at.substation)).length) continue;
  usable.push({ ...d, substation: at.substation });
}
const bySub = new Map();
for (const d of usable) {
  if (!bySub.has(d.substation)) bySub.set(d.substation, new Map());
  if (!bySub.get(d.substation).has(d.feeder)) bySub.get(d.substation).set(d.feeder, d);
}
const g9Sub = [...bySub].find(([, f]) => f.size >= 2)?.[0];
const [g9F1, g9F2] = g9Sub ? [...bySub.get(g9Sub).values()] : [];
const [dtA, dtB, dtC, dtD] = [...bySub].filter(([s]) => s !== g9Sub).map(([, f]) => [...f.values()][0]);
await db.none("UPDATE incidents SET status='closed' WHERE substation IN ($1:csv)", [[dtA, dtB, dtC, dtD, g9F1].map((d) => d.substation)]);
const coreOf = (name) => name.replace(/^\s*\d+\s*\/\s*\d+\s*kv\s*/i, '').replace(/\s*s\/s\s*$/i, '').replace(/[^A-Za-z0-9]/g, '');
const closeAt = (sub) => db.none("UPDATE incidents SET status='closed' WHERE substation=$1 OR substation ILIKE $2", [sub, `%${coreOf(sub)}%`]);
const who = { username: 'intake-test', roles: ['system_admin'] };

try {
  // ---- the migration ----
  const idx = await db.oneOrNone("SELECT indexdef FROM pg_indexes WHERE indexname='complaints_external_id_key'");
  check('migration: unique index on complaints.external_id', /UNIQUE/.test(idx?.indexdef || ''), idx?.indexdef || '(missing)');
  let again = null;
  try { await migrate(); } catch (e) { again = e.message; }
  check('migration: running migrate() again is a no-op', again === null, again || '');

  // ---- G1: 200 concurrent SCADA trips on one feeder (a real network feeder code) ----
  {
    const feeder = dtD.feeder, substation = dtD.substation;
    const t0 = Date.now();
    const res = await Promise.allSettled(Array.from({ length: 200 }, (_, i) =>
      handleScadaEvent({ tag: `G1.FDR.CB${i}.TRIP`, condition: 'CRITICAL', limit_val: 'TRIP', feeder, substation, customers: 400 })));
    const rejected = res.filter((r) => r.status === 'rejected');
    const n = await count("SELECT count(*)::int n FROM incidents WHERE feeder=$1 AND status='open'", [feeder]);
    const created = res.filter((r) => r.value?.deduplicated === false).length;
    const inc = await db.one("SELECT id, open_trip_tags FROM incidents WHERE feeder=$1 AND status='open'", [feeder]).catch(() => null);
    check('G1: 200 concurrent SCADA events on one feeder -> exactly 1 incident', n === 1 && created === 1 && rejected.length === 0,
      `(incidents=${n}, created=${created}, deduplicated=${res.length - created - rejected.length}, errors=${rejected.length}, ${ms(t0)})`);
    check('G1: every trip tag recorded on that incident', inc?.open_trip_tags?.length === 200, `(${inc?.open_trip_tags?.length})`);

    // feeder unknown -> same substation (D2), also under a burst
    const res2 = await Promise.allSettled(Array.from({ length: 100 }, (_, i) =>
      handleScadaEvent({ tag: `G1B${i}`, condition: 'CRITICAL', substation: 'G1B TEST S/s', customers: 50 })));
    const n2 = await count("SELECT count(*)::int n FROM incidents WHERE substation='G1B TEST S/s'");
    check('G1: 100 concurrent substation-only events (feeder unknown) -> 1 incident', n2 === 1 && res2.every((r) => r.status === 'fulfilled'), `(${n2})`);

  }

  // ---- G9: feeder identity. SCADA tag names and network codes meet on one canonical id ----
  {
    const S = g9Sub, F1 = g9F1.feeder, F2 = g9F2.feeder, core = coreOf(S);
    const complain = (d, ext) => ingestComplaint({ externalId: ext, customer: 'G9', phone: '9800000009', category: 'No Supply', lat: d.lat, lon: d.lon }, who);
    const incAt = () => db.any("SELECT id, feeder FROM incidents WHERE status='open' AND (substation=$1 OR substation ILIKE $2)", [S, `%${core}%`]);
    const keys = await db.one('SELECT oms_feeder_key($1) a, oms_feeder_key($2) b, oms_substation_key($3, $1) s, oms_substation_key($4, NULL) t',
      [`${core}.FDR7`, F1, core, core]);
    check('G9 rule: a tag feeder not in the network is unknown; a network code is itself; the tag substation resolves by core name',
      keys.a === null && keys.b === F1 && keys.s === S && keys.t === S, JSON.stringify(keys));

    // 1. SCADA tag feeder (unknown) first, then a complaint resolved to a network code, same substation
    await closeAt(S);
    const t1 = await handleScadaEvent({ tag: `${core}.FDR7.CB1.TRIP`, condition: 'CRITICAL', limit_val: 'TRIP', customers: 100 });
    const c1 = await complain(g9F1, 'G9-1');
    const n1 = await incAt();
    check('G9: SCADA tag feeder + complaint with a network code, same substation -> 1 incident', n1.length === 1 && c1.incidentId === t1.incidentId && c1.action === 'merged',
      `(incidents=${n1.length}, scada=${t1.incidentId}, complaint->${c1.incidentId})`);

    // 2. the other order: complaint first, then the tag-named trip
    await closeAt(S);
    const c2 = await complain(g9F1, 'G9-2');
    const t2 = await handleScadaEvent({ tag: `${core}.FDR8.CB1.TRIP`, condition: 'CRITICAL', limit_val: 'TRIP', customers: 100 });
    check('G9: same, complaint first -> 1 incident', (await incAt()).length === 1 && t2.deduplicated === true && t2.incidentId === c2.incidentId,
      `(${c2.incidentId} / ${t2.incidentId})`);

    // 3. two different KNOWN feeders of that substation -> 2 incidents
    await closeAt(S);
    const t3 = await handleScadaEvent({ tag: `${core}.X.CB1.TRIP`, feeder: F1, condition: 'CRITICAL', limit_val: 'TRIP', customers: 100 });
    const c3 = await complain(g9F2, 'G9-3');
    const n3 = await incAt();
    check('G9: two different known feeders -> 2 incidents', n3.length === 2 && c3.action === 'created' && c3.incidentId !== t3.incidentId,
      `(incidents=${n3.length}: ${n3.map((i) => i.feeder).join(', ')})`);

    // 4. a tag dictionary entry (network_aliases) makes the tag feeder known
    await closeAt(S);
    await db.none("INSERT INTO network_aliases (kind, alias, canonical, note) VALUES ('feeder', 'DEHRA.FDR7', $1, 'selftest') ON CONFLICT (kind, alias) DO UPDATE SET canonical = EXCLUDED.canonical", [F1]);
    await refreshNetworkIdentity();
    const t4 = await handleScadaEvent({ tag: 'DEHRA.FDR7.CB1.TRIP', condition: 'CRITICAL', limit_val: 'TRIP', customers: 100 });
    const c4a = await complain(g9F1, 'G9-4a');
    const c4b = await complain(g9F2, 'G9-4b');
    const i4 = await repo.incident(t4.incidentId);
    check('G9: an alias resolves DEHRA.FDR7 to its feeder: same feeder merges, the other feeder does not',
      i4?.feeder === F1 && i4?.substation === S && c4a.incidentId === t4.incidentId && c4b.incidentId !== t4.incidentId && (await incAt()).length === 2,
      `(stored feeder=${i4?.feeder}, substation=${i4?.substation})`);
    await db.none("DELETE FROM network_aliases WHERE note = 'selftest'");
    await refreshNetworkIdentity();

    // 5. under a burst: 50 tag-named trips and 50 complaints at once -> still 1 incident
    await closeAt(S);
    const burst = await Promise.allSettled([
      ...Array.from({ length: 50 }, (_, i) => handleScadaEvent({ tag: `${core}.FDR9.CB${i}.TRIP`, condition: 'CRITICAL', limit_val: 'TRIP', customers: 10 })),
      ...Array.from({ length: 50 }, (_, i) => complain(g9F1, `G9-5-${i}`)),
    ]);
    const n5 = await incAt();
    check('G9: 50 tag-named trips + 50 network-code complaints at once -> 1 incident', n5.length === 1 && burst.every((r) => r.status === 'fulfilled'),
      `(incidents=${n5.length}, errors=${burst.filter((r) => r.status === 'rejected').length})`);
    await closeAt(S);
  }

  // ---- G2: 1,000 concurrent complaints on one feeder ----
  {
    const t0 = Date.now();
    const res = await Promise.allSettled(Array.from({ length: 1000 }, (_, i) =>
      ingestComplaint({ externalId: `G2-${i}`, customer: `G2 customer ${i}`, phone: '9800000000', category: 'No Supply',
        lat: dtA.lat + (i % 7) * 1e-6, lon: dtA.lon }, { username: 'intake-test', roles: ['system_admin'] })));
    const rejected = res.filter((r) => r.status === 'rejected');
    const incs = await db.any("SELECT id, customers FROM incidents WHERE feeder=$1 AND status='open'", [dtA.feeder]);
    const complaints = await count("SELECT count(DISTINCT qid)::int n FROM complaints WHERE external_id LIKE 'G2-%'");
    const linked = incs.length === 1 ? await count('SELECT count(*)::int n FROM complaints WHERE incident_id=$1', [incs[0].id]) : -1;
    check('G2: 1,000 concurrent complaints on one feeder -> 1 incident', incs.length === 1 && rejected.length === 0,
      `(incidents=${incs.length}, errors=${rejected.length}${rejected[0] ? ': ' + rejected[0].reason.message : ''}, ${ms(t0)})`);
    check('G2: customer count equals the number of distinct complaints', incs[0]?.customers === complaints && complaints === 1000 && linked === 1000,
      `(customers=${incs[0]?.customers}, distinct complaints=${complaints}, linked=${linked})`);
  }

  // ---- G3: the same external_id posted 50 times at once (over HTTP) ----
  {
    const body = { externalId: 'G3-EXT-1', customer: 'G3', phone: '9800000003', category: 'No Supply', lat: dtB.lat, lon: dtB.lon };
    const res = await Promise.all(Array.from({ length: 50 }, () => fetch(base + '/complaints', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))));
    const n = await count("SELECT count(*)::int n FROM complaints WHERE external_id='G3-EXT-1'");
    const created = res.filter((r) => r.status === 201).length;
    const dup = res.filter((r) => r.status === 200 && r.body.duplicate === true).length;
    const qids = new Set(res.map((r) => r.body.queryId));
    check('G3: the same external_id posted 50 times at once -> 1 complaint', n === 1 && created === 1 && dup === 49 && qids.size === 1,
      `(rows=${n}, 201=${created}, 200 duplicate=${dup}, distinct queryIds=${qids.size})`);
    const inc = await db.oneOrNone('SELECT customers FROM incidents WHERE id=$1', [res[0].body.incidentId]);
    check('G3: the duplicates did not add customers', inc?.customers === 1, `(${inc?.customers})`);
    let unique = null;
    try { await db.none("INSERT INTO complaints (qid, external_id, ts) VALUES ('QRY-G3-X', 'G3-EXT-1', now())"); } catch (e) { unique = e.code; }
    check('G3: the database itself rejects a second row with that external_id', unique === '23505', `(${unique})`);
  }

  // ---- G4: one injected database error is retried; processed exactly once ----
  {
    let calls = 0;
    intakeTestHooks.afterIncidentInsert = async (t) => { calls++; if (calls === 1) await t.none('SELECT 1/0'); }; // division_by_zero, once
    const alarm = { id: 'ALM-G4', tag: 'G4.FDR.CB1.TRIP', condition: 'CRITICAL', limit_val: 'TRIP', priority: 1, message: 'g4', ts: new Date().toISOString(), ack: 0 };
    await repo.createAlarm(alarm);
    let r, err = null;
    try { r = await handleScadaEvent({ ...alarm, feeder: 'G4-FDR', substation: 'G4 TEST S/s', customers: 300 }); } catch (e) { err = e.message; }
    intakeTestHooks.afterIncidentInsert = null;
    const incs = await db.any("SELECT id FROM incidents WHERE feeder='G4-FDR'");
    const id = incs[0]?.id;
    const createdEv = id ? await count("SELECT count(*)::int n FROM incident_events WHERE incident_id=$1 AND kind='created'", [id]) : 0;
    const audits = id ? await count("SELECT count(*)::int n FROM audit_log WHERE action='incident.autodetect' AND target=$1", [id]) : 0;
    const linkedAlarm = await db.one("SELECT incident_id FROM alarms WHERE id='ALM-G4'");
    check('G4: the injected error was retried (2 attempts) and the call succeeded', calls === 2 && !err && r?.deduplicated === false, `(attempts=${calls}${err ? ', error=' + err : ''})`);
    check('G4: processed exactly once (1 incident, 1 created event, 1 audit row, alarm linked)',
      incs.length === 1 && createdEv === 1 && audits === 1 && linkedAlarm.incident_id === id,
      `(incidents=${incs.length}, created events=${createdEv}, audit=${audits}, alarm->${linkedAlarm.incident_id})`);
  }

  // ---- G5: a forced failure after the incident insert rolls back both rows ----
  {
    let calls = 0, seenId = null;
    intakeTestHooks.afterIncidentInsert = async (t, { id }) => {
      calls++; seenId = id;
      const there = await t.oneOrNone('SELECT 1 FROM incidents WHERE id=$1', [id]);
      if (!there) throw new Error('hook ran before the insert');
      throw new Error('G5 forced failure after the incident insert');
    };
    let err = null;
    try {
      await ingestComplaint({ externalId: 'G5-EXT-1', customer: 'G5', phone: '9800000005', category: 'No Supply', lat: dtC.lat, lon: dtC.lon },
        { username: 'intake-test', roles: ['system_admin'] });
    } catch (e) { err = e.message; }
    intakeTestHooks.afterIncidentInsert = null;
    const incN = await count('SELECT count(*)::int n FROM incidents WHERE id=$1 OR feeder=$2', [seenId, dtC.feeder]);
    const cN = await count("SELECT count(*)::int n FROM complaints WHERE external_id='G5-EXT-1'");
    const evN = await count('SELECT count(*)::int n FROM incident_events WHERE incident_id=$1', [seenId]);
    check('G5: the failure surfaces to the caller after the bounded retries (not swallowed)', /G5 forced failure/.test(err || '') && calls === 3, `(attempts=${calls})`);
    check('G5: incident and complaint both rolled back', incN === 0 && cN === 0 && evN === 0, `(incident rows=${incN}, complaint rows=${cN}, events=${evN})`);
    // and the same complaint goes through once the fault is gone
    const ok = await ingestComplaint({ externalId: 'G5-EXT-1', customer: 'G5', phone: '9800000005', category: 'No Supply', lat: dtC.lat, lon: dtC.lon },
      { username: 'intake-test', roles: ['system_admin'] });
    check('G5: after the fault clears the same complaint is accepted once', ok.action === 'created' && !ok.duplicate
      && (await count("SELECT count(*)::int n FROM complaints WHERE external_id='G5-EXT-1'")) === 1);
  }
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
}
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
server.closeAllConnections();
await new Promise((r) => server.close(r));
await worker.stop();
await closeListener();
await db.$pool.end().catch(() => {});
process.exitCode = fails ? 1 : 0;
