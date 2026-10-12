// OMS-03 crew workload balancing. Pure functions over crews and jobs that
// the repo layer has already loaded -- no SQL, no I/O, no clock -- so a
// proposal is fully determined by its inputs and can be unit tested and
// re-validated at apply time. See docs/OMS03_WORKLOAD_BALANCING.md.
//
// Input shapes:
//   crew: { id, name, on_shift, capacity, aor: string[]|null, skills: string[], lat, lon }
//   job:  { id, crew_id, status, priority, estimated_duration_min, required_skill,
//           area, lat, lon, planned, call_categories: string[], incident_id }
// The engine only proposes; applying (and every trigger) lives in the repo.

export const PRIORITY_CLASSES = ['Critical', 'VIP', 'Urgent', 'Normal']; // high -> low
const RANK = { Critical: 4, VIP: 3, Urgent: 2, Normal: 1 };

export const DEFAULT_WORKLOAD_SETTINGS = Object.freeze({
  priorityWeights: Object.freeze({ Critical: 3, VIP: 2.5, Urgent: 2, Normal: 1 }),
  defaultDurationMin: 60,
  defaultCapacity: 4,
  overloadThreshold: 1.0,
});

export const INACTIVE_STATUSES = ['Work Complete', 'Cancelled', 'Closed', 'Rejected'];
// Only jobs nobody has started on may move; En Route / On Site / Work Started stay put.
export const MOVABLE_STATUSES = ['Acknowledged', 'Pending Acceptance', 'Assigned'];

// Trouble-call category -> priority class. Medical is Critical but keeps a
// marker so the dispatcher can see why.
const CALL_CATEGORY_CLASS = { medical: 'Critical', critical: 'Critical', 'premium-vip': 'VIP', normal: 'Normal' };

const EPS = 1e-9; // float slack so 4/4 counts as "at threshold", not over
const round = (n, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;
const posNum = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) && Number(v) > 0;
const norm = (s) => String(s ?? '').trim().toLowerCase();

function normClass(p) {
  const n = norm(p);
  return PRIORITY_CLASSES.find((c) => c.toLowerCase() === n) ?? null;
}

// Fill gaps in partial settings from the defaults (the PUT route validates;
// this just keeps the engine total).
export function normalizeSettings(settings) {
  const s = settings ?? {};
  const w = s.priorityWeights ?? {};
  const d = DEFAULT_WORKLOAD_SETTINGS;
  return {
    priorityWeights: Object.fromEntries(PRIORITY_CLASSES.map((c) => [c, posNum(w[c]) ? Number(w[c]) : d.priorityWeights[c]])),
    defaultDurationMin: posNum(s.defaultDurationMin) ? Number(s.defaultDurationMin) : d.defaultDurationMin,
    defaultCapacity: posNum(s.defaultCapacity) ? Number(s.defaultCapacity) : d.defaultCapacity,
    overloadThreshold: posNum(s.overloadThreshold) ? Number(s.overloadThreshold) : d.overloadThreshold,
  };
}

// { priority, medical }: the highest of the job's own priority and the
// categories of the trouble calls linked to its incident.
export function priorityInfo(job) {
  let best = normClass(job?.priority) ?? 'Normal';
  let medical = false;
  for (const cat of job?.call_categories ?? []) {
    const n = norm(cat);
    if (n === 'medical') medical = true;
    const c = CALL_CATEGORY_CLASS[n];
    if (c && RANK[c] > RANK[best]) best = c;
  }
  return { priority: best, medical };
}

export const effectivePriority = (job) => priorityInfo(job).priority;

export function jobWeight(job, settings) {
  const s = normalizeSettings(settings);
  const dur = posNum(job?.estimated_duration_min) ? Number(job.estimated_duration_min) : s.defaultDurationMin;
  return s.priorityWeights[effectivePriority(job)] * dur / 60;
}

export const isActive = (job) => !INACTIVE_STATUSES.includes(job?.status);

export const isMovable = (job) =>
  !!job && job.crew_id != null && MOVABLE_STATUSES.includes(job.status) && !job.planned;

const capacityOf = (crew, s) => (posNum(crew?.capacity) ? Number(crew.capacity) : s.defaultCapacity);

function crewSkills(crew) {
  const raw = Array.isArray(crew?.skills) ? crew.skills : String(crew?.skills ?? '').split(',');
  return new Set(raw.map(norm).filter(Boolean));
}

// No requirement when NULL/'any'; otherwise the crew must list the skill.
export function skillOk(crew, job) {
  const need = norm(job?.required_skill);
  return !need || need === 'any' || crewSkills(crew).has(need);
}

// Job without an area fits anyone; crew without an AoR is unrestricted (legacy rows).
export function aorOk(crew, job) {
  if (job?.area == null || job.area === '') return true;
  if (!Array.isArray(crew?.aor) || crew.aor.length === 0) return true;
  return crew.aor.includes(job.area);
}

export const isEligible = (crew, job) => aorOk(crew, job) && skillOk(crew, job);

const num = (v) => (v == null || v === '' ? NaN : Number(v));
export function distanceKm(crew, job) {
  const [la1, lo1, la2, lo2] = [num(crew?.lat), num(crew?.lon), num(job?.lat), num(job?.lon)];
  if (![la1, lo1, la2, lo2].every(Number.isFinite)) return Infinity;
  const r = Math.PI / 180;
  const a = Math.sin((la2 - la1) * r / 2) ** 2 +
    Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const byId = (a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

function loadRow(crew, weight, s) {
  const capacity = capacityOf(crew, s);
  const load = weight / capacity;
  return {
    crewId: crew.id, load: round(load), weight: round(weight), capacity,
    onShift: crew.on_shift !== false, over: load > s.overloadThreshold + EPS,
  };
}

// One row per crew (input order), counting active jobs only.
export function crewLoads(crews, jobs, settings) {
  const s = normalizeSettings(settings);
  const w = new Map(crews.map((c) => [c.id, 0]));
  for (const j of jobs) if (isActive(j) && w.has(j.crew_id)) w.set(j.crew_id, w.get(j.crew_id) + jobWeight(j, s));
  return crews.map((c) => loadRow(c, w.get(c.id), s));
}

export function proposeRebalance({ crews = [], jobs = [], settings, trigger = 'manual' } = {}) {
  const s = normalizeSettings(settings);
  const T = s.overloadThreshold;
  const crewList = [...crews].sort(byId);
  const crewById = new Map(crewList.map((c) => [c.id, c]));
  const onShift = crewList.filter((c) => c.on_shift !== false);
  const warnings = [];

  const active = jobs.filter(isActive).sort(byId);
  const info = new Map(active.map((j) => [j.id, { ...priorityInfo(j), weight: jobWeight(j, s) }]));
  const weightOf = new Map(crewList.map((c) => [c.id, 0]));
  const assigned = new Map(); // jobId -> crewId as planned so far
  for (const j of active) {
    // Flagged (crew_id NULL) jobs are not re-offered here; they are placed via manual assign.
    if (j.crew_id == null) continue;
    if (!crewById.has(j.crew_id)) { warnings.push(`job ${j.id} is on unknown crew ${j.crew_id}; ignored`); continue; }
    assigned.set(j.id, j.crew_id);
    weightOf.set(j.crew_id, weightOf.get(j.crew_id) + info.get(j.id).weight);
  }
  const before = crewList.map((c) => loadRow(c, weightOf.get(c.id), s));

  const loadOf = (id) => weightOf.get(id) / capacityOf(crewById.get(id), s);
  const projected = (crew, w) => (weightOf.get(crew.id) + w) / capacityOf(crew, s);
  const moved = new Set();
  const moves = [];
  const unassigned = [];
  const stuck = [];

  // High priority first, then heavy first, then id -- the placement order.
  const placementOrder = (a, b) =>
    RANK[info.get(b.id).priority] - RANK[info.get(a.id).priority] ||
    info.get(b.id).weight - info.get(a.id).weight || byId(a, b);

  // Lowest projected load, then nearest, then crew id.
  const pickTarget = (cands, job, w) => cands
    .map((c) => ({ c, load: projected(c, w), dist: distanceKm(c, job) }))
    .sort((x, y) => (Math.abs(x.load - y.load) > EPS ? x.load - y.load : 0) ||
      (x.dist === y.dist ? 0 : x.dist < y.dist ? -1 : 1) || byId(x.c, y.c))[0];

  const move = (job, from, pick, reason) => {
    const { weight, priority, medical } = info.get(job.id);
    weightOf.set(from, weightOf.get(from) - weight);
    weightOf.set(pick.c.id, weightOf.get(pick.c.id) + weight);
    assigned.set(job.id, pick.c.id);
    moved.add(job.id);
    moves.push({
      jobId: job.id, incidentId: job.incident_id ?? null, fromCrew: from, toCrew: pick.c.id, reason,
      priority, medical, weight: round(weight),
      distanceKm: Number.isFinite(pick.dist) ? round(pick.dist, 2) : null,
    });
  };

  // Phase A: crews that went off shift hand over everything not yet started.
  const offIds = new Set(crewList.filter((c) => c.on_shift === false).map((c) => c.id));
  const offJobs = active.filter((j) => offIds.has(assigned.get(j.id)));
  for (const j of offJobs.filter((x) => !isMovable(x))) {
    const why = j.planned ? 'planned-outage job' : 'in progress';
    stuck.push({ jobId: j.id, crewId: j.crew_id, reason: `${j.status}: ${why}, left with crew` });
    warnings.push(`job ${j.id} (${j.status}) is ${j.planned ? 'a planned-outage job' : 'in progress'} on off-shift crew ${j.crew_id}; left with crew`);
  }
  for (const j of offJobs.filter(isMovable).sort(placementOrder)) {
    const w = info.get(j.id).weight;
    const eligible = onShift.filter((c) => isEligible(c, j));
    if (!eligible.length) {
      const skill = norm(j.required_skill) && norm(j.required_skill) !== 'any' ? ` with skill ${j.required_skill}` : '';
      unassigned.push({ jobId: j.id, fromCrew: j.crew_id, reason: `no on-shift crew covers ${j.area ?? 'any area'}${skill}` });
      weightOf.set(j.crew_id, weightOf.get(j.crew_id) - w);
      assigned.delete(j.id);
      moved.add(j.id);
      continue;
    }
    const fit = eligible.filter((c) => projected(c, w) <= T + EPS);
    move(j, j.crew_id, pickTarget(fit.length ? fit : eligible, j, w), 'crew_off_shift');
  }

  // Phase B: relieve overloaded on-shift crews with as few moves as possible.
  // A move must leave the target at or under threshold, so overload is
  // removed, never shuffled around.
  const overloaded = onShift.filter((c) => loadOf(c.id) > T + EPS)
    .sort((a, b) => loadOf(b.id) - loadOf(a.id) || byId(a, b));
  for (const crew of overloaded) {
    const cap = capacityOf(crew, s);
    while (loadOf(crew.id) > T + EPS) {
      const cands = [];
      for (const j of active) {
        if (assigned.get(j.id) !== crew.id || moved.has(j.id) || !isMovable(j)) continue;
        const w = info.get(j.id).weight;
        const targets = onShift.filter((c) => c.id !== crew.id && isEligible(c, j) && projected(c, w) <= T + EPS);
        if (targets.length) cands.push({ j, w, targets });
      }
      if (!cands.length) break;
      const cur = weightOf.get(crew.id);
      const single = cands.filter((x) => (cur - x.w) / cap <= T + EPS)
        .sort((a, b) => a.w - b.w || placementOrder(a.j, b.j));
      // No single fix: move the heaviest job; priority only breaks weight ties.
      const pick = single[0] ?? cands.sort((a, b) => b.w - a.w || placementOrder(a.j, b.j))[0];
      move(pick.j, crew.id, pickTarget(pick.targets, pick.j, pick.w), 'overload');
    }
    if (loadOf(crew.id) > T + EPS) {
      const pct = Math.round(loadOf(crew.id) * 100);
      stuck.push({ jobId: null, crewId: crew.id, reason: `still at ${pct}%: no movable job fits another eligible crew` });
      warnings.push(`crew ${crew.id} stays overloaded at ${pct}%: no movable job fits another eligible crew`);
    }
  }

  const after = crewList.map((c) => loadRow(c, weightOf.get(c.id), s));
  return { trigger, settings: s, before, after, moves, unassigned, stuck, warnings };
}
