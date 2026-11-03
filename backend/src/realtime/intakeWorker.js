// Intake queue wiring (runbook v2, WP2): what each queued kind runs, how the
// HTTP routes submit to the queue, and how they wait for the answer.
import { repo } from '../infra/repo.js';
import { enqueue, notifyDone, waitForDone, startIntakeConsumer } from '../infra/intakeQueue.js';
import { handleScadaEvent, handleScadaBatch, canBatchScada, scadaGroupKey } from './scada.js';
import { ingestComplaint, plannedNotice } from './complaintIntake.js';

// Each handler runs inside the queue item's transaction t and returns
// { result, effects }; the queue deletes the item in that same transaction.
export const intakeHandlers = {
  scada: (evt, t) => handleScadaEvent(evt, { cx: t, deferEffects: true }),
  complaint: async (p, t) => {
    const out = await ingestComplaint(p.body, p.who, { cx: t, deferEffects: true, qid: p.qid, ts: p.ts });
    await notifyDone(t, p.qid); // delivered at commit
    return out;
  },
};

// F5: queued SCADA trips of one feeder run as one transaction (realtime/scada.js).
export const intakeBatchHandlers = {
  scada: { canBatch: canBatchScada, groupKey: scadaGroupKey, run: (evts, t) => handleScadaBatch(evts, t) },
};

export const startIntakeWorker = (opts) => startIntakeConsumer(intakeHandlers, { batchHandlers: intakeBatchHandlers, ...opts });

export { enqueueScadaEvent } from './scada.js';

// The verified user, as much of it as the timeline and audit need.
const whoOf = (user) => (user && typeof user === 'object'
  ? { username: user.username, roles: user.roles || [], ...(user.crewId ? { crewId: user.crewId } : {}) }
  : user || null);

const syncWaitMs = () => Number(process.env.INTAKE_SYNC_WAIT_MS) || 15000;

// Queue a complaint and wait (up to INTAKE_SYNC_WAIT_MS) for it to be
// processed, so the external complaint service still gets its incident id in
// the same call. Returns { status, body }:
//   201  processed: same body as before the queue
//   200  duplicate: this externalId was already stored (duplicate: true)
//   202  accepted and queued, not processed yet (status: 'queued')
export async function submitComplaint(body, user) {
  const externalId = body.externalId || null;
  const existing = externalId && await repo.complaintByExternalId(externalId);
  if (existing) return { status: 200, body: await responseFor(existing, true) };

  const qid = await repo.nextQueryId();
  await enqueue('complaint', { qid, ts: new Date().toISOString(), body, who: whoOf(user) });
  const find = async () => (await repo.complaint(qid)) || (externalId && await repo.complaintByExternalId(externalId)) || null;
  await waitForDone(qid, { timeoutMs: syncWaitMs(), check: find });
  const c = await find();
  if (!c) return { status: 202, body: { queryId: qid, externalId, status: 'queued' } };
  const duplicate = c.qid !== qid;
  return { status: duplicate ? 200 : 201, body: await responseFor(c, duplicate) };
}

async function responseFor(c, duplicate) {
  const notice = !duplicate && c.action === 'merged' ? await plannedNotice(c.incident_id) : null;
  return {
    queryId: c.qid, externalId: c.external_id, action: c.action,
    incidentId: c.incident_id, feeder: c.feeder, substation: c.substation,
    complaint: c,
    ...(duplicate ? { duplicate: true } : {}),
    // OMS-01, additive: present only when the complaint was linked to a
    // planned outage; `message` is what to tell the customer.
    ...(notice ? { plannedOutage: notice } : {}),
  };
}
