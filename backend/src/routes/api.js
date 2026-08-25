import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { repo } from '../infra/repo.js';
import { requireRole } from './auth.js';
import { bus, TOPICS } from '../domain/bus.js';
import { canTransition, nextStates, LABELS } from '../domain/lifecycle.js';
import { computeIndices } from '../domain/indices.js';
import { resolve as resolveAsset, substations as netSubstations } from '../infra/geo.js';

export const api = Router();
const actor = (req) => req.header('x-user') || 'operator';

// ---------- network topology (real Haridwar GIS, loaded once — unchanged, no DB) ----------
const _dir = dirname(fileURLToPath(import.meta.url));
let NETWORK = null;
try { NETWORK = JSON.parse(readFileSync(join(_dir, '..', 'infra', 'network.json'), 'utf8')); }
catch { NETWORK = { counts: {}, substations: [], feederLines: [] }; }
api.get('/network', (req, res) => res.json(NETWORK));
api.get('/network/meta', (req, res) => res.json({ counts: NETWORK.counts, bounds: NETWORK.bounds, feeders: NETWORK.feeders }));

// ---------- incidents ----------
api.get('/incidents', async (req, res) => res.json(await repo.incidents()));

api.get('/incidents/:id', async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  res.json({ ...inc, events: await repo.incidentEvents(inc.id), nextStates: nextStates(inc.status), stateLabels: LABELS });
});

api.post('/incidents', async (req, res) => {
  const b = req.body || {};
  if (!b.zone || !b.severity) return res.status(400).json({ error: 'zone and severity are required (FR-OMS-002)' });
  const id = await repo.nextIncidentId();
  const opened = new Date().toISOString();
  const SLA = { critical: 90, high: 180, medium: 360, low: 720 }[b.severity] || 360;
  const inc = await repo.createIncident({
    id, type: b.type || 'Power Outage', severity: b.severity, status: 'open',
    zone: b.zone, feeder: b.feeder || null, customers: b.customers || 0, cause: b.cause || 'Unknown',
    lat: b.lat ?? null, lon: b.lon ?? null, crew_id: null, opened_at: opened,
    ert: null, sla_due_at: new Date(Date.now() + SLA * 60000).toISOString(), source: b.source || 'MANUAL',
  });
  await repo.addIncidentEvent(id, actor(req), 'created', `Manually created — ${b.cause || 'Unknown'}`);
  await repo.audit(actor(req), 'incident.create', id);
  bus.publish(TOPICS.INCIDENT_CREATED, inc);
  res.status(201).json(inc);
});

api.patch('/incidents/:id/status', requireRole('oms_operator', 'system_admin'), async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  const to = req.body?.status;
  if (!canTransition(inc.status, to))
    return res.status(409).json({ error: `illegal transition ${inc.status} → ${to}`, allowed: nextStates(inc.status) });
  const patch = { status: to };
  if (to === 'resolved') patch.ert = null;
  const updated = await repo.updateIncident(inc.id, patch);
  await repo.addIncidentEvent(inc.id, actor(req), 'status', `${LABELS[inc.status]} → ${LABELS[to]}${req.body?.note ? ' — ' + req.body.note : ''}`);
  await repo.audit(actor(req), 'incident.status', `${inc.id}:${to}`);
  bus.publish(TOPICS.INCIDENT_UPDATED, updated);
  await pushIndices();
  res.json(updated);
});

// ---------- dispatch ----------
api.post('/incidents/:id/assign', requireRole('oms_operator', 'system_admin'), async (req, res) => {
  const inc = await repo.incident(req.params.id);
  const crew = await repo.crew(req.body?.crewId);
  if (!inc || !crew) return res.status(404).json({ error: 'incident or crew not found' });
  await repo.updateIncident(inc.id, { crew_id: crew.id, status: inc.status === 'open' ? 'dispatched' : inc.status });
  await repo.updateCrew(crew.id, { status: 'in_transit', job_id: inc.id, location: inc.zone });
  const job = await repo.createJob({
    id: 'JOB-' + inc.id.slice(-3) + '-' + crew.id, incident_id: inc.id, crew_id: crew.id,
    priority: req.body?.priority || 'Normal', status: 'Acknowledged', address: inc.zone,
    updated_at: new Date().toISOString(),
  });
  // Nearest available crews to an incident (PostGIS distance-ranked)
api.get('/incidents/:id/nearest-crews', async (req, res) => {
  const inc = await repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  const crews = await repo.nearestAvailableCrews(inc.id);
  res.json(crews);
});
  await repo.addIncidentEvent(inc.id, actor(req), 'assigned', `${crew.name} assigned`);
  await repo.audit(actor(req), 'dispatch.assign', `${inc.id}→${crew.id}`);
  const updated = await repo.incident(inc.id);
  const updatedCrew = await repo.crew(crew.id);
  bus.publish(TOPICS.INCIDENT_UPDATED, updated);
  bus.publish(TOPICS.CREW_UPDATED, updatedCrew);
  bus.publish(TOPICS.JOB_UPDATED, job);
  res.json({ incident: updated, crew: updatedCrew, job });
});

// ---------- crews ----------
api.get('/crews', async (req, res) => res.json(await repo.crews()));

// ---------- alarms ----------
api.get('/alarms', async (req, res) => res.json(await repo.alarms()));

api.post('/alarms/:id/ack', async (req, res) => {
  const a = await repo.updateAlarm(req.params.id, { ack: 1 });
  await repo.audit(actor(req), 'alarm.ack', req.params.id);
  bus.publish(TOPICS.ALARM_ACKED, a);
  res.json(a);
});

api.post('/alarms/ack-all', async (req, res) => {
  // NOTE: was `.forEach(async ...)` — that pattern doesn't await, so it's a
  // correctness bug once repo calls are async. Use a real loop instead.
  const alarms = await repo.alarms();
  for (const a of alarms.filter(a => !a.ack)) {
    await repo.updateAlarm(a.id, { ack: 1 });
    bus.publish(TOPICS.ALARM_ACKED, { ...a, ack: 1 });
  }
  res.json(await repo.alarms());
});

// ---------- trouble calls ----------
api.get('/calls', async (req, res) => res.json(await repo.calls()));

api.post('/calls/:id/to-incident', async (req, res) => {
  const calls = await repo.calls();
  const call = calls.find(c => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: 'not found' });
  const id = await repo.nextIncidentId();
  const opened = new Date().toISOString();
  const inc = await repo.createIncident({
    id, type: 'Power Outage', severity: call.category === 'Critical' ? 'critical' : 'medium',
    status: 'open', zone: call.address, feeder: null, customers: 1, cause: 'Customer reported',
    lat: null, lon: null, crew_id: null, opened_at: opened, ert: null,
    sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(), source: 'TCS',
  });
  await repo.updateCall(call.id, { status: 'incident', linked_id: id });
  await repo.addIncidentEvent(id, actor(req), 'created', `From trouble call ${call.id} (${call.customer})`);
  bus.publish(TOPICS.INCIDENT_CREATED, inc);
  res.status(201).json(inc);
});

// ---------- complaints (external REST intake → dedup → merge → traceability) ----------
const CATEGORY_TYPE = { 'No Supply': 'Power Outage', 'Partial Supply': 'Partial Power', 'Voltage': 'Power Quality', 'Wire Down': 'Safety Hazard', 'Meter': 'Metering', 'Other': 'Power Outage' };
const CATEGORY_SEV = { 'Wire Down': 'critical', 'No Supply': 'high', 'Partial Supply': 'medium', 'Voltage': 'medium', 'Meter': 'low', 'Other': 'medium' };

const SUPPLY = ['No Supply', 'Partial Supply', 'Voltage'];      // symptoms of one outage
const OUTAGE_TYPES = ['Power Outage', 'Partial Power', 'Power Quality'];
// Decide whether a new complaint belongs to an already-open incident at the same substation. (pure, unchanged)
function pickIncident(candidates, category) {
  const supply = SUPPLY.includes(category);
  return candidates.find((c) =>
    supply ? (OUTAGE_TYPES.includes(c.type) || SUPPLY.includes(c.cause)) : c.cause === category) || null;
}

// Core intake: takes an external complaint, mints our own query id, resolves the
// affected substation, and either MERGES into an active matching incident or opens a new one.
async function ingestComplaint(body, who) {
  const qid = await repo.nextQueryId();
  const ts = new Date().toISOString();
  const category = body.category || 'No Supply';
  const lat = typeof body.lat === 'number' ? body.lat : null;
  const lon = typeof body.lon === 'number' ? body.lon : null;
  const loc = resolveAsset(lat, lon);                       // → nearest DT, feeder, substation (in-memory, sync)

  const candidates = loc.substation ? await repo.activeIncidentsAtSubstation(loc.substation) : [];
  const match = pickIncident(candidates, category);
  let incidentId, action;

  if (match) {                                              // MERGE
    incidentId = match.id; action = 'merged';
    await repo.updateIncident(match.id, { customers: (match.customers || 0) + 1 });
    await repo.addIncidentEvent(match.id, who, 'complaint', `Merged complaint ${qid}${body.externalId ? ' (ext ' + body.externalId + ')' : ''} — ${category}, ${body.customer || 'customer'}`);
    bus.publish(TOPICS.INCIDENT_UPDATED, await repo.incident(match.id));
  } else {                                                  // NEW
    incidentId = await repo.nextIncidentId(); action = 'created';
    const inc = await repo.createIncident({
      id: incidentId, type: CATEGORY_TYPE[category] || 'Power Outage', severity: CATEGORY_SEV[category] || 'medium',
      status: 'open', zone: loc.substation ? loc.substation.replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() : (body.address || 'Unknown'),
      feeder: loc.feeder, customers: 1, cause: category, lat: lat, lon: lon, crew_id: null,
      opened_at: ts, ert: null, sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(),
      source: 'Customer', substation: loc.substation,
    });
    await repo.addIncidentEvent(incidentId, who, 'created', `Opened from complaint ${qid} — ${category} near ${loc.substation || 'unknown'}`);
    bus.publish(TOPICS.INCIDENT_CREATED, inc);
  }

  const complaint = await repo.addComplaint({
    qid, external_id: body.externalId || null, customer: body.customer || null, phone: body.phone || null,
    address: body.address || null, category, lat, lon, dt_id: loc.dt_id, feeder: loc.feeder,
    substation: loc.substation, incident_id: incidentId, action, ts,
  });
  return { complaint, action, incidentId, resolved: loc };
}

api.get('/complaints', async (req, res) => res.json(await repo.complaints()));

// REST intake used by the external complaint service
api.post('/complaints', async (req, res) => {
  const r = await ingestComplaint(req.body || {}, actor(req));
  res.status(201).json({
    queryId: r.complaint.qid, externalId: r.complaint.external_id, action: r.action,
    incidentId: r.incidentId, feeder: r.resolved.feeder, substation: r.resolved.substation,
    complaint: r.complaint,
  });
});

// Full traceback: complaint → query → incident/problem → feeder → substation
api.get('/complaints/:qid/trace', async (req, res) => {
  const c = await repo.complaint(req.params.qid);
  if (!c) return res.status(404).json({ error: 'not found' });
  const inc = c.incident_id ? await repo.incident(c.incident_id) : null;
  const siblings = c.incident_id ? await repo.complaintsForIncident(c.incident_id) : [c];
  res.json({
    complaint: { qid: c.qid, externalId: c.external_id, customer: c.customer, category: c.category, address: c.address, ts: c.ts, action: c.action },
    incident: inc ? { id: inc.id, type: inc.type, severity: inc.severity, status: inc.status, customers: inc.customers } : null,
    feeder: c.feeder, substation: c.substation, dt: c.dt_id,
    grouped: siblings.length, groupedIds: siblings.map((s) => s.qid),
  });
});

// Demo helper: generate a realistic incoming complaint near a random substation
api.post('/complaints/simulate', async (req, res) => {
  const cats = ['No Supply', 'No Supply', 'Partial Supply', 'Voltage', 'Wire Down', 'Meter'];
  const names = ['Rakesh Verma', 'Sunita Devi', 'Imran Khan', 'Pooja Sharma', 'Deepak Rana', 'Anjali Bisht', 'Mohit Saini', 'Kavita Joshi'];
  const s = netSubstations[Math.floor(Math.random() * netSubstations.length)] || { lat: 29.95, lon: 78.13 };
  const body = {
    externalId: 'EXT-' + Math.floor(100000 + Math.random() * 899999),
    customer: names[Math.floor(Math.random() * names.length)],
    phone: '9' + Math.floor(100000000 + Math.random() * 899999999),
    category: cats[Math.floor(Math.random() * cats.length)],
    address: 'Near ' + (s.name || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim(),
    lat: s.lat + (Math.random() - 0.5) * 0.006, lon: s.lon + (Math.random() - 0.5) * 0.006,
  };
  const r = await ingestComplaint(body, 'complaint-api');
  res.status(201).json({ queryId: r.complaint.qid, action: r.action, incidentId: r.incidentId, substation: r.resolved.substation, feeder: r.resolved.feeder, category: body.category, customer: body.customer });
});

// ---------- indicators / analytics ----------
api.get('/indicators', async (req, res) => res.json(computeIndices(await repo.incidents())));
api.get('/analytics/monthly', async (req, res) =>
  res.json({ saidi: [2.1, 3.8, 2.9, 4.1, 3.6, 2.8, 3.2, 4.5, 3.0, 2.7, 3.9, computeIndices(await repo.incidents()).saidi] }));

// ---------- crew app (mobile) ----------
api.get('/mobile/crews/:id/jobs', async (req, res) => {
  // NOTE: was a sync `.map()` with a repo lookup inside — under async repo
  // calls that returns an array of unresolved Promises. Use Promise.all instead.
  const rawJobs = await repo.jobsForCrew(req.params.id);
  const jobs = await Promise.all(rawJobs.map(async (j) => ({ ...j, incident: await repo.incident(j.incident_id) })));
  res.json(jobs);
});

api.get('/mobile/crews/:id', async (req, res) => {
  const crew = await repo.crew(req.params.id);
  if (!crew) return res.status(404).json({ error: 'not found' });
  res.json(crew);
});

api.get('/mobile/jobs/:id/history', async (req, res) => res.json(await repo.jobUpdates(req.params.id)));

api.patch('/mobile/jobs/:id/status', async (req, res) => {
  const job = await repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { status, lat, lon, note } = req.body || {};
  await repo.updateJob(job.id, { status, updated_at: new Date().toISOString() });
  await repo.addJobUpdate(job.id, status, lat ?? null, lon ?? null, note ?? null);
  // reflect crew status + incident progress back to control room
  const map = { 'En Route': 'in_transit', 'On Site': 'in_service', 'Work Started': 'in_service', 'Work Complete': 'available' };
  if (map[status]) await repo.updateCrew(job.crew_id, { status: map[status] });
  if (status === 'On Site' && job.incident_id) await repo.updateIncident(job.incident_id, { status: 'in_progress' });
  if (status === 'Work Complete' && job.incident_id) {
    await repo.updateIncident(job.incident_id, { status: 'pending' });
    await repo.addIncidentEvent(job.incident_id, 'Crew', 'field', 'Work complete — awaiting verification');
  }
  const updated = await repo.job(job.id);
  const updatedCrew = await repo.crew(job.crew_id);
  bus.publish(TOPICS.JOB_UPDATED, updated);
  bus.publish(TOPICS.CREW_UPDATED, updatedCrew);
  if (job.incident_id) bus.publish(TOPICS.INCIDENT_UPDATED, await repo.incident(job.incident_id));
  res.json(updated);
});

// ---------- admin ----------
api.get('/audit', requireRole('system_admin'), async (req, res) => res.json(await repo.auditLog()));

async function pushIndices() { bus.publish(TOPICS.INDICES_UPDATED, computeIndices(await repo.incidents())); }
export { pushIndices };