// WP6 burst, chaos and load harness (runbook v2, 2 Nov 2026).
//
// Each scenario gets a FRESH scratch database (created in the scratch Postgres
// container, dropped afterwards), a flushed scratch Redis, and its own backend
// process on PORT 4100 started from --backend (any worktree's backend folder).
// Traffic goes through the real HTTP routes and the real requireAuth (the
// harness serves its own JWKS and mints RS256 tokens), then every event the
// backend acknowledged is checked in the database: lost, duplicated, never
// processed, and incidents per feeder.
//
//   LOADTEST_PG_URL_BASE=postgres://oms:<pw>@127.0.0.1:25434 \
//   LOADTEST_PG_CONTAINER=oms-scratch-winc LOADTEST_REDIS_CONTAINER=oms-scratch-winc-redis \
//   LOADTEST_REDIS_URL=redis://127.0.0.1:26381 \
//   node scripts/loadtest/run.mjs --backend ../oms-burst-intake/backend --label wp2 \
//        --scenarios scada,complaints,dashboard,chaos-kill,chaos-pg,chaos-redis,soak [--scale 0.1]
//
// --scale shortens every duration (smoke runs); results record the scale used.
// Containers and databases must have "scratch" in their names (chaos restarts them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import {
  sleep, now, startFakeIdp, request, makeSender, makeRecorder, openLoop, summarize,
  backendEnvGuard, startBackend, waitHealthy, waitPortFree, killHard, isAlive, rssBytes, docker, psql, psqlScript,
  assertScratch, queueDepthFrom, writeJson,
} from './lib.mjs';

// ---------------------------------------------------------------- args / config
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(args.backend || path.join(here, '..', '..'));
const LABEL = args.label || 'run';
const SCALE = Number(args.scale || 1);
const SCENARIOS = (args.scenarios || 'scada,complaints,dashboard,chaos-kill,chaos-pg,chaos-redis,soak').split(',');
const OUT = path.resolve(args.out || path.join(os.tmpdir(), 'oms-loadtest'));
const PORT = 4100;
const BASE = `http://127.0.0.1:${PORT}`;
const FEEDERS = Number(args.feeders || 20);
const KEEP_DB = args['keep-db'] === 'true';
// --roles split: WP4. An API process (ROLE=api, PORT 4100) and a worker
// (ROLE=worker, PORT 4101, health only); chaos-kill then kills the worker.
const SPLIT = args.roles === 'split';

const PG_URL_BASE = process.env.LOADTEST_PG_URL_BASE;
const PG_CONTAINER = process.env.LOADTEST_PG_CONTAINER;
const PG_USER = process.env.LOADTEST_PG_USER || 'oms';
const REDIS_CONTAINER = process.env.LOADTEST_REDIS_CONTAINER;
const REDIS_URL = process.env.LOADTEST_REDIS_URL;
for (const [k, v] of Object.entries({ LOADTEST_PG_URL_BASE: PG_URL_BASE, LOADTEST_PG_CONTAINER: PG_CONTAINER, LOADTEST_REDIS_CONTAINER: REDIS_CONTAINER, LOADTEST_REDIS_URL: REDIS_URL })) {
  if (!v) { console.error(`set ${k}`); process.exit(2); }
}
for (const c of [PG_CONTAINER, REDIS_CONTAINER]) if (!/scratch/.test(c)) { console.error(`refusing container "${c}": name must contain "scratch"`); process.exit(2); }
backendEnvGuard(BACKEND);
fs.mkdirSync(OUT, { recursive: true });

const RUN = Date.now().toString(36).slice(-6).toUpperCase(); // tag / id prefix, unique per invocation
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

// ---------------------------------------------------------------- network fixtures
// Feeders with distribution transformers, spread across substations, so both
// the per-feeder (D2) and per-substation merge rules can be read off the result.
const NET = JSON.parse(fs.readFileSync(path.join(BACKEND, 'src', 'infra', 'network.json'), 'utf8'));
const dtsByFeeder = new Map();
for (const d of NET.distTx) if (d.feeder && typeof d.lat === 'number') {
  if (!dtsByFeeder.has(d.feeder)) dtsByFeeder.set(d.feeder, { ss: d.ss, dts: [] });
  dtsByFeeder.get(d.feeder).dts.push(d);
}
const bySs = new Map();
for (const [f, v] of dtsByFeeder) { if (!bySs.has(v.ss)) bySs.set(v.ss, []); bySs.get(v.ss).push(f); }
const feeders = [];
for (let round = 0; feeders.length < FEEDERS; round++) {
  let added = false;
  for (const list of bySs.values()) if (list[round] && feeders.length < FEEDERS) { feeders.push(list[round]); added = true; }
  if (!added) break;
}

// ---------------------------------------------------------------- item factories
const scadaItem = (run, { finiteTags = false } = {}) => (i) => {
  const feeder = feeders[i % feeders.length];
  const tag = finiteTags ? `LT${run}.${feeder}.CB${Math.floor(i / feeders.length) % 8}` : `LT${run}.${feeder}.E${i}`;
  return {
    kind: 'POST /api/scada/fault', key: `LT${run}-S${i}`, tag, feeder,
    body: { tag, feeder, event: 'trip', condition: 'CRITICAL', eventId: `LT${run}-S${i}`, external_id: `LT${run}-S${i}` },
  };
};
const complaintItem = (run, dupRate = 0) => {
  const made = [];
  return (i) => {
    let it;
    if (dupRate > 0 && made.length > 10 && Math.random() < dupRate) {
      it = { ...made[Math.floor(Math.random() * made.length)], dup: true }; // same externalId resent
    } else {
      const feeder = feeders[i % feeders.length];
      const { dts } = dtsByFeeder.get(feeder);
      const dt = dts[Math.floor(i / feeders.length) % dts.length];
      const externalId = `LT${run}-C${i}`;
      it = {
        kind: 'POST /api/complaints', key: externalId, feeder,
        body: { externalId, customer: `Load Test ${i}`, phone: `9${String(100000000 + i).slice(-9)}`, category: 'No Supply', address: `Near ${dt.name}`, lat: dt.lat, lon: dt.lon },
      };
      made.push(it);
    }
    return it;
  };
};

// ---------------------------------------------------------------- environment per scenario
const idp = await startFakeIdp();
const TOKEN = idp.mint('loadtest.gateway', ['system_admin', 'oms_operator', 'scada_operator', 'call_centre_attendant']);
const DASH_TOKEN = idp.mint('loadtest.dashboard', ['oms_operator']);

function backendEnv(dbname, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^LOADTEST_/.test(k)) delete env[k];
  return {
    ...env,
    DATABASE_URL: `${PG_URL_BASE}/${dbname}`, PORT: String(PORT), REDIS_URL,
    KEYCLOAK_JWKS_URI: idp.jwksUri, SIMULATOR: 'off', EVENT_BUS_DRIVER: 'memory',
    ENCRYPTION_KEY: 'loadtest-only-key', NODE_ENV: 'production', ...extra,
  };
}

async function withScenario(name, fn) {
  const dbname = `oms_scratch_lt_${name.replace(/-/g, '_')}_${RUN.toLowerCase()}`;
  assertScratch(dbname);
  const logFile = path.join(OUT, `${LABEL}-${name}-backend.log`);
  fs.writeFileSync(logFile, '');
  log(`== ${name}: creating ${dbname}`);
  psql(PG_CONTAINER, PG_USER, 'postgres', `CREATE DATABASE ${dbname}`);
  // As a deployed database: the extensions db/init/00-init.sql enables, plus pgcrypto.
  psqlScript(PG_CONTAINER, PG_USER, dbname, ['postgis', 'timescaledb', 'uuid-ossp', 'pg_trgm', 'pgcrypto']
    .map((e) => `CREATE EXTENSION IF NOT EXISTS "${e}";`).join('\n'));
  docker('exec', REDIS_CONTAINER, 'redis-cli', 'FLUSHALL');
  const env = backendEnv(dbname);
  const portWaitMs = await waitPortFree(BASE);
  const procs = [];
  const start = (label = 'backend', extra = {}) => { const c = startBackend({ backendDir: BACKEND, env: { ...env, ...extra }, logFile, label }); procs.push(c); return c; };
  const startWorker = (label = 'worker') => start(label, { ROLE: 'worker', PORT: String(PORT + 1) });
  const ctx = { name, dbname, logFile, env, procs, start, startWorker, current: SPLIT ? start('api', { ROLE: 'api' }) : start() };
  if (SPLIT) { ctx.worker = startWorker(); await waitHealthy(`http://127.0.0.1:${PORT + 1}`, 240000, '/api/health', ctx.worker); }
  const startupMs = await waitHealthy(BASE, 240000, '/api/health', ctx.current);
  await waitHealthy(BASE, 240000, '/api/health/ready', ctx.current);
  // The manual phone-at-rest migrations (after the app's tables exist), as selftest-oms03 does.
  const mig = (f) => fs.readFileSync(path.join(BACKEND, '..', 'db', 'migrations', f), 'utf8');
  psqlScript(PG_CONTAINER, PG_USER, dbname, mig('encrypt_phone_at_rest.sql').replace(/:key\b/g, `'${env.ENCRYPTION_KEY}'`));
  psqlScript(PG_CONTAINER, PG_USER, dbname, mig('safe_decrypt_phone.sql'));
  ctx.runStart = psql(PG_CONTAINER, PG_USER, dbname, 'SELECT now()');
  log(`   backend healthy after ${startupMs} ms (pid ${ctx.current.pid})`);
  let result;
  try {
    result = await fn(ctx);
  } finally {
    for (const c of procs) await killHard(c);
    if (!KEEP_DB) {
      for (let i = 0; i < 10; i++) {
        try { psql(PG_CONTAINER, PG_USER, 'postgres', `DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)`); break; } catch { await sleep(2000); }
      }
    }
  }
  const out = { label: LABEL, scenario: name, run: RUN, scale: SCALE, roles: SPLIT ? 'api + worker' : 'single process', backend: BACKEND, feeders: feeders.length,
    db: dbname, dbDropped: !KEEP_DB, startupMs, portWaitMs, host: hostInfo(), ...result, logScan: scanLog(logFile) };
  writeJson(path.join(OUT, `${LABEL}-${name}.json`), out);
  log(`   wrote ${path.join(OUT, `${LABEL}-${name}.json`)}`);
  return out;
}

function hostInfo() {
  return { platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version };
}

function scanLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const pick = (re) => {
    const hit = lines.filter((l) => re.test(l));
    const uniq = [...new Set(hit.map((l) => l.replace(/\d+/g, 'N').slice(0, 200)))].slice(0, 6);
    return { count: hit.length, examples: uniq };
  };
  return {
    lines: lines.length,
    fatal: pick(/\[fatal\]/),
    // [notifier] = e-mail with no SMTP configured in the test; counted apart so it does not hide real errors
    errors: pick(/^(?!\[notifier\]).*(error|failed|ECONNREFUSED|ETIMEDOUT)/i),
    notifier: pick(/\[notifier\].*failed/i),
    redis: pick(/\[redis\]/i),
    db: pick(/\[db\]|database/i),
    scada: pick(/\[scada\]/),
    queue: pick(/queue|dead.?letter|dlq/i),
    exits: pick(/=====.*exited/),
  };
}

// ---------------------------------------------------------------- DB verification
const q = (dbname, sql) => JSON.parse(psql(PG_CONTAINER, PG_USER, dbname, `SELECT coalesce(json_agg(t), '[]') FROM (${sql}) t`) || '[]');

function schemaInfo(dbname) {
  const alarmCols = q(dbname, `SELECT column_name AS c FROM information_schema.columns WHERE table_schema='public' AND table_name='alarms'`).map((r) => r.c);
  const idCol = ['event_id', 'external_id', 'source_event_id', 'idempotency_key'].find((c) => alarmCols.includes(c)) || null;
  // column alias must differ from q()'s subquery alias "t", or json_agg(t) aggregates the bare strings
  const qTables = q(dbname, `SELECT table_name AS tbl FROM information_schema.tables WHERE table_schema='public' AND table_name ~* '(queue|dead|dlq|outbox|inbox)'`).map((r) => r.tbl);
  const tables = {};
  for (const t of qTables) {
    const cols = q(dbname, `SELECT column_name AS c FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'`).map((r) => r.c);
    const statusCol = ['status', 'state'].find((c) => cols.includes(c));
    tables[t] = statusCol
      ? Object.fromEntries(q(dbname, `SELECT ${statusCol}::text AS s, count(*)::int AS n FROM ${t} GROUP BY 1`).map((r) => [r.s, r.n]))
      : { rows: q(dbname, `SELECT count(*)::int AS n FROM ${t}`)[0].n };
  }
  return { alarmEventIdColumn: idCol, queueTables: tables };
}

function verifyScada(ctx, results, run) {
  const { dbname } = ctx;
  const { alarmEventIdColumn: idCol } = schemaInfo(dbname);
  const acked = results.filter((r) => r.ok);
  const rows = idCol
    ? q(dbname, `SELECT ${idCol} AS k, count(*)::int n, count(incident_id)::int linked, array_agg(DISTINCT incident_id) incs FROM alarms WHERE ${idCol} LIKE 'LT${run}-S%' GROUP BY 1`)
    : q(dbname, `SELECT tag AS k, count(*)::int n, count(incident_id)::int linked, array_agg(DISTINCT incident_id) incs FROM alarms WHERE tag LIKE 'LT${run}.%' GROUP BY 1`);
  const byKey = new Map(rows.map((r) => [r.k, r]));
  const keyOf = (r) => (idCol ? r.key : r.tag);
  const expected = new Map();
  for (const r of acked) expected.set(keyOf(r), (expected.get(keyOf(r)) || 0) + 1);
  let lost = 0, dupRows = 0, unprocessed = 0, orphanRows = 0;
  for (const [k, n] of expected) {
    const row = byKey.get(k);
    const have = row ? row.n : 0;
    if (have < n) lost += n - have;
    if (have > n) dupRows += have - n;
    if (row) unprocessed += Math.max(0, Math.min(have, n) - row.linked);
  }
  for (const [k, row] of byKey) if (!expected.has(k)) orphanRows += row.n;
  // Incidents holding this run's events, per feeder (tag = LT<run>.<feeder>.<x>).
  const incsPerFeeder = new Map();
  for (const r of rows) {
    const feeder = idCol ? null : r.k.split('.')[1];
    if (!feeder) continue;
    if (!incsPerFeeder.has(feeder)) incsPerFeeder.set(feeder, new Set());
    for (const i of r.incs || []) if (i) incsPerFeeder.get(feeder).add(i);
  }
  const feedersSplit = [...incsPerFeeder.values()].filter((s) => s.size > 1).length;
  return {
    eventKey: idCol ? `alarms.${idCol}` : 'alarms.tag (unique per event)' ,
    sent: results.length, acked: acked.length, rejectedAfterRetries: results.length - acked.length,
    lost, duplicateRows: dupRows, unprocessed, rowsForUnackedRequests: orphanRows,
    feedersWithEventsInMoreThanOneIncident: feedersSplit,
    incidents: incidentSummary(ctx),
  };
}

function verifyComplaints(ctx, results, run) {
  const { dbname } = ctx;
  const rows = q(dbname, `SELECT external_id AS k, count(*)::int n, count(incident_id)::int linked FROM complaints WHERE external_id LIKE 'LT${run}-C%' GROUP BY 1`);
  const byKey = new Map(rows.map((r) => [r.k, r]));
  const ackedKeys = new Set(results.filter((r) => r.ok).map((r) => r.key));
  const sentKeys = new Set(results.map((r) => r.key));
  let lost = 0, dupRows = 0, unlinked = 0, orphanRows = 0;
  for (const k of ackedKeys) {
    const row = byKey.get(k);
    if (!row) { lost++; continue; }
    if (row.n > 1) dupRows += row.n - 1;
    if (row.linked < row.n) unlinked += row.n - row.linked;
  }
  for (const [k, row] of byKey) if (!ackedKeys.has(k)) orphanRows += row.n;
  // Customer count vs distinct complaints, for incidents opened by this run's complaints.
  const counts = q(dbname, `SELECT i.id, i.customers, count(c.qid)::int linked, count(DISTINCT c.external_id)::int distinct_ext
      FROM incidents i JOIN complaints c ON c.incident_id = i.id
      WHERE i.opened_at >= '${ctx.runStart}' AND i.source = 'Customer' AND c.external_id LIKE 'LT${run}-C%' GROUP BY i.id, i.customers`);
  const mismatch = counts.filter((c) => c.customers !== c.distinct_ext);
  return {
    sent: results.length, resentDuplicates: results.filter((r) => r.dup).length,
    uniqueExternalIds: sentKeys.size, ackedUniqueExternalIds: ackedKeys.size,
    rejectedAfterRetries: results.filter((r) => !r.ok).length,
    lost, duplicateRows: dupRows, unlinked, rowsForUnackedRequests: orphanRows,
    customerCountMismatches: mismatch.length, customerCountMismatchExamples: mismatch.slice(0, 5),
    incidents: incidentSummary(ctx),
  };
}

function incidentSummary(ctx) {
  const rows = q(ctx.dbname, `SELECT feeder, substation, source, status FROM incidents WHERE opened_at >= '${ctx.runStart}'`);
  const active = rows.filter((r) => !['resolved', 'closed', 'cancelled'].includes(r.status));
  const per = (key) => {
    const m = new Map();
    for (const r of active) { const k = r[key] || '(none)'; m.set(k, (m.get(k) || 0) + 1); }
    return { groups: m.size, withMoreThanOne: [...m.values()].filter((n) => n > 1).length, extra: [...m.values()].reduce((s, n) => s + n - 1, 0) };
  };
  const bySource = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;
  return { createdInRun: rows.length, activeCreatedInRun: active.length, bySource, perFeeder: per('feeder'), perSubstation: per('substation') };
}

// Wait until the backend has worked off its backlog: queue depth on
// /api/health is 0 (when it reports one) and the processed count is unchanged
// for three polls in a row. Gives up after maxMs and says so.
async function settle(ctx, countSql, maxMs = 15 * 60 * 1000) {
  const t0 = Date.now();
  let last = null, stable = 0, depth = null, health = null, polls = 0;
  while (Date.now() - t0 < maxMs) {
    const h = await request(BASE, 'GET', '/api/health', { wantBody: true, timeoutMs: 5000 });
    health = h.body ?? null;
    depth = h.body ? queueDepthFrom(h.body) : null;
    let c = null;
    try { c = psql(PG_CONTAINER, PG_USER, ctx.dbname, countSql); } catch { c = null; }
    if (c !== null && c === last && (depth === null || depth === 0)) { if (++stable >= 3) break; } else stable = 0;
    if (++polls % 15 === 1) log(`   settle: ${Math.round((Date.now() - t0) / 1000)} s, count ${c}, queue depth ${depth}`);
    last = c;
    await sleep(2000);
  }
  const ms = Date.now() - t0;
  return { settleMs: ms, settled: ms < maxMs, queueDepthAtEnd: depth, healthAtEnd: health };
}

// ---------------------------------------------------------------- dashboard sessions / probes
// A dashboard session = one Socket.IO connection (counts broadcast events) plus
// the control room's REST reads: the initial screen load, then the hot lists
// refreshed every refreshS seconds.
const INITIAL = ['/api/incidents', '/api/crews', '/api/indicators', '/api/alarms', '/api/complaints', '/api/calls', '/api/network/meta'];
const REFRESH = ['/api/incidents', '/api/indicators', '/api/alarms'];
function startSessions(n, { rec, refreshS = 5, rampS = 10, phaseOf = () => '' } = {}) {
  const sessions = [];
  let stop = false;
  for (let i = 0; i < n; i++) {
    const s = { events: 0, connected: false, connectErrors: 0, disconnects: 0 };
    sessions.push(s);
    (async () => {
      await sleep((rampS * 1000 * i) / Math.max(1, n));
      if (stop) return;
      const sock = ioClient(BASE, { transports: ['websocket'], reconnection: true, auth: { token: DASH_TOKEN } });
      s.sock = sock;
      sock.on('connect', () => { s.connected = true; });
      sock.on('connect_error', () => { s.connectErrors++; });
      sock.on('disconnect', () => { s.disconnects++; s.connected = false; });
      sock.onAny(() => { s.events++; });
      const get = async (p) => { const r = await request(BASE, 'GET', p, { token: DASH_TOKEN }); rec.attempt(`${phaseOf()}GET ${p}`, r); };
      for (const p of INITIAL) { if (stop) return; await get(p); }
      while (!stop) {
        await sleep(refreshS * 1000 * (0.8 + Math.random() * 0.4));
        for (const p of REFRESH) { if (stop) return; await get(p); }
      }
    })();
  }
  return {
    stop() { stop = true; for (const s of sessions) s.sock?.close(); },
    stats() {
      return { sessions: n, connectedNow: sessions.filter((s) => s.connected).length, connectErrors: sessions.reduce((a, s) => a + s.connectErrors, 0),
        disconnects: sessions.reduce((a, s) => a + s.disconnects, 0), socketEventsReceived: sessions.reduce((a, s) => a + s.events, 0) };
    },
  };
}

function memSampler(ctx, everyMs) {
  const samples = [];
  const t0 = Date.now();
  const tick = () => {
    const live = ctx.procs.filter((c) => isAlive(c));
    const rss = live.reduce((s, c) => s + (rssBytes(c.pid) || 0), 0);
    samples.push({ s: Math.round((Date.now() - t0) / 1000), mb: Math.round(rss / 2 ** 20) });
  };
  tick();
  const h = setInterval(tick, everyMs);
  return { stop() { clearInterval(h); tick(); return samples; } };
}
const memSummary = (samples) => ({ startMB: samples[0]?.mb, endMB: samples.at(-1)?.mb, maxMB: Math.max(...samples.map((s) => s.mb)) });

// Health sampler for chaos: is /api/health answering every second?
function healthSampler() {
  const samples = [];
  let stop = false;
  (async () => {
    const t0 = now();
    while (!stop) {
      const r = await request(BASE, 'GET', '/api/health', { timeoutMs: 2000 });
      samples.push({ s: Math.round((now() - t0) / 100) / 10, status: r.status, ms: Math.round(r.ms) });
      await sleep(1000);
    }
  })();
  return { stop() { stop = true; const ok = samples.filter((x) => x.status === 200).length; return { samples: samples.length, ok, availabilityPct: samples.length ? Math.round((1000 * ok) / samples.length) / 10 : null, longestGapS: longestGap(samples) }; } };
}
function longestGap(samples) {
  let best = 0, start = null;
  for (const x of samples) {
    if (x.status !== 200) { if (start === null) start = x.s; best = Math.max(best, x.s - start + 1); } else start = null;
  }
  return best;
}

// ---------------------------------------------------------------- scenarios
const D = (s) => Math.max(5, Math.round(s * SCALE));

async function burst(ctx, { rate, durationS, make, probes = 5, retryBudgetMs = 60000, during }) {
  const t0 = now();
  const rec = makeRecorder(t0);
  const send = makeSender({ base: BASE, token: TOKEN, rec, retryBudgetMs });
  const probe = probes ? startSessions(probes, { rec, refreshS: 2, rampS: 1, phaseOf: () => 'probe ' }) : null;
  const mem = memSampler(ctx, 5000);
  const extra = during ? during(t0) : null;
  const load = await openLoop({ rate, durationS, make, send: (it) => send('POST', it.kind.split(' ')[1], it.body, it) });
  probe?.stop();
  const extraResult = extra ? await extra : undefined;
  const samples = mem.stop();
  return {
    load: { targetRate: rate, durationS, issued: load.issued, clientSkipped: load.skipped, sendWindowS: +load.sendWindowS.toFixed(1),
      achievedRate: +(load.issued / load.sendWindowS).toFixed(1), drainS: +(load.totalS - load.sendWindowS).toFixed(1) },
    latency: rec.report(), sessions: probe?.stats(), memory: memSummary(samples), results: load.results, extra: extraResult,
  };
}

const strip = ({ results, ...rest }) => rest;

const SCEN = {
  async scada(ctx) {
    const b = await burst(ctx, { rate: 1000, durationS: D(60), make: scadaItem(RUN) });
    const s = await settle(ctx, `SELECT count(*)||'/'||count(incident_id) FROM alarms WHERE tag LIKE 'LT${RUN}.%'`);
    return { spec: '1,000 SCADA trips/s for 60 s, unique tag per event, 20 feeders', ...strip(b), settle: s, verify: verifyScada(ctx, b.results, RUN), schema: schemaInfo(ctx.dbname) };
  },
  async complaints(ctx) {
    const b = await burst(ctx, { rate: 50, durationS: D(300), make: complaintItem(RUN, 0.02) });
    const s = await settle(ctx, `SELECT count(*)||'/'||count(incident_id) FROM complaints WHERE external_id LIKE 'LT${RUN}-C%'`);
    return { spec: '50 complaints/s for 5 min, 2% resent with an already-used externalId, 20 feeders', ...strip(b), settle: s, verify: verifyComplaints(ctx, b.results, RUN), schema: schemaInfo(ctx.dbname) };
  },
  async dashboard(ctx) {
    const total = D(120), burstFrom = D(30), burstTo = D(90);
    const t0 = now();
    const rec = makeRecorder(t0);
    const phaseOf = () => { const s = (now() - t0) / 1000; return s >= burstFrom && s < burstTo ? 'burst ' : 'quiet '; };
    const sess = startSessions(100, { rec, refreshS: 5, rampS: 10, phaseOf });
    const mem = memSampler(ctx, 5000);
    await sleep(burstFrom * 1000);
    const send = makeSender({ base: BASE, token: TOKEN, rec });
    const load = await openLoop({ rate: 50, durationS: burstTo - burstFrom, make: complaintItem(RUN), send: (it) => send('POST', '/api/complaints', it.body, it) });
    const rest = total * 1000 - (now() - t0);
    if (rest > 0) await sleep(rest);
    const stats = sess.stats();
    sess.stop();
    const samples = mem.stop();
    const report = rec.report();
    return { spec: `100 dashboard sessions (Socket.IO + REST reads, refresh 5 s) for ${total} s; complaints at 50/s from ${burstFrom}s to ${burstTo}s`,
      latency: report, sessions: stats, memory: memSummary(samples),
      background: { issued: load.issued, acked: load.results.filter((r) => r.ok).length },
      verify: verifyComplaints(ctx, load.results, RUN) };
  },
  async soak(ctx) {
    const dur = D(3600);
    const mem = memSampler(ctx, 30000);
    const b = await burst(ctx, { rate: 100, durationS: dur, make: scadaItem(RUN, { finiteTags: true }), probes: 2 });
    const s = await settle(ctx, `SELECT count(*)||'/'||count(incident_id) FROM alarms WHERE tag LIKE 'LT${RUN}.%'`);
    const samples = mem.stop();
    // Growth: median of the last 5 minutes vs median of minutes 5-10 (after warm-up).
    const med = (a) => { const s2 = [...a].sort((x, y) => x - y); return s2.length ? s2[Math.floor(s2.length / 2)] : null; };
    const w = (from, to) => samples.filter((x) => x.s >= from && x.s < to).map((x) => x.mb);
    const base = med(w(dur * (5 / 60), dur * (10 / 60))), end = med(w(dur - dur * (5 / 60), dur + 1));
    return { spec: `100 SCADA trips/s for ${dur} s on a fixed set of 8 breaker tags per feeder (count-based accounting)`, ...strip(b),
      memorySamples: samples, memoryGrowth: { baselineMB: base, endMB: end, growthPct: base ? +(((end - base) / base) * 100).toFixed(1) : null, rule: 'median(last 5 min) vs median(min 5-10)' },
      settle: s, verify: verifyScada(ctx, b.results, RUN), schema: schemaInfo(ctx.dbname) };
  },
  'chaos-kill': (ctx) => chaos(ctx, 'SIGKILL the backend at 15 s, restart it 2 s later', async (mark) => {
    const victim = SPLIT ? ctx.worker : ctx.current;
    mark(`kill ${victim.label}`, victim.pid);
    await killHard(victim);
    await sleep(2000);
    mark('restart');
    if (SPLIT) {
      ctx.worker = ctx.startWorker('worker (restarted)');
      mark('healthy-again', await waitHealthy(`http://127.0.0.1:${PORT + 1}`, 240000, '/api/health', ctx.worker));
    } else {
      ctx.current = ctx.start('backend (restarted)');
      mark('healthy-again', await waitHealthy(BASE, 240000, '/api/health', ctx.current));
    }
  }),
  'chaos-pg': (ctx) => chaos(ctx, 'docker restart of the scratch Postgres container at 15 s', async (mark) => {
    mark('pg-restart-begin');
    docker('restart', PG_CONTAINER);
    mark('pg-restart-returned');
    for (let i = 0; i < 120; i++) { try { psql(PG_CONTAINER, PG_USER, ctx.dbname, 'SELECT 1'); break; } catch { await sleep(1000); } }
    mark('pg-accepting');
  }),
  'chaos-redis': (ctx) => chaos(ctx, 'docker stop of the scratch Redis at 15 s, docker start at 45 s', async (mark, t0) => {
    mark('redis-stop');
    docker('stop', REDIS_CONTAINER);
    await sleep(Math.max(0, D(45) * 1000 - (now() - t0)));
    docker('start', REDIS_CONTAINER);
    mark('redis-start');
  }),
};

// Chaos: SCADA 200/s + complaints 50/s for 60 s, the fault injected at 15 s.
async function chaos(ctx, what, inject) {
  const dur = D(60), at = D(15);
  const t0 = now();
  const rec = makeRecorder(t0);
  const send = makeSender({ base: BASE, token: TOKEN, rec, retryBudgetMs: 90000 });
  const marks = [];
  const mark = (ev, v) => { marks.push({ s: +((now() - t0) / 1000).toFixed(1), ev, ...(v !== undefined ? { v } : {}) }); log(`   chaos: ${ev}${v !== undefined ? ' ' + v : ''}`); };
  const health = healthSampler();
  const mem = memSampler(ctx, 5000);
  const injected = (async () => { await sleep(at * 1000); await inject(mark, t0); })();
  const sc = scadaItem(RUN), cp = complaintItem(RUN);
  const [ls, lc] = await Promise.all([
    openLoop({ rate: 200, durationS: dur, make: sc, send: (it) => send('POST', '/api/scada/fault', it.body, it) }),
    openLoop({ rate: 50, durationS: dur, make: cp, send: (it) => send('POST', '/api/complaints', it.body, it) }),
  ]);
  await injected;
  const h = health.stop();
  const alive = ctx.procs.filter((c) => isAlive(c)).map((c) => ({ label: c.label, pid: c.pid }));
  const s1 = await settle(ctx, `SELECT (SELECT count(*)||'/'||count(incident_id) FROM alarms WHERE tag LIKE 'LT${RUN}.%')||' '||(SELECT count(*) FROM complaints WHERE external_id LIKE 'LT${RUN}-C%')`);
  const samples = mem.stop();
  return { spec: `${what}; load SCADA 200/s + complaints 50/s for ${dur} s; senders retry for up to 90 s with the same ids`,
    marks, health: h, processesAliveAtEnd: alive, latency: rec.report(), memory: memSummary(samples), settle: s1,
    load: { scadaIssued: ls.issued, scadaSkipped: ls.skipped, complaintsIssued: lc.issued, complaintsSkipped: lc.skipped },
    verify: { scada: verifyScada(ctx, ls.results, RUN), complaints: verifyComplaints(ctx, lc.results, RUN) }, schema: schemaInfo(ctx.dbname) };
}

// ---------------------------------------------------------------- main
log(`harness ${LABEL}: backend=${BACKEND} scale=${SCALE} run=${RUN} feeders=${feeders.length} out=${OUT}`);
const summary = [];
for (const name of SCENARIOS) {
  if (!SCEN[name]) { console.error(`unknown scenario ${name}`); continue; }
  try {
    const r = await withScenario(name, SCEN[name]);
    summary.push({ scenario: name, ok: true, verify: r.verify });
  } catch (e) {
    log(`   ${name} FAILED TO RUN: ${e.stack || e.message}`);
    summary.push({ scenario: name, ok: false, error: e.message });
    writeJson(path.join(OUT, `${LABEL}-${name}.json`), { label: LABEL, scenario: name, run: RUN, harnessError: e.message });
  }
}
idp.close();
log('done', JSON.stringify(summary.map((s) => ({ s: s.scenario, ok: s.ok, err: s.error })), null, 0));
process.exit(0);
