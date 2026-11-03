// WP6 load / chaos harness: shared helpers. No secrets are read: the harness
// mints its own RS256 tokens against a local JWKS it serves itself, and talks
// only to the scratch Postgres / Redis containers named on the command line.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

// ---------------------------------------------------------------- auth
// A local JWKS endpoint + a token carrying every intake role. The backend's
// real requireAuth verifies it (KEYCLOAK_JWKS_URI points here), so the load
// goes through the same authentication path as production traffic.
export async function startFakeIdp() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'loadtest-' + randomUUID().slice(0, 8);
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const jwksUri = `http://127.0.0.1:${server.address().port}/certs`;
  const mint = (username, roles, hours = 8) => jwt.sign(
    { preferred_username: username, realm_access: { roles } },
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { algorithm: 'RS256', keyid: kid, expiresIn: `${hours}h` });
  return { jwksUri, mint, close: () => server.close() };
}

// ---------------------------------------------------------------- HTTP
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

// One request. Resolves { status, ms, body?, error? }; never rejects.
export function request(base, method, urlPath, { token, body, timeoutMs = 30000, wantBody = false } = {}) {
  return new Promise((resolveOnce) => {
    const t0 = now();
    // Settles exactly once, whatever the socket does: a response cut off by a
    // killed server may emit 'close' without 'end' or 'error', so a hard timer
    // and the close events all resolve too.
    let settled = false;
    const resolve = (v) => { if (!settled) { settled = true; clearTimeout(hard); resolveOnce(v); } };
    const hard = setTimeout(() => { req.destroy(); resolve({ status: 0, ms: now() - t0, error: 'TIMEOUT' }); }, timeoutMs + 2000);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(urlPath, base);
    const req = http.request({
      agent, method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (wantBody) chunks.push(c); });
      res.on('end', () => {
        let parsed;
        if (wantBody) { try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { parsed = undefined; } }
        resolve({ status: res.statusCode, ms: now() - t0, body: parsed });
      });
      res.on('error', (e) => resolve({ status: 0, ms: now() - t0, error: e.code || e.message }));
      res.on('close', () => { if (!res.complete) resolve({ status: 0, ms: now() - t0, error: 'RESPONSE_CUT' }); });
    });
    req.on('close', () => resolve({ status: 0, ms: now() - t0, error: 'SOCKET_CLOSED' }));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (e) => resolve({ status: 0, ms: now() - t0, error: e.code || e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Retrying sender, the way a real gateway behaves: network errors, 5xx and 429
// are retried with capped back-off until retryBudgetMs has passed since the
// first attempt; other 4xx are final. The SAME body (same idempotency key) is
// resent, so a retry after a lost response is how duplicates would appear.
export function makeSender({ base, token, retryBudgetMs = 60000, rec }) {
  return async (method, urlPath, body, meta) => {
    const first = now();
    let attempt = 0, r;
    for (;;) {
      attempt++;
      r = await request(base, method, urlPath, { token, body });
      rec.attempt(meta.kind, r, first);
      const retryable = r.status === 0 || r.status >= 500 || r.status === 429;
      if (!retryable || now() - first > retryBudgetMs) break;
      await sleep(Math.min(250 * 2 ** (attempt - 1), 5000) * (0.75 + Math.random() * 0.5));
    }
    return { ...meta, attempts: attempt, status: r.status, ok: r.status >= 200 && r.status < 300, error: r.error, totalMs: now() - first };
  };
}

// ---------------------------------------------------------------- recording
export function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
export function summarize(ms) {
  const s = Float64Array.from(ms).sort();
  const r = (v) => (v == null ? null : Math.round(v));
  return { n: s.length, p50: r(pct(s, 50)), p95: r(pct(s, 95)), p99: r(pct(s, 99)), max: r(s[s.length - 1] ?? null) };
}

// Collects every attempt: latency per kind, status counts, and 10-second
// windows (throughput, errors, p95) so chaos events show up on a timeline.
export function makeRecorder(t0) {
  const kinds = new Map();
  const windows = new Map();
  const k = (name) => {
    if (!kinds.has(name)) kinds.set(name, { ms: [], status: {}, timeouts: 0 });
    return kinds.get(name);
  };
  return {
    attempt(kind, r) {
      const e = k(kind);
      const key = r.status === 0 ? `ERR:${r.error}` : String(r.status);
      e.status[key] = (e.status[key] || 0) + 1;
      if (r.status !== 0) e.ms.push(r.ms);
      const w = Math.floor((now() - t0) / 10000);
      if (!windows.has(w)) windows.set(w, { ok: 0, fail: 0, ms: [] });
      const ww = windows.get(w);
      (r.status >= 200 && r.status < 300) ? ww.ok++ : ww.fail++;
      if (r.status !== 0) ww.ms.push(r.ms);
    },
    report() {
      const byKind = {};
      const groupMs = {};
      for (const [name, e] of kinds) {
        byKind[name] = { ...summarize(e.ms), status: e.status };
        // writes = every POST; "<phase> reads" = the dashboard/probe GETs of that phase
        const g = name.startsWith('POST') ? 'writes' : `${name.split(' ')[0]} reads`;
        (groupMs[g] ||= []).push(...e.ms);
      }
      const groups = Object.fromEntries(Object.entries(groupMs).map(([g, ms]) => [g, summarize(ms)]));
      groups.all = summarize([...kinds.values()].flatMap((e) => e.ms));
      const timeline = [...windows.entries()].sort((a, b) => a[0] - b[0])
        .map(([w, v]) => ({ t: `${w * 10}-${w * 10 + 10}s`, ok: v.ok, fail: v.fail, p95: summarize(v.ms).p95 }));
      return { groups, byKind, timeline };
    },
  };
}

// ---------------------------------------------------------------- open-loop load
// Sends `rate` items a second for durationS, independent of response time
// (open loop: a slow server does not slow the arrivals). If maxInflight
// requests are already outstanding the item is NOT sent and is counted as
// clientSkipped, so the achieved rate is reported honestly.
export async function openLoop({ rate, durationS, make, send, maxInflight = 4000, onTick }) {
  const start = now();
  const results = [];
  const pending = new Set();
  let issued = 0, skipped = 0;
  const total = Math.round(rate * durationS);
  while (issued + skipped < total) {
    const elapsed = (now() - start) / 1000;
    const due = Math.min(total, Math.floor(elapsed * rate));
    while (issued + skipped < due) {
      const i = issued + skipped;
      if (pending.size >= maxInflight) { skipped++; continue; }
      issued++;
      const p = send(make(i)).then((r) => { results.push(r); pending.delete(p); });
      pending.add(p);
    }
    if (onTick) onTick(elapsed);
    if (Math.floor(elapsed / 10) !== Math.floor((elapsed - 0.006) / 10)) console.log(`   load: ${Math.round(elapsed)} s, issued ${issued}, in flight ${pending.size}, done ${results.length}`);
    await sleep(5);
  }
  const sendWindowS = (now() - start) / 1000;
  const waitLog = setInterval(() => console.log(`   load: waiting for ${pending.size} in-flight items`), 10000);
  await Promise.all(pending);
  clearInterval(waitLog);
  return { results, issued, skipped, sendWindowS, totalS: (now() - start) / 1000 };
}

// ---------------------------------------------------------------- backend process
export function backendEnvGuard(backendDir) {
  // dotenv in src/index.js would load backend/.env and mix real settings into
  // the test; refuse instead of reading it.
  if (fs.existsSync(path.join(backendDir, '.env'))) {
    throw new Error(`${backendDir}/.env exists; run the harness against a worktree without one (it is never read)`);
  }
}

export function startBackend({ backendDir, env, logFile, label }) {
  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `\n===== ${label} started ${new Date().toISOString()} =====\n`);
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: backendDir, env, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.on('exit', (code, sig) => {
    try { fs.writeSync(out, `\n===== ${label} exited code=${code} signal=${sig} ${new Date().toISOString()} =====\n`); } catch {}
  });
  child.label = label;
  return child;
}

// Other windows' selftests also bind PORT 4100: wait until nothing answers
// there before starting our backend, so we never measure someone else's.
export async function waitPortFree(base, maxMs = 30 * 60 * 1000) {
  const t0 = Date.now();
  let said = false;
  while (Date.now() - t0 < maxMs) {
    const r = await request(base, 'GET', '/api/health', { timeoutMs: 2000 });
    if (r.status === 0 && /ECONNREFUSED/.test(r.error || '')) return Date.now() - t0;
    if (!said) { console.log(`   port busy at ${base} (another process answers); waiting`); said = true; }
    await sleep(5000);
  }
  throw new Error(`${base} still in use after ${maxMs} ms`);
}

// child: when given, the health answer only counts while that process is alive
// (if it died, e.g. EADDRINUSE, whatever answers is not ours).
export async function waitHealthy(base, timeoutMs = 240000, urlPath = '/api/health', child = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child && !isAlive(child)) throw new Error(`backend pid ${child.pid} exited before it was healthy (see its log)`);
    const r = await request(base, 'GET', urlPath, { timeoutMs: 3000 });
    if (r.status === 200 && (!child || isAlive(child))) return Date.now() - t0;
    await sleep(500);
  }
  throw new Error(`backend not healthy at ${base}${urlPath} after ${timeoutMs} ms`);
}

// A child killed by a signal has exitCode null and signalCode set: check both.
export const isAlive = (child) => child.exitCode === null && child.signalCode === null;

export function killHard(child) {
  // SIGKILL: on Linux kill -9; on Windows Node maps it to TerminateProcess.
  return new Promise((r) => {
    if (!isAlive(child)) return r();
    child.once('exit', () => r());
    child.kill('SIGKILL');
  });
}

export function rssBytes(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const m = out.trim().split('\n')[0].match(/"([\d,.\s]+) K"$/);
      return m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null;
    }
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = s.match(/VmRSS:\s+(\d+) kB/);
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- docker / db
// maxBuffer: the default 1 MB is too small for a 60,000-event verification query (ENOBUFS)
const MAX_BUFFER = 512 * 1024 * 1024;
export const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER }).trim();

export function psql(container, user, dbname, sql) {
  return docker('exec', container, 'psql', '-U', user, '-d', dbname, '-v', 'ON_ERROR_STOP=1', '-Atc', sql);
}

export function psqlScript(container, user, dbname, sqlText) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', user, '-d', dbname, '-v', 'ON_ERROR_STOP=1', '-q'],
    { input: sqlText, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
}

export function assertScratch(dbname) {
  if (!/scratch/.test(dbname)) throw new Error(`refusing database "${dbname}": its name must contain "scratch"`);
}

// Queue depth from /api/health, whatever shape WP2 gives it: the sum of the
// numeric leaves whose path says depth / pending / backlog (dead-letter excluded).
export function queueDepthFrom(health) {
  let found = false, sum = 0;
  const walk = (o, p) => {
    if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`); return; }
    if (typeof o === 'number' && /(depth|pending|backlog)/i.test(p) && !/dead/i.test(p)) { found = true; sum += o; }
  };
  walk(health, '');
  return found ? sum : null;
}

export function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
