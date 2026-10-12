// OMS-03 crew workload balancing: workload view, settings, crew resource
// changes and the propose -> approve -> apply flow. Mounted by routes/api.js
// (under requireAuth). The engine is domain/rebalance.js; data access and the
// transactional apply are in infra/repo.js. See docs/OMS03_WORKLOAD_BALANCING.md.
//
// Resource changes (crew added, on/off shift, capacity, AoR/skills) create a
// proposal automatically, but only a dispatcher's apply ever moves a job.
import { Router } from 'express';
import { repo } from '../infra/repo.js';
import { requireRole } from './auth.js';
import { bus, TOPICS } from '../domain/bus.js';
import { substations as netSubstations } from '../infra/geo.js';
import { proposeRebalance, crewLoads, priorityInfo, jobWeight, isMovable, PRIORITY_CLASSES } from '../domain/rebalance.js';

export const dispatchRoutes = Router();
const r = dispatchRoutes;

// Same async wrapper as api.js: a rejected handler becomes a JSON 500, not a hang.
for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
  const original = r[method].bind(r);
  r[method] = (path, ...handlers) => original(path, ...handlers.map((h) =>
    typeof h === 'function' ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h));
}

// field_crew_coordinator has no dispatch rights in the current role mapping, so it is not here.
const dispatcher = requireRole('oms_operator', 'system_admin');
// Every change is recorded against a person, taken from the verified token.
function needActor(req, res, next) {
  if (!req.user?.username) return res.status(401).json({ code: 'NO_IDENTITY', message: 'token has no username' });
  next();
}
const write = [dispatcher, needActor];
const bad = (res, message) => res.status(400).json({ code: 'INVALID', message });
const fail = (res, out) => res.status(out.error.status || 409).json({ code: out.error.code, message: out.error.message, ...(out.error.problems ? { problems: out.error.problems } : {}) });

const KNOWN_AREAS = new Set(netSubstations.map((s) => s.name));
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Body field parsers: undefined = not given, { error } = invalid.
function parseAor(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v) || v.some((a) => typeof a !== 'string')) return { error: 'aor must be an array of substation names' };
  const unknown = v.filter((a) => !KNOWN_AREAS.has(a));
  if (unknown.length) return { error: `unknown area: ${unknown.join(', ')}` };
  return [...new Set(v)];
}
function parseSkills(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list || list.some((s) => typeof s !== 'string')) return { error: 'skills must be an array or a comma-separated string' };
  const clean = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  return clean.length ? clean.join(',') : null;
}
const isErr = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'error' in v;

// ---------- proposals ----------

// Runs the engine on current data. Persists a proposal only when it would
// change something; otherwise reports "balanced" (with any warnings) and
// supersedes any open proposal, which was made for a situation that has gone.
async function propose(trigger, detail, actor) {
  const [crews, jobs, settings] = await Promise.all([repo.workloadCrews(), repo.workloadJobs(), repo.workloadSettings()]);
  const { settings: used, ...result } = proposeRebalance({ crews, jobs, settings, trigger });
  if (!result.moves.length && !result.unassigned.length) {
    const superseded = await repo.supersedeOpenProposals(actor, `situation changed (${trigger}): now balanced`);
    for (const p of superseded) bus.publish(TOPICS.DISPATCH_REBALANCE, { event: 'superseded', proposalId: p.id, trigger: p.trigger });
    return { proposal: null, reason: 'balanced', result, superseded: superseded.map((p) => p.id) };
  }
  const proposal = await repo.saveProposal({ trigger, detail, actor, settings: used, result });
  await repo.audit(actor, 'dispatch.rebalance.propose', `${proposal.id}:${trigger}`);
  bus.publish(TOPICS.DISPATCH_REBALANCE, { event: 'proposed', proposalId: proposal.id, trigger });
  return { proposal };
}

r.post('/dispatch/rebalance/propose', ...write, async (req, res) => {
  res.status(201).json(await propose('manual', req.body?.note ? String(req.body.note).slice(0, 500) : null, req.user.username));
});

r.get('/dispatch/rebalance/proposals', async (req, res) => {
  res.json(await repo.proposals(typeof req.query.status === 'string' ? req.query.status : null));
});

r.get('/dispatch/rebalance/proposals/:id', async (req, res) => {
  const p = await repo.proposal(req.params.id);
  if (!p) return res.status(404).json({ code: 'NOT_FOUND', message: 'proposal not found' });
  res.json(p);
});

r.post('/dispatch/rebalance/proposals/:id/apply', ...write, async (req, res) => {
  const out = await repo.applyProposal(req.params.id, req.user.username);
  if (out.error) {
    if (out.proposal) bus.publish(TOPICS.DISPATCH_REBALANCE, { event: 'stale', proposalId: out.proposal.id, trigger: out.proposal.trigger });
    return fail(res, out);
  }
  // Published after the transaction committed.
  for (const id of out.jobIds) bus.publish(TOPICS.JOB_UPDATED, await repo.job(id));
  for (const id of out.crewIds) bus.publish(TOPICS.CREW_UPDATED, await repo.crew(id));
  for (const id of out.incidentIds) bus.publish(TOPICS.INCIDENT_UPDATED, await repo.incident(id));
  bus.publish(TOPICS.DISPATCH_REBALANCE, { event: 'applied', proposalId: out.proposal.id, trigger: out.proposal.trigger });
  res.json({ proposal: out.proposal, moved: out.proposal.result.moves.length, unassigned: out.proposal.result.unassigned.length });
});

r.post('/dispatch/rebalance/proposals/:id/reject', ...write, async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  const out = await repo.rejectProposal(req.params.id, req.user.username, note);
  if (out.error) return fail(res, out);
  bus.publish(TOPICS.DISPATCH_REBALANCE, { event: 'rejected', proposalId: out.proposal.id, trigger: out.proposal.trigger });
  res.json(out);
});

r.get('/dispatch/rebalance/history', async (req, res) => {
  const [proposals, reassignments] = await Promise.all([repo.decidedProposals(), repo.reassignments()]);
  res.json({ proposals, reassignments });
});

// ---------- workload view ----------

r.get('/dispatch/workload', async (req, res) => {
  const [crews, jobs, settings, openProposal] = await Promise.all([
    repo.workloadCrews(), repo.workloadJobs(), repo.workloadSettings(), repo.openProposal()]);
  const loads = new Map(crewLoads(crews, jobs, settings).map((l) => [l.crewId, l]));
  const view = (j) => {
    const { priority, medical } = priorityInfo(j);
    return {
      id: j.id, incident_id: j.incident_id, crew_id: j.crew_id, status: j.status, priority: j.priority,
      effectivePriority: priority, medical, weight: Math.round(jobWeight(j, settings) * 1e4) / 1e4,
      movable: isMovable(j), planned: j.planned, area: j.area, required_skill: j.required_skill,
      estimated_duration_min: j.estimated_duration_min, call_categories: j.call_categories,
      flagged_reason: j.flagged_reason, flagged_at: j.flagged_at,
    };
  };
  res.json({
    settings,
    crews: crews.map((c) => {
      const l = loads.get(c.id);
      return { ...c, load: l.load, weight: l.weight, over: l.over, jobs: jobs.filter((j) => j.crew_id === c.id).map(view) };
    }),
    unassigned: jobs.filter((j) => j.crew_id == null).map(view),
    openProposal,
  });
});

// ---------- settings ----------

r.get('/dispatch/settings', async (req, res) => res.json(await repo.workloadSettings()));

r.put('/dispatch/settings', ...write, async (req, res) => {
  const b = req.body || {};
  const w = b.priorityWeights;
  if (!w || typeof w !== 'object' || !PRIORITY_CLASSES.every((c) => posNum(w[c]))) {
    return bad(res, `priorityWeights needs a positive number for each of ${PRIORITY_CLASSES.join(', ')}`);
  }
  if (!posNum(b.defaultDurationMin)) return bad(res, 'defaultDurationMin must be a positive number');
  if (!posNum(b.defaultCapacity)) return bad(res, 'defaultCapacity must be a positive number');
  if (!(typeof b.overloadThreshold === 'number' && b.overloadThreshold >= 0.1 && b.overloadThreshold <= 5)) {
    return bad(res, 'overloadThreshold must be between 0.1 and 5 (1.0 = 100%)');
  }
  const value = {
    priorityWeights: Object.fromEntries(PRIORITY_CLASSES.map((c) => [c, w[c]])),
    defaultDurationMin: b.defaultDurationMin, defaultCapacity: b.defaultCapacity, overloadThreshold: b.overloadThreshold,
  };
  const saved = await repo.saveWorkloadSettings(value, req.user.username);
  await repo.audit(req.user.username, 'dispatch.settings', JSON.stringify(value));
  // A settings change is not a resource change: no automatic proposal.
  res.json(saved);
});

// ---------- crew resources (each change re-proposes) ----------

r.post('/crews', ...write, async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return bad(res, 'name is required');
  if (b.id !== undefined && !(typeof b.id === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(b.id))) return bad(res, 'id must be 1-20 letters, digits, _ or -');
  const aor = parseAor(b.aor);
  if (isErr(aor)) return bad(res, aor.error);
  const skills = parseSkills(b.skills);
  if (isErr(skills)) return bad(res, skills.error);
  if (b.capacity !== undefined && !posNum(b.capacity)) return bad(res, 'capacity must be a positive number');
  for (const k of ['lat', 'lon']) if (b[k] != null && !(typeof b[k] === 'number' && Number.isFinite(b[k]))) return bad(res, `${k} must be a number`);
  const out = await repo.createCrew({
    id: b.id, name, lead: typeof b.lead === 'string' ? b.lead.trim() || null : null,
    location: typeof b.location === 'string' ? b.location.trim() || null : null,
    skills: skills ?? null, aor: aor ?? null, capacity: b.capacity ?? (await repo.workloadSettings()).defaultCapacity,
    lat: b.lat ?? null, lon: b.lon ?? null,
  });
  if (out.error) return fail(res, out);
  await repo.audit(req.user.username, 'crew.create', out.crew.id);
  bus.publish(TOPICS.CREW_UPDATED, out.crew);
  const rebalance = await propose('crew_added', `${out.crew.id} (${out.crew.name}) added`, req.user.username);
  res.status(201).json({ crew: out.crew, rebalance });
});

// Crew status implied by a job already under way, for a crew coming back on shift.
const CREW_STATUS_FOR_JOB = { 'En Route': 'in_transit', 'On Site': 'in_service', 'Work Started': 'in_service' };

r.patch('/crews/:id', ...write, async (req, res) => {
  const crew = await repo.crew(req.params.id);
  if (!crew) return res.status(404).json({ code: 'NOT_FOUND', message: 'crew not found' });
  const b = req.body || {};
  const patch = {};
  if (b.on_shift !== undefined) {
    if (typeof b.on_shift !== 'boolean') return bad(res, 'on_shift must be true or false');
    patch.on_shift = b.on_shift;
  }
  if (b.capacity !== undefined) {
    if (!posNum(b.capacity)) return bad(res, 'capacity must be a positive number');
    patch.capacity = b.capacity;
  }
  const aor = parseAor(b.aor);
  if (isErr(aor)) return bad(res, aor.error);
  if (aor !== undefined) patch.aor = aor;
  const skills = parseSkills(b.skills);
  if (isErr(skills)) return bad(res, skills.error);
  if (skills !== undefined) patch.skills = skills;
  if (!Object.keys(patch).length) return bad(res, 'nothing to change (on_shift, capacity, aor, skills)');

  const shiftChanged = patch.on_shift !== undefined && patch.on_shift !== crew.on_shift;
  if (shiftChanged && !patch.on_shift) patch.status = 'off_shift';
  if (shiftChanged && patch.on_shift) {
    const active = await repo.activeJobsForCrew(crew.id);
    const started = active.find((j) => CREW_STATUS_FOR_JOB[j.status]);
    patch.status = !active.length ? 'available' : started ? CREW_STATUS_FOR_JOB[started.status] : 'in_transit';
  }
  const updated = await repo.updateCrew(crew.id, patch);
  const fields = Object.keys(patch).filter((k) => k !== 'status').join(',');
  await repo.audit(req.user.username, 'crew.update', `${crew.id}:${fields}`);
  bus.publish(TOPICS.CREW_UPDATED, updated);

  const capChanged = patch.capacity !== undefined && Number(patch.capacity) !== Number(crew.capacity);
  const [trigger, detail] = shiftChanged
    ? (patch.on_shift ? ['crew_on_shift', `${crew.id} back on shift`] : ['crew_off_shift', `${crew.id} went off shift`])
    : capChanged ? ['capacity_changed', `${crew.id} capacity ${Number(crew.capacity)} -> ${patch.capacity}`]
      : ['crew_updated', `${crew.id} ${fields} changed`];
  const rebalance = await propose(trigger, detail, req.user.username);
  res.json({ crew: updated, rebalance });
});
