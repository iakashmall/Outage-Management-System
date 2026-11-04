// Load-test findings F1-F3, F5, F6 (3 Nov 2026; docs/LOAD_TEST_RESULTS_2026-11-02.md
// section 4 on feat/load-tests). F4 (Redis) is src/infra/redisFailFast.test.js.
// Needs a scratch PostGIS database; it reseeds it:
//   DATABASE_URL=<scratch db> node src/selftest-loadfixes.js
//   F1  alarm ids never collide: 100,000 ids, and 100,000 alarm inserts through the intake writer
//   F2  a SCADA resend never stores a second row: the API is killed after the insert
//       and before the reply, the sender retries, there is one row and the retry
//       answers 200 duplicate
//   F3  /api/health answers in under 200 ms while Postgres is unreachable
//   F5  feeder-grouped processing: exactly once, trip/reclose/trip order kept, throughput
//   F6  complaints are not held up by a SCADA backlog; API reads stay fast during the drain
import express from 'express';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-loadfixes: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
process.env.INTAKE_RETRY_BASE_MS = process.env.INTAKE_RETRY_BASE_MS || '20';
const here = path.dirname(fileURLToPath(import.meta.url));

const { db, migrate } = await import('./infra/db.js');
const { seed } = await import('./infra/seed.js');
const { initBus } = await import('./domain/bus.js');
const { repo } = await import('./infra/repo.js');
const { distTx } = await import('./infra/geo.js');
const { queueStats, closeListener, consumerStats } = await import('./infra/intakeQueue.js');
const { startIntakeWorker, submitComplaint } = await import('./realtime/intakeWorker.js');
const { newAlarmId } = await import('./infra/ids.js');
const { buildScadaEvent, submitScadaEvent, scadaIntakeStats } = await import('./infra/scadaIntake.js');
const { stopHealthRefresher } = await import('./routes/health.js');
const { api } = await import('./routes/api.js');

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => { ok ? passes++ : fails++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = async (sql, params) => Number((await db.one(sql, params)).n);
async function waitUntil(fn, timeoutMs, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return true; await sleep(everyMs); }
  return false;
}
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null; };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

await migrate();
await seed({ force: true });
await initBus();
await db.none('DELETE FROM intake_queue; DELETE FROM intake_dead_letter;'); // scratch database only

// Real network feeders, all incidents on them closed, so each test starts clean.
const feeders = [...new Set(distTx.map((d) => d.feeder).filter(Boolean))].slice(0, 30);
await db.none("UPDATE incidents SET status='closed' WHERE feeder IN ($1:csv)", [feeders]);

// The real router behind a fake signed-in user (as selftest-queue G8 does).
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { username: 'loadfix-test', roles: ['system_admin'] }; next(); });
app.use('/api', api);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- F1
{
  const N = 100_000;
  const oldGen = () => 'ALM-' + Math.random().toString(36).slice(2, 7);
  const ids = new Set(); const old = new Set(); let oldCollisions = 0;
  for (let i = 0; i < N; i++) { ids.add(newAlarmId()); const o = oldGen(); if (old.has(o)) oldCollisions++; else old.add(o); }
  check('F1: 100,000 new alarm ids are 100,000 distinct values', ids.size === N,
    `(distinct=${ids.size}; the old 5-character generator gave ${oldCollisions} collisions on the same count, expected ~${Math.round(N * N / (2 * 36 ** 5))})`);

  const t0 = Date.now();
  const results = await Promise.allSettled(Array.from({ length: N }, (_, i) =>
    submitScadaEvent(buildScadaEvent({ tag: `F1.${feeders[i % 20]}.E${i}`, feeder: feeders[i % 20], condition: 'MINOR' }), { actor: 'loadfix-test' })));
  const rejected = results.filter((r) => r.status === 'rejected');
  const rows = await n("SELECT count(*) n FROM alarms WHERE tag LIKE 'F1.%'");
  const distinct = await n("SELECT count(DISTINCT id) n FROM alarms WHERE tag LIKE 'F1.%'");
  const queued = await n("SELECT count(*) n FROM intake_queue WHERE payload->>'tag' LIKE 'F1.%'");
  check('F1: 100,000 alarm inserts through the intake writer: 0 errors, 100,000 rows, 100,000 distinct ids, 100,000 queue items',
    rejected.length === 0 && rows === N && distinct === N && queued === N,
    `(errors=${rejected.length}${rejected[0] ? ' e.g. ' + rejected[0].reason?.message : ''}, rows=${rows}, distinct=${distinct}, queued=${queued}, ${Date.now() - t0} ms, ${scadaIntakeStats.batches} batches, largest ${scadaIntakeStats.maxBatch})`);
  await db.none("DELETE FROM intake_queue WHERE payload->>'tag' LIKE 'F1.%'; DELETE FROM alarms WHERE tag LIKE 'F1.%'; DELETE FROM audit_log WHERE target LIKE 'F1.%'");
}

// ---------------------------------------------------------------- F2
// The route in its own process: express + the real api router, with the
// test hook index.js sets for SCADA_TEST_CRASH_AFTER_COMMIT=1.
function startChildApi(port, crash) {
  const code = `
    const express = (await import('express')).default;
    const { initBus } = await import(${JSON.stringify(new URL('./domain/bus.js', import.meta.url).href)});
    const { api } = await import(${JSON.stringify(new URL('./routes/api.js', import.meta.url).href)});
    const { scadaIntakeTestHooks } = await import(${JSON.stringify(new URL('./infra/scadaIntake.js', import.meta.url).href)});
    await initBus();
    if (${crash}) scadaIntakeTestHooks.afterCommit = () => { console.log('committed; killing myself before the reply'); process.kill(process.pid, 'SIGKILL'); };
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.user = { username: 'loadfix-sender', roles: ['scada_operator'] }; next(); });
    app.use('/api', api);
    app.listen(${port}, '127.0.0.1', () => console.log('child api ready'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(here, '..'), env: { ...process.env, SIMULATOR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  child.ready = waitUntil(async () => child.output.includes('child api ready'), 60000, 100);
  return child;
}
{
  const port = await freePort();
  const body = { tag: `F2.${feeders[25]}.CB1`, feeder: feeders[25], condition: 'CRITICAL', eventId: 'F2-EVT-0001' };
  const a = startChildApi(port, true);
  await a.ready;
  let firstAnswer;
  try { const r = await fetch(`http://127.0.0.1:${port}/api/scada/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); firstAnswer = `${r.status}`; }
  catch (err) { firstAnswer = `no reply (${err.cause?.code || err.message})`; }
  const exit = await a.exited;
  const rowsAfterCrash = await n("SELECT count(*) n FROM alarms WHERE event_key = 'id:F2-EVT-0001'");
  const queuedAfterCrash = await n("SELECT count(*) n FROM intake_queue WHERE payload->>'tag' = $1", [body.tag]);
  check('F2: the API died after committing and before replying; the event is stored once and queued once',
    // SIGKILL: on Linux the exit reports the signal; on Windows it is TerminateProcess (code 1, no signal)
    !/^2/.test(firstAnswer) && a.output.includes('committed; killing myself') && (exit.signal === 'SIGKILL' || exit.code !== 0)
      && rowsAfterCrash === 1 && queuedAfterCrash === 1,
    `(first attempt: ${firstAnswer}; child said "${a.output.includes('committed; killing myself') ? 'committed; killing myself before the reply' : '?'}", exit code=${exit.code} signal=${exit.signal}; alarm rows=${rowsAfterCrash}, queue items=${queuedAfterCrash})`);

  const b = startChildApi(port, false);
  await b.ready;
  const r2 = await fetch(`http://127.0.0.1:${port}/api/scada/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j2 = await r2.json();
  const stored = await db.one("SELECT id FROM alarms WHERE event_key = 'id:F2-EVT-0001'");
  const rowsAfterRetry = await n("SELECT count(*) n FROM alarms WHERE event_key = 'id:F2-EVT-0001'");
  const queuedAfterRetry = await n("SELECT count(*) n FROM intake_queue WHERE payload->>'tag' = $1", [body.tag]);
  check('F2: the retry answers 200 duplicate with the stored alarm id; still 1 row and 1 queue item',
    r2.status === 200 && j2.duplicate === true && j2.alarmId === stored.id && rowsAfterRetry === 1 && queuedAfterRetry === 1,
    `(${r2.status} ${JSON.stringify(j2)}; rows=${rowsAfterRetry}, queue items=${queuedAfterRetry})`);

  // Same event 20 times at once (one micro-batch and across batches): one row.
  const burst = await Promise.all(Array.from({ length: 20 }, () => fetch(`http://127.0.0.1:${port}/api/scada/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, eventId: 'F2-EVT-0002' }) })));
  const codes = burst.map((r) => r.status);
  check('F2: the same eventId 20 times at once -> 1 row, one 202 and nineteen 200 duplicate',
    (await n("SELECT count(*) n FROM alarms WHERE event_key = 'id:F2-EVT-0002'")) === 1 && codes.filter((c) => c === 202).length === 1 && codes.filter((c) => c === 200).length === 19,
    `(${JSON.stringify(codes.reduce((m, c) => ({ ...m, [c]: (m[c] || 0) + 1 }), {}))})`);

  // No sender id: tag + source timestamp + state is the key.
  const hb = { tag: `F2.${feeders[25]}.CB2`, feeder: feeders[25], condition: 'CRITICAL', sourceTs: '2026-11-03T10:00:00.000Z' };
  const h1 = await fetch(`http://127.0.0.1:${port}/api/scada/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hb) });
  const h2 = await fetch(`http://127.0.0.1:${port}/api/scada/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hb) });
  const h3 = await fetch(`http://127.0.0.1:${port}/api/scada/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...hb, sourceTs: '2026-11-03T10:05:00.000Z' }) });
  check('F2: no eventId: same tag + source timestamp + state is a duplicate, a later timestamp is a new event',
    h1.status === 202 && h2.status === 200 && h3.status === 202 && (await n('SELECT count(*) n FROM alarms WHERE tag = $1', [hb.tag])) === 2,
    `(${h1.status} ${h2.status} ${h3.status})`);
  b.kill('SIGKILL'); await b.exited;
  await db.none("DELETE FROM intake_queue WHERE payload->>'tag' LIKE 'F2.%'");
}

// ---------------------------------------------------------------- F3
// The real backend (src/index.js) reaching Postgres through a TCP proxy this
// test controls; "Postgres stopped" = the proxy cuts every connection and
// then holds new ones open without ever answering (worse than refused).
{
  const target = new URL(process.env.DATABASE_URL);
  let mode = 'forward';
  const socks = new Set();
  const proxy = net.createServer((c) => {
    socks.add(c); c.on('close', () => socks.delete(c)); c.on('error', () => {});
    if (mode !== 'forward') return; // black hole: accept, never answer
    const up = net.connect(Number(target.port || 5432), target.hostname);
    socks.add(up); up.on('close', () => socks.delete(up)); up.on('error', () => c.destroy());
    c.pipe(up); up.pipe(c);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const viaProxy = new URL(process.env.DATABASE_URL); viaProxy.host = `127.0.0.1:${proxy.address().port}`;
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: viaProxy.href, PORT: String(port), ROLE: 'all', SIMULATOR: 'off', FEEDER_TELEMETRY_SIM: 'off', NODE_ENV: 'production', KEYCLOAK_JWKS_URI: 'http://127.0.0.1:9/none' },
  });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const hb = `http://127.0.0.1:${port}/api/health`;
  const up = await waitUntil(async () => { try { return (await fetch(hb)).ok; } catch { return false; } }, 120000, 250);
  await sleep(2500); // one refresh with the database up
  const timed = async () => { const t0 = performance.now(); try { const r = await fetch(hb, { signal: AbortSignal.timeout(3000) }); const j = await r.json(); return { ms: performance.now() - t0, status: r.status, queue: j.queue }; } catch (e) { return { ms: performance.now() - t0, status: 0 }; } };
  const before = await timed();
  mode = 'blackhole';
  for (const s of [...socks]) s.destroy();
  const samples = [];
  for (let i = 0; i < 40; i++) { samples.push(await timed()); await sleep(150); }
  const okCount = samples.filter((s) => s.status === 200 && s.ms < 200).length;
  const last = samples.at(-1);
  check('F3: Postgres unreachable (connections cut, then held without answer): /api/health answers 200 in under 200 ms, 40 of 40 times',
    up && okCount === samples.length,
    `(up=${up}; before: ${Math.round(before.ms)} ms depth=${before.queue?.depth}; during: max ${Math.round(Math.max(...samples.map((s) => s.ms)))} ms, p95 ${Math.round(p95(samples.map((s) => s.ms)))} ms, ok ${okCount}/40)`);
  check('F3: ... and it says the queue figures are stale, with the error', last.queue?.stale === true && /queue unavailable/.test(last.queue?.error || ''), JSON.stringify(last.queue));
  mode = 'forward';
  const fresh = await waitUntil(async () => { const s = await timed(); return s.status === 200 && !s.queue?.stale; }, 30000, 500);
  check('F3: once Postgres answers again, health shows fresh figures', fresh);
  child.kill('SIGKILL'); await exited;
  for (const s of [...socks]) s.destroy();
  await new Promise((r) => proxy.close(r));
}

// ---------------------------------------------------------------- F5
{
  // Ordering on one tag: trip, reclose, trip queued before any worker runs.
  const of = feeders[26];
  const f5Start = new Date().toISOString();
  const tag = `F5ORD.${of}.CB1`;
  for (const ev of ['trip', 'reclose', 'trip']) {
    const r = await post('/scada/fault', { tag, feeder: of, event: ev, condition: ev === 'trip' ? 'CRITICAL' : undefined });
    if (r.status !== 202) console.log('   F5 ordering post', ev, r.status, await r.text());
  }
  // 10,000 trips on 20 feeders, unique tags, queued through the HTTP route.
  const N = 10_000;
  const t0 = Date.now();
  const codes = {};
  for (let k = 0; k < N; k += 200) { // 200 at a time: Windows refuses connects past the listen backlog
    const rs = await Promise.all(Array.from({ length: 200 }, (_, j) => post('/scada/fault', { tag: `F5.${feeders[(k + j) % 20]}.E${k + j}`, feeder: feeders[(k + j) % 20], condition: 'CRITICAL', eventId: `F5-${k + j}` })));
    for (const r of rs) codes[r.status] = (codes[r.status] || 0) + 1;
  }
  const enqueueMs = Date.now() - t0;
  const depth = (await queueStats()).depth;
  check('F5: 10,000 trips accepted through POST /scada/fault (micro-batched enqueue)', codes[202] === N && depth >= N, `(${JSON.stringify(codes)}, queue depth ${depth}, ${enqueueMs} ms = ${Math.round(N / (enqueueMs / 1000))}/s)`);

  const before = consumerStats();
  const w0 = Date.now();
  const worker = startIntakeWorker({ pollMs: 20 });
  const drained = await waitUntil(async () => (await queueStats()).depth === 0, 300000, 200);
  const drainMs = Date.now() - w0;
  const after = consumerStats();
  check('F5: the backlog is processed by feeder groups', drained && after.groups > before.groups,
    `(drained=${drained} in ${drainMs} ms = ${Math.round((N + 3) / (drainMs / 1000))} items/s; ${after.groups - before.groups} group transactions holding ${after.groupedItems - before.groupedItems} items)`);
  const linked = await n("SELECT count(*) n FROM alarms WHERE tag LIKE 'F5.%' AND incident_id IS NOT NULL");
  const rows = await n("SELECT count(*) n FROM alarms WHERE tag LIKE 'F5.%'");
  const perEvent = await db.one(`SELECT count(*)::int tags, count(*) FILTER (WHERE c = 1)::int once, max(c)::int mx FROM (
      SELECT a.tag, (SELECT count(*) FROM incident_events e WHERE e.incident_id = a.incident_id AND e.note ~ ('on ' || replace(a.tag, '.', '\\.') || '( |$)')) c
      FROM alarms a WHERE a.tag LIKE 'F5.%') x`);
  check('F5: exactly once: 10,000 alarm rows, all linked, each event on its incident timeline exactly once',
    rows === N && linked === N && perEvent.tags === N && perEvent.once === N && perEvent.mx === 1,
    `(rows=${rows}, linked=${linked}, exactly once=${perEvent.once}, max=${perEvent.mx})`);
  const incs = await db.any(`SELECT feeder, count(*)::int c FROM incidents WHERE status NOT IN ('resolved','closed','cancelled') AND feeder IN ($1:csv) AND source='SCADA' GROUP BY 1`, [feeders.slice(0, 20)]);
  check('F5: one active incident per feeder (20 feeders)', incs.length === 20 && incs.every((r) => r.c === 1), `(${incs.length} feeders, counts ${[...new Set(incs.map((r) => r.c))].join(',')})`);
  const ord = await db.any("SELECT id, status, open_trip_tags FROM incidents WHERE feeder = $1 AND source = 'SCADA' AND opened_at >= $2 ORDER BY opened_at", [of, f5Start]);
  check('F5: trip, reclose, trip on one tag stays ordered: the first incident is restored by the reclose, the second trip opens a new one',
    ord.length === 2 && ['resolved', 'closed'].includes(ord[0].status) && ord[1].status === 'open' && JSON.stringify(ord[1].open_trip_tags) === JSON.stringify([tag]),
    JSON.stringify(ord.map((o) => [o.status, o.open_trip_tags])));
  await worker.stop();
}

// ---------------------------------------------------------------- F6
{
  const N = 20_000;
  await db.none("UPDATE incidents SET status='closed' WHERE feeder IN ($1:csv)", [feeders]);
  for (let k = 0; k < N; k += 200) { // 200 at a time: Windows refuses connects past the listen backlog
    await Promise.all(Array.from({ length: 200 }, (_, j) => post('/scada/fault', { tag: `F6.${feeders[(k + j) % 20]}.E${k + j}`, feeder: feeders[(k + j) % 20], condition: 'CRITICAL' })));
  }
  const worker = startIntakeWorker({ pollMs: 20 });
  await sleep(500);
  const d = distTx.find((x) => x.feeder === feeders[28] && typeof x.lat === 'number') || distTx.find((x) => typeof x.lat === 'number');
  const depthBefore = (await queueStats()).depth;
  const c0 = Date.now();
  const r = await submitComplaint({ externalId: 'F6-C1', customer: 'F6', phone: '9800000016', category: 'No Supply', lat: d.lat, lon: d.lon }, { username: 'loadfix-test', roles: ['call_centre_attendant'] });
  const complaintMs = Date.now() - c0;
  const depthAfter = (await queueStats()).depth;
  check('F6: a complaint is processed in under 2 s while a SCADA backlog is being worked off',
    r.status === 201 && complaintMs < 2000 && depthAfter > 1000,
    `(${r.status} in ${complaintMs} ms; SCADA backlog ${depthBefore} -> ${depthAfter})`);
  // Only reads that finish while a backlog is still there count (since the
  // feeder-group claim of 4 Nov the 20,000 items can drain before 40 reads).
  const reads = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await fetch(base + '/incidents'); await fetch(base + '/indicators');
    const ms = performance.now() - t;
    if ((await queueStats()).depth === 0) break;
    reads.push(ms);
    await sleep(50);
  }
  check('F6: dashboard reads (GET /incidents + /indicators) during the drain: p95 under 1 s (at least 10 reads under backlog)',
    reads.length >= 10 && p95(reads) < 1000, `(${reads.length} reads under backlog, p95 ${Math.round(p95(reads))} ms, max ${Math.round(Math.max(0, ...reads))} ms)`);
  await waitUntil(async () => (await queueStats()).depth === 0, 300000, 500);
  await worker.stop();
}

stopHealthRefresher();
server.closeAllConnections();
await new Promise((r) => server.close(r));
await closeListener();
console.log(`\n  ${passes}/${passes + fails} passed`);
await db.$pool.end();
process.exit(fails ? 1 : 0);
