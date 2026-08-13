import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { repo } from '../infra/repo.js';
import { bus, TOPICS } from '../domain/bus.js';
import { canTransition, nextStates, LABELS } from '../domain/lifecycle.js';
import { computeIndices } from '../domain/indices.js';
import { resolve as resolveAsset, substations as netSubstations } from '../infra/geo.js';

export const api = Router();
const actor = (req) => req.header('x-user') || 'operator';

// ---------- network topology (real Haridwar GIS, loaded once) ----------
const _dir = dirname(fileURLToPath(import.meta.url));
let NETWORK = null;
try { NETWORK = JSON.parse(readFileSync(join(_dir, '..', 'infra', 'network.json'), 'utf8')); }
catch { NETWORK = { counts: {}, substations: [], feederLines: [] }; }
api.get('/network', (req, res) => res.json(NETWORK));
api.get('/network/meta', (req, res) => res.json({ counts: NETWORK.counts, bounds: NETWORK.bounds, feeders: NETWORK.feeders }));

// ---------- incidents ----------
api.get('/incidents', (req, res) => res.json(repo.incidents()));
api.get('/incidents/:id', (req, res) => {
  const inc = repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  res.json({ ...inc, events: repo.incidentEvents(inc.id), nextStates: nextStates(inc.status), stateLabels: LABELS });
});
api.post('/incidents', (req, res) => {
  const b = req.body || {};
  if (!b.zone || !b.severity) return res.status(400).json({ error: 'zone and severity are required (FR-OMS-002)' });
  const id = repo.nextIncidentId();
  const opened = new Date().toISOString();
  const SLA = { critical: 90, high: 180, medium: 360, low: 720 }[b.severity] || 360;
  const inc = repo.createIncident({
    id, type: b.type || 'Power Outage', severity: b.severity, status: 'open',
    zone: b.zone, feeder: b.feeder || null, customers: b.customers || 0, cause: b.cause || 'Unknown',
    lat: b.lat ?? null, lon: b.lon ?? null, crew_id: null, opened_at: opened,
    ert: null, sla_due_at: new Date(Date.now() + SLA * 60000).toISOString(), source: b.source || 'MANUAL',
  });
  repo.addIncidentEvent(id, actor(req), 'created', `Manually created — ${b.cause || 'Unknown'}`);
  repo.audit(actor(req), 'incident.create', id);
  bus.publish(TOPICS.INCIDENT_CREATED, inc);
  res.status(201).json(inc);
});
api.patch('/incidents/:id/status', (req, res) => {
  const inc = repo.incident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  const to = req.body?.status;
  if (!canTransition(inc.status, to))
    return res.status(409).json({ error: `illegal transition ${inc.status} → ${to}`, allowed: nextStates(inc.status) });
  const patch = { status: to };
  if (to === 'resolved') patch.ert = null;
  const updated = repo.updateIncident(inc.id, patch);
  repo.addIncidentEvent(inc.id, actor(req), 'status', `${LABELS[inc.status]} → ${LABELS[to]}${req.body?.note ? ' — ' + req.body.note : ''}`);
  repo.audit(actor(req), 'incident.status', `${inc.id}:${to}`);
  bus.publish(TOPICS.INCIDENT_UPDATED, updated);
  pushIndices();
  res.json(updated);
});

// ---------- dispatch ----------
api.post('/incidents/:id/assign', (req, res) => {
  const inc = repo.incident(req.params.id);
  const crew = repo.crew(req.body?.crewId);
  if (!inc || !crew) return res.status(404).json({ error: 'incident or crew not found' });
  repo.updateIncident(inc.id, { crew_id: crew.id, status: inc.status === 'open' ? 'dispatched' : inc.status });
  repo.updateCrew(crew.id, { status: 'in_transit', job_id: inc.id, location: inc.zone });
  const job = repo.createJob({
    id: 'JOB-' + inc.id.slice(-3) + '-' + crew.id, incident_id: inc.id, crew_id: crew.id,
    priority: req.body?.priority || 'Normal', status: 'Acknowledged', address: inc.zone,
    updated_at: new Date().toISOString(),
  });
  repo.addIncidentEvent(inc.id, actor(req), 'assigned', `${crew.name} assigned`);
  repo.audit(actor(req), 'dispatch.assign', `${inc.id}→${crew.id}`);
  const updated = repo.incident(inc.id);
  bus.publish(TOPICS.INCIDENT_UPDATED, updated);
  bus.publish(TOPICS.CREW_UPDATED, repo.crew(crew.id));
  bus.publish(TOPICS.JOB_UPDATED, job);
  res.json({ incident: updated, crew: repo.crew(crew.id), job });
});

// ---------- crews ----------
api.get('/crews', (req, res) => res.json(repo.crews()));

// ---------- alarms ----------
api.get('/alarms', (req, res) => res.json(repo.alarms()));
api.post('/alarms/:id/ack', (req, res) => {
  const a = repo.updateAlarm(req.params.id, { ack: 1 });
  repo.audit(actor(req), 'alarm.ack', req.params.id);
  bus.publish(TOPICS.ALARM_ACKED, a);
  res.json(a);
});
api.post('/alarms/ack-all', (req, res) => {
  repo.alarms().filter(a => !a.ack).forEach(a => { repo.updateAlarm(a.id, { ack: 1 }); bus.publish(TOPICS.ALARM_ACKED, { ...a, ack: 1 }); });
  res.json(repo.alarms());
});

// ---------- trouble calls ----------
api.get('/calls', (req, res) => res.json(repo.calls()));
api.post('/calls/:id/to-incident', (req, res) => {
  const call = repo.calls().find(c => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: 'not found' });
  const id = repo.nextIncidentId();
  const opened = new Date().toISOString();
  const inc = repo.createIncident({
    id, type: 'Power Outage', severity: call.category === 'Critical' ? 'critical' : 'medium',
    status: 'open', zone: call.address, feeder: null, customers: 1, cause: 'Customer reported',
    lat: null, lon: null, crew_id: null, opened_at: opened, ert: null,
    sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(), source: 'TCS',
  });
  repo.updateCall(call.id, { status: 'incident', linked_id: id });
  repo.addIncidentEvent(id, actor(req), 'created', `From trouble call ${call.id} (${call.customer})`);
  bus.publish(TOPICS.INCIDENT_CREATED, inc);
  res.status(201).json(inc);
});

// ---------- complaints (external REST intake → dedup → merge → traceability) ----------
const CATEGORY_TYPE = { 'No Supply': 'Power Outage', 'Partial Supply': 'Partial Power', 'Voltage': 'Power Quality', 'Wire Down': 'Safety Hazard', 'Meter': 'Metering', 'Other': 'Power Outage' };
const CATEGORY_SEV = { 'Wire Down': 'critical', 'No Supply': 'high', 'Partial Supply': 'medium', 'Voltage': 'medium', 'Meter': 'low', 'Other': 'medium' };

const SUPPLY = ['No Supply', 'Partial Supply', 'Voltage'];      // symptoms of one outage
const OUTAGE_TYPES = ['Power Outage', 'Partial Power', 'Power Quality'];
// Decide whether a new complaint belongs to an already-open incident at the same substation.
function pickIncident(candidates, category) {
  const supply = SUPPLY.includes(category);
  return candidates.find((c) =>
    supply ? (OUTAGE_TYPES.includes(c.type) || SUPPLY.includes(c.cause)) : c.cause === category) || null;
}

// Core intake: takes an external complaint, mints our own query id, resolves the
// affected substation, and either MERGES into an active matching incident or opens a new one.
function ingestComplaint(body, who) {
  const qid = repo.nextQueryId();
  const ts = new Date().toISOString();
  const category = body.category || 'No Supply';
  const lat = typeof body.lat === 'number' ? body.lat : null;
  const lon = typeof body.lon === 'number' ? body.lon : null;
  const loc = resolveAsset(lat, lon);                       // → nearest DT, feeder, substation

  const candidates = loc.substation ? repo.activeIncidentsAtSubstation(loc.substation) : [];
  const match = pickIncident(candidates, category);
  let incidentId, action;

  if (match) {                                              // MERGE
    incidentId = match.id; action = 'merged';
    repo.updateIncident(match.id, { customers: (match.customers || 0) + 1 });
    repo.addIncidentEvent(match.id, who, 'complaint', `Merged complaint ${qid}${body.externalId ? ' (ext ' + body.externalId + ')' : ''} — ${category}, ${body.customer || 'customer'}`);
    bus.publish(TOPICS.INCIDENT_UPDATED, repo.incident(match.id));
  } else {                                                  // NEW
    incidentId = repo.nextIncidentId(); action = 'created';
    const inc = repo.createIncident({
      id: incidentId, type: CATEGORY_TYPE[category] || 'Power Outage', severity: CATEGORY_SEV[category] || 'medium',
      status: 'open', zone: loc.substation ? loc.substation.replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim() : (body.address || 'Unknown'),
      feeder: loc.feeder, customers: 1, cause: category, lat: lat, lon: lon, crew_id: null,
      opened_at: ts, ert: null, sla_due_at: new Date(Date.now() + 180 * 60000).toISOString(),
      source: 'Customer', substation: loc.substation,
    });
    repo.addIncidentEvent(incidentId, who, 'created', `Opened from complaint ${qid} — ${category} near ${loc.substation || 'unknown'}`);
    bus.publish(TOPICS.INCIDENT_CREATED, inc);
  }

  const complaint = repo.addComplaint({
    qid, external_id: body.externalId || null, customer: body.customer || null, phone: body.phone || null,
    address: body.address || null, category, lat, lon, dt_id: loc.dt_id, feeder: loc.feeder,
    substation: loc.substation, incident_id: incidentId, action, ts,
  });
  return { complaint, action, incidentId, resolved: loc };
}

api.get('/complaints', (req, res) => res.json(repo.complaints()));

// REST intake used by the external complaint service
api.post('/complaints', (req, res) => {
  const r = ingestComplaint(req.body || {}, actor(req));
  res.status(201).json({
    queryId: r.complaint.qid, externalId: r.complaint.external_id, action: r.action,
    incidentId: r.incidentId, feeder: r.resolved.feeder, substation: r.resolved.substation,
    complaint: r.complaint,
  });
});

// Full traceback: complaint → query → incident/problem → feeder → substation
api.get('/complaints/:qid/trace', (req, res) => {
  const c = repo.complaint(req.params.qid);
  if (!c) return res.status(404).json({ error: 'not found' });
  const inc = c.incident_id ? repo.incident(c.incident_id) : null;
  const siblings = c.incident_id ? repo.complaintsForIncident(c.incident_id) : [c];
  res.json({
    complaint: { qid: c.qid, externalId: c.external_id, customer: c.customer, category: c.category, address: c.address, ts: c.ts, action: c.action },
    incident: inc ? { id: inc.id, type: inc.type, severity: inc.severity, status: inc.status, customers: inc.customers } : null,
    feeder: c.feeder, substation: c.substation, dt: c.dt_id,
    grouped: siblings.length, groupedIds: siblings.map((s) => s.qid),
  });
});

// Demo helper: generate a realistic incoming complaint near a random substation
api.post('/complaints/simulate', (req, res) => {
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
  const r = ingestComplaint(body, 'complaint-api');
  res.status(201).json({ queryId: r.complaint.qid, action: r.action, incidentId: r.incidentId, substation: r.resolved.substation, feeder: r.resolved.feeder, category: body.category, customer: body.customer });
});

// ---------- indicators / analytics ----------
api.get('/indicators', (req, res) => res.json(computeIndices(repo.incidents())));
api.get('/analytics/monthly', (req, res) =>
  res.json({ saidi: [2.1,3.8,2.9,4.1,3.6,2.8,3.2,4.5,3.0,2.7,3.9, computeIndices(repo.incidents()).saidi] }));

// ---------- crew app (mobile) ----------
api.get('/mobile/crews/:id/jobs', (req, res) => {
  const jobs = repo.jobsForCrew(req.params.id).map(j => ({ ...j, incident: repo.incident(j.incident_id) }));
  res.json(jobs);
});
api.get('/mobile/crews/:id', (req, res) => {
  const crew = repo.crew(req.params.id);
  if (!crew) return res.status(404).json({ error: 'not found' });
  res.json(crew);
});
api.get('/mobile/jobs/:id/history', (req, res) => {
  res.json(repo.jobUpdates(req.params.id));
});
api.patch('/mobile/jobs/:id/status', (req, res) => {
  const job = repo.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { status, lat, lon, note } = req.body || {};
  repo.updateJob(job.id, { status, updated_at: new Date().toISOString() });
  repo.addJobUpdate(job.id, status, lat ?? null, lon ?? null, note ?? null);
  // reflect crew status + incident progress back to control room
  const map = { 'En Route': 'in_transit', 'On Site': 'in_service', 'Work Started': 'in_service', 'Work Complete': 'available' };
  if (map[status]) repo.updateCrew(job.crew_id, { status: map[status] });
  if (status === 'On Site' && job.incident_id) repo.updateIncident(job.incident_id, { status: 'in_progress' });
  if (status === 'Work Complete' && job.incident_id) {
    repo.updateIncident(job.incident_id, { status: 'pending' });
    repo.addIncidentEvent(job.incident_id, 'Crew', 'field', 'Work complete — awaiting verification');
  }
  const updated = repo.job(job.id);
  bus.publish(TOPICS.JOB_UPDATED, updated);
  bus.publish(TOPICS.CREW_UPDATED, repo.crew(job.crew_id));
  if (job.incident_id) bus.publish(TOPICS.INCIDENT_UPDATED, repo.incident(job.incident_id));
  res.json(updated);
});

// ---------- admin ----------
api.get('/audit', (req, res) => res.json(repo.auditLog()));

function pushIndices() { bus.publish(TOPICS.INDICES_UPDATED, computeIndices(repo.incidents())); }
export { pushIndices };
