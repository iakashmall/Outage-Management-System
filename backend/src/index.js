import 'express-async-errors'; // first: lets async route errors reach errorHandler (Express 4 drops them otherwise)
import 'dotenv/config'; // loads .env into process.env
// Log which database we use, but never the password inside the URL.
function redactUrl(raw) {
  if (!raw) return '(unset)';
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable)';
  }
}
console.log('DATABASE_URL loaded as:', redactUrl(process.env.DATABASE_URL));
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { db, ensureSchema } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { requireAuth } from './routes/auth.js';
import { errorHandler } from './routes/errors.js';
import { mountIntakeParsers } from './routes/intake.js';
import { bus, initBus, NOT_BROADCAST } from './domain/bus.js';
import { connectRedis } from './infra/redis.js';
import { startPlannedNotices } from './realtime/plannedNotices.js';
import { publicOutages } from './domain/publicStatus.js';
import { startSimulator } from './realtime/simulator.js';
import { startScadaConsumer } from './realtime/scada.js';
import { startIntakeWorker } from './realtime/intakeWorker.js';
import { healthHandler, setHealthInfo, startHealthRefresher } from './routes/health.js';
import { scadaIntakeTestHooks } from './infra/scadaIntake.js';
import { startRestorationPublisher } from './realtime/restoration.js';
import { startNotifier } from './realtime/notifier.js';
import { startScheduledReports } from './realtime/scheduledReports.js';
import { ensureRatings, startFeederKpiJobs } from './realtime/feederKpi.js';
import { startFeederTelemetrySim } from './realtime/feederTelemetrySim.js';
import { startStaleLocationMonitor } from './realtime/staleLocation.js';
import { startEscalations } from './realtime/escalation.js';
import { startFeederManagerAlerts } from './realtime/feederManagers.js';
import { deepHealth, startUptimeMonitor } from './realtime/uptime.js';
import { runExclusive, runningJobs, waitingJobs } from './infra/jobs.js';
import { enableBusRelay } from './infra/busRelay.js';

const PORT = process.env.PORT || 4000;

// Process role (runbook v2, WP4):
//   all     (default) one process does everything, exactly as before
//   api     HTTP + Socket.IO only: no background job, no queue consumer
//   worker  intake queue consumer + background jobs; HTTP serves only /api/health
// Run one api and one or more workers against the same database. Each
// background job runs in exactly one process (infra/jobs.js); events cross
// between the processes through the bus relay (infra/busRelay.js).
const ROLE = (process.env.ROLE || 'all').trim().toLowerCase();
if (!['all', 'api', 'worker'].includes(ROLE)) {
  console.error(`ROLE must be api, worker or all (got "${process.env.ROLE}")`);
  process.exit(2);
}
const RUNS_HTTP_API = ROLE !== 'worker';
const RUNS_JOBS = ROLE !== 'api';
process.env.ROLE = ROLE;
console.log(`[role] ${ROLE}`);

// Last-resort crash guards. Registered before the startup awaits below so
// they also cover migrate/seed/bus init, not just post-listen traffic.
//
// Why this exists: a single unhandled DB error on one request used to kill
// the whole process -- taking the SCADA Kafka consumer, the dashboard, and
// every other operator's session down with it, not just the one request
// that failed (see docs/P8_6_CROSS_SOURCE_CORRELATION_RESULTS.md, where a
// burst test killed the backend ~1.2s in). Staying up degraded beats
// vanishing: an OMS that drops SCADA fault detection during a storm because
// one complaint insert lost a race is worse than one that logs and limps.
//
// D1 (4 Nov 2026): that applies once the process is running. A failure BEFORE
// startup finished used to land here too and was only logged: the half-started
// process served nothing and later exited with code 0 (load test section 8.2),
// which a restart-on-failure supervisor does not restart. Until `startupDone`,
// a fatal error now exits with code 1.
let startupDone = false;
function logFatal(kind, err) {
  console.error(`[fatal] ${kind} at ${new Date().toISOString()}:`, err?.stack || err);
  if (!startupDone) {
    console.error('[fatal] startup did not finish: exiting with code 1');
    process.exit(1);
  }
}
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => logFatal('uncaughtException', err));

// A startup step that can fail for a passing reason (a lock wait over
// lock_timeout, a deadlock while another process takes traffic, the database
// restarting) is retried with a growing delay: STARTUP_RETRY_ATTEMPTS (5),
// STARTUP_RETRY_DELAY_MS (2000, doubled each time, at most 30 s). After the
// last attempt the process exits with code 1.
async function startupStep(name, fn) {
  const attempts = Math.max(1, Number(process.env.STARTUP_RETRY_ATTEMPTS) || 5);
  const base = Math.max(0, Number(process.env.STARTUP_RETRY_DELAY_MS ?? 2000));
  for (let n = 1; ; n++) {
    try { return await fn(); } catch (err) {
      if (n >= attempts) {
        console.error(`[fatal] startup step "${name}" failed ${n} time(s), last: ${err?.message || err}: exiting with code 1`);
        process.exit(1);
      }
      const wait = Math.min(30000, base * 2 ** (n - 1));
      console.warn(`[startup] step "${name}" failed (attempt ${n}/${attempts}): ${err?.message || err}; retrying in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Schema (D1): when the database already has the current schema version --
// every normal start -- this runs no DDL and no setval and takes no lock, so
// a process can start while others take traffic. Only an older schema is
// migrated, under one advisory lock with a short lock_timeout (infra/db.js).
await startupStep('schema', () => ensureSchema());
// First-run demo data, only on an empty database, one process at a time.
await startupStep('seed', async () => {
  const { n } = await db.one('SELECT count(*)::int AS n FROM incidents');
  if (n > 0) return;
  await db.task(async (t) => {
    await t.one('SELECT pg_advisory_lock(41000, 1)');
    try { await seed(); } finally { await t.one('SELECT pg_advisory_unlock(41000, 1)'); }
  });
});
await connectRedis(); // non-fatal if unreachable — see infra/redis.js
await initBus();       // memory driver by default; EVENT_BUS_DRIVER=kafka for the real broker
if (ROLE !== 'all') await enableBusRelay(); // events cross between the api and worker processes

// The simulator fakes crew GPS drift, SCADA alarms and trouble calls so a
// dev stack looks live. It must be off wherever real crews or a real SCADA
// feed are connected, or it mixes fake data into theirs.
const simulatorOn = !/^(off|false|0|no)$/i.test(process.env.SIMULATOR || '');

let intakeConsumer = null;
async function startBackgroundJobs(phase) {
  if (phase === 'boot') {
    intakeConsumer = startIntakeWorker(); // WP2: shared by every worker (SKIP LOCKED), not exclusive
    await runExclusive('scada-bus-intake', startScadaConsumer); // SCADA fault events on the bus -> intake queue
    await runExclusive('restoration', startRestorationPublisher); // Phase 2: restoration commands back to the DMS
    await runExclusive('feeder-kpi', async () => { await ensureRatings(); startFeederKpiJobs(); });
    await runExclusive('stale-location', startStaleLocationMonitor); // alert dispatch when a tracked crew's phone goes quiet
    await runExclusive('scheduled-reports', startScheduledReports);
    return;
  }
  if (simulatorOn) {
    await runExclusive('simulator', () => {
      console.log('  [simulator] running - fake crew GPS, alarms and calls (set SIMULATOR=off to disable)');
      startSimulator();
      startFeederTelemetrySim();
    });
  } else {
    console.log('  [simulator] disabled (SIMULATOR=off) - no fake crew GPS, alarms or calls');
  }
  await runExclusive('notifier', startNotifier);
  await runExclusive('planned-notices', startPlannedNotices); // OMS-01 advance notices, after the notifier is listening
  await runExclusive('uptime', startUptimeMonitor);           // P8.6g availability samples + alerts
  await runExclusive('feeder-manager-alerts', startFeederManagerAlerts); // outage / restoration SMS to the feeder's manager
  await runExclusive('escalations', startEscalations);        // FR-OMS-008 SLA escalation SMS to officers
}

setHealthInfo(() => ({
  jobs: runningJobs(),
  waitingJobs: waitingJobs(),
  intakeConsumer: !!intakeConsumer,
}));

if (RUNS_JOBS) await startBackgroundJobs('boot');

const app = express();
if (RUNS_HTTP_API) app.use(cors());
startHealthRefresher(); // F3: /api/health answers from stats refreshed in the background
// Test-only (selftest-scada-intake.js, F2): die after a SCADA batch commits and
// before its requests are answered. Ignored when NODE_ENV=production.
if (process.env.SCADA_TEST_CRASH_AFTER_COMMIT === '1' && process.env.NODE_ENV !== 'production') {
  scadaIntakeTestHooks.afterCommit = () => { console.log('[test] SCADA batch committed; killing this process before the reply'); process.kill(process.pid, 'SIGKILL'); };
}
app.get('/api/health', healthHandler); // + role, intake queue depth (WP2), jobs here (WP4)

if (!RUNS_HTTP_API) {
  // ROLE=worker: the health check and nothing else.
  app.use((req, res) => res.status(404).json({ error: 'not found (ROLE=worker serves only /api/health)' }));
  createServer(app).listen(PORT, async () => {
    console.log(`\n  OMS worker running (ROLE=worker) - Health → http://localhost:${PORT}/api/health\n`);
    startupDone = true;
    await startBackgroundJobs('listening');
  });
} else {
  mountIntakeParsers(app); // 64 KB on complaints, SCADA and calls; must come before the app-wide parser
  app.use(express.json({ limit: '12mb' })); // photo uploads need the large limit
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use('/portal', express.static(path.join(__dirname, '..', 'public')));
  // P8.6g: every dependency, for monitors (no login, no secrets). 503 when a critical one is down.
  app.get('/api/health/deep', async (req, res) => {
    const h = await deepHealth();
    res.status(h.status === 'down' ? 503 : 200).json(h);
  });
  app.get('/api/health/ready', async (req, res) => {
    try { await repo.incidents(); res.json({ status: 'ready' }); }
    catch (e) { res.status(503).json({ status: 'not ready', error: e.message }); }
  });
  // Public, no-login outage status lookup for customers.
  app.get('/api/public/outage-status', async (req, res) => {
    try {
      const { ref, zone } = req.query;
      // only active incidents, only safe public fields (domain/publicStatus.js);
      // planned outages (OMS-01) are labelled as planned, with their window
      const planned = new Map((await repo.plannedOutages()).map((p) => [p.incident_id, p]));
      const safe = publicOutages(await repo.incidents(), planned, { ref, zone });
      res.json({ count: safe.length, outages: safe });
    } catch (e) {
      res.status(500).json({ error: 'lookup failed' });
    }
  });
  app.use('/api', requireAuth, api);

  // Global safety net: JSON 503 when the database pool is exhausted, JSON 500
  // for anything else (routes/errors.js).
  app.use(errorHandler);

  const http = createServer(app);
  const io = new Server(http, { cors: { origin: '*' } });

  // Bridge every domain event straight to WebSocket subscribers.
  // The frontend and mobile app both listen on these topic names.
  // Raw SCADA analog samples are not bridged (see NOT_BROADCAST in bus.js).
  bus.onAny(({ topic, payload }) => { if (!NOT_BROADCAST.has(topic)) io.emit(topic, payload); });

  io.on('connection', (socket) => {
    socket.emit('server.hello', { ts: new Date().toISOString() });
  });

  http.listen(PORT, async () => {
    console.log(`\n  OMS backend running (ROLE=${ROLE})`);
    console.log(`  REST   → http://localhost:${PORT}/api`);
    console.log(`  WS     → ws://localhost:${PORT}`);
    console.log(`  Health → http://localhost:${PORT}/api/health\n`);
    startupDone = true;
    if (RUNS_JOBS) await startBackgroundJobs('listening');
    else console.log('  [role] api: no background jobs and no intake consumer in this process (run ROLE=worker)');
  });
}
