// OMS-03 workload engine unit tests (node:test; run with `npm run test:oms03`).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKLOAD_SETTINGS, effectivePriority, priorityInfo, jobWeight, crewLoads, isMovable, proposeRebalance, validateProposal,
} from './rebalance.js';

const crew = (id, o = {}) => ({ id, name: id, on_shift: true, capacity: 4, aor: null, skills: [], lat: null, lon: null, ...o });
const job = (id, crewId, o = {}) => ({
  id, crew_id: crewId, status: 'Acknowledged', priority: 'Normal', estimated_duration_min: 60,
  required_skill: null, area: null, lat: null, lon: null, planned: false, call_categories: [], incident_id: `INC-${id}`, ...o,
});
const loadOf = (rows, id) => rows.find((r) => r.crewId === id).load;
const movedIds = (r) => r.moves.map((m) => m.jobId);

test('effective priority takes the highest of job priority and linked call categories', () => {
  assert.equal(effectivePriority(job('J1', 'C1')), 'Normal');
  assert.equal(effectivePriority(job('J1', 'C1', { priority: 'Urgent' })), 'Urgent');
  assert.equal(effectivePriority(job('J1', 'C1', { call_categories: ['Normal', 'Premium-VIP'] })), 'VIP');
  assert.equal(effectivePriority(job('J1', 'C1', { priority: 'Urgent', call_categories: ['Critical'] })), 'Critical');
  assert.deepEqual(priorityInfo(job('J1', 'C1', { call_categories: ['Medical'] })), { priority: 'Critical', medical: true });
  assert.equal(priorityInfo(job('J1', 'C1', { call_categories: ['Critical'] })).medical, false);
});

test('job weight = priority weight x duration hours, defaults for missing duration', () => {
  const s = DEFAULT_WORKLOAD_SETTINGS;
  assert.equal(jobWeight(job('J1', 'C1', { estimated_duration_min: 120 }), s), 2);
  assert.equal(jobWeight(job('J1', 'C1', { priority: 'Critical', estimated_duration_min: 30 }), s), 1.5);
  assert.equal(jobWeight(job('J1', 'C1', { priority: 'Urgent', estimated_duration_min: null }), s), 2);
  assert.equal(jobWeight(job('J1', 'C1', { call_categories: ['Premium-VIP'] }), s), 2.5);
});

test('crew load counts active jobs only and uses default capacity', () => {
  const rows = crewLoads(
    [crew('C1'), crew('C2', { capacity: null })],
    [job('J1', 'C1'), job('J2', 'C1', { status: 'Work Complete' }), job('J3', 'C2', { status: 'On Site', estimated_duration_min: 120 })],
    DEFAULT_WORKLOAD_SETTINGS,
  );
  assert.deepEqual(rows.map((r) => [r.crewId, r.load, r.capacity, r.over]), [['C1', 0.25, 4, false], ['C2', 0.5, 4, false]]);
});

test('movable = unstarted, assigned, unplanned', () => {
  assert.equal(isMovable(job('J1', 'C1')), true);
  assert.equal(isMovable(job('J1', 'C1', { status: 'Pending Acceptance' })), true);
  assert.equal(isMovable(job('J1', 'C1', { status: 'Assigned' })), true);
  for (const status of ['En Route', 'On Site', 'Work Started', 'Work Complete']) assert.equal(isMovable(job('J1', 'C1', { status })), false);
  assert.equal(isMovable(job('J1', 'C1', { planned: true })), false);
  assert.equal(isMovable(job('J1', null)), false);
});

test('overloaded crew: exactly one move when one suffices, smallest sufficient job', () => {
  // C1 weight 5 on capacity 4 (125%). Removing either the 1h or 2h job fixes it; the smaller one moves.
  const crews = [crew('C1'), crew('C2')];
  const jobs = [
    job('J1', 'C1', { estimated_duration_min: 120 }),
    job('J2', 'C1', { estimated_duration_min: 60 }),
    job('J3', 'C1', { estimated_duration_min: 120 }),
  ];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS, trigger: 'manual' });
  assert.equal(r.moves.length, 1);
  assert.deepEqual(r.moves[0], {
    jobId: 'J2', incidentId: 'INC-J2', fromCrew: 'C1', toCrew: 'C2', reason: 'overload',
    priority: 'Normal', medical: false, weight: 1, distanceKm: null,
  });
  assert.equal(loadOf(r.before, 'C1'), 1.25);
  assert.equal(loadOf(r.after, 'C1'), 1);
  assert.equal(r.after.find((x) => x.crewId === 'C1').over, false);
  assert.equal(r.trigger, 'manual');
  assert.deepEqual(r.unassigned, []);
  assert.deepEqual(r.stuck, []);
});

test('overload with no single fix moves largest jobs first and never pushes a target over', () => {
  // C1 weight 8 (200%): needs 4 off. Largest movable (3) then 1.
  const crews = [crew('C1'), crew('C2'), crew('C3')];
  const jobs = [
    job('J1', 'C1', { estimated_duration_min: 180 }),
    job('J2', 'C1', { estimated_duration_min: 60 }),
    job('J3', 'C1', { estimated_duration_min: 240, status: 'On Site' }),
  ];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(movedIds(r), ['J1', 'J2']);
  for (const row of r.after) assert.ok(row.load <= 1, `${row.crewId} at ${row.load}`);
});

test('overloaded crew that cannot be relieved is reported stuck, not shuffled', () => {
  const crews = [crew('C1'), crew('C2')];
  const jobs = [
    job('J1', 'C1', { estimated_duration_min: 300 }),
    job('J2', 'C2', { estimated_duration_min: 180 }),
  ];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(r.moves, []);
  assert.equal(r.stuck.length, 1);
  assert.equal(r.stuck[0].crewId, 'C1');
  assert.equal(r.stuck[0].jobId, null);
  assert.match(r.warnings.join('\n'), /C1 stays overloaded/);
});

test('off-shift crew: movable jobs are redistributed, in-progress ones stay', () => {
  const crews = [crew('C1', { on_shift: false }), crew('C2'), crew('C3')];
  const jobs = [
    job('J1', 'C1'),
    job('J2', 'C1', { estimated_duration_min: 120 }),
    job('J3', 'C1', { status: 'En Route' }),
    job('J4', 'C1', { status: 'On Site' }),
    job('J5', 'C2', { estimated_duration_min: 60 }),
  ];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS, trigger: 'crew_off_shift' });
  // Heavier first: J2 -> C3 (empty), then J1 -> C2 vs C3 tie on 0.5 -> distance unknown -> id C2.
  assert.deepEqual(r.moves.map((m) => [m.jobId, m.toCrew, m.reason]), [['J2', 'C3', 'crew_off_shift'], ['J1', 'C2', 'crew_off_shift']]);
  assert.ok(!movedIds(r).includes('J3') && !movedIds(r).includes('J4'));
  assert.deepEqual(r.stuck.map((x) => x.jobId), ['J3', 'J4']);
  assert.equal(r.warnings.length, 2);
  const c1 = r.after.find((x) => x.crewId === 'C1');
  assert.equal(c1.onShift, false);
  assert.equal(c1.load, 0.5); // the two in-progress jobs remain
  assert.equal(r.before.length, 3);
  assert.equal(r.after.length, 3);
});

test('no eligible crew -> unassigned with a reason, not thrown or dropped', () => {
  const crews = [crew('C1', { on_shift: false, aor: ['Mayapur'], skills: ['HV'] }), crew('C2', { aor: ['Mayapur'], skills: ['LV'] }), crew('C3', { aor: ['Kankhal-2'], skills: ['HV'] })];
  const jobs = [
    job('J1', 'C1', { area: 'Mayapur', required_skill: 'HV' }),
    job('J2', 'C1', { area: 'Mayapur', required_skill: 'any' }),
  ];
  let r;
  assert.doesNotThrow(() => { r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS }); });
  assert.deepEqual(r.unassigned, [{ jobId: 'J1', fromCrew: 'C1', reason: 'no on-shift crew covers Mayapur with skill HV' }]);
  assert.deepEqual(r.moves.map((m) => [m.jobId, m.toCrew]), [['J2', 'C2']]);
  assert.equal(loadOf(r.after, 'C1'), 0);
});

test('in-progress jobs never appear in moves', () => {
  const crews = [crew('C1', { capacity: 1 }), crew('C2')];
  const jobs = ['En Route', 'On Site', 'Work Started'].map((status, i) => job(`J${i}`, 'C1', { status }));
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(r.moves, []);
  assert.equal(r.stuck[0].crewId, 'C1');
});

test('priority ordering: Critical/Medical placed before Normal when capacity is scarce', () => {
  // C1 is off shift. Only C2 has room (one weight-1 job) under threshold;
  // C3 is nearly full. Id order alone would place 'A-normal' first.
  const crews = [crew('C1', { on_shift: false }), crew('C2'), crew('C3')];
  const jobs = [
    job('A-normal', 'C1', { estimated_duration_min: 60 }), // weight 1
    job('Z-medical', 'C1', { estimated_duration_min: 20, call_categories: ['Medical'] }), // weight 3 x 1/3 = 1
    job('J8', 'C2', { estimated_duration_min: 180 }), // C2 at 75%
    job('J9', 'C3', { estimated_duration_min: 210 }), // C3 at 87.5%
  ];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(r.moves.map((m) => [m.jobId, m.toCrew]), [['Z-medical', 'C2'], ['A-normal', 'C3']]);
  assert.equal(r.moves[0].medical, true);
  assert.equal(r.moves[0].priority, 'Critical');
  assert.equal(loadOf(r.after, 'C2'), 1); // the Medical job got the in-threshold slot
  assert.equal(r.after.find((x) => x.crewId === 'C3').over, true); // the Normal one is placed over threshold
});

test('priority ordering in overload: equal weights, the higher priority job is placed first', () => {
  const crews = [crew('C1', { capacity: 2 }), crew('C2', { capacity: 2 }), crew('C3', { capacity: 1 })];
  const jobs = [
    job('J1', 'C1', { estimated_duration_min: 60, priority: 'Normal', status: 'On Site' }),
    job('J2', 'C1', { estimated_duration_min: 60 }),
    job('J3', 'C1', { estimated_duration_min: 20, call_categories: ['Critical'] }),
    job('J4', 'C1', { estimated_duration_min: 60 }),
  ];
  // C1 weight 4/2 = 200%: needs 2 moves of weight 1; Critical J3 goes first.
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.equal(r.moves.length, 2);
  assert.equal(r.moves[0].jobId, 'J3');
  assert.equal(r.moves[0].priority, 'Critical');
});

test('overload with no single fix: heaviest job moves first, light Critical job stays', () => {
  const crews = [crew('C1'), crew('C2', { capacity: 10 })];
  const jobs = [
    job('J1', 'C1', { estimated_duration_min: 10, call_categories: ['Critical'] }), // w 0.5
    job('J2', 'C1', { estimated_duration_min: 180 }), // w 3
    job('J3', 'C1', { estimated_duration_min: 180 }), // w 3
    job('J4', 'C1', { estimated_duration_min: 150 }), // w 2.5
  ];
  // C1 at 9/4 = 225%: J2 first (heaviest), then J4 is the smallest single fix (6 - 2.5 = 3.5).
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(movedIds(r), ['J2', 'J4']);
  assert.equal(loadOf(r.after, 'C1'), 0.875);
});

test('planned job on an off-shift crew is reported as planned, not in progress', () => {
  const r = proposeRebalance({ crews: [crew('C1', { on_shift: false }), crew('C2')], jobs: [job('J1', 'C1', { planned: true })], settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.equal(r.stuck[0].reason, 'Acknowledged: planned-outage job, left with crew');
  assert.ok(!/in progress/.test(r.warnings[0]));
});

test('AoR and skill filtering choose the only eligible crew', () => {
  const crews = [
    crew('C1', { on_shift: false, aor: ['Mayapur'] }),
    crew('C2', { aor: ['Kankhal-2'], skills: ['HV'] }), // wrong area
    crew('C3', { aor: ['Mayapur'], skills: ['LV'] }), // wrong skill
    crew('C4', { aor: ['Mayapur', 'Kankhal-2'], skills: ['lv', ' hv '] }), // case/space-insensitive
    crew('C5', { aor: null, skills: 'HV,Cable' }), // unrestricted legacy crew, CSV skills
  ];
  const jobs = [job('J1', 'C1', { area: 'Mayapur', required_skill: 'HV' }), job('J0', 'C5', { estimated_duration_min: 180 })];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(r.moves.map((m) => [m.jobId, m.toCrew]), [['J1', 'C4']]);
  // Without the heavy job on C5, C4 vs C5 tie on load -> id.
  const r2 = proposeRebalance({ crews, jobs: [jobs[0]], settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.equal(r2.moves[0].toCrew, 'C4');
  // A job with no area is eligible anywhere.
  const r3 = proposeRebalance({ crews: crews.slice(0, 2), jobs: [job('J2', 'C1', { area: null })], settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.equal(r3.moves[0].toCrew, 'C2');
});

test('distance breaks a load tie, then crew id', () => {
  const crews = [
    crew('C1', { on_shift: false }),
    crew('C2', { lat: 29.95, lon: 78.16 }),
    crew('C3', { lat: 29.90, lon: 78.10 }),
    crew('C4'), // no coords -> sorts last
  ];
  const jobs = [job('J1', 'C1', { lat: 29.91, lon: 78.11 })];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.equal(r.moves[0].toCrew, 'C3');
  assert.ok(r.moves[0].distanceKm > 0 && r.moves[0].distanceKm < 2);
  const noCoords = proposeRebalance({ crews, jobs: [job('J1', 'C1')], settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.equal(noCoords.moves[0].toCrew, 'C2');
  assert.equal(noCoords.moves[0].distanceKm, null);
});

test('planned-outage jobs never move', () => {
  const crews = [crew('C1', { on_shift: false }), crew('C2'), crew('C3', { capacity: 1 })];
  const jobs = [
    job('J1', 'C1', { planned: true }),
    job('J2', 'C3', { planned: true, estimated_duration_min: 180 }),
  ];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(r.moves, []);
  assert.deepEqual(r.unassigned, []);
  assert.ok(r.stuck.some((x) => x.jobId === 'J1'));
  assert.ok(r.stuck.some((x) => x.crewId === 'C3' && x.jobId === null));
});

test('threshold and weights come from settings', () => {
  const crews = [crew('C1'), crew('C2')];
  const jobs = [job('J1', 'C1', { estimated_duration_min: 120 }), job('J2', 'C1', { estimated_duration_min: 60 })];
  // Default: 3/4 = 75%, balanced.
  assert.deepEqual(proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS }).moves, []);
  // Threshold 0.5: 75% is over, moving the 1h job brings C1 to 50%.
  const lowT = proposeRebalance({ crews, jobs, settings: { ...DEFAULT_WORKLOAD_SETTINGS, overloadThreshold: 0.5 } });
  assert.deepEqual(movedIds(lowT), ['J2']);
  // Normal weight 2: 6/4 = 150%; moving the 2h job (weight 4) would put C2 at 100%, the 1h (2) leaves C1 at 100%.
  const heavy = { ...DEFAULT_WORKLOAD_SETTINGS, priorityWeights: { ...DEFAULT_WORKLOAD_SETTINGS.priorityWeights, Normal: 2 } };
  const r = proposeRebalance({ crews, jobs, settings: heavy });
  assert.deepEqual(movedIds(r), ['J2']);
  assert.equal(loadOf(r.before, 'C1'), 1.5);
  // Default capacity from settings applies to crews without one.
  const cap = proposeRebalance({ crews: [crew('C1', { capacity: null }), crew('C2')], jobs, settings: { ...DEFAULT_WORKLOAD_SETTINGS, defaultCapacity: 2 } });
  assert.equal(loadOf(cap.before, 'C1'), 1.5);
  assert.equal(cap.after.find((x) => x.crewId === 'C1').capacity, 2);
});

test('deterministic: same input in any order gives the same proposal; a job moves at most once', () => {
  const crews = [crew('C1', { on_shift: false }), crew('C2', { capacity: 2 }), crew('C3', { capacity: 2 }), crew('C4')];
  const jobs = [
    job('J1', 'C1', { estimated_duration_min: 90 }),
    job('J2', 'C1', { call_categories: ['Medical'] }),
    job('J3', 'C2', { estimated_duration_min: 150 }),
    job('J4', 'C2', { status: 'On Site' }),
    job('J5', 'C3'),
    job('J6', 'C4', { priority: 'Urgent', estimated_duration_min: 120 }),
  ];
  const a = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  const b = proposeRebalance({ crews: [...crews].reverse(), jobs: [...jobs].reverse(), settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a); // JSON-safe (no Infinity)
  assert.equal(new Set(movedIds(a)).size, a.moves.length);
});

test('empty input and missing settings do not throw', () => {
  const r = proposeRebalance({ crews: [], jobs: [] });
  assert.deepEqual([r.before, r.after, r.moves, r.unassigned, r.stuck], [[], [], [], [], []]);
  assert.deepEqual(r.settings, { ...DEFAULT_WORKLOAD_SETTINGS, priorityWeights: { ...DEFAULT_WORKLOAD_SETTINGS.priorityWeights } });
});

test('flagged (unassigned) jobs are offered again to an eligible crew with room', () => {
  const flagged = job('J1', null, { area: 'KK', required_skill: 'Fuse', estimated_duration_min: 60 });
  const none = proposeRebalance({ crews: [crew('C1', { aor: ['KK'], skills: ['MV'] })], jobs: [flagged], settings: DEFAULT_WORKLOAD_SETTINGS });
  assert.deepEqual([none.moves, none.unassigned], [[], []]);
  const crews = [crew('C1', { aor: ['KK'], skills: ['MV'] }), crew('C2', { aor: ['KK'], skills: ['Fuse'] }), crew('C3', { aor: ['KK'], skills: ['Fuse'], capacity: 1 })];
  const jobs = [flagged, job('J2', 'C3', { area: 'KK' }), job('J3', null, { planned: true }), job('J4', null, { status: 'Work Complete' })];
  const r = proposeRebalance({ crews, jobs, settings: DEFAULT_WORKLOAD_SETTINGS });
  // C3 has the skill but no room (100% already); planned and finished jobs stay put.
  assert.deepEqual(r.moves.map((m) => [m.jobId, m.fromCrew, m.toCrew, m.reason]), [['J1', null, 'C2', 'flagged_reassign']]);
  assert.equal(loadOf(r.after, 'C2'), 0.25);
});

test('validateProposal: a proposal whose reason no longer holds is stale', () => {
  const s = DEFAULT_WORKLOAD_SETTINGS;
  const crews = [crew('C1', { on_shift: false }), crew('C2'), crew('C3', { aor: ['X'] })];
  const jobs = [job('J1', 'C1'), job('J2', 'C1', { area: 'X' })];
  const p = proposeRebalance({ crews, jobs, settings: s });
  assert.deepEqual(validateProposal({ crews, jobs, settings: s, ...p }), []);
  // Crew back on shift: its jobs need not move.
  const back = crews.map((c) => (c.id === 'C1' ? { ...c, on_shift: true } : c));
  assert.ok(validateProposal({ crews: back, jobs, settings: s, ...p }).some((x) => /back on shift/.test(x)));
  // Job started or gone.
  assert.ok(validateProposal({ crews, jobs: [job('J1', 'C1', { status: 'En Route' }), jobs[1]], settings: s, ...p }).some((x) => /can no longer move/.test(x)));
  assert.ok(validateProposal({ crews, jobs: [jobs[1]], settings: s, ...p }).some((x) => /no longer active/.test(x)));

  // Overload: from-crew no longer over, or target would be pushed over.
  const oc = [crew('C1'), crew('C2')];
  const oj = [job('J1', 'C1', { estimated_duration_min: 180 }), job('J2', 'C1', { estimated_duration_min: 120 })];
  const op = proposeRebalance({ crews: oc, jobs: oj, settings: s });
  assert.equal(op.moves.length, 1);
  assert.deepEqual(validateProposal({ crews: oc, jobs: oj, settings: s, ...op }), []);
  const bigger = oc.map((c) => (c.id === 'C1' ? { ...c, capacity: 10 } : c));
  assert.ok(validateProposal({ crews: bigger, jobs: oj, settings: s, ...op }).some((x) => /no longer over/.test(x)));
  const busy = [...oj, job('J9', 'C2', { estimated_duration_min: 180 })];
  assert.ok(validateProposal({ crews: oc, jobs: busy, settings: s, ...op }).some((x) => /over the threshold/.test(x)));

  // Unassigned entry: another crew can now cover it.
  const uc = [crew('C1', { on_shift: false }), crew('C2', { aor: ['Y'] })];
  const uj = [job('J1', 'C1', { area: 'X' })];
  const up = proposeRebalance({ crews: uc, jobs: uj, settings: s });
  assert.equal(up.unassigned.length, 1);
  const covered = [uc[0], { ...uc[1], aor: ['X', 'Y'] }];
  assert.ok(validateProposal({ crews: covered, jobs: uj, settings: s, ...up }).some((x) => /can now take/.test(x)));
});
