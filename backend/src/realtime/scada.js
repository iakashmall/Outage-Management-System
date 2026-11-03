import { nanoid } from 'nanoid';
import { bus, TOPICS } from '../domain/bus.js';
import { repo } from '../infra/repo.js';
import { resolve as resolveAsset } from '../infra/geo.js';
import { setTag, cacheDel } from '../infra/redis.js';
import { canScadaRestore, LABELS } from '../domain/lifecycle.js';
import { predictDownstream } from '../domain/prediction.js';
import { slaDueAt } from '../domain/sla.js';
import { sendRestorationCallbacks } from './notifier.js';
import { db } from '../infra/db.js';
import { lockScope, runIntake, runEffectsSafely, intakeTestHooks } from '../infra/intake.js';
import { enqueue } from '../infra/intakeQueue.js';
import { resolveScope } from '../infra/networkIdentity.js';

// ============================================================
// Phase 2 ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â SCADA & DMS integration: fault-event ingest + auto-detection
//
// This is the piece that turns the OMS from "operators manually raise
// incidents" into "the grid tells us it faulted and an incident appears on
// its own." It consumes SCADA fault events off the event bus (Kafka topic
// scada.alarm.raised ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â INT-001), and for each genuine fault:
//   1. resolves WHICH part of the network faulted (feeder/substation) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â via
//      the existing PostGIS-backed geo resolver;
//   2. de-duplicates against outages already open on the same asset within a
//      short window, so one feeder trip doesn't spawn 20 incidents
//      (FR-OMS-003);
//   3. classifies severity from the SCADA condition + how many customers the
//      faulted asset feeds (FR-OMS-004);
//   4. auto-creates the incident and publishes it, exactly as if an operator
//      had (FR-OMS-001).
//
// It deliberately reuses repo + geo + the bus rather than introducing a new
// data path, so everything the control room, indices, and dispatch already do
// works unchanged on an auto-detected incident.
// ============================================================

// Dedup (FR-OMS-003, decision D2): a fault joins an incident still open on
// the same feeder (or, feeder unknown, the same substation) opened within the
// last 4 hours, decided in the database under a per-feeder advisory lock
// (infra/intake.js). The old in-process 60 s map is gone: it raced under
// bursts and cannot be shared between processes (worker split, WP4).

// SCADA "condition" ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ base severity. TRIP/CRITICAL is a confirmed outage;
// MAJOR is likely; MINOR is usually a warning that isn't an outage on its own.
const CONDITION_SEVERITY = {
  CRITICAL: 'critical',
  TRIP: 'critical',
  MAJOR: 'high',
  MINOR: 'medium',
};

// Rough customers-per-kVA heuristic used only when we can't get a real count,
// so severity has *something* to weigh. Documented as an assumption, not a
// measurement ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Phase 3's load model will replace this.
const CUSTOMERS_PER_KVA = 2;

// Asset key used in timeline notes (the feeder, else the substation).

function assetKey(loc) {
  return (loc.feeder || loc.substation || 'UNKNOWN').toUpperCase();
}

// Is this SCADA condition actually an outage we should open an incident for?
// MINOR alarms (e.g. a load approaching a limit) are recorded but don't by
// themselves create an outage ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â that would flood the control room.
function isOutageCondition(condition) {
  const sev = CONDITION_SEVERITY[(condition || '').toUpperCase()];
  return sev === 'critical' || sev === 'high';
}

// Where a SCADA event happened, most precise first (OMS-05):
//   1. The event names the tripped equipment by mRID (evt.cim_mrid): that
//      equipment's own position and its feeder/substation from network.* are
//      authoritative -- an exact reference, not an inference -- and win over
//      the event's lat/lon and its tag. If the equipment has no position, the
//      event's reported lat/lon (or none) is kept: never an invented point.
//   2. / 3. Otherwise locateFromEvent below, unchanged.
// The honest limit: without cim_mrid there is still NO precise equipment
// link, exactly as before. Nothing here guesses a tag -> mRID mapping; that
// needs a tag dictionary (the SDP's UNS dictionary), which does not exist yet.
// An mRID that is not in network.* is reported, and the event located as if
// it had none.
async function locate(evt) {
  const base = locateFromEvent(evt);
  if (!evt.cim_mrid) return { ...base, equipment: null };
  const eq = await repo.equipmentByMrid(evt.cim_mrid).catch(() => null);
  if (!eq) return { ...base, equipment: null, unresolvedMrid: evt.cim_mrid };
  const positioned = eq.lat != null && eq.lon != null;
  return {
    ...base,
    feeder: eq.feeder || base.feeder,
    substation: eq.substation || base.substation,
    lat: positioned ? eq.lat : base.lat,
    lon: positioned ? eq.lon : base.lon,
    equipment: { id: eq.id, cim_mrid: eq.cim_mrid, cim_class: eq.cim_class, name: eq.name, positioned },
  };
}

const equipmentLabel = (e) => `${e.cim_class} ${e.name || e.cim_mrid} (${e.cim_mrid})`;

// Timeline note for how the incident was located (only when an mRID was given).
function locationNote(loc) {
  if (loc.equipment) {
    return `Tripped equipment: ${equipmentLabel(loc.equipment)} - ${loc.equipment.positioned
      ? 'location from the network model' : 'it has no position in the network model; location as reported by the event'}`;
  }
  if (loc.unresolvedMrid) return `Equipment ${loc.unresolvedMrid} is not in the network model - located from the tag/event only, no equipment link`;
  return null;
}

// A deduplicated event that names its equipment links the incident it joins,
// if that incident has no link yet: the equipment's point then replaces a
// merely reported position (equipment > reported > none). An incident
// already linked keeps its first equipment.
async function linkEquipment(t, incidentId, loc) {
  if (!loc.equipment) return;
  const inc = await repo.incident(incidentId, t);
  if (!inc || inc.tripped_equipment_id) return;
  const patch = { tripped_equipment_id: loc.equipment.id };
  if (loc.equipment.positioned) Object.assign(patch, { lat: loc.lat, lon: loc.lon });
  await repo.updateIncident(incidentId, patch, t);
  await repo.addIncidentEvent(incidentId, 'SCADA', 'field', locationNote(loc), undefined, t);
}

// Pull lat/lon out of a SCADA event if it carries them; otherwise fall back to
// resolving from the tag's asset. Real SCADA points are geo-tagged; the
// simulator's tags aren't, so we tolerate both.
function locateFromEvent(evt) {
  if (typeof evt.lat === 'number' && typeof evt.lon === 'number') {
    return { ...resolveAsset(evt.lat, evt.lon), lat: evt.lat, lon: evt.lon };
  }
  // Tag shape like "DEHRA.SE01.T2.MW" follows SUBSTATION.FEEDER.DEVICE.SIGNAL.
  // Without coordinates we can't geo-resolve, so we read the asset identity
  // straight from the tag path: token 0 = substation, tokens 0+1 = feeder.
  // Deriving both the same way every time is what makes dedup keys line up
  // regardless of whether a later event also carries explicit fields.
  const parts = (evt.tag || '').split('.').filter(Boolean);
  const substation = evt.substation || parts[0] || null;
  const feeder = evt.feeder || (parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null);
  return {
    dt_id: null,
    feeder,
    substation,
    substation_code: parts[0] || null,
    lat: null,
    lon: null,
  };
}

// Estimate affected customers for severity weighting. Prefers a real count if
// the event carries one; else a documented kVA-based heuristic; else 0.
function estimateCustomers(evt, loc) {
  if (typeof evt.customers === 'number') return evt.customers;
  if (typeof evt.kva === 'number') return Math.round(evt.kva * CUSTOMERS_PER_KVA);
  return 0;
}

// Final severity = base severity from condition, escalated one step if the
// faulted asset feeds a lot of customers. Keeps critical as the ceiling.
function classifySeverity(condition, customers) {
  let sev = CONDITION_SEVERITY[(condition || '').toUpperCase()] || 'medium';
  if (customers >= 1000 && sev === 'high') sev = 'critical';
  if (customers >= 500 && sev === 'medium') sev = 'high';
  return sev;
}

// The core handler: one SCADA fault event in, at most one incident out.
// Severity ranking so we can tell whether a SCADA confirmation should
// actually upgrade an incident's severity, or just corroborate it as-is.
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

// If the incident we just matched a SCADA event against was opened from a
// customer complaint alone (unconfirmed), a real electrical confirmation is
// meaningfully different from "one more customer said the same thing" --
// it should be logged distinctly, and if SCADA's own classification implies
// a higher severity than the complaint-based guess, the incident should be
// upgraded to reflect that. Returns true if it wrote a "confirmed" event
// (so the caller can skip its own generic dedup note).
async function corroborateFromCustomerReport(t, inc, evt, loc) {
  if (inc.source !== 'Customer') return false;
  const customers = estimateCustomers(evt, loc);
  const scadaSeverity = classifySeverity(evt.condition, customers);
  if (SEVERITY_RANK[scadaSeverity] > SEVERITY_RANK[inc.severity]) {
    await repo.updateIncident(inc.id, { severity: scadaSeverity }, t);
    await repo.addIncidentEvent(inc.id, 'SCADA', 'confirmed',
      `SCADA confirmed this outage (was customer-reported only) - severity upgraded ${inc.severity} to ${scadaSeverity}`, undefined, t);
  } else {
    await repo.addIncidentEvent(inc.id, 'SCADA', 'confirmed',
      `SCADA confirmed this outage (was customer-reported only) - severity unchanged (${inc.severity})`, undefined, t);
  }
  return true;
}

// ---- OMS-02: downstream prediction, trip tags, reclose ----

// Record the trip's tag on the incident it created or was merged into, and
// attach a downstream prediction if the incident doesn't have one yet.
// prediction is computed before the transaction (it may read network.*), so
// nothing inside the transaction waits for a second pool connection.
async function recordTrip(t, incidentId, evt, prediction) {
  if (evt.tag) await repo.addTripTag(incidentId, evt.tag, t);
  const inc = await repo.incident(incidentId, t);
  if (inc && !inc.prediction) {
    await repo.updateIncident(incidentId, { prediction }, t);
    await repo.addIncidentEvent(incidentId, 'SCADA', 'predicted', predictionNote(prediction), undefined, t);
  }
}

function predictionNote(p) {
  if (p.method === 'none') return `Downstream prediction unavailable: ${p.basis}`;
  if (p.method === 'cim-trace') return `Predicted downstream: ${p.transformers} transformers (CIM trace) - ${p.basis}`;
  return `Predicted downstream: ${p.transformers} transformers, ~${p.customers_estimate} customers (feeder-level, ${p.kva_total} kVA on ${p.feeder})`;
}

const momentaryMaxMin = () => Number(process.env.MOMENTARY_MAX_MIN) || 5;

// The tripped device reported closed again. Remove its tag from every active
// incident holding it; an incident is restored only once no tripped device
// remains open on it.
async function handleReclose(evt) {
  if (!evt.tag) return { restored: [], pending: [] };
  const touched = await repo.removeTripTag(evt.tag);
  const restored = [], pending = [];
  for (const inc of touched) {
    const left = inc.open_trip_tags || [];
    if (left.length) {
      await repo.addIncidentEvent(inc.id, 'SCADA', 'field', `${evt.tag} reclosed; still open: ${left.join(', ')}`);
      pending.push(inc.id);
      continue;
    }
    const r = await restoreFromScada(inc, evt.tag);
    if (r) restored.push(r);
  }
  return { restored, pending };
}

async function restoreFromScada(inc, tag) {
  if (!canScadaRestore(inc.status)) return null;
  // A planned outage (OMS-01) is restored only through its switching plan,
  // after the work permit is returned -- never by a device reporting closed.
  if (await repo.isPlannedIncident(inc.id)) return null;
  const now = new Date();
  const minutes = (now.getTime() - new Date(inc.opened_at).getTime()) / 60000;
  const momentary = minutes <= momentaryMaxMin();

  if (inc.crew_id) {
    await repo.addIncidentEvent(inc.id, 'SCADA', 'restored',
      `Restored by SCADA while crew ${inc.crew_id} assigned - confirm whether the crew is still needed`);
  }
  await repo.updateIncident(inc.id, { status: 'resolved', restored_by: 'SCADA', resolved_at: now.toISOString(), momentary, ert: null });
  await repo.addIncidentEvent(inc.id, 'SCADA', 'status',
    `${LABELS[inc.status]} - ${LABELS.resolved} - ${tag} reclosed after ${minutes.toFixed(1)} min (${momentary ? 'momentary' : 'sustained'})`);
  if (momentary) {
    await repo.updateIncident(inc.id, { status: 'closed' });
    await repo.addIncidentEvent(inc.id, 'SCADA', 'status',
      `${LABELS.resolved} - ${LABELS.closed} - auto-closed as momentary interruption (<= ${momentaryMaxMin()} min, counted in MAIFI)`);
  }
  await repo.audit('SCADA', momentary ? 'incident.momentary' : 'incident.scada_restored', inc.id);
  await cacheDel('indicators'); // SAIDI/SAIFI/MAIFI change now, not after the 15 s cache TTL
  const final = await repo.incident(inc.id);
  await sendRestorationCallbacks(final);
  // Published once, after the final status, so status-driven listeners fire once.
  bus.publish(TOPICS.INCIDENT_UPDATED, final);
  return { incidentId: inc.id, momentary, status: final.status };
}

// One SCADA event in, at most one incident out. Throws when the event could
// not be processed after the bounded retries (infra/intake.js withRetry): the
// caller (bus subscriber, intake queue) then logs it, retries it later or
// dead-letters it. Nothing is swallowed.
//   cx:            run inside this transaction (a savepoint), e.g. the queue's
//   deferEffects:  return { result, effects } instead of running the
//                  post-commit effects (bus publishes) here
export async function handleScadaEvent(evt, { cx = db, deferEffects = false } = {}) {
  // Always push the raw value into the RTDB tag cache first -- even non-outage
  // conditions matter for the live HMI (Phase 2's live tag view). Non-fatal
  // if Redis is down, and idempotent, so safe on a retry.
  if (evt.tag) {
    await setTag(evt.tag, evt.limit_val ?? evt.value ?? evt.condition, evt.quality || 'GOOD');
  }
  const done = (result, effects = []) => (deferEffects ? { result, effects } : result);

  // A reclose is idempotent (the tag is removed once), so it is not wrapped.
  if (evt.event === 'reclose') return done({ reclose: true, ...(await handleReclose(evt)) });

  if (!isOutageCondition(evt.condition)) return done(null); // recorded, not an outage

  // Reads that may use the network model run before the transaction, so the
  // transaction never waits on a second pool connection.
  // Canonical feeder / substation (G9): a tag feeder ("DEHRA.FDR7") resolves
  // to its network code through the identity tables, or stays unknown.
  const located = await locate(evt);
  const scope = await resolveScope(located);
  const loc = { ...located, feeder: scope.feeder, substation: scope.substation, scope };
  const prediction = await predictDownstream({ feeder: loc.feeder, cim_mrid: evt.cim_mrid });
  prediction.customers_source = typeof evt.customers === 'number' ? 'event' : 'estimated';

  const out = await runIntake('scada', (t) => scadaTripTx(t, evt, loc, prediction), { cx, runEffects: false });
  if (deferEffects) return out;
  await runEffectsSafely('scada', out.effects);
  return out.result;
}

// ---- F5: several queued trips of one feeder in one transaction ----
// The intake queue hands over the heads of several tags at once (at most one
// item per tag, so a tag's trip / reclose / trip order is untouched). Trips
// that need nothing per event beyond the merge (an outage condition, no
// equipment mRID, not a reclose) are grouped by the feeder they name and run
// as ONE transaction per group: one scope lock, one open-incident lookup,
// the first event creates or joins the incident exactly as handleScadaEvent
// does, then the rest are merged with multi-row writes (one INSERT of their
// timeline notes, one UPDATE linking their alarms, one UPDATE of the trip
// tags, at most one severity upgrade). Everything else runs one by one.
export const canBatchScada = (evt) => !!evt && evt.event !== 'reclose' && !evt.cim_mrid && isOutageCondition(evt.condition);
export const scadaGroupKey = (evt) => {
  const loc = locateFromEvent(evt);
  return `f:${loc.feeder || ''}|s:${loc.substation || ''}`;
};

export async function handleScadaBatch(evts, t) {
  await Promise.all(evts.filter((e) => e.tag).map((e) => setTag(e.tag, e.limit_val ?? e.value ?? e.condition, e.quality || 'GOOD')));
  const located = { ...locateFromEvent(evts[0]), equipment: null };
  const scope = await resolveScope(located, t);
  const loc = { ...located, feeder: scope.feeder, substation: scope.substation, scope };
  const prediction = await predictDownstream({ feeder: loc.feeder });
  prediction.customers_source = typeof evts[0].customers === 'number' ? 'event' : 'estimated';

  const first = await scadaTripTx(t, evts[0], loc, prediction);
  const rest = evts.slice(1);
  const effects = [...(first.effects || [])];
  if (!rest.length) return { result: [first.result], effects };

  const incidentId = first.result.incidentId;
  const inc = await repo.incident(incidentId, t);
  const fromCustomer = inc.source === 'Customer';
  const now = new Date().toISOString();
  const notes = rest.map((e) => ({
    id: 'EV' + nanoid(10), incident_id: incidentId, ts: now, actor: 'SCADA', actor_role: null,
    kind: fromCustomer ? 'confirmed' : 'field',
    note: fromCustomer
      ? `SCADA confirmed this outage (was customer-reported only) - ${e.condition} on ${e.tag || assetKey(loc)}`
      : `Correlated SCADA ${e.condition} on ${e.tag || assetKey(loc)} (deduplicated)${repeatsNote(e)}`,
  }));
  await t.none(`INSERT INTO incident_events (id,incident_id,ts,actor,actor_role,kind,note)
    SELECT n.id, n.incident_id, n.ts, n.actor, n.actor_role, n.kind, n.note
      FROM json_populate_recordset(NULL::incident_events, $1::json) n`, [JSON.stringify(notes)]);
  const alarmIds = rest.flatMap((e) => [e.id, ...(Array.isArray(e.coalesced_ids) ? e.coalesced_ids : [])]).filter(Boolean);
  if (alarmIds.length) await t.none('UPDATE alarms SET incident_id = $1 WHERE id IN ($2:csv)', [incidentId, alarmIds]);
  const tags = [...new Set(rest.map((e) => e.tag).filter(Boolean))];
  if (tags.length) {
    await t.none(`UPDATE incidents SET
        open_trip_tags = open_trip_tags || COALESCE((SELECT jsonb_agg(x) FROM unnest($2::text[]) x WHERE NOT (open_trip_tags ? x)), '[]'::jsonb),
        trip_tag = COALESCE(trip_tag, ($2::text[])[1])
      WHERE id = $1`, [incidentId, tags]);
  }
  if (fromCustomer) {
    const best = rest.map((e) => classifySeverity(e.condition, estimateCustomers(e, loc)))
      .reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), inc.severity);
    if (SEVERITY_RANK[best] > SEVERITY_RANK[inc.severity]) {
      await repo.updateIncident(incidentId, { severity: best }, t);
      await repo.addIncidentEvent(incidentId, 'SCADA', 'confirmed', `SCADA confirmed this outage - severity upgraded ${inc.severity} to ${best}`, undefined, t);
      const after = await repo.incident(incidentId, t);
      effects.push(() => bus.publish(TOPICS.INCIDENT_UPDATED, after));
    }
  }
  return { result: [first.result, ...rest.map(() => ({ deduplicated: true, incidentId }))], effects };
}

// The locked check-and-create for one trip, inside transaction t.
async function scadaTripTx(t, evt, loc, prediction) {
  const key = assetKey(loc);
  await lockScope(t, loc.scope);

  // --- de-duplication (FR-OMS-003, D2): same feeder, else same substation ---
  const [open] = await repo.activeIncidentsInScope(loc.scope, t);
  if (open) {
    // Attach as evidence to the existing incident instead of opening a new
    // one. If that incident was customer-reported only, this SCADA event is a
    // real confirmation, not just a repeat.
    const confirmed = await corroborateFromCustomerReport(t, open, evt, loc);
    if (!confirmed) {
      await repo.addIncidentEvent(open.id, 'SCADA', 'field',
        `Correlated SCADA ${evt.condition} on ${evt.tag || key} (deduplicated)${repeatsNote(evt)}`, undefined, t);
    }
    await linkAlarms(t, evt, open.id);
    await recordTrip(t, open.id, evt, prediction);
    await linkEquipment(t, open.id, loc);
    const after = await repo.incident(open.id, t);
    const effects = after.severity !== open.severity ? [() => bus.publish(TOPICS.INCIDENT_UPDATED, after)] : [];
    return { result: { deduplicated: true, incidentId: open.id }, effects };
  }

  // --- classify (FR-OMS-004) ---
  const customers = estimateCustomers(evt, loc);
  const severity = classifySeverity(evt.condition, customers);

  // --- downstream prediction (OMS-02) ---
  // A real customer count on the event always wins; otherwise the incident
  // carries the prediction's kVA-share estimate. Severity above is unchanged.
  const hasRealCount = typeof evt.customers === 'number';
  const incCustomers = hasRealCount || prediction.customers_estimate == null ? customers : prediction.customers_estimate;

  // --- auto-create the incident (FR-OMS-001) ---
  const id = await repo.nextIncidentId(t);
  const openedAt = new Date().toISOString();
  const created = await repo.createIncident({
      id,
      type: 'outage',
      severity,
      status: 'open',
      zone: loc.substation || null,
      feeder: loc.feeder || null,
      substation: loc.substation || null,
      customers: incCustomers,
      cause: `SCADA ${evt.condition} on ${evt.tag || key}`,
      lat: loc.lat,
      lon: loc.lon,
      crew_id: null,
      opened_at: openedAt,
      ert: null,
      sla_due_at: slaDueAt(severity, openedAt),
      source: 'SCADA',
    tripped_equipment_id: loc.equipment?.id ?? null,
  }, t);
  if (intakeTestHooks.afterIncidentInsert) await intakeTestHooks.afterIncidentInsert(t, { source: 'scada', id });
  await repo.addIncidentEvent(id, 'SCADA', 'created',
    `Auto-detected from SCADA ${evt.condition} on ${evt.tag || key} - ${severity} severity, ~${incCustomers} customers`, undefined, t);
  const where = locationNote(loc);
  if (where) await repo.addIncidentEvent(id, 'SCADA', 'field', where, undefined, t);
  await repo.audit('SCADA', 'incident.autodetect', id, t);
  await linkAlarms(t, evt, id);
  if (evt.tag) await repo.addTripTag(id, evt.tag, t);
  await repo.updateIncident(id, { prediction }, t);
  await repo.addIncidentEvent(id, 'SCADA', 'predicted', predictionNote(prediction), undefined, t);
  const inc = await repo.incident(id, t) || created;

  // A planned outage switching at this substation may explain the trip
  // (an isolate step opening a breaker). Say so on both timelines, but
  // still raise the incident: a real fault must never be hidden.
  if (loc.substation) {
    for (const po of await repo.activePlannedOutagesAtSubstation(loc.substation, t)) {
      await repo.addIncidentEvent(id, 'SCADA', 'field', `Planned outage ${po.incident_id} is ${po.status} at this substation - this trip may be its planned switching; verify before dispatching`, undefined, t);
      await repo.addIncidentEvent(po.incident_id, 'SCADA', 'field', `SCADA ${evt.condition} on ${evt.tag || key} raised ${id} - check whether it is this outage's planned switching`, undefined, t);
    }
  }

  return {
    result: { deduplicated: false, incidentId: id, incident: inc },
    effects: [() => bus.publish(TOPICS.INCIDENT_CREATED, inc)],
  };
}

// Wire the consumer to the bus. Call once at boot AFTER initBus().
// Subscribes to the same ALARM_RAISED topic the simulator already publishes to,
// so in local dev the existing simulated alarms now drive real auto-detection;
// in production the SCADA ingest adapter (DNP3/IEC 61968, P2.2) publishes to the
// same topic and nothing here changes.
// WP2: the subscriber only writes the event to the durable intake queue; the
// queue consumer (realtime/intakeWorker.js) runs handleScadaEvent. Events the
// HTTP route already queued arrive flagged queued: true and are skipped. The
// promise is returned, so the Kafka driver commits its offset only after the
// event is safely queued (and retries / dead-letters if that fails).
export function startScadaConsumer() {
  bus.subscribe(TOPICS.ALARM_RAISED, (evt) => (evt?.queued ? null : enqueueScadaEvent(evt)));
  console.log('[scada] fault-event consumer subscribed to', TOPICS.ALARM_RAISED, '(queues to intake_queue)');
}

// A SCADA event's queue position is ordered by its tag, so a trip is always
// processed before the reclose of the same device.
// Repeats of the same state on the same tag, queued while the previous one is
// still waiting, are coalesced into that item (infra/intakeQueue.js): the
// state is the event kind plus its condition, so a reclose never absorbs a
// trip, and a CRITICAL never absorbs a MAJOR.
export const scadaCoalesceKey = (evt) => (evt?.tag
  ? `scada|${evt.tag}|${evt.event === 'reclose' ? 'reclose' : `trip:${String(evt.condition || '').toUpperCase()}`}`
  : null);
export const enqueueScadaEvent = (evt) => {
  const { queued, ...clean } = evt || {};
  return enqueue('scada', clean, { orderKey: clean.tag ? `tag:${clean.tag}` : null, coalesceKey: scadaCoalesceKey(clean) });
};

// Every alarm row behind this event, including repeats coalesced into it,
// points at the incident it raised or joined.
async function linkAlarms(t, evt, incidentId) {
  const ids = [evt.id, ...(Array.isArray(evt.coalesced_ids) ? evt.coalesced_ids : [])].filter(Boolean);
  if (ids.length) await t.none('UPDATE alarms SET incident_id = $1 WHERE id IN ($2:csv)', [incidentId, ids]);
}
const repeatsNote = (evt) => (Array.isArray(evt.coalesced_ids) && evt.coalesced_ids.length
  ? ` (+${evt.coalesced_ids.length} identical event(s) coalesced while queued)` : '');

// Kept for the self-tests: dedup has no in-process state any more (WP1).
export function _resetDedupState() {}