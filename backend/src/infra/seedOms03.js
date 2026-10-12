// OMS-03 workload-balancing demo (FAT): `npm run seed:oms03`, which is
// `seed.js --force --scenario=oms03` = the base seed plus this. Three crews
// share two substations (Mayapur, Kankhal-2); C003 is the crew-app demo
// login's crew, so reassigned jobs show up on that phone. C001/C002/C006
// cover other substations, so they are never eligible for these jobs.
//
// Load profile with the default settings, which this resets (weights Critical 3, VIP 2.5,
// Urgent 2, Normal 1; weight = class weight x hours; threshold 100%):
//   C003 cap 6: JOB-004 En Route (base seed, Medical call -> Critical) 3.0 + JOB-106 1.0  = 4.0  ->  67%
//   C004 cap 4: JOB-101 1.0, JOB-102 (Medical, 30 min) 1.5, JOB-103 (needs Fuse) 1.0,
//               JOB-104 (30 min) 0.5, JOB-105 En Route (Critical, 20 min) 1.0           = 5.0  -> 125%
//   C005 cap 5: JOB-107 (Premium-VIP, 30 min) 1.25 + JOB-108 1.0 + JOB-109 (30 min) 0.5 = 2.75 ->  55%
// Expected engine results (asserted in selftest-oms03.js):
//   (a) Rebalance: exactly one move, JOB-101 C004 -> C005 (C004 back to 100%).
//   (b) then C004 off shift: JOB-102 -> C003, JOB-104 -> C005, JOB-103 left
//       unassigned (no other crew in Kankhal-2 has Fuse), JOB-105 (En Route) stays.
import { db, syncIdSequences } from './db.js';
import { repo } from './repo.js';
import { CALL_SEVERITY } from '../domain/callState.js';
import { DEFAULT_WORKLOAD_SETTINGS } from '../domain/rebalance.js';

const MP = '33/11 kV MAYAPUR S/s', KK = '33/11 kV KANKHAL- 2 S/s';
const AREA = {
  [MP]: { zone: 'Mayapur', feeder: 'UPCL-MP-A', lat: 29.940311, lon: 78.147653 },
  [KK]: { zone: 'Kankhal-2', feeder: 'UPCL-KK-C', lat: 29.918303, lon: 78.143566 },
};
const SLA = { critical: 90, high: 180, medium: 360, low: 720 }; // minutes, as in seed.js

const CREWS = [
  // id, status, aor, skills, capacity, lat, lon
  ['C003', 'in_transit', [MP, KK], 'HV,Transformer', 6, 29.9390, 78.1490],
  ['C004', 'in_transit', [KK], 'MV,Fuse', 4, 29.9183, 78.1436],
  ['C005', 'in_transit', [MP, KK], 'MV,LV', 5, 29.9300, 78.1460],
];

const JOBS = [
  // n, customer, phone, address, call category, area, crew, job status, minutes, required skill, minutes ago, offset (lat, lon)
  [101, 'Lalit Bhatt', '9837100101', '4 Jagjeetpur Rd, Kankhal', 'Normal', KK, 'C004', 'Acknowledged', 60, null, 40, [0.0021, -0.0012]],
  [102, 'Sarla Devi', '9837100102', 'Nirmal Bagh, Kankhal (oxygen concentrator)', 'Medical', KK, 'C004', 'Acknowledged', 30, null, 35, [-0.0015, 0.0018]],
  [103, 'Kankhal Cold Store', '9837100103', 'Krishna Nagar DT, Kankhal', 'Normal', KK, 'C004', 'Acknowledged', 60, 'Fuse', 30, [0.0008, 0.0025]],
  [104, 'Mohan Lal', '9837100104', '12 Rajghat Rd, Kankhal', 'Normal', KK, 'C004', 'Acknowledged', 30, null, 25, [-0.0022, -0.0009]],
  [105, 'Kankhal Water Works', '9837100105', 'Pump House 2, Kankhal', 'Critical', KK, 'C004', 'En Route', 20, null, 50, [0.0012, 0.0006]],
  [106, 'Rekha Saini', '9837100106', '8 Shiv Murti Marg, Mayapur', 'Normal', MP, 'C003', 'Acknowledged', 60, null, 20, [0.0017, 0.0011]],
  [107, 'Ganga Heritage Hotel', '9837100107', 'Mal Godam Rd, Mayapur', 'Premium-VIP', MP, 'C005', 'Acknowledged', 30, null, 15, [-0.0011, 0.0021]],
  [108, 'Anil Kashyap', '9837100108', '21 Bairaj Rd, Mayapur', 'Normal', MP, 'C005', 'Acknowledged', 60, null, 12, [0.0024, -0.0016]],
  [109, 'Pushpa Rawat', '9837100109', 'Deopura Chowk, Mayapur', 'Normal', MP, 'C005', 'Acknowledged', 30, null, 8, [-0.0019, -0.0023]],
];

export async function seedOms03Demo() {
  if (await db.oneOrNone("SELECT 1 FROM trouble_calls WHERE id='CALL-101'")) return { skipped: true, reason: 'OMS-03 demo already seeded' };
  // The profile above assumes the default weights and threshold.
  await repo.saveWorkloadSettings(DEFAULT_WORKLOAD_SETTINGS, 'seed');
  for (const [id, status, aor, skills, capacity, lat, lon] of CREWS) {
    await repo.updateCrew(id, { status, aor, skills, capacity, lat, lon, on_shift: true });
  }
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const firstIncident = {};
  for (const [n, customer, phone, address, category, area, crewId, jobStatus, minutes, skill, minAgo, [dLat, dLon]] of JOBS) {
    const a = AREA[area];
    const severity = CALL_SEVERITY[category] || 'medium';
    const id = await repo.nextIncidentId();
    await repo.createIncident({
      id, type: 'Power Outage', severity, status: 'dispatched', zone: a.zone, feeder: a.feeder, customers: 1,
      cause: 'Customer reported', lat: a.lat + dLat, lon: a.lon + dLon, crew_id: crewId, opened_at: iso(minAgo),
      ert: null, sla_due_at: new Date(now + (SLA[severity] - minAgo) * 60000).toISOString(), source: 'TCS', substation: area,
    });
    await repo.createCall({ id: `CALL-${n}`, customer, phone, address, category, status: 'incident', linked_id: id, ts: iso(minAgo + 2), area });
    await repo.addIncidentEvent(id, 'seed', 'created', `From trouble call CALL-${n} (${customer})`);
    await repo.addIncidentEvent(id, 'seed', 'assigned', `${crewId} assigned`);
    await repo.createJob({
      id: `JOB-${n}`, incident_id: id, crew_id: crewId, priority: 'Normal', status: jobStatus, address,
      updated_at: iso(minAgo - 5), estimated_duration_min: minutes, required_skill: skill,
    });
    await repo.addJobUpdate(`JOB-${n}`, jobStatus, null, null, 'OMS-03 demo');
    if (jobStatus !== 'Acknowledged' || !firstIncident[crewId]) firstIncident[crewId] = id;
  }
  // crews.job_id points at a started job first (C004's En Route one).
  for (const crewId of ['C004', 'C005']) await repo.updateCrew(crewId, { job_id: firstIncident[crewId] });
  await syncIdSequences();
  return { seeded: true, crews: CREWS.length, calls: JOBS.length, jobs: JOBS.length };
}
