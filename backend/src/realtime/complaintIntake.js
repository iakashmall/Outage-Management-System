// Complaint intake (external REST complaint service, the demo simulator, and
// the intake queue). Moved out of routes/api.js for runbook v2 WP1 and made
// burst-safe:
//   - one transaction per complaint: the incident (when one is opened), its
//     timeline events and the complaint row commit together or not at all;
//   - an advisory lock per feeder (infra/intake.js lockScope) around the
//     "merge or create" decision, so a burst on one feeder opens one incident;
//   - the merged incident's customer count is incremented in SQL;
//   - idempotent on external_id (and on our own qid): a repeat returns the
//     complaint already stored, flagged duplicate, and changes nothing;
//   - bounded retry of the whole transaction (infra/intake.js withRetry).
// Bus publishes and the indicators cache drop run only after the commit.
import { db } from '../infra/db.js';
import { repo } from '../infra/repo.js';
import { bus, TOPICS } from '../domain/bus.js';
import { resolve as resolveAsset } from '../infra/geo.js';
import { cacheDel } from '../infra/redis.js';
import { plannedComplaintDecision } from '../domain/plannedComplaints.js';
import { lockScope, lockExternalId, runIntake, runEffectsSafely, intakeTestHooks } from '../infra/intake.js';
import { resolveScope } from '../infra/networkIdentity.js';

const CATEGORY_TYPE = { 'No Supply': 'Power Outage', 'Partial Supply': 'Partial Power', 'Voltage': 'Power Quality', 'Wire Down': 'Safety Hazard', 'Meter': 'Metering', 'Other': 'Power Outage' };
const CATEGORY_SEV = { 'Wire Down': 'critical', 'No Supply': 'high', 'Partial Supply': 'medium', 'Voltage': 'medium', 'Meter': 'low', 'Other': 'medium' };

const SUPPLY = ['No Supply', 'Partial Supply', 'Voltage'];      // symptoms of one outage
const OUTAGE_TYPES = ['Power Outage', 'Partial Power', 'Power Quality'];
// Decide whether a new complaint belongs to one of the open incidents in its
// scope (same feeder, else same substation: decision D2). (pure)
// A supply complaint also joins an outage SCADA opened: scada.js creates those with
// type 'outage' and cause 'SCADA <condition> on <tag>', which neither list above matches.
const isScadaOutage = (c) => c.source === 'SCADA' || c.type === 'outage';
export function pickIncident(candidates, category) {
  const supply = SUPPLY.includes(category);
  return candidates.find((c) =>
    supply ? (OUTAGE_TYPES.includes(c.type) || SUPPLY.includes(c.cause) || isScadaOutage(c)) : c.cause === category) || null;
}

// Takes an external complaint, mints our own query id (unless the queue
// already did), resolves the affected feeder/substation, and either MERGES it
// into an open matching incident or opens a new one.
//   cx:           run inside this transaction (a savepoint), e.g. the queue's
//   deferEffects: return { result, effects } instead of running the effects
// Returns { complaint, action, incidentId, resolved, plannedOutage, duplicate }.
// Throws after the bounded retries; nothing is swallowed.
export async function ingestComplaint(body, who, { cx = db, deferEffects = false, qid = null, ts = null } = {}) {
  const id = qid || await repo.nextQueryId();
  const at = ts || new Date().toISOString();
  const out = await runIntake('complaint', (t) => complaintTx(t, body, who, id, at), { cx, runEffects: false });
  if (deferEffects) return out;
  await runEffectsSafely('complaint', out.effects);
  return out.result;
}

// What to tell a customer whose complaint joined a planned outage (OMS-01).
function noticeFor(incidentId, plannedOutageId, windowEnd) {
  const end = new Date(windowEnd);
  return {
    incidentId, plannedOutageId, windowEnd: end.toISOString(),
    message: `Planned maintenance is in progress in your area. Supply is expected to be restored by ${end.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}. Ref: ${incidentId}.`,
  };
}

// The same notice, rebuilt after the fact (the queued path answers from the
// stored complaint): null when the incident is not a planned outage.
export async function plannedNotice(incidentId, cx = db) {
  const po = incidentId && await cx.oneOrNone('SELECT id, window_end FROM planned_outages WHERE incident_id = $1', [incidentId]);
  return po ? noticeFor(incidentId, po.id, po.window_end) : null;
}

const duplicateOf = (c) => ({
  complaint: c, action: c.action, incidentId: c.incident_id, duplicate: true, plannedOutage: null,
  resolved: { dt_id: c.dt_id, feeder: c.feeder, substation: c.substation },
});

async function complaintTx(t, body, who, qid, ts) {
  const externalId = body.externalId || null;
  // --- idempotency: the same external id (or a redelivered qid) once only ---
  await lockExternalId(t, externalId);
  const already = (externalId && await repo.complaintByExternalId(externalId, t)) || await repo.complaint(qid, t);
  if (already) return { result: duplicateOf(already), effects: [] };

  const category = body.category || 'No Supply';
  const lat = typeof body.lat === 'number' ? body.lat : null;
  const lon = typeof body.lon === 'number' ? body.lon : null;
  const loc = resolveAsset(lat, lon);                       // nearest DT, feeder, substation (in-memory, sync)
  const scope = await resolveScope(loc, t);                 // canonical keys, the same rule SCADA uses (G9)
  await lockScope(t, scope);
  const effects = [];
  const ext = externalId ? ' (ext ' + externalId + ')' : '';

  // OMS-01: a supply complaint inside an active planned outage's window (same
  // feeder, or same substation when a feeder is unknown) belongs to that
  // planned outage, not to a new fault incident. A different feeder of the
  // same substation still opens a fault incident, noted below.
  const plannedDecision = loc.substation
    ? plannedComplaintDecision({ category, feeder: loc.feeder, substation: loc.substation }, await repo.plannedOutagesForComplaint(loc.substation, t))
    : { action: 'none' };
  const planned = plannedDecision.action === 'attach' ? plannedDecision.outage : null;

  const candidates = planned ? [] : await repo.activeIncidentsInScope(scope, t);
  const match = pickIncident(candidates, category);
  let incidentId, action, plannedOutage = null;

  if (planned) {                                            // PLANNED OUTAGE
    // action stays 'merged' (an existing incident) so the response values API
    // consumers know are unchanged; the plannedOutage field marks it.
    incidentId = planned.incident_id; action = 'merged';
    await repo.addIncidentEvent(incidentId, who, 'complaint',
      `Customer complaint during planned outage: ${qid}${ext} - ${category}, ${body.customer || 'customer'}`, undefined, t);
    plannedOutage = noticeFor(incidentId, planned.id, planned.window_end);
    effects.push(() => bus.publish(TOPICS.PLANNED_OUTAGE_UPDATED, { id: planned.id, incidentId, status: planned.status, complaint: qid }));
  } else if (match) {                                       // MERGE
    incidentId = match.id; action = 'merged';
    // Atomic in SQL: concurrent merges can never lose an increment.
    await t.none('UPDATE incidents SET customers = COALESCE(customers, 0) + 1 WHERE id = $1', [match.id]);
    await repo.addIncidentEvent(match.id, who, 'complaint', `Merged complaint ${qid}${ext} - ${category}, ${body.customer || 'customer'}`, undefined, t);
    const after = await repo.incident(match.id, t);
    effects.push(() => bus.publish(TOPICS.INCIDENT_UPDATED, after));
  } else {                                                  // NEW
    incidentId = await repo.nextIncidentId(t); action = 'created';
    const inc = await repo.createIncident({
      id: incidentId, type: CATEGORY_TYPE[category] || 'Power Outage', severity: CATEGORY_SEV[category] || 'medium',
      status: 'open', zone: loc.substation ? loc.substation.replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() : (body.address || 'Unknown'),
      feeder: loc.feeder, customers: 1, cause: category, lat: lat, lon: lon, crew_id: null,
      opened_at: ts, ert: null, sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(),
      source: 'Customer', substation: loc.substation,
    }, t);
    if (intakeTestHooks.afterIncidentInsert) await intakeTestHooks.afterIncidentInsert(t, { source: 'complaint', id: incidentId });
    await repo.addIncidentEvent(incidentId, who, 'created', `Opened from complaint ${qid} - ${category} near ${loc.substation || 'unknown'}`, undefined, t);
    effects.push(() => bus.publish(TOPICS.INCIDENT_CREATED, inc));
  }
  if (plannedDecision.action === 'note') {
    const po = plannedDecision.outage;
    await repo.addIncidentEvent(incidentId, who, 'complaint',
      `Planned outage ${po.incident_id} is active at this substation on feeder ${po.feeder} (this complaint resolved to feeder ${loc.feeder || 'unknown'})`, undefined, t);
  }

  const complaint = await repo.addComplaint({
    qid, external_id: externalId, customer: body.customer || null, phone: body.phone || null,
    address: body.address || null, category, lat, lon, dt_id: loc.dt_id, feeder: loc.feeder,
    substation: loc.substation, incident_id: incidentId, action, ts,
  }, t);
  effects.push(() => cacheDel('indicators'));
  return { result: { complaint, action, incidentId, resolved: loc, plannedOutage, duplicate: false }, effects };
}
