// Durable intake queue (runbook v2, WP2; decision D1: Postgres, not Kafka).
//
// SCADA events and complaints are written to intake_queue first and processed
// by a consumer that claims rows with FOR UPDATE SKIP LOCKED, so a burst is
// absorbed by the table instead of by the connection pool, and nothing that
// was accepted is lost when a process dies.
//
// Exactly once: an item's work (incident, complaint, events, ...) and the
// DELETE of its queue row commit in ONE transaction. If the process dies
// half way, both roll back and the item is processed again later, once.
// Bus publishes and cache drops run after that commit (at most once: a crash
// in between loses a live-screen refresh, never data).
//
// Claim -> process -> delete:
//   1. claim (own short transaction): attempts + 1 and a lease
//      (available_at = now + lease), so no other worker takes it meanwhile;
//      a worker that dies leaves the lease to expire, then the item is retried.
//   2. process in a transaction that first re-locks the row (FOR UPDATE) and
//      skips it if it is gone (another worker finished it after a lease ran out).
//   3. on failure: back-off (available_at = now + base * 2^(attempts-1)),
//      last_error kept; after QUEUE_MAX_ATTEMPTS it moves to intake_dead_letter.
//      An item that already used up its attempts (e.g. it kept killing the
//      worker) is dead-lettered when next claimed, without running it again.
// Ordering: items with the same order_key (a SCADA tag: its trip before its
// reclose) are taken strictly in id order; a failing item only holds back
// later items with its own key, never the rest of the queue.
import { db } from './db.js';

const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
export const queueConfig = () => ({
  concurrency: envInt('QUEUE_CONCURRENCY', 4),
  pollMs: envInt('QUEUE_POLL_MS', 250),
  leaseMs: envInt('QUEUE_LEASE_MS', 60000),
  maxAttempts: envInt('QUEUE_MAX_ATTEMPTS', 8),
  backoffBaseMs: envInt('QUEUE_BACKOFF_BASE_MS', 1000),
  backoffMaxMs: envInt('QUEUE_BACKOFF_MAX_MS', 300000),
});

export async function migrateIntakeQueue() {
  await db.none(`
    CREATE TABLE IF NOT EXISTS intake_queue (
      id           BIGSERIAL PRIMARY KEY,
      kind         TEXT NOT NULL,
      payload      JSONB NOT NULL,
      order_key    TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE intake_queue ADD COLUMN IF NOT EXISTS coalesce_key TEXT;
    ALTER TABLE intake_queue ADD COLUMN IF NOT EXISTS coalesced INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_intake_queue_available ON intake_queue (available_at, id);
    CREATE INDEX IF NOT EXISTS idx_intake_queue_order_key ON intake_queue (order_key, id) WHERE order_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS intake_dead_letter (
      id         BIGINT PRIMARY KEY,
      kind       TEXT NOT NULL,
      payload    JSONB NOT NULL,
      order_key  TEXT,
      attempts   INTEGER NOT NULL,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      failed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ---- producers ----
const local = new Set(); // wake-up callbacks of consumers running in this process

// Enqueue-time coalescing (storm throughput): when coalesceKey is given
// (source + tag + state, e.g. "scada|DEHRA.FDR7.CB1|trip:CRITICAL") and the
// NEWEST queued item of the same order_key is still unclaimed (attempts = 0)
// with the same coalesceKey, that item is updated instead of a new one being
// added: its payload becomes the latest event, the earlier event's id is kept
// in payload.coalesced_ids, and coalesced counts the absorbed events. Only
// the tail of a tag's sequence can absorb, so trip -> reclose -> trip stays
// three items in order and the final trip is never lost. If the tail is being
// processed right now (row locked) the event is simply added.
const coalescingOn = () => !/^(off|false|0|no)$/i.test(process.env.INTAKE_COALESCE || '');
export const intakeStats = { enqueued: 0, coalesced: 0 };

export async function enqueue(kind, payload, { orderKey = null, coalesceKey = null, cx = db } = {}) {
  const body = JSON.stringify(payload);
  if (coalesceKey && orderKey && coalescingOn()) {
    try {
      const hit = await cx.oneOrNone(`
        WITH tail AS (
          SELECT id FROM intake_queue WHERE order_key = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE NOWAIT)
        UPDATE intake_queue q
           SET payload = $3::jsonb || jsonb_build_object('coalesced_ids',
                 COALESCE(q.payload->'coalesced_ids', '[]'::jsonb)
                 || CASE WHEN q.payload ? 'id' THEN jsonb_build_array(q.payload->'id') ELSE '[]'::jsonb END),
               coalesced = q.coalesced + 1
          FROM tail
         WHERE q.id = tail.id AND q.coalesce_key = $2 AND q.attempts = 0
        RETURNING q.id`, [orderKey, coalesceKey, body]);
      if (hit) { intakeStats.coalesced++; return Number(hit.id); }
    } catch (err) {
      if (err.code !== '55P03') throw err; // 55P03: tail locked (being claimed/processed) -> add a new item
    }
  }
  const { id } = await cx.one(
    'INSERT INTO intake_queue (kind, payload, order_key, coalesce_key) VALUES ($1, $2, $3, $4) RETURNING id',
    [kind, body, orderKey, coalesceKey]);
  intakeStats.enqueued++;
  for (const wake of local) wake();
  return Number(id);
}

// For /api/health and monitoring: queued items, how old the oldest is, how
// many are waiting on a retry, and the dead-letter count.
export async function queueStats(cx = db) {
  const r = await cx.one(`
    SELECT (SELECT count(*) FROM intake_queue)::int AS depth,
           (SELECT count(*) FROM intake_queue WHERE attempts > 0)::int AS retrying,
           COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(created_at) FROM intake_queue)), 0)::int AS oldest_age_s,
           (SELECT count(*) FROM intake_dead_letter)::int AS dead_letter,
           (SELECT COALESCE(sum(coalesced), 0) FROM intake_queue)::int AS coalesced`);
  return { depth: r.depth, retrying: r.retrying, oldestAgeS: r.oldest_age_s, deadLetter: r.dead_letter, coalescedWaiting: r.coalesced };
}

// ---- completion notices (LISTEN/NOTIFY) ----
// A handler calls notifyDone(t, key) inside the item's transaction, so the
// notice is delivered only if (and when) the work commits. waitForDone()
// lets an HTTP request wait for its own item from any process (the API and
// the worker may be different processes, WP4). One listening connection per
// process; a slow fallback check covers a lost connection or notice.
const CHANNEL = 'oms_intake_done';
const waiters = new Map(); // key -> Set(resolve)
let listener = null;

export const notifyDone = (t, key) => t.any('SELECT pg_notify($1, $2)', [CHANNEL, String(key)]);

async function ensureListener() {
  if (listener) return listener;
  listener = (async () => {
    const sco = await db.connect({ direct: true });
    sco.client.on('notification', (m) => {
      if (m.channel !== CHANNEL) return;
      for (const r of waiters.get(m.payload) || []) r(true);
    });
    sco.client.on('error', (err) => { console.error('[queue] notice listener lost:', err.message); listener = null; });
    sco.client.on('end', () => { listener = null; });
    await sco.none('LISTEN $1:name', [CHANNEL]);
    return sco;
  })().catch((err) => { listener = null; throw err; });
  return listener;
}

// Resolves true when key is notified or check() turns true, false on timeout.
export async function waitForDone(key, { timeoutMs = 15000, check = null, checkEveryMs = 1000 } = {}) {
  try { await ensureListener(); } catch (err) { console.warn('[queue] no notice listener, polling instead:', err.message); }
  key = String(key);
  return new Promise((resolve) => {
    let settled = false, poll = null;
    const finish = (v) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(poll);
      const set = waiters.get(key); set?.delete(finish); if (set && !set.size) waiters.delete(key);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (!waiters.has(key)) waiters.set(key, new Set());
    waiters.get(key).add(finish);
    if (check) {
      const tick = async () => {
        if (settled) return;
        try { if (await check()) return finish(true); } catch { /* next tick */ }
        poll = setTimeout(tick, checkEveryMs);
      };
      poll = setTimeout(tick, checkEveryMs);
    }
  });
}

export async function closeListener() {
  const l = listener; listener = null;
  if (l) { try { (await l).done(); } catch { /* already gone */ } }
}

// ---- consumer ----
// handlers: { [kind]: async (payload, t) => ({ result, effects }) } -- t is
// the item's transaction; effects run after it commits.
export function startIntakeConsumer(handlers, opts = {}) {
  const cfg = { ...queueConfig(), ...opts };
  // Every worker holds one connection for its item's transaction and the
  // handlers read on the pool too, so leave the pool some room.
  const poolMax = db.$pool.options.max || 10;
  const concurrency = Math.max(1, Math.min(cfg.concurrency, poolMax - 2));
  let running = true;
  const sleepers = new Set(); // one per idle worker loop
  const wake = () => { for (const s of [...sleepers]) s(); };
  const nap = (ms) => new Promise((r) => {
    const done = () => { clearTimeout(tm); sleepers.delete(done); r(); };
    const tm = setTimeout(done, ms);
    sleepers.add(done);
  });
  local.add(wake);

  const claim = () => db.oneOrNone(`
    UPDATE intake_queue SET attempts = attempts + 1, available_at = now() + ($1 || ' milliseconds')::interval
    WHERE id = (
      SELECT q.id FROM intake_queue q
      WHERE q.available_at <= now()
        AND (q.order_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM intake_queue p WHERE p.order_key = q.order_key AND p.id < q.id))
      ORDER BY q.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
    RETURNING id, kind, payload, order_key, attempts, last_error`, [String(cfg.leaseMs)]);

  const deadLetter = (id, reason) => db.tx(async (t) => {
    await t.none(`INSERT INTO intake_dead_letter (id, kind, payload, order_key, attempts, last_error, created_at)
      SELECT id, kind, payload, order_key, attempts, $2, created_at FROM intake_queue WHERE id = $1
      ON CONFLICT (id) DO NOTHING`, [id, String(reason).slice(0, 2000)]);
    await t.none('DELETE FROM intake_queue WHERE id = $1', [id]);
  });

  async function processOne(item) {
    if (item.attempts > cfg.maxAttempts) {
      console.error(`[queue] item ${item.id} (${item.kind}) used up ${cfg.maxAttempts} attempts without finishing -> dead letter`);
      await deadLetter(item.id, item.last_error || 'attempts exhausted (worker stopped while processing it)');
      return;
    }
    const handler = handlers[item.kind];
    let effects = [];
    try {
      if (!handler) throw new Error(`no handler for intake kind "${item.kind}"`);
      await db.tx('intake-item', async (t) => {
        const still = await t.oneOrNone('SELECT id FROM intake_queue WHERE id = $1 FOR UPDATE', [item.id]);
        if (!still) return; // finished by another worker after our lease ran out
        const out = await handler(item.payload, t);
        effects = out?.effects || [];
        await t.none('DELETE FROM intake_queue WHERE id = $1', [item.id]);
      });
    } catch (err) {
      const msg = err?.message || String(err);
      if (item.attempts >= cfg.maxAttempts) {
        console.error(`[queue] item ${item.id} (${item.kind}) failed ${item.attempts} time(s), moved to dead letter: ${msg}`);
        await deadLetter(item.id, msg);
      } else {
        const wait = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** (item.attempts - 1));
        console.warn(`[queue] item ${item.id} (${item.kind}) attempt ${item.attempts}/${cfg.maxAttempts} failed, retry in ${wait} ms: ${msg}`);
        await db.none(`UPDATE intake_queue SET last_error = $2, available_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1`,
          [item.id, msg.slice(0, 2000), String(wait)]);
      }
      return;
    }
    for (const fx of effects) {
      try { await fx(); } catch (err) { console.error(`[queue] item ${item.id}: post-commit effect failed:`, err.message); }
    }
  }

  async function loop(n) {
    while (running) {
      let item = null;
      try {
        item = await claim();
        if (item) await processOne(item);
      } catch (err) {
        // the database itself is unreachable or similar: log, wait, carry on
        console.error(`[queue] worker ${n}:`, err.message);
        await nap(cfg.pollMs * 4);
        continue;
      }
      if (!item) await nap(cfg.pollMs);
    }
  }

  const loops = Array.from({ length: concurrency }, (_, i) => loop(i + 1));
  console.log(`[queue] intake consumer started: ${concurrency} worker(s), lease ${cfg.leaseMs} ms, max ${cfg.maxAttempts} attempts`);
  return {
    async stop() { running = false; local.delete(wake); wake(); await Promise.all(loops); },
  };
}
