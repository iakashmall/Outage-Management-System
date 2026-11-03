// GET /api/health: liveness plus the intake queue (runbook v2 WP2, G8).
// No login, no secrets. Stays 200 while the process is up; if the queue
// cannot be read within HEALTH_QUEUE_TIMEOUT_MS the queue field says so
// instead of the endpoint hanging (/api/health/deep is the dependency check).
import { queueStats } from '../infra/intakeQueue.js';

// index.js registers what this process runs (role, jobs, consumer), WP4.
let info = () => ({});
export const setHealthInfo = (fn) => { info = fn; };

export async function healthHandler(req, res) {
  const timeoutMs = Number(process.env.HEALTH_QUEUE_TIMEOUT_MS) || 2000;
  let queue;
  try {
    queue = await Promise.race([
      queueStats(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs).unref()),
    ]);
  } catch (err) {
    queue = { error: `queue unavailable: ${err.message}` };
  }
  res.json({ ok: true, ts: new Date().toISOString(), role: process.env.ROLE || 'all', queue, ...info() });
}
