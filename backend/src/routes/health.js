// GET /api/health: liveness plus the intake queue (runbook v2 WP2, G8).
// No login, no secrets.
//
// F3 (load-test findings, 3 Nov 2026): the handler never waits on Postgres or
// Redis. A background refresher reads the queue stats every
// HEALTH_REFRESH_MS (2 s), each read capped at HEALTH_QUEUE_TIMEOUT_MS
// (1.5 s), one read at a time; the handler answers from the last result at
// once. When reads fail or time out the answer says so (queue.stale,
// queue.error, queue.ageMs) and still comes back immediately with 200: the
// process is up. /api/health/ready and /api/health/deep are the dependency checks.
import { queueStats } from '../infra/intakeQueue.js';

// index.js registers what this process runs (role, jobs, consumer), WP4.
let info = () => ({});
export const setHealthInfo = (fn) => { info = fn; };

const envInt = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
let last = null;      // { stats, at } of the last successful read
let lastError = null; // { message, at } of the last failed read
let inFlight = null;
let timer = null;

// One read at a time; resolves when it is done (never rejects).
export function refreshHealth() {
  if (inFlight) return inFlight;
  const timeoutMs = envInt('HEALTH_QUEUE_TIMEOUT_MS', 1500);
  let to;
  inFlight = Promise.race([
    queueStats(),
    new Promise((_, reject) => { to = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); to.unref?.(); }),
  ]).then((stats) => { last = { stats, at: Date.now() }; lastError = null; },
    (err) => { lastError = { message: err.message, at: Date.now() }; })
    .finally(() => { clearTimeout(to); inFlight = null; });
  return inFlight;
}

export function startHealthRefresher() {
  if (timer) return;
  refreshHealth();
  timer = setInterval(refreshHealth, envInt('HEALTH_REFRESH_MS', 2000));
  timer.unref?.();
}
export function stopHealthRefresher() { clearInterval(timer); timer = null; }

export function queueSnapshot() {
  const staleAfter = 3 * envInt('HEALTH_REFRESH_MS', 2000);
  if (!last) {
    return lastError ? { error: `queue unavailable: ${lastError.message}`, stale: true } : { status: 'first read running', stale: true };
  }
  const ageMs = Date.now() - last.at;
  const stale = ageMs > staleAfter || !!lastError;
  return { ...last.stats, ageMs, ...(stale ? { stale: true } : {}), ...(lastError ? { error: `queue unavailable: ${lastError.message}` } : {}) };
}

export function healthHandler(req, res) {
  if (!timer) startHealthRefresher();
  res.json({ ok: true, ts: new Date().toISOString(), role: process.env.ROLE || 'all', queue: queueSnapshot(), ...info() });
}
