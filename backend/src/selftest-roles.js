// Worker split self-test (runbook v2, WP4). Starts the real backend
// (src/index.js) as separate processes on a scratch database:
//   DATABASE_URL=<scratch db> node src/selftest-roles.js
//   - ROLE=all: everything in one process, as before
//   - ROLE=api: HTTP and Socket.IO, but no background job and no queue consumer
//   - ROLE=worker: no HTTP except /api/health
//   - two workers: each background job runs in exactly one of them, and the
//     other takes over when that one dies
//   - events cross processes: an incident the worker creates reaches the
//     api's Socket.IO clients; an event published elsewhere reaches the worker
// The processes use ephemeral ports (two of them cannot share PORT=4100).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-roles: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
const { db } = await import('./infra/db.js');

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

const ALL_JOBS = ['scada-bus-intake', 'restoration', 'feeder-kpi', 'stale-location', 'scheduled-reports',
  'notifier', 'planned-notices', 'uptime', 'feeder-manager-alerts', 'escalations'];
const procs = [];
async function start(role, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ROLE: role, PORT: String(port), SIMULATOR: 'off', FEEDER_TELEMETRY_SIM: 'off',
      JOB_LOCK_RETRY_MS: '1000', QUEUE_POLL_MS: '100', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  child.base = `http://127.0.0.1:${port}`;
  child.role = role;
  procs.push(child);
  const up = await waitUntil(async () => (await fetch(child.base + '/api/health')).ok, 60000, 250);
  if (!up) console.log(`--- ${role} did not come up ---\n${child.output.slice(-3000)}`);
  return child;
}
const health = async (p) => (await fetch(p.base + '/api/health')).json();
async function stop(p) { p.kill('SIGKILL'); await p.exited; }
const jobLocks = () => db.any(`SELECT l.pid, count(*)::int n FROM pg_locks l
  WHERE l.locktype = 'advisory' AND l.classid = 41010 AND l.granted GROUP BY l.pid`);
const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// Minimal Socket.IO (EIO 4) client over HTTP long-polling: no extra dependency.
async function socketClient(base) {
  const url = (sid) => `${base}/socket.io/?EIO=4&transport=polling${sid ? `&sid=${sid}` : ''}`;
  const open = await (await fetch(url())).text();
  const sid = JSON.parse(open.slice(1)).sid;
  await fetch(url(sid), { method: 'POST', body: '40' });
  const events = [];
  let alive = true;
  (async () => {
    while (alive) {
      try {
        const body = await (await fetch(url(sid), { signal: AbortSignal.timeout(30000) })).text();
        for (const pkt of body.split('\x1e')) {
          if (pkt === '2') await fetch(url(sid), { method: 'POST', body: '3' }); // ping -> pong
          else if (pkt.startsWith('42')) events.push(JSON.parse(pkt.slice(2)));
        }
      } catch { if (alive) await sleep(200); }
    }
  })();
  return { events, close: () => { alive = false; } };
}

try {
  // ---- ROLE=all: unchanged single-process behaviour ----
  {
    const all = await start('all');
    const h = await health(all);
    check('ROLE=all: one process runs every job and the queue consumer', h.role === 'all' && same(h.jobs, ALL_JOBS) && h.intakeConsumer === true,
      `(jobs=${h.jobs?.length}, consumer=${h.intakeConsumer})`);
    check('ROLE=all: the API answers (401 without a token)', (await fetch(all.base + '/api/incidents')).status === 401);
    await stop(all);
    await waitUntil(async () => (await jobLocks()).length === 0, 10000);
  }

  // ---- ROLE=api: HTTP + Socket.IO, no background job ----
  const api = await start('api', { SIMULATOR: 'on' }); // even with the simulator switched on
  {
    const alarmsBefore = (await db.one('SELECT count(*)::int n FROM alarms')).n;
    const h = await health(api);
    check('ROLE=api: health says api, no jobs, no queue consumer', h.role === 'api' && h.jobs.length === 0 && h.intakeConsumer === false,
      `(jobs=${JSON.stringify(h.jobs)}, waiting=${JSON.stringify(h.waitingJobs)}, consumer=${h.intakeConsumer})`);
    check('ROLE=api: holds no job lock', (await jobLocks()).length === 0);
    await db.none(`INSERT INTO intake_queue (kind, payload, order_key) VALUES ('scada', $1, 'tag:ROLES.API.CB1')`,
      [JSON.stringify({ tag: 'ROLES.API.CB1', condition: 'CRITICAL', limit_val: 'TRIP', feeder: 'ROLES-FDR-1', substation: 'ROLES SUB', customers: 10 })]);
    await sleep(4000);
    const left = (await db.one("SELECT count(*)::int n FROM intake_queue WHERE order_key = 'tag:ROLES.API.CB1'")).n;
    const alarmsAfter = (await db.one('SELECT count(*)::int n FROM alarms')).n;
    check('ROLE=api: a queued item stays queued (nothing consumes it)', left === 1, `(depth=${left})`);
    check('ROLE=api: no simulator ran, though SIMULATOR is on (no new alarms in 4 s)', alarmsAfter === alarmsBefore, `(${alarmsBefore} -> ${alarmsAfter})`);
    check('ROLE=api: REST API and Socket.IO are served',
      (await fetch(api.base + '/api/incidents')).status === 401 && (await fetch(api.base + '/socket.io/?EIO=4&transport=polling')).status === 200);
  }

  // ---- ROLE=worker: health only; consumes the queue; events reach the api ----
  const sock = await socketClient(api.base);
  const w1 = await start('worker');
  {
    const h = await health(w1);
    check('ROLE=worker: health says worker, every job and the queue consumer run here',
      h.role === 'worker' && same(h.jobs, ALL_JOBS) && h.intakeConsumer === true && typeof h.queue?.depth === 'number', `(jobs=${h.jobs?.length})`);
    const codes = await Promise.all([
      fetch(w1.base + '/api/incidents').then((r) => r.status),
      fetch(w1.base + '/api/complaints', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status),
      fetch(w1.base + '/api/public/outage-status').then((r) => r.status),
      fetch(w1.base + '/api/health/deep').then((r) => r.status),
      fetch(w1.base + '/socket.io/?EIO=4&transport=polling').then((r) => r.status),
      fetch(w1.base + '/portal/').then((r) => r.status),
    ]);
    check('ROLE=worker: no HTTP except /api/health (REST, public, deep health, Socket.IO, portal all 404)', codes.every((c) => c === 404), `(${codes.join(' ')})`);
    const inc = await waitUntil(() => db.oneOrNone("SELECT id FROM incidents WHERE feeder='ROLES-FDR-1'"), 15000);
    check('ROLE=worker: consumed the item the api left queued', !!inc
      && (await db.one("SELECT count(*)::int n FROM intake_queue WHERE order_key = 'tag:ROLES.API.CB1'")).n === 0, inc?.id);
    const seen = await waitUntil(() => sock.events.find((e) => e[0] === 'oms.incident.created' && e[1]?.id === inc?.id), 10000);
    check('relay: the incident the worker created reached the api\'s Socket.IO client', !!seen, seen?.[1]?.id);

    // an event published in another process (this test, standing in for the
    // api) reaches the worker that holds the scada-bus-intake job
    const { bus, initBus, TOPICS } = await import('./domain/bus.js');
    const { enableBusRelay } = await import('./infra/busRelay.js');
    await initBus();
    await enableBusRelay();
    bus.publish(TOPICS.ALARM_RAISED, { tag: 'ROLES.RELAY.CB1', condition: 'CRITICAL', limit_val: 'TRIP', feeder: 'ROLES-FDR-2', substation: 'ROLES SUB 2', customers: 10 });
    const inc2 = await waitUntil(() => db.oneOrNone("SELECT id FROM incidents WHERE feeder='ROLES-FDR-2'"), 15000);
    check('relay: a bus event from another process reaches the worker\'s job and is processed once', !!inc2
      && (await db.one("SELECT count(*)::int n FROM incident_events WHERE note LIKE '%on ROLES.RELAY.CB1%'")).n === 1, inc2?.id);
  }

  // ---- two workers: each job exactly once; failover ----
  const w2 = await start('worker');
  {
    await sleep(2500); // a few lock retries
    const [h1, h2] = [await health(w1), await health(w2)];
    const both = h1.jobs.filter((j) => h2.jobs.includes(j));
    const locks = await jobLocks();
    check('two workers: each job runs in exactly one of them', same([...h1.jobs, ...h2.jobs], ALL_JOBS) && both.length === 0,
      `(w1=${h1.jobs.length}, w2=${h2.jobs.length}, in both=${both.length})`);
    check('two workers: one advisory lock per job, all held by one database session', locks.length === 1 && locks[0].n === ALL_JOBS.length, JSON.stringify(locks));
    check('two workers: both consume the intake queue', h1.intakeConsumer === true && h2.intakeConsumer === true);

    // both workers share a burst; nothing is processed twice
    await db.none(`INSERT INTO intake_queue (kind, payload, order_key)
      SELECT 'scada', jsonb_build_object('tag', 'ROLES.B.' || g, 'condition', 'CRITICAL', 'feeder', 'ROLES-B-' || (g % 10), 'substation', 'ROLES B SUB ' || (g % 10), 'customers', 1),
             'tag:ROLES.B.' || g FROM generate_series(1, 300) g`);
    await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue')).n === 0, 60000);
    const per = await db.one(`SELECT count(*)::int tags, max(n)::int maxn FROM (SELECT substring(note from 'on (ROLES\\.B\\.[0-9]+)') t, count(*) n
      FROM incident_events WHERE note ~ 'on ROLES\\.B\\.' GROUP BY 1) x`);
    const incs = (await db.one("SELECT count(*)::int n FROM incidents WHERE feeder LIKE 'ROLES-B-%'")).n;
    check('two workers: 300 queued events processed exactly once, 1 incident per feeder', per.tags === 300 && per.maxn === 1 && incs === 10,
      `(events=${per.tags}, max per event=${per.maxn}, incidents=${incs})`);

    const holder = h1.jobs.length ? w1 : w2, other = holder === w1 ? w2 : w1;
    await stop(holder);
    const took = await waitUntil(async () => { const h = await health(other); return same(h.jobs, ALL_JOBS) ? h : null; }, 15000, 250);
    const locks2 = await jobLocks();
    check('failover: when that worker dies the other takes over every job, still once each', !!took && locks2.length === 1 && locks2[0].n === ALL_JOBS.length,
      `(jobs=${took?.jobs?.length}, locks=${JSON.stringify(locks2)})`);
  }
  sock.close();
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
}
for (const p of procs) if (p.exitCode === null && p.signalCode === null) await stop(p);
if (fails) for (const p of procs) console.log(`--- ${p.role} output (tail) ---\n${p.output.slice(-2000)}`);
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
await db.$pool.end().catch(() => {});
process.exit(fails ? 1 : 0);
