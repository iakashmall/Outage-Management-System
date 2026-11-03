// SCADA intake at storm rates (load-test findings F1, F2, F5; 3 Nov 2026).
//
// POST /scada/fault no longer writes alarm, queue item and audit row with
// separate statements per request. Requests are gathered into micro-batches
// (up to SCADA_BATCH_MAX events, or SCADA_BATCH_WAIT_MS after the first one)
// and each batch is ONE transaction:
//   1. one multi-row INSERT into alarms ... ON CONFLICT (event_key) DO NOTHING
//   2. one multi-row INSERT into intake_queue, for the alarms actually inserted
//   3. one multi-row INSERT into audit_log
//   4. COMMIT, then every request of the batch is answered
// A resend of an event already stored (same event_key, F2) inserts nothing
// and is answered 200 duplicate with the stored alarm id, also when the first
// copy was stored by a process that died before it could answer.
// Alarm and queue item commit together, so an alarm can never exist without
// its queue item (nothing accepted is left unprocessed) or the reverse.
// Queue items are inserted in arrival order, so the queue's per-tag ordering
// (trip, reclose, trip) is the order the requests arrived in.
import { nanoid } from 'nanoid';
import { db, pgp } from './db.js';
import { wakeConsumers } from './intakeQueue.js';
import { newAlarmId, scadaEventKey } from './ids.js';
import { scadaCoalesceKey } from '../realtime/scada.js';

const envInt = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
const batchMax = () => envInt('SCADA_BATCH_MAX', 500);
const batchWaitMs = () => envInt('SCADA_BATCH_WAIT_MS', 5);

const alarmCols = new pgp.helpers.ColumnSet(['id', 'tag', 'condition', 'limit_val', 'priority', 'message', 'ts', 'ack', 'event_key'], { table: 'alarms' });
const queueCols = new pgp.helpers.ColumnSet(['kind', { name: 'payload', mod: ':json' }, 'order_key', 'coalesce_key'], { table: 'intake_queue' });
const auditCols = new pgp.helpers.ColumnSet(['id', 'ts', 'actor', 'action', 'target'], { table: 'audit_log' });

// Test-only (selftest-scada-intake.js): when set, awaited after the batch
// commits and before any request is answered.
export const scadaIntakeTestHooks = { afterCommit: null };
export const scadaIntakeStats = { batches: 0, events: 0, duplicates: 0, maxBatch: 0 };

// Builds the event the queue and the bus carry, from a validated body.
export function buildScadaEvent(body) {
  const { tag, event = 'trip', customers, lat, lon, cim_mrid } = body;
  const reclose = event === 'reclose';
  const condition = body.condition || (reclose ? 'NORMAL' : 'CRITICAL');
  const limit_val = body.limit_val || (reclose ? 'CLOSED' : 'TRIP');
  return {
    id: newAlarmId(),
    tag, event, condition, limit_val,
    priority: reclose ? 3 : condition === 'CRITICAL' ? 1 : condition === 'MAJOR' ? 2 : 3,
    customers, feeder: body.feeder, substation: body.substation, lat, lon, cim_mrid,
    message: reclose ? `${tag} reclosed` : `${condition} injected on ${tag}`,
    ts: new Date().toISOString(), ack: 0,
    event_key: scadaEventKey(body),
  };
}

let pending = [];
let timer = null;

// Resolves { duplicate: false, event } once the event is durably queued, or
// { duplicate: true, alarmId } when the same event was stored before.
export function submitScadaEvent(evt, { actor = 'system', auditAction = 'scada.fault.inject' } = {}) {
  return new Promise((resolve, reject) => {
    pending.push({ evt, actor, auditAction, resolve, reject });
    if (pending.length >= batchMax()) flush();
    else if (!timer) timer = setTimeout(flush, batchWaitMs());
  });
}

function flush() {
  clearTimeout(timer); timer = null;
  const batch = pending; pending = [];
  if (batch.length) writeBatch(batch);
}

async function writeBatch(batch) {
  // The same event twice inside one batch: the first copy is written, the
  // others are answered as duplicates of it.
  const firstByKey = new Map();
  const unique = [];
  for (const b of batch) {
    const k = b.evt.event_key;
    if (k && firstByKey.has(k)) { b.dupOf = firstByKey.get(k); continue; }
    if (k) firstByKey.set(k, b);
    unique.push(b);
  }
  let inserted, existing;
  try {
    ({ inserted, existing } = await db.tx('scada-batch', async (t) => {
      const rows = unique.map(({ evt }) => ({
        id: evt.id, tag: evt.tag, condition: evt.condition, limit_val: evt.limit_val, priority: evt.priority,
        message: evt.message, ts: evt.ts, ack: evt.event === 'reclose' ? 1 : 0, event_key: evt.event_key ?? null,
      }));
      const ins = await t.any(`${pgp.helpers.insert(rows, alarmCols)}
        ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING RETURNING id`);
      const insertedIds = new Set(ins.map((r) => r.id));
      const fresh = unique.filter((b) => insertedIds.has(b.evt.id));
      const lostKeys = unique.filter((b) => !insertedIds.has(b.evt.id)).map((b) => b.evt.event_key);
      const found = lostKeys.length
        ? await t.any('SELECT id, event_key FROM alarms WHERE event_key IN ($1:csv)', [lostKeys]) : [];
      if (fresh.length) {
        await t.none(pgp.helpers.insert(fresh.map(({ evt }) => {
          const { event_key: _k, ...payload } = evt;
          return { kind: 'scada', payload, order_key: evt.tag ? `tag:${evt.tag}` : null, coalesce_key: scadaCoalesceKey(evt) };
        }), queueCols));
        const now = new Date().toISOString();
        await t.none(pgp.helpers.insert(fresh.map((b) => ({
          id: 'AU' + nanoid(10), ts: now, actor: b.actor, action: b.auditAction, target: `${b.evt.tag}:${b.evt.event}`,
        })), auditCols));
      }
      return { inserted: insertedIds, existing: new Map(found.map((r) => [r.event_key, r.id])) };
    }));
  } catch (err) {
    for (const b of batch) b.reject(err);
    return;
  }
  scadaIntakeStats.batches++; scadaIntakeStats.events += batch.length;
  scadaIntakeStats.maxBatch = Math.max(scadaIntakeStats.maxBatch, batch.length);
  if (inserted.size) wakeConsumers();
  if (scadaIntakeTestHooks.afterCommit) await scadaIntakeTestHooks.afterCommit(batch.map((b) => b.evt));
  for (const b of batch) {
    const src = b.dupOf || b;
    if (!b.dupOf && inserted.has(b.evt.id)) { b.resolve({ duplicate: false, event: b.evt }); continue; }
    const alarmId = b.dupOf ? (inserted.has(src.evt.id) ? src.evt.id : existing.get(src.evt.event_key)) : existing.get(b.evt.event_key);
    scadaIntakeStats.duplicates++;
    b.resolve({ duplicate: true, alarmId: alarmId || null });
  }
}
