// Worst-case SCADA intake bench: events spread evenly over many feeders, every
// event on its own tag, so feeder grouping in the queue consumer has the least
// to work with. Scratch databases only; no .env is read.
//
//   cd backend
//   DATABASE_URL=postgres://.../oms_scratch_x node scripts/loadtest/worstcase.mjs drain --feeders 257 --events 10000 --batch 500,1000,2000
//   DATABASE_URL=postgres://.../oms_scratch_y REDIS_URL=redis://... node scripts/loadtest/worstcase.mjs storm --feeders 257 --rate 1000 --seconds 60 [--port 4101] [--batch 2000]
//
// drain: queues --events through POST /scada/fault (the real router, in this
//   process, no worker running), then starts one intake worker per --batch
//   value (QUEUE_BATCH_MAX) and times the drain.
// storm: starts the real backend (src/index.js, ROLE=all) as a child process
//   on --port, sends --rate events a second for --seconds (open loop, a
//   retrying sender that resends the same eventId), and measures the time
//   from the end of the storm until intake_queue is empty.
// Both: the database must already be migrated for drain; storm migrates by
//   starting the backend. Feeders beyond the network's canonical ones are
//   added to feeder_identity as synthetic identities (source
//   'worstcase-bench'), spread over the real substations.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

const mode = process.argv[2];
const args = Object.fromEntries(process.argv.slice(3).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!['drain', 'storm'].includes(mode)) { console.error('usage: worstcase.mjs drain|storm [--feeders N] ...'); process.exit(2); }
if (!/scratch/.test(process.env.DATABASE_URL || '')) { console.error('DATABASE_URL must name a scratch database'); process.exit(2); }
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(path.join(backend, 'src', p)).href);
const FEEDERS = Number(args.feeders || 257);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null);
const pct = (a) => { const s = Float64Array.from(a).sort(); return { n: s.length, p50: Math.round(p(s, 0.5)), p95: Math.round(p(s, 0.95)), p99: Math.round(p(s, 0.99)), max: Math.round(s[s.length - 1] ?? 0) }; };

// ---------------------------------------------------------------- shared
async function ensureFeeders(db) {
  const real = await db.any('SELECT DISTINCT feeder_code, substation FROM feeder_identity WHERE source <> $1 ORDER BY feeder_code', ['worstcase-bench']);
  const subs = [...new Set(real.map((r) => r.substation).filter(Boolean))];
  const want = Math.max(0, FEEDERS - real.length);
  if (want) {
    await db.none(`INSERT INTO feeder_identity (alias_norm, feeder_code, source, substation)
      SELECT oms_norm(code), code, 'worstcase-bench', s.subs[1 + (i % array_length(s.subs, 1))]
      FROM generate_series(1, $1) i, LATERAL (SELECT 'WC-F' || lpad(i::text, 4, '0') AS code) c, (SELECT $2::text[] AS subs) s
      ON CONFLICT (alias_norm) DO NOTHING`, [want, subs]);
  }
  const all = (await db.any('SELECT DISTINCT feeder_code AS feeder, substation FROM feeder_identity ORDER BY feeder_code')).slice(0, FEEDERS);
  const keys = await db.one('SELECT count(DISTINCT oms_feeder_key(f))::int n FROM unnest($1::text[]) f', [all.map((f) => f.feeder)]);
  console.log(`feeders: ${all.length} (network ${Math.min(real.length, FEEDERS)}, synthetic ${all.length - Math.min(real.length, FEEDERS)}), distinct canonical keys ${keys.n}, substations ${subs.length}`);
  if (all.length !== FEEDERS || keys.n !== FEEDERS) throw new Error('could not set up the feeders');
  return all;
}
const eventBody = (prefix, feeders, i) => {
  const f = feeders[i % feeders.length];
  return { tag: `${prefix}.${f.feeder}.E${i}`, feeder: f.feeder, substation: f.substation, condition: 'CRITICAL', eventId: `${prefix}-${i}` };
};
async function verify(db, prefix, expected) {
  const v = await db.one(`SELECT count(*)::int rows, count(DISTINCT tag)::int tags, count(incident_id)::int linked, count(DISTINCT incident_id)::int incidents
    FROM alarms WHERE tag LIKE $1`, [`${prefix}.%`]);
  // One pass: take the tag out of each timeline note once ("... on <tag> ..."),
  // count per (incident, tag), then join to the alarms. Same count as a per-alarm
  // regex scan, without 60k correlated subqueries.
  const once = await db.one(`WITH ev AS (
      SELECT e.incident_id, substring(e.note from ' on (\\S+)') tag, count(*)::int c
      FROM incident_events e
      WHERE e.incident_id IN (SELECT DISTINCT incident_id FROM alarms WHERE tag LIKE $1 AND incident_id IS NOT NULL)
      GROUP BY 1, 2)
    SELECT count(*) FILTER (WHERE COALESCE(ev.c, 0) = 1)::int once, max(COALESCE(ev.c, 0))::int mx
    FROM alarms a LEFT JOIN ev ON ev.incident_id = a.incident_id AND ev.tag = a.tag
    WHERE a.tag LIKE $1`, [`${prefix}.%`]);
  const perFeeder = await db.one(`SELECT count(*)::int feeders, max(n)::int max_incidents FROM (
      SELECT split_part(a.tag, '.', 2) f, count(DISTINCT a.incident_id) n FROM alarms a WHERE a.tag LIKE $1 GROUP BY 1) x`, [`${prefix}.%`]);
  return { expected, ...v, duplicateRows: v.rows - v.tags, timelineExactlyOnce: once.once, timelineMax: once.mx, feedersWithEvents: perFeeder.feeders, maxIncidentsPerFeeder: perFeeder.max_incidents };
}

// ---------------------------------------------------------------- drain
async function drain() {
  const express = (await import('express')).default;
  const { db } = await imp('infra/db.js');
  const { initBus } = await imp('domain/bus.js');
  const { queueStats, consumerStats, closeListener } = await imp('infra/intakeQueue.js');
  const { startIntakeWorker } = await imp('realtime/intakeWorker.js');
  const { api } = await imp('routes/api.js');
  const { stopHealthRefresher } = await imp('routes/health.js');
  await initBus();
  await db.none('DELETE FROM intake_queue');
  const feeders = await ensureFeeders(db);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { username: 'worstcase-bench', roles: ['system_admin'] }; next(); });
  app.use('/api', api);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const N = Number(args.events || 10000);
  const out = [];
  for (const batch of String(args.batch || '200').split(',').map(Number)) {
    await db.none("UPDATE incidents SET status='closed' WHERE status NOT IN ('resolved','closed','cancelled')");
    const prefix = `WCD${batch}x${Date.now().toString(36).slice(-4)}`;
    const t0 = Date.now(); const codes = {};
    for (let k = 0; k < N; k += 200) { // 200 at a time: Windows refuses connects past the listen backlog
      const rs = await Promise.all(Array.from({ length: Math.min(200, N - k) }, (_, j) => fetch(base + '/scada/fault', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(eventBody(prefix, feeders, k + j)) })));
      for (const r of rs) codes[r.status] = (codes[r.status] || 0) + 1;
    }
    const enqueueMs = Date.now() - t0;
    const depth0 = (await queueStats()).depth;
    process.env.QUEUE_BATCH_MAX = String(batch);
    const before = consumerStats();
    const w0 = Date.now();
    const worker = startIntakeWorker();
    while ((await queueStats()).depth > 0 && Date.now() - w0 < 900000) await sleep(100);
    const drainMs = Date.now() - w0;
    await worker.stop();
    const after = consumerStats();
    const grouped = after.groupedItems - before.groupedItems, groups = after.groups - before.groups;
    const r = { batch, feeders: FEEDERS, events: N, enqueue: { ms: enqueueMs, statuses: codes }, drainMs, itemsPerS: Math.round(depth0 / (drainMs / 1000)),
      inGroupsPct: +((100 * grouped) / depth0).toFixed(1), groupTx: groups, avgGroup: groups ? +(grouped / groups).toFixed(2) : 0, verify: await verify(db, prefix, N) };
    console.log('RESULT ' + JSON.stringify(r));
    out.push(r);
  }
  stopHealthRefresher();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await closeListener();
  await db.$pool.end();
  return out;
}

// ---------------------------------------------------------------- storm
async function storm() {
  const jwt = (await import('jsonwebtoken')).default;
  const { db, workerDb } = await imp('infra/db.js');
  const PORT = Number(args.port || 4101), RATE = Number(args.rate || 1000), SECONDS = Number(args.seconds || 60);
  // A local JWKS so the backend's real requireAuth accepts our token.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'wc-' + randomUUID().slice(0, 8);
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const idp = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  const token = jwt.sign({ preferred_username: 'worstcase.storm', realm_access: { roles: ['scada_operator'] } }, privateKey.export({ format: 'pem', type: 'pkcs8' }), { algorithm: 'RS256', keyid: kid, expiresIn: '2h' });

  const env = { ...process.env, PORT: String(PORT), ROLE: 'all', SIMULATOR: 'off', FEEDER_TELEMETRY_SIM: 'off', EVENT_BUS_DRIVER: 'memory', NODE_ENV: 'production',
    KEYCLOAK_JWKS_URI: `http://127.0.0.1:${idp.address().port}/certs`, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'worstcase-placeholder-key',
    ...(args.batch ? { QUEUE_BATCH_MAX: String(args.batch) } : {}) };
  const child = spawn(process.execPath, ['src/index.js'], { cwd: backend, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
  const request = (method, p2, body, timeoutMs = 30000) => new Promise((resolve) => {
    const t0 = performance.now();
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ agent, method, host: '127.0.0.1', port: PORT, path: p2, timeout: timeoutMs,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t0 }));
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, error: e.code || e.message }));
    if (payload) req.write(payload); req.end();
  });
  try {
    let up = false;
    for (let i = 0; i < 480 && !up; i++) { const r = await request('GET', '/api/health/ready'); up = r.status === 200; if (!up) await sleep(500); }
    if (!up) throw new Error('backend did not become ready:\n' + log.slice(-2000));
    const feeders = await ensureFeeders(db);
    await db.none("UPDATE incidents SET status='closed' WHERE status NOT IN ('resolved','closed','cancelled')");
    const prefix = `WCS${Date.now().toString(36).slice(-5)}`;
    const total = RATE * SECONDS;
    const lat = [], statuses = {}, results = [];
    // queue depth, polled from Postgres every 250 ms
    const depth = []; let polling = true;
    const tStart = performance.now();
    const poller = (async () => { while (polling) { const t = (performance.now() - tStart) / 1000; try { const { n } = await workerDb().one('SELECT count(*)::int n FROM intake_queue'); depth.push({ t, n }); } catch { /* next */ } await sleep(250); } })();
    const send = async (body) => {
      const first = performance.now(); let attempt = 0, r;
      for (;;) {
        attempt++;
        r = await request('POST', '/api/scada/fault', body);
        const k = r.status === 0 ? `ERR:${r.error}` : String(r.status);
        statuses[k] = (statuses[k] || 0) + 1;
        if (r.status) lat.push(r.ms);
        if (!(r.status === 0 || r.status >= 500 || r.status === 429) || performance.now() - first > 60000) break;
        await sleep(Math.min(250 * 2 ** (attempt - 1), 5000));
      }
      return { ok: r.status >= 200 && r.status < 300, attempts: attempt };
    };
    let issued = 0; const pending = new Set();
    while (issued < total) {
      const due = Math.min(total, Math.floor(((performance.now() - tStart) / 1000) * RATE));
      while (issued < due) { const pr = send(eventBody(prefix, feeders, issued)).then((r) => { results.push(r); pending.delete(pr); }); pending.add(pr); issued++; }
      await sleep(2);
    }
    const stormEnd = (performance.now() - tStart) / 1000;
    const depthAtEnd = depth.at(-1)?.n;
    await Promise.all(pending);
    const lastReply = (performance.now() - tStart) / 1000;
    let emptyAt = null;
    while ((performance.now() - tStart) / 1000 < stormEnd + 900) {
      const { n } = await workerDb().one('SELECT count(*)::int n FROM intake_queue');
      if (n === 0) { emptyAt = (performance.now() - tStart) / 1000; break; }
      await sleep(250);
    }
    polling = false; await poller;
    const v = await verify(db, prefix, results.filter((r) => r.ok).length);
    const peak = depth.reduce((m, d) => Math.max(m, d.n), 0);
    const r = {
      feeders: FEEDERS, rate: RATE, seconds: SECONDS, batch: env.QUEUE_BATCH_MAX || '(default)',
      sent: total, acked: results.filter((x) => x.ok).length, retried: results.filter((x) => x.attempts > 1).length, statuses,
      sendWindowS: +stormEnd.toFixed(1), achievedRate: Math.round(total / stormEnd), enqueueLatencyMs: pct(lat),
      queueDepthAtStormEnd: depthAtEnd, peakDepth: peak, lastReplyAfterStormS: +(lastReply - stormEnd).toFixed(1),
      emptyAfterStormS: emptyAt === null ? null : +(emptyAt - stormEnd).toFixed(1), gate120s: emptyAt !== null && emptyAt - stormEnd <= 120,
      processedPerSOverall: emptyAt ? Math.round(total / emptyAt) : null,
      depthEvery10s: depth.filter((d, i, a) => i === 0 || Math.floor(d.t / 10) !== Math.floor(a[i - 1].t / 10)).map((d) => `${Math.round(d.t)}s:${d.n}`).join(' '),
      verify: v, backendLogErrors: (log.match(/\[(unhandled route error|queue\][^\n]*failed|fatal)/g) || []).length,
    };
    console.log('RESULT ' + JSON.stringify(r));
    return r;
  } finally {
    child.kill('SIGKILL'); await exited; idp.close(); agent.destroy();
    await db.$pool.end(); await workerDb().$pool.end();
  }
}

const result = mode === 'drain' ? await drain() : await storm();
process.exit(result ? 0 : 1);
