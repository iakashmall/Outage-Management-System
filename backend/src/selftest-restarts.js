// G10 / G11 self-test (4 Nov 2026; load test results section 8): restarts
// under load. Starts the real backend as ROLE=api (PORT, default 4101) and
// ROLE=worker (PORT+1) on a scratch database, sends SCADA events and
// complaints through the real HTTP routes and auth, and meanwhile kills
// (SIGKILL) and restarts the worker and the API, alternating. Senders behave
// like a gateway: network errors, 5xx and 429 are retried with the same
// eventId / externalId. Two profiles:
//   light (default; npm test and CI): 3 + 3 restarts, 200 SCADA/s, 40 complaints/s,
//         about a minute, test process well under 1 GB
//     DATABASE_URL=<scratch db> PORT=4101 node src/selftest-restarts.js
//   full (npm run test:restarts:full; never in CI): 10 + 10 restarts, 1,000
//         SCADA/s and 200 complaints/s (the G10 gate rate)
//     DATABASE_URL=<scratch db> PORT=4101 node src/selftest-restarts.js --full
// RESTARTS_EACH, G10_SCADA_RATE, G10_COMPLAINT_RATE and G10_MAX_IN_FLIGHT
// (300) override either profile.
//   G10  every restart is healthy again; no [fatal] line in any process;
//        no acknowledged complaint (201/200/202) is lost; nothing dead-lettered
//   G11  every acknowledged complaint exists exactly once, under the qid it was
//        given, and no qid was ever given to two different complaints
// The complaint rate limit is raised for this test only (200/s is above the
// default 100/s per user).
// CI robustness: fixed ports (PORT, PORT+1), a 60 s wait for each restart to
// answer /api/health, a 180 s drain wait, and no assertion on any duration:
// times are reported, not checked. The sender is capped in flight, so a slow
// runner sends fewer requests (reported as not sent) instead of piling them up.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-restarts: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
const jwt = (await import('jsonwebtoken')).default;
const { db, migrate } = await import('./infra/db.js');
const { seed } = await import('./infra/seed.js');
const { distTx } = await import('./infra/geo.js');

const API_PORT = Number(process.env.PORT || 4101), WORKER_PORT = API_PORT + 1;
const FULL = process.argv.includes('--full');
const PROFILE = FULL ? { each: 10, scada: 1000, complaints: 200 } : { each: 3, scada: 200, complaints: 40 };
const EACH = Number(process.env.RESTARTS_EACH || PROFILE.each);
const SCADA_RATE = Number(process.env.G10_SCADA_RATE || PROFILE.scada), COMPLAINT_RATE = Number(process.env.G10_COMPLAINT_RATE || PROFILE.complaints);
const T_START = Date.now();
let peakRssMb = 0;
const rssTimer = setInterval(() => { peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 1048576); }, 500);
rssTimer.unref();
console.log(`  profile ${FULL ? 'full' : 'light'}: ${EACH} + ${EACH} restarts, ${SCADA_RATE} SCADA/s, ${COMPLAINT_RATE} complaints/s, cap ${process.env.G10_MAX_IN_FLIGHT || 300} in flight`);
let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = randomUUID().slice(0, 6).toUpperCase();

await migrate();
await seed({ force: true });

// A local JWKS so the backend's real requireAuth accepts our token.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'g10-' + RUN;
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const idp = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => idp.listen(0, '127.0.0.1', r));
const token = jwt.sign({ preferred_username: 'g10.restarts', realm_access: { roles: ['system_admin'] } },
  privateKey.export({ format: 'pem', type: 'pkcs8' }), { algorithm: 'RS256', keyid: kid, expiresIn: '2h' });

// ---- processes
const logs = [];
function start(role) {
  const port = role === 'api' ? API_PORT : WORKER_PORT;
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ROLE: role, PORT: String(port), SIMULATOR: 'off', FEEDER_TELEMETRY_SIM: 'off', NODE_ENV: 'production',
      KEYCLOAK_JWKS_URI: `http://127.0.0.1:${idp.address().port}/certs`, INTAKE_RATE_LIMIT_PER_MIN: '60000', SCADA_RATE_LIMIT_PER_MIN: '600000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = { role, pid: child.pid, out: '', fatal: 0, exit: null };
  const scan = (d) => { const s = String(d); entry.fatal += (s.match(/\[fatal\]/g) || []).length; entry.out = (entry.out + s).slice(-6000); };
  child.stdout.on('data', scan); child.stderr.on('data', scan);
  child.exited = new Promise((r) => child.once('exit', (code, signal) => { entry.exit = { code, signal }; r(entry.exit); }));
  child.entry = entry; child.port = port;
  logs.push(entry);
  return child;
}
const agentProbe = new http.Agent({ keepAlive: false });
const probe = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: agentProbe, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
});
async function healthy(child, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.entry.exit) return null;
    if (await probe(child.port)) return Date.now() - t0;
    await sleep(100);
  }
  return null;
}

// ---- senders (open loop, retrying like a gateway)
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const post = (path, body) => new Promise((resolve) => {
  const payload = Buffer.from(JSON.stringify(body));
  const req = http.request({ agent, method: 'POST', host: '127.0.0.1', port: API_PORT, path, timeout: 30000,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
    let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; });
    res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, body: j }); });
  });
  req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
  req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
  req.end(payload);
});
const statuses = {};
async function send(path, body) {
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    const r = await post(path, body);
    const k = `${path} ${r.status || 'ERR:' + r.error}`; statuses[k] = (statuses[k] || 0) + 1;
    const retry = r.status === 0 || r.status >= 500 || r.status === 429;
    if (!retry || Date.now() - t0 > 120000) return r;
    await sleep(Math.min(100 * 2 ** (attempt - 1), 2000));
  }
}
const dts = distTx.filter((d) => typeof d.lat === 'number' && d.feeder).slice(0, 20);
const scada = [], complaints = [];
let sending = true;
// Keeps only what the checks read (key, status, the answered qid) and counts
// requests in flight instead of holding every promise: at ~1,200 requests a
// second for several minutes the full requests and answers took over 0.5 GB.
// Bounded: at most MAX_IN_FLIGHT requests (both senders together; a request
// counts until its last retry ends) are open at once. A request that falls due
// while the cap is reached is not queued: it is counted as not sent and the
// sender waits for the next tick. A not-sent request was never acknowledged,
// so the loss checks are unaffected; the counts are reported.
const MAX_IN_FLIGHT = Number(process.env.G10_MAX_IN_FLIGHT || 300);
let inFlightAll = 0, peakInFlight = 0;
function openLoop(rate, make, into) {
  const t0 = Date.now(); let i = 0, inFlight = 0, notSent = 0;
  return (async () => {
    while (sending) {
      const due = Math.floor(((Date.now() - t0) / 1000) * rate);
      while (i < due) {
        if (inFlightAll >= MAX_IN_FLIGHT) { notSent += due - i; i = due; break; }
        const it = make(i++); inFlight++; inFlightAll++; peakInFlight = Math.max(peakInFlight, inFlightAll);
        send(it.path, it.body).then((r) => { into.push({ key: it.key, r: { status: r.status, body: r.body?.queryId ? { queryId: r.body.queryId } : null } }); inFlight--; inFlightAll--; });
      }
      await sleep(5);
    }
    while (inFlight > 0) await sleep(50);
    return { due: i, sent: i - notSent, notSent };
  })();
}

let api = start('api'), worker = start('worker');
const firstUp = [await healthy(api), await healthy(worker)];
check('setup: api and worker healthy', firstUp.every((x) => x != null), `(${firstUp.join(' / ')} ms)`);

const t0 = Date.now();
const scadaLoop = openLoop(SCADA_RATE, (i) => {
  const d = dts[i % dts.length];
  return { path: '/api/scada/fault', key: `G10${RUN}-S${i}`, body: { tag: `G10${RUN}.${d.feeder}.E${i}`, feeder: d.feeder, condition: 'CRITICAL', eventId: `G10${RUN}-S${i}` } };
}, scada);
const complaintLoop = openLoop(COMPLAINT_RATE, (i) => {
  const d = dts[(i * 7) % dts.length];
  return { path: '/api/complaints', key: `G10${RUN}-C${i}`, body: { externalId: `G10${RUN}-C${i}`, customer: 'G10', phone: '9800000010', category: 'No Supply', lat: d.lat, lon: d.lon } };
}, complaints);

// ---- restarts: worker, api, worker, api ... EACH times each
const restarts = [];
await sleep(3000);
for (let n = 0; n < EACH * 2; n++) {
  const role = n % 2 === 0 ? 'worker' : 'api';
  const victim = role === 'api' ? api : worker;
  victim.kill('SIGKILL'); await victim.exited;
  await sleep(1000);
  const next = start(role);
  if (role === 'api') api = next; else worker = next;
  const ms = await healthy(next);
  restarts.push({ n: n + 1, role, healthyMs: ms, exit: next.entry.exit });
  console.log(`  restart ${n + 1}/${EACH * 2} ${role}: ${ms == null ? 'NOT healthy' : `healthy in ${ms} ms`} (${complaints.length} complaint and ${scada.length} SCADA answers so far)`);
  if (ms == null) console.log(`--- ${role} restart ${n + 1} not healthy ---\n${next.entry.out.slice(-2500)}`);
  await sleep(2000);
}
sending = false;
const [scadaRun, complaintRun] = await Promise.all([scadaLoop, complaintLoop]);
const scadaSent = scadaRun.sent, complaintsSent = complaintRun.sent;
const loadS = (Date.now() - t0) / 1000;
console.log(`  sender (cap ${MAX_IN_FLIGHT} in flight, peak ${peakInFlight}): SCADA ${scadaRun.due} due, ${scadaRun.sent} sent, ${scadaRun.notSent} not sent (cap reached); complaints ${complaintRun.due} due, ${complaintRun.sent} sent, ${complaintRun.notSent} not sent (cap reached); achieved ${(scadaRun.sent / loadS).toFixed(0)} SCADA/s and ${(complaintRun.sent / loadS).toFixed(0)} complaints/s over ${loadS.toFixed(0)} s`);

// ---- drain, then verify
const drainT0 = Date.now();
let depth = null;
for (;;) {
  depth = (await db.one('SELECT count(*)::int n FROM intake_queue')).n;
  if (depth === 0 || Date.now() - drainT0 > 180000) break;
  await sleep(500);
}
const drainS = (Date.now() - drainT0) / 1000;
const okHealthy = restarts.filter((r) => r.healthyMs != null);
const fatal = logs.reduce((a, l) => a + l.fatal, 0);
check(`G10: all ${EACH * 2} restarts (${EACH} worker, ${EACH} api) healthy again`, okHealthy.length === EACH * 2,
  `(${okHealthy.length}/${restarts.length}; time to healthy: worker max ${Math.max(...restarts.filter((r) => r.role === 'worker').map((r) => r.healthyMs ?? Infinity))} ms, api max ${Math.max(...restarts.filter((r) => r.role === 'api').map((r) => r.healthyMs ?? Infinity))} ms)`);
check('G10: no [fatal] line in any of the processes', fatal === 0, `(${logs.length} processes, ${fatal} [fatal] lines)`);

const ackedC = complaints.filter((c) => [200, 201, 202].includes(c.r.status));
const rows = await db.any(`SELECT external_id, qid FROM complaints WHERE external_id LIKE $1`, [`G10${RUN}-C%`]);
const byExt = new Map(); for (const r of rows) byExt.set(r.external_id, [...(byExt.get(r.external_id) || []), r.qid]);
const lostC = ackedC.filter((c) => !byExt.has(c.key));
const dupC = [...byExt.values()].filter((q) => q.length > 1).length;
const dead = (await db.one('SELECT count(*)::int n FROM intake_dead_letter')).n;
check('G10: no acknowledged complaint lost, nothing dead-lettered, queue drained',
  lostC.length === 0 && dead === 0 && depth === 0,
  `(${complaintsSent} complaints sent, ${ackedC.length} acknowledged: ${['201', '200', '202'].map((s) => `${s} x${ackedC.filter((c) => String(c.r.status) === s).length}`).join(', ')}; ${rows.length} stored; lost ${lostC.length}; dead letter ${dead}; queue ${depth} after ${drainS.toFixed(1)} s)`);

// G11: exactly once, under the qid it was given; no qid given to two complaints
const qidOwner = new Map(); let qidShared = 0, wrongQid = 0;
for (const c of ackedC) {
  const q = c.r.body?.queryId;
  if (!q) continue;
  if (qidOwner.has(q) && qidOwner.get(q) !== c.key) qidShared++; else qidOwner.set(q, c.key);
  const stored = byExt.get(c.key);
  if (stored && stored.length === 1 && c.r.status !== 200 && stored[0] !== q) wrongQid++;
}
const qidAll = await db.one('SELECT count(*)::int n, count(qid)::int q, count(DISTINCT qid)::int d FROM complaints');
check('G11: every acknowledged complaint exists exactly once, under the qid it was given; no qid given to two different complaints',
  dupC === 0 && qidShared === 0 && wrongQid === 0 && lostC.length === 0 && qidAll.q === qidAll.d,
  `(${byExt.size} distinct complaints, ${dupC} stored more than once, ${qidShared} qid(s) answered for two complaints, ${wrongQid} stored under another qid than answered; whole table: ${qidAll.n} complaint rows, ${qidAll.q} with a qid, ${qidAll.d} distinct qids)`);

const ackedS = scada.filter((s) => [200, 202].includes(s.r.status));
const sv = await db.one(`SELECT count(*)::int n, count(DISTINCT tag)::int tags, count(incident_id)::int linked FROM alarms WHERE tag LIKE $1`, [`G10${RUN}.%`]);
check('G10: SCADA under the same restarts: every acknowledged event stored once and processed',
  sv.n === sv.tags && sv.tags >= new Set(ackedS.map((s) => s.key)).size && sv.linked === sv.n,
  `(${scadaSent} sent, ${ackedS.length} acknowledged, ${sv.n} rows, ${sv.tags} distinct, ${sv.linked} linked to an incident)`);

console.log(`  load ${loadS.toFixed(0)} s; statuses ${JSON.stringify(statuses)}`);
console.log(`  restarts: ${restarts.map((r) => `${r.role[0]}${r.n}:${r.healthyMs ?? 'X'}`).join(' ')}`);
peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / 1048576);
check('test process stays under 1 GB', peakRssMb < 1024, `(peak RSS ${peakRssMb.toFixed(0)} MB, sampled every 0.5 s; backend processes not included)`);
console.log(`  total ${((Date.now() - T_START) / 1000).toFixed(0)} s from start (light profile budget 180 s; reported, not asserted)`);
for (const p of [api, worker]) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
idp.close(); agent.destroy();
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
await db.$pool.end().catch(() => {});
process.exit(fails ? 1 : 0);
