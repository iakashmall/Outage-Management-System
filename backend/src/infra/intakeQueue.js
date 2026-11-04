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
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { db, workerDb } from './db.js';

const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
export const queueConfig = () => ({
  concurrency: envInt('QUEUE_CONCURRENCY', 4),
  pollMs: envInt('QUEUE_POLL_MS', 250),
  // D3 (4 Nov 2026): 10 s, renewed by a heartbeat while the worker lives
  // (was 60 s with no renewal: a killed worker's items waited a full minute).
  leaseMs: envInt('QUEUE_LEASE_MS', 10000),
  maxAttempts: envInt('QUEUE_MAX_ATTEMPTS', 8),
  backoffBaseMs: envInt('QUEUE_BACKOFF_BASE_MS', 1000),
  backoffMaxMs: envInt('QUEUE_BACKOFF_MAX_MS', 300000),
});

export async function migrateIntakeQueue(cx = db) {
  await cx.none(`
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
    -- F2: one alarm row per SCADA event, whatever the sender resends.
    ALTER TABLE alarms ADD COLUMN IF NOT EXISTS event_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS alarms_event_key_uq ON alarms (event_key) WHERE event_key IS NOT NULL;
    -- F6: the complaint lane claims complaints without scanning a SCADA backlog.
    CREATE INDEX IF NOT EXISTS idx_intake_queue_complaints ON intake_queue (id) WHERE kind = 'complaint';
    -- D2 (4 Nov 2026): no queue item is deleted unless it was stored, recorded
    -- here as a duplicate of something already stored, or dead-lettered.
    -- complaints.intake_item_id is the queue item that stored the complaint:
    -- the idempotency key of a complaint that has no external id.
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS intake_item_id BIGINT;
    -- D3: which claim holds an item (one token per claim); the heartbeat renews
    -- only that claim's lease, and only that claim may process or fail the item.
    ALTER TABLE intake_queue ADD COLUMN IF NOT EXISTS claimed_by TEXT;
    CREATE TABLE IF NOT EXISTS intake_duplicates (
      item_id      BIGINT PRIMARY KEY,
      kind         TEXT NOT NULL,
      dup_key      TEXT NOT NULL,
      existing_ref TEXT,
      payload      JSONB NOT NULL,
      decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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
export const wakeConsumers = () => { for (const wake of local) wake(); };

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
// batchHandlers (F5): { [kind]: { canBatch(payload), groupKey(payload),
// run(payloads, t) => ({ effects }) } } -- items of one group run in ONE
// transaction together with the DELETE of all their queue rows; if that
// transaction fails, each item of the group is run on its own (its own
// attempts, back-off and dead letter), so one bad item never holds up the rest.
//
// Two lanes (F6), each with its own worker loops on the consumer's own pool
// (infra/db.js workerDb):
//   - complaints: QUEUE_COMPLAINT_CONCURRENCY loops (2) that claim only
//     complaints, so a complaint never waits behind a SCADA backlog;
//   - everything else: QUEUE_CONCURRENCY loops (4), each claiming up to
//     QUEUE_BATCH_MAX (200) queue heads at once, by feeder group (below).
// Ordering is unchanged: only the head of each order_key (a SCADA tag) is
// ever claimed, so at most one item per tag is in flight.
//
// Feeder-group claim (worst case 4 Nov 2026: 257 feeders, every event on its
// own tag): taking the 200 oldest heads hit ~200 different feeders, so almost
// every item ran in a transaction of its own (257 items/s; a 60 s storm at
// 1,000/s needed 174 s to drain). The main lane now looks at the oldest
// QUEUE_CLAIM_SCAN heads (default 10 x QUEUE_BATCH_MAX), groups them by the
// feeder the payload names (payload.feeder, else the first two tag tokens --
// the same rule as scada.js locateFromEvent; anything else is its own group),
// and claims whole groups, the groups with the oldest head first, up to
// QUEUE_GROUP_MAX (50) items per group and QUEUE_BATCH_MAX in all. The SQL
// grouping only decides what is claimed together: processClaimed still
// groups on the handler's exact key, and order/exactly-once rest on the
// head rule and the per-transaction DELETE as before.
const stats = { groups: 0, groupedItems: 0, heartbeats: 0, renewed: 0, leaseLost: 0 };
export const consumerStats = () => ({ ...stats });

export function startIntakeConsumer(handlers, opts = {}) {
  const cfg = {
    ...queueConfig(),
    complaintConcurrency: envInt('QUEUE_COMPLAINT_CONCURRENCY', 2),
    batchMax: envInt('QUEUE_BATCH_MAX', 200),
    groupMax: envInt('QUEUE_GROUP_MAX', 50),
    ...opts,
  };
  cfg.claimScan = Math.max(cfg.batchMax, opts.claimScan || envInt('QUEUE_CLAIM_SCAN', cfg.batchMax * 10));
  const pool = cfg.db || workerDb();
  const batchHandlers = cfg.batchHandlers || {};
  // Each loop holds one connection for its transaction; leave the pool room.
  const poolMax = pool.$pool.options.max || 8;
  const room = Math.max(2, poolMax - 2);
  const complaintLoops = Math.max(1, Math.min(cfg.complaintConcurrency, Math.floor(room / 2)));
  const mainLoops = Math.max(1, Math.min(cfg.concurrency, room - complaintLoops));
  let running = true;
  const sleepers = new Set(); // one per idle worker loop
  const wake = () => { for (const s of [...sleepers]) s(); };
  const nap = (ms) => new Promise((r) => {
    const done = () => { clearTimeout(tm); sleepers.delete(done); r(); };
    const tm = setTimeout(done, ms);
    sleepers.add(done);
  });
  local.add(wake);

  const lease = String(cfg.leaseMs);
  // D3 lease heartbeat. Every claim gets its own token (claimed_by). While this
  // process lives, a timer pushes the lease of every claim it still holds
  // forward (every leaseMs / 3, QUEUE_HEARTBEAT_MS), so a slow item is never
  // taken by another worker. A killed worker stops renewing, and its items are
  // claimable again within one lease (10 s by default). A worker that stalls
  // (blocked event loop) also stops renewing; if its items are re-claimed, the
  // token no longer matches and it skips them instead of processing them a
  // second time (processOne / processGroup / failed / deadLetter check it).
  const consumerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let claimSeq = 0;
  const held = new Set(); // tokens of claims this process is still working on
  const heartbeatMs = Math.max(200, envInt('QUEUE_HEARTBEAT_MS', Math.round(cfg.leaseMs / 3)));
  const heartbeat = setInterval(async () => {
    if (!held.size) return;
    try {
      // SKIP LOCKED: the row being processed right now is locked by our own
      // processing transaction (and protected by that lock); waiting for it
      // would stall the heartbeat until it commits and let the others expire.
      const r = await pool.result(`UPDATE intake_queue SET available_at = now() + ($1 || ' milliseconds')::interval
        WHERE id IN (SELECT id FROM intake_queue WHERE claimed_by = ANY($2::text[]) FOR UPDATE SKIP LOCKED)`, [lease, [...held]]);
      stats.heartbeats++; stats.renewed += r.rowCount;
    } catch (err) { console.warn('[queue] lease heartbeat failed:', err.message); }
  }, heartbeatMs);
  heartbeat.unref?.();
  const laneFilter = { complaint: "q.kind = 'complaint'", main: "q.kind <> 'complaint'" };
  // lane 'complaint': complaints only; lane 'main': everything else.
  const claim = async (lane, limit) => {
    const token = `${consumerId}:${++claimSeq}`;
    held.add(token);
    try {
      const items = await (lane === 'main' ? claimGroups(limit, token) : claimHeads(lane, limit, token));
      if (!items.length) held.delete(token);
      for (const i of items) i.claim = token;
      return items;
    } catch (err) { held.delete(token); throw err; }
  };
  const claimHeads = (lane, limit, token) => pool.any(`
    UPDATE intake_queue u SET attempts = u.attempts + 1, available_at = now() + ($1 || ' milliseconds')::interval, claimed_by = $3
    FROM (
      SELECT q.id FROM intake_queue q
      WHERE ${laneFilter[lane]}
        AND q.available_at <= now()
        AND (q.order_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM intake_queue p WHERE p.order_key = q.order_key AND p.id < q.id))
      ORDER BY q.id
      FOR UPDATE SKIP LOCKED
      LIMIT $2) c
    WHERE u.id = c.id
    RETURNING u.id, u.kind, u.payload, u.order_key, u.attempts, u.last_error`, [lease, limit, token]);
  // Main lane: whole feeder groups out of the oldest claimScan heads (see the
  // comment above startIntakeConsumer). The lock step re-checks the lane and
  // available_at on the current row, so an item another loop claimed between
  // our snapshot and our lock is skipped, as with claimHeads.
  const claimGroups = (limit, token) => pool.any(`
    WITH heads AS (
      SELECT q.id, q.kind || '|' || COALESCE(
               NULLIF(q.payload->>'feeder', ''),
               substring(q.payload->>'tag' from '^[^.]+\\.[^.]+'),
               'item:' || q.id::text) AS g
      FROM intake_queue q
      WHERE ${laneFilter.main}
        AND q.available_at <= now()
        AND (q.order_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM intake_queue p WHERE p.order_key = q.order_key AND p.id < q.id))
      ORDER BY q.id
      LIMIT $3),
    ranked AS (
      SELECT id, row_number() OVER (PARTITION BY g ORDER BY id) AS rn, min(id) OVER (PARTITION BY g) AS g0 FROM heads),
    pick AS (
      SELECT id FROM ranked WHERE rn <= $4 ORDER BY g0, rn LIMIT $2),
    c AS (
      SELECT q.id FROM intake_queue q
      WHERE q.id IN (SELECT id FROM pick) AND ${laneFilter.main} AND q.available_at <= now()
      FOR UPDATE SKIP LOCKED)
    UPDATE intake_queue u SET attempts = u.attempts + 1, available_at = now() + ($1 || ' milliseconds')::interval, claimed_by = $5
    FROM c
    WHERE u.id = c.id
    RETURNING u.id, u.kind, u.payload, u.order_key, u.attempts, u.last_error`, [lease, limit, cfg.claimScan, cfg.groupMax, token]);

  // D3: only the claim that holds the item (token) may dead-letter it.
  const deadLetter = (id, reason, token) => pool.tx(async (t) => {
    const row = await t.oneOrNone('SELECT claimed_by FROM intake_queue WHERE id = $1 FOR UPDATE', [id]);
    if (!row || (token && row.claimed_by !== token)) return false; // gone, or another worker's claim now
    await t.none(`INSERT INTO intake_dead_letter (id, kind, payload, order_key, attempts, last_error, created_at)
      SELECT id, kind, payload, order_key, attempts, $2, created_at FROM intake_queue WHERE id = $1
      ON CONFLICT (id) DO NOTHING`, [id, String(reason).slice(0, 2000)]);
    await t.none('DELETE FROM intake_queue WHERE id = $1', [id]);
    return true;
  });

  // An item that already used up its attempts (e.g. it kept killing the
  // worker) is dead-lettered when next claimed, without running it again.
  const exhausted = async (item) => {
    if (item.attempts <= cfg.maxAttempts) return false;
    console.error(`[queue] item ${item.id} (${item.kind}) used up ${cfg.maxAttempts} attempts without finishing -> dead letter`);
    await deadLetter(item.id, item.last_error || 'attempts exhausted (worker stopped while processing it)', item.claim);
    return true;
  };

  const failed = async (item, msg) => {
    if (item.attempts >= cfg.maxAttempts) {
      console.error(`[queue] item ${item.id} (${item.kind}) failed ${item.attempts} time(s), moved to dead letter: ${msg}`);
      await deadLetter(item.id, msg, item.claim);
    } else {
      const wait = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** (item.attempts - 1));
      console.warn(`[queue] item ${item.id} (${item.kind}) attempt ${item.attempts}/${cfg.maxAttempts} failed, retry in ${wait} ms: ${msg}`);
      // releases the claim (the heartbeat must not override the back-off)
      await pool.none(`UPDATE intake_queue SET last_error = $2, available_at = now() + ($3 || ' milliseconds')::interval, claimed_by = NULL
        WHERE id = $1 AND claimed_by IS NOT DISTINCT FROM $4`, [item.id, msg.slice(0, 2000), String(wait), item.claim ?? null]);
    }
  };

  const runEffects = async (label, effects) => {
    for (const fx of effects || []) {
      try { await fx(); } catch (err) { console.error(`[queue] ${label}: post-commit effect failed:`, err.message); }
    }
  };

  async function processOne(item) {
    if (await exhausted(item)) return;
    const handler = handlers[item.kind];
    let effects = [];
    try {
      if (!handler) throw new Error(`no handler for intake kind "${item.kind}"`);
      await pool.tx('intake-item', async (t) => {
        const row = await t.oneOrNone('SELECT claimed_by FROM intake_queue WHERE id = $1 FOR UPDATE', [item.id]);
        if (!row) return; // finished by another worker after our lease ran out
        if (item.claim && row.claimed_by !== item.claim) { // D3: re-claimed by another worker while we stalled
          stats.leaseLost++;
          console.warn(`[queue] item ${item.id} (${item.kind}): lease lost (now claimed by another worker), skipped here`);
          return;
        }
        const out = await handler(item.payload, t, item);
        effects = out?.effects || [];
        await t.none('DELETE FROM intake_queue WHERE id = $1', [item.id]);
      });
    } catch (err) {
      if (err?.deadLetter) { // D2: IntakeRejected -- retrying gives the same answer
        console.error(`[queue] item ${item.id} (${item.kind}) rejected, moved to dead letter: ${err.message}`);
        await deadLetter(item.id, err.message, item.claim);
        // wake an HTTP request waiting for this item (it then reads the reason)
        if (item.payload?.qid) await notifyDone(pool, item.payload.qid).catch(() => {});
        return;
      }
      await failed(item, err?.message || String(err));
      return;
    }
    await runEffects(`item ${item.id}`, effects);
  }

  // F5: one transaction for a group of items of the same kind and group key.
  async function processGroup(kind, items) {
    let effects = [];
    try {
      await pool.tx('intake-group', async (t) => {
        const ids = items.map((i) => i.id).sort((a, b) => Number(a) - Number(b));
        const rows = await t.any('SELECT id, claimed_by FROM intake_queue WHERE id IN ($1:csv) ORDER BY id FOR UPDATE', [ids]);
        const mine = new Set(rows.filter((r) => !items[0].claim || r.claimed_by === items[0].claim).map((r) => String(r.id)));
        if (rows.length > mine.size) {
          stats.leaseLost += rows.length - mine.size;
          console.warn(`[queue] group of ${items.length} ${kind} item(s): ${rows.length - mine.size} re-claimed by another worker (lease lost), skipped here`);
        }
        const live = items.filter((i) => mine.has(String(i.id)));
        if (!live.length) return;
        const out = await batchHandlers[kind].run(live.map((i) => i.payload), t);
        effects = out?.effects || [];
        await t.none('DELETE FROM intake_queue WHERE id IN ($1:csv)', [live.map((i) => i.id)]);
      });
    } catch (err) {
      console.warn(`[queue] group of ${items.length} ${kind} item(s) failed (${err.message}); running them one by one`);
      for (const item of items) await processOne(item);
      return;
    }
    stats.groups++; stats.groupedItems += items.length;
    await runEffects(`group of ${items.length}`, effects);
  }

  async function processClaimed(items) {
    const singles = [];
    const groups = new Map();
    for (const item of items) {
      if (await exhausted(item)) continue;
      const bh = batchHandlers[item.kind];
      if (bh && bh.canBatch(item.payload)) {
        const k = `${item.kind}|${bh.groupKey(item.payload)}`;
        if (!groups.has(k)) groups.set(k, { kind: item.kind, items: [] });
        groups.get(k).items.push(item);
      } else singles.push(item);
    }
    for (const g of groups.values()) {
      if (g.items.length === 1) singles.push(g.items[0]);
      else await processGroup(g.kind, g.items);
    }
    // Items of different tags have no order between them; these run by id.
    for (const item of singles.sort((a, b) => Number(a.id) - Number(b.id))) await processOne(item);
  }

  async function loop(lane, n) {
    const limit = lane === 'complaint' ? 1 : cfg.batchMax;
    while (running) {
      let items = [];
      try {
        items = await claim(lane, limit);
        if (items.length) {
          try { await processClaimed(items); } finally { held.delete(items[0].claim); } // D3: stop renewing this claim
        }
      } catch (err) {
        // the database itself is unreachable or similar: log, wait, carry on
        console.error(`[queue] ${lane} worker ${n}:`, err.message);
        await nap(cfg.pollMs * 4);
        continue;
      }
      if (!items.length) await nap(cfg.pollMs);
    }
  }

  const loops = [
    ...Array.from({ length: complaintLoops }, (_, i) => loop('complaint', i + 1)),
    ...Array.from({ length: mainLoops }, (_, i) => loop('main', i + 1)),
  ];
  console.log(`[queue] intake consumer started: ${mainLoops} worker(s) + ${complaintLoops} complaint-lane worker(s), batch ${cfg.batchMax} (feeder groups of up to ${cfg.groupMax} from the oldest ${cfg.claimScan} heads), own pool of ${poolMax}, lease ${cfg.leaseMs} ms renewed every ${heartbeatMs} ms, max ${cfg.maxAttempts} attempts`);
  return {
    async stop() { running = false; local.delete(wake); wake(); await Promise.all(loops); clearInterval(heartbeat); },
  };
}
