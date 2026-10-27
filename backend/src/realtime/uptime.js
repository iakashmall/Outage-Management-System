// P8.6g availability monitoring.
//   deepHealth()         checks every service the OMS depends on (GET /api/health/deep)
//   startUptimeMonitor() records one sample every UPTIME_INTERVAL_S seconds (default 30)
//                        into uptime_checks and alerts when a critical service goes down
//                        or comes back (UPTIME_ALERT_TO=+91..., comma-separated; SMS seam)
// Samples the recorder could not write (server down) show up as gaps, which the uptime
// report counts as downtime (domain/uptime.js). For the real 99.9% evidence an EXTERNAL
// checker should also poll /api/health/deep - see docs/UPTIME.md.
import { db } from '../infra/db.js';
import { redis, isRedisConnected } from '../infra/redis.js';
import { bus } from '../domain/bus.js';
import { repo } from '../infra/repo.js';
import { sendSmsVia } from './sms.js';
import { overallStatus } from '../domain/uptime.js';

const TIMEOUT_MS = 3000;
export const intervalS = () => Math.max(10, Number(process.env.UPTIME_INTERVAL_S) || 30);

const timed = async (fn) => {
  const t = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS))]);
    return { ok: true, ms: Date.now() - t };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: String(e.message || e).slice(0, 160) };
  }
};

const keycloakUrl = () => {
  const jwks = process.env.KEYCLOAK_JWKS_URI || 'http://localhost:18080/realms/oms-upcl/protocol/openid-connect/certs';
  return jwks.replace(/\/protocol\/openid-connect\/certs$/, '');
};
const mapUrl = () => (process.env.MAP_SERVER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const fetchOk = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); };

let kafkaAdmin = null;
async function kafkaCheck() {
  if (!bus._kafka) return; // in-memory bus: nothing external to reach
  if (!kafkaAdmin) { kafkaAdmin = bus._kafka.admin(); await kafkaAdmin.connect(); }
  try { await kafkaAdmin.describeCluster(); } catch (e) { kafkaAdmin = null; throw e; }
}

// critical: the control room cannot work without it (counts against uptime).
// Non-critical failures make the system 'degraded', not down.
const CHECKS = {
  database: { critical: true, run: () => db.one('SELECT 1') },
  keycloak: { critical: true, run: () => fetchOk(keycloakUrl()) },
  kafka: { critical: true, run: kafkaCheck },
  redis: { critical: false, run: async () => { if (!isRedisConnected()) throw new Error('not connected'); await redis.ping(); } },
  map: { critical: false, run: () => fetchOk(`${mapUrl()}/health`) },
};

export async function deepHealth() {
  const names = Object.keys(CHECKS);
  const results = await Promise.all(names.map((n) => timed(CHECKS[n].run)));
  const components = { api: { ok: true, ms: 0, critical: true } };
  names.forEach((n, i) => { components[n] = { ...results[i], critical: CHECKS[n].critical }; });
  if (!bus._kafka) components.kafka.note = 'in-memory event bus';
  return { status: overallStatus(components), ts: new Date().toISOString(), components };
}

// ---- recorder + alerts ----
const down = new Map(); // component -> consecutive failures
const alerted = new Set();

async function alert(text) {
  console.warn(`[uptime] ${text}`);
  try { await repo.audit('system', 'uptime.alert', text); } catch { /* audit is best effort */ }
  const to = (process.env.UPTIME_ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const phone of to) await sendSmsVia({ to: phone, body: `GridQ OMS: ${text}`, label: 'uptime alert' });
}

async function sample() {
  const h = await deepHealth();
  await db.none('INSERT INTO uptime_checks (ts, status, components) VALUES ($1, $2, $3)', [h.ts, h.status, h.components]);
  // Alert after 2 failed checks in a row (one blip is not an outage), and once on recovery.
  for (const [name, c] of Object.entries(h.components)) {
    if (!c.critical) continue;
    if (!c.ok) {
      const n = (down.get(name) || 0) + 1; down.set(name, n);
      if (n === 2 && !alerted.has(name)) { alerted.add(name); await alert(`${name} is DOWN (${c.error || 'failed'})`); }
    } else {
      if (alerted.has(name)) await alert(`${name} has recovered`);
      down.delete(name); alerted.delete(name);
    }
  }
}

export function startUptimeMonitor() {
  if ((process.env.UPTIME_MONITOR || '').toLowerCase() === 'off') { console.log('  [uptime] monitor off (UPTIME_MONITOR=off)'); return; }
  const every = intervalS();
  const tick = () => sample().catch((e) => console.error('[uptime] sample failed:', e.message));
  tick();
  setInterval(tick, every * 1000).unref?.();
  // keep 400 days (a full year of evidence plus margin), pruned daily
  const prune = () => db.none("DELETE FROM uptime_checks WHERE ts < now() - interval '400 days'").catch(() => {});
  prune(); setInterval(prune, 86400000).unref?.();
  console.log(`  [uptime] recording health every ${every}s · alerts to ${(process.env.UPTIME_ALERT_TO || '').split(',').filter(Boolean).length} number(s) (UPTIME_ALERT_TO)`);
}
