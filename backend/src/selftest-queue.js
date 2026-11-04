// Durable intake queue self-test (runbook v2, WP2 gates G6-G8). Needs a
// scratch PostGIS database (pgcrypto available); it reseeds it:
//   DATABASE_URL=<scratch db> node src/selftest-queue.js
//   G6  kill the worker during a burst of 5,000 queued items; after a restart
//       every item is processed exactly once: no loss, no duplicates
//   G7  a poison message goes to dead-letter after N tries and never blocks the queue
//   G8  queue depth is visible on /api/health
import express from 'express';
import { spawn } from 'node:child_process';

if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-queue: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
process.env.INTAKE_RETRY_BASE_MS = process.env.INTAKE_RETRY_BASE_MS || '20';

const { db, migrate } = await import('./infra/db.js');
const { seed } = await import('./infra/seed.js');
const { initBus } = await import('./domain/bus.js');
const { repo } = await import('./infra/repo.js');
const { distTx, resolve: resolveAsset } = await import('./infra/geo.js');
const { enqueue, queueStats, closeListener } = await import('./infra/intakeQueue.js');
const { startIntakeWorker, enqueueScadaEvent } = await import('./realtime/intakeWorker.js');
const { healthHandler, refreshHealth, stopHealthRefresher } = await import('./routes/health.js');
const { api } = await import('./routes/api.js');

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = async (sql, params) => (await db.one(sql, params)).n;
async function waitUntil(fn, timeoutMs, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return true; await sleep(everyMs); }
  return false;
}

// migrate() alone sets up everything intake needs: no manual db/migrations here.
await migrate();
await seed({ force: true });
await initBus();
await db.none('DELETE FROM intake_queue; DELETE FROM intake_dead_letter;'); // scratch database only

// A worker in its own process, so it can be killed like kill -9.
const WORKER_ENV = { QUEUE_LEASE_MS: '3000', QUEUE_CONCURRENCY: '4', QUEUE_POLL_MS: '50', QUEUE_BACKOFF_BASE_MS: '200' };
function startChildWorker() {
  const code = `
    const { startIntakeWorker } = await import(${JSON.stringify(new URL('./realtime/intakeWorker.js', import.meta.url).href)});
    startIntakeWorker();
    console.log('child worker ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ...WORKER_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return child;
}

// Feeders with no live planned outage, for the complaints.
const dts = [];
for (const d of distTx) {
  if (!d.feeder || dts.some((x) => x.feeder === d.feeder)) continue;
  const at = resolveAsset(d.lat, d.lon);
  if (at.feeder !== d.feeder || (await repo.plannedOutagesForComplaint(at.substation)).length) continue;
  dts.push(d);
  if (dts.length === 5) break;
}
await db.none("UPDATE incidents SET status='closed' WHERE feeder IN ($1:csv)", [dts.map((d) => d.feeder)]);
// 25 other real network feeders for the SCADA events (canonical feeder codes, G9).
const scadaFeeders = [...new Set(distTx.map((d) => d.feeder).filter(Boolean))].filter((f) => !dts.some((d) => d.feeder === f)).slice(0, 25);
// Nothing seeded stays open: an unknown-feeder seeded incident at one of these
// substations would (rightly, D2) absorb the test's events. Scratch DB only.
await db.none("UPDATE incidents SET status='closed' WHERE status NOT IN ('resolved','closed','cancelled')");

try {
  // ---- migration ----
  let again = null;
  try { await migrate(); } catch (e) { again = e.message; }
  check('migration: intake_queue and intake_dead_letter exist; migrate() again is a no-op',
    again === null && (await db.one("SELECT to_regclass('intake_queue') IS NOT NULL AND to_regclass('intake_dead_letter') IS NOT NULL AS ok")).ok, again || '');

  // ---- G6: kill the worker during a burst of 5,000 queued items ----
  {
    const N_SCADA = 2500, N_COMPLAINT = 2500, FEEDERS = 25;
    const qids = (await db.any('SELECT nextval(\'complaint_qid_seq\') n FROM generate_series(1, $1)', [N_COMPLAINT]))
      .map((r) => 'QRY-2026-' + String(r.n).padStart(6, '0'));
    const who = { username: 'queue-test', roles: ['system_admin'] };
    const rows = [];
    for (let i = 0; i < N_SCADA; i++) {
      const f = i % FEEDERS;
      const tag = `G6.F${f}.E${i}`;
      rows.push({ kind: 'scada', order_key: `tag:${tag}`,
        payload: JSON.stringify({ tag, condition: 'CRITICAL', limit_val: 'TRIP', feeder: scadaFeeders[f], customers: 100 }) });
    }
    for (let i = 0; i < N_COMPLAINT; i++) {
      const d = dts[i % dts.length];
      rows.push({ kind: 'complaint', order_key: null, payload: JSON.stringify({ qid: qids[i], ts: new Date().toISOString(), who,
        body: { externalId: `G6-${i}`, customer: `G6 ${i}`, phone: '9811000000', category: 'No Supply', lat: d.lat, lon: d.lon } }) });
    }
    rows.sort(() => Math.random() - 0.5); // SCADA and complaints interleaved
    const pgp = db.$config.pgp;
    const cs = new pgp.helpers.ColumnSet(['kind', { name: 'payload', cast: 'jsonb' }, 'order_key'], { table: 'intake_queue' });
    for (let i = 0; i < rows.length; i += 1000) await db.none(pgp.helpers.insert(rows.slice(i, i + 1000), cs));
    const queued = (await queueStats()).depth;
    check('G6: 5,000 items queued', queued === 5000, `(depth=${queued})`);

    const t0 = Date.now();
    const w1 = startChildWorker();
    await waitUntil(async () => (await queueStats()).depth <= 4000, 120000, 50);
    w1.kill('SIGKILL'); // TerminateProcess on Windows: no cleanup, like kill -9
    const ex = await w1.exited;
    const atKill = await db.one('SELECT count(*)::int depth, count(*) FILTER (WHERE attempts > 0 AND available_at > now())::int leased FROM intake_queue');
    check('G6: worker killed mid-burst with items in flight', ex.signal === 'SIGKILL' && atKill.depth > 0 && atKill.depth < 5000 && atKill.leased > 0,
      `(left=${atKill.depth}, in flight when killed=${atKill.leased}, ${Date.now() - t0} ms in)`);

    const w2 = startChildWorker();
    const drained = await waitUntil(async () => (await queueStats()).depth === 0, 300000, 250);
    w2.kill('SIGKILL'); await w2.exited;
    const stats = await queueStats();
    check('G6: after the restart the queue drains completely', drained && stats.depth === 0 && stats.deadLetter === 0,
      `(depth=${stats.depth}, dead letter=${stats.deadLetter}, total ${Date.now() - t0} ms)`);
    if (!drained || stats.deadLetter) console.log(w2.output.split('\n').slice(-15).join('\n'));

    // complaints: one row each, and exactly one timeline entry each
    const c = await db.one("SELECT count(*)::int n, count(DISTINCT external_id)::int ext FROM complaints WHERE external_id LIKE 'G6-%'");
    const perQid = await db.one(`
      SELECT count(*)::int qids, count(*) FILTER (WHERE n = 1)::int once, COALESCE(max(n), 0)::int maxn FROM (
        SELECT substring(e.note from 'omplaint (QRY-[0-9]+-[0-9]+)') qid, count(*) n FROM incident_events e
        WHERE e.kind IN ('created', 'complaint') AND e.note ~ 'omplaint QRY-' GROUP BY 1) x
      WHERE qid = ANY($1)`, [qids]);
    check('G6: complaints: 2,500 stored, none lost, none duplicated', c.n === N_COMPLAINT && c.ext === N_COMPLAINT, `(rows=${c.n}, distinct=${c.ext})`);
    check('G6: complaints: each written to a timeline exactly once', perQid.qids === N_COMPLAINT && perQid.once === N_COMPLAINT,
      `(with an entry=${perQid.qids}, exactly once=${perQid.once}, max=${perQid.maxn})`);
    const cust = await db.any(`SELECT i.id, i.customers, (SELECT count(*) FROM complaints c WHERE c.incident_id = i.id)::int n
      FROM incidents i WHERE i.feeder IN ($1:csv) AND i.status = 'open'`, [dts.map((d) => d.feeder)]);
    check('G6: complaints: one incident per feeder, customers = complaints linked',
      cust.length === dts.length && cust.every((r) => r.customers === r.n) && cust.reduce((s, r) => s + r.n, 0) === N_COMPLAINT,
      `(${cust.map((r) => `${r.customers}/${r.n}`).join(' ')})`);

    // SCADA: exactly one timeline entry per event, one incident per feeder
    const perTag = await db.one(`
      SELECT count(*)::int tags, count(*) FILTER (WHERE n = 1)::int once, COALESCE(max(n), 0)::int maxn FROM (
        SELECT substring(note from 'SCADA [A-Z]+ on (G6\\.F[0-9]+\\.E[0-9]+)') tag, count(*) n FROM incident_events
        WHERE kind IN ('created', 'field') AND note ~ 'SCADA [A-Z]+ on G6\\.F' GROUP BY 1) x`);
    const scadaIncs = await count("SELECT count(*)::int n FROM incidents WHERE status='open' AND feeder IN ($1:csv)", [scadaFeeders]);
    check('G6: SCADA: all 2,500 events processed exactly once', perTag.tags === N_SCADA && perTag.once === N_SCADA,
      `(events seen=${perTag.tags}, exactly once=${perTag.once}, max=${perTag.maxn})`);
    check('G6: SCADA: exactly one incident per feeder (25)', scadaIncs === FEEDERS, `(${scadaIncs})`);
  }

  // ---- G7: a poison message is dead-lettered after N tries, never blocks the queue ----
  {
    process.env.QUEUE_MAX_ATTEMPTS = '3';
    const worker = startIntakeWorker({ pollMs: 20, maxAttempts: 3, backoffBaseMs: 300, concurrency: 2 });
    // customers 1e20 does not fit incidents.customers (integer): a real database error, every time
    const poisonId = await enqueueScadaEvent({ tag: 'G7.POISON.CB1', condition: 'CRITICAL', feeder: 'G7-POISON', substation: 'G7 SUB', customers: 1e20 });
    const unknownId = await enqueue('no-such-kind', { x: 1 });
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await enqueueScadaEvent({ tag: `G7.OK.${i}`, condition: 'CRITICAL', feeder: `G7-OK-${i % 5}`, substation: 'G7 OK SUB', customers: 10 });
    const goodDone = await waitUntil(async () => (await count("SELECT count(*)::int n FROM incident_events WHERE note ~ 'on G7\\.OK\\.'")) === 50, 30000, 50);
    const goodMs = Date.now() - t0;
    const poisonStillQueued = await db.oneOrNone('SELECT attempts FROM intake_queue WHERE id = $1', [poisonId]);
    check('G7: 50 good items processed while the poison item was still retrying (not blocked)', goodDone && !!poisonStillQueued,
      `(${goodMs} ms; poison attempts so far=${poisonStillQueued?.attempts})`);
    await waitUntil(async () => (await count('SELECT count(*)::int n FROM intake_dead_letter WHERE id IN ($1, $2)', [poisonId, unknownId])) === 2, 30000);
    const dl = await db.any('SELECT id, kind, attempts, last_error FROM intake_dead_letter WHERE id IN ($1, $2) ORDER BY id', [poisonId, unknownId]);
    const p = dl.find((r) => Number(r.id) === poisonId), u = dl.find((r) => Number(r.id) === unknownId);
    check('G7: the poison item is in dead letter after exactly 3 tries, with its error', p?.attempts === 3 && /out of range/i.test(p?.last_error || ''),
      `(attempts=${p?.attempts}, error=${p?.last_error})`);
    check('G7: an item of an unknown kind is dead-lettered too', u?.attempts === 3 && /no handler/.test(u?.last_error || ''), `(${u?.last_error})`);
    check('G7: neither is left in the queue; no incident from the poison', (await queueStats()).depth === 0
      && (await count("SELECT count(*)::int n FROM incidents WHERE feeder='G7-POISON'")) === 0);

    // ordering by tag: a reclose queued right behind its trip waits for it
    await enqueueScadaEvent({ tag: 'G7.ORDER.CB1', condition: 'CRITICAL', limit_val: 'TRIP', feeder: 'G7-ORDER', substation: 'G7 ORDER SUB', customers: 10 });
    await enqueueScadaEvent({ tag: 'G7.ORDER.CB1', event: 'reclose', condition: 'NORMAL', limit_val: 'CLOSED' });
    await waitUntil(async () => (await queueStats()).depth === 0, 10000, 50);
    const ord = await db.oneOrNone("SELECT status, momentary FROM incidents WHERE feeder='G7-ORDER'");
    check('ordering: a trip and its reclose (same tag) are processed in order -> momentary close', ord?.status === 'closed' && ord?.momentary === true, `(${ord?.status})`);
    await worker.stop();
    delete process.env.QUEUE_MAX_ATTEMPTS;
  }

  // ---- enqueue-time coalescing (throughput under a storm) ----
  {
    const feeder = scadaFeeders[24];
    const alarm = async (id, tag, extra = {}) => {
      const evt = { id, tag, condition: 'CRITICAL', limit_val: 'TRIP', feeder, customers: 5, ...extra };
      await repo.createAlarm({ id, tag, condition: evt.condition, limit_val: evt.limit_val, priority: 1, message: 'coalesce test', ts: new Date().toISOString(), ack: 0 });
      return enqueueScadaEvent(evt);
    };
    const a = await alarm('ALM-CO-1', 'CO.CB1'), b = await alarm('ALM-CO-2', 'CO.CB1'), c = await alarm('ALM-CO-3', 'CO.CB1');
    const row = await db.oneOrNone("SELECT count(*) OVER () n, coalesced, payload FROM intake_queue WHERE order_key = 'tag:CO.CB1'");
    check('coalescing: 3 identical trips on one tag while unclaimed -> 1 queued item, 2 coalesced, earlier alarm ids kept',
      a === b && b === c && Number(row?.n) === 1 && row.coalesced === 2 && row.payload.id === 'ALM-CO-3'
      && JSON.stringify(row.payload.coalesced_ids) === '["ALM-CO-1","ALM-CO-2"]', `(items=${row?.n}, coalesced=${row?.coalesced})`);

    // trip -> reclose -> trip must stay three items in that order (the last trip is not lost)
    await enqueueScadaEvent({ tag: 'CO.CB2', condition: 'CRITICAL', limit_val: 'TRIP', feeder, customers: 5 });
    await enqueueScadaEvent({ tag: 'CO.CB2', event: 'reclose', condition: 'NORMAL', limit_val: 'CLOSED' });
    await enqueueScadaEvent({ tag: 'CO.CB2', condition: 'CRITICAL', limit_val: 'TRIP', feeder, customers: 5 });
    await enqueueScadaEvent({ tag: 'CO.CB2', condition: 'MAJOR', limit_val: 'TRIP', feeder, customers: 5 });
    const seq = await db.any("SELECT payload->>'event' ev, payload->>'condition' cond, coalesced FROM intake_queue WHERE order_key = 'tag:CO.CB2' ORDER BY id");
    check('coalescing: only the newest item of a tag absorbs, and only the same state (trip, reclose, trip, MAJOR trip -> 4 items)',
      seq.length === 4 && seq[1].ev === 'reclose' && seq.every((s) => s.coalesced === 0), JSON.stringify(seq.map((s) => s.ev || s.cond)));

    const worker = startIntakeWorker({ pollMs: 20 });
    await waitUntil(async () => (await queueStats()).depth === 0, 15000, 50);
    await worker.stop();
    const linked = await db.any("SELECT id, incident_id FROM alarms WHERE id LIKE 'ALM-CO-%' ORDER BY id");
    const note = await db.oneOrNone("SELECT count(*)::int n FROM incident_events WHERE note LIKE '%on CO.CB1%'");
    check('coalescing: all 3 alarms linked to the incident; the item processed once', linked.length === 3 && linked.every((l) => l.incident_id && l.incident_id === linked[0].incident_id) && note.n === 1,
      `(${linked.map((l) => l.incident_id).join(',')}, timeline entries=${note.n})`);
    const cb2 = await db.oneOrNone("SELECT status, open_trip_tags FROM incidents WHERE open_trip_tags ? 'CO.CB2' AND status='open'");
    check('coalescing: after trip, reclose, trip the device is still tripped (incident open)', !!cb2, cb2?.status || 'no open incident holds CO.CB2');
  }

  // ---- G8: queue depth on /api/health; and a queued complaint answers 202 ----
  {
    const app = express();
    app.use(express.json());
    app.get('/api/health', healthHandler);
    app.use((req, res, next) => { req.user = { username: 'queue-test', roles: ['system_admin'] }; next(); });
    app.use('/api', api);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api`;

    for (let i = 0; i < 7; i++) await enqueueScadaEvent({ tag: `G8.T${i}`, condition: 'CRITICAL', feeder: 'G8-FDR', substation: 'G8 SUB' });
    await refreshHealth(); // F3: /api/health answers from stats refreshed every 2 s; wait for one refresh
    const h = await (await fetch(base + '/health')).json();
    check('G8: /api/health shows the queue depth (7 queued, no worker running)', h.ok === true && h.queue?.depth === 7 && typeof h.queue.oldestAgeS === 'number',
      JSON.stringify(h.queue));
    check('G8: ... and the dead-letter count', h.queue?.deadLetter === 2, `(${h.queue?.deadLetter})`);

    // with no worker, POST /complaints is accepted and queued: 202
    process.env.INTAKE_SYNC_WAIT_MS = '300';
    const d = dts[0];
    const r = await fetch(base + '/complaints', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: 'G8-Q1', customer: 'G8', phone: '9800000008', category: 'No Supply', lat: d.lat, lon: d.lon }) });
    const b = await r.json();
    check('queued complaint: 202 with its queryId while no worker runs', r.status === 202 && b.status === 'queued' && /^QRY-/.test(b.queryId), `(${r.status} ${JSON.stringify(b)})`);
    delete process.env.INTAKE_SYNC_WAIT_MS;
    const worker = startIntakeWorker({ pollMs: 20 });
    await waitUntil(async () => (await queueStats()).depth === 0, 10000, 50);
    const stored = await repo.complaint(b.queryId);
    check('... and is processed under that queryId once a worker runs', stored?.external_id === 'G8-Q1' && !!stored.incident_id, stored?.incident_id);
    await refreshHealth(); await refreshHealth(); // the second read starts after the drain
    const h2 = await (await fetch(base + '/health')).json();
    check('G8: depth back to 0 after the worker drained it', h2.queue?.depth === 0, JSON.stringify(h2.queue));
    await worker.stop();
    stopHealthRefresher();
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }

  // Feeder-group claim, worst case (4 Nov 2026): 257 feeders, every event on
  // its own tag, plus tags that carry an ordered trip/reclose/trip sequence.
  // A recording handler stands in for SCADA so the test measures only the claim.
  {
    await db.none('DELETE FROM intake_queue');
    const FEEDERS = 257, PER = 8, ORDERED = 20;
    const fdr = (i) => `GQ-F${String(i).padStart(3, '0')}`;
    const seen = new Map(); const order = new Map(); const groupSizes = [];
    const record = (p) => {
      seen.set(p.tag, (seen.get(p.tag) || 0) + 1);
      if (p.seq) { if (!order.has(p.tag)) order.set(p.tag, []); order.get(p.tag).push(p.seq); }
    };
    let total = 0;
    for (let k = 0; k < FEEDERS * PER; k += 200) {
      await Promise.all(Array.from({ length: Math.min(200, FEEDERS * PER - k) }, (_, j) => {
        const i = k + j, tag = `GQ.${fdr(i % FEEDERS)}.E${i}`;
        return enqueue('gqtest', { tag, feeder: fdr(i % FEEDERS) }, { orderKey: `tag:${tag}` });
      }));
      total += Math.min(200, FEEDERS * PER - k);
    }
    for (let s = 1; s <= 3; s++) { // seq 1, 2, 3 on each ordered tag, interleaved across tags
      for (let o = 0; o < ORDERED; o++) {
        const tag = `GQ.${fdr(o * 13 % FEEDERS)}.ORD${o}`;
        await enqueue('gqtest', { tag, feeder: fdr(o * 13 % FEEDERS), seq: s }, { orderKey: `tag:${tag}` });
        total++;
      }
    }
    const { startIntakeConsumer } = await import('./infra/intakeQueue.js');
    const consumer = startIntakeConsumer(
      { gqtest: async (p) => { record(p); return { effects: [] }; } },
      { batchMax: 200, pollMs: 20, batchHandlers: { gqtest: {
        canBatch: () => true, groupKey: (p) => p.feeder,
        run: async (ps) => { groupSizes.push(ps.length); ps.forEach(record); return { effects: [] }; } } } });
    const t0 = Date.now();
    const drained = await waitUntil(async () => (await queueStats()).depth === 0, 120000, 50);
    const ms = Date.now() - t0;
    await consumer.stop();
    const counts = [...seen.values()];
    const grouped = groupSizes.reduce((a, b) => a + b, 0);
    check(`feeder-group claim: ${total} items on ${FEEDERS} feeders (every event its own tag) drained, each processed exactly once`,
      drained && seen.size === FEEDERS * PER + ORDERED && counts.every((c) => c === 1 || c === 3) && counts.reduce((a, b) => a + b, 0) === total,
      `(drained=${drained} in ${ms} ms, ${seen.size} tags, ${counts.reduce((a, b) => a + b, 0)} runs)`);
    const ordOk = [...order.values()].length === ORDERED && [...order.values()].every((v) => v.join() === '1,2,3');
    check('feeder-group claim: trip/reclose/trip order kept on all 20 ordered tags', ordOk,
      `(${[...order.entries()].filter(([, v]) => v.join() !== '1,2,3').map(([t, v]) => `${t}:${v}`).join(' ') || 'all 1,2,3'})`);
    const avg = groupSizes.length ? grouped / groupSizes.length : 0;
    check('feeder-group claim: claims of 200 bring whole feeder groups (>= 90% of items in groups, average group >= 4)',
      grouped >= 0.9 * total && avg >= 4,
      `(${(100 * grouped / total).toFixed(1)}% in ${groupSizes.length} groups, average ${avg.toFixed(2)}, largest ${Math.max(0, ...groupSizes)})`);
  }
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
}
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
await closeListener();
await db.$pool.end().catch(() => {});
process.exit(fails ? 1 : 0);
