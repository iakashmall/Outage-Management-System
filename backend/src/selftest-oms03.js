// OMS-03 workload-balancing self-test: schema on a fresh database, ID
// sequences after seeding, the demo load profile, propose -> apply (and the
// DB it leaves behind), off-shift redistribution with an unassignable job,
// stale and rejected proposals, the crew-app ownership check, the
// append-only reassignment log and role guards. Same style as
// selftest-oms01.js: real DB, real routes, identities injected the way
// requireAuth would attach them.
// Run: DATABASE_URL=<scratch db> node src/selftest-oms03.js  (npm run test:oms03:db)
// Destructive: it runs seed --force. It does not read .env.
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate, db } from './infra/db.js';
import { seed } from './infra/seed.js';
import { seedOms03Demo } from './infra/seedOms03.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { bus, initBus, TOPICS } from './domain/bus.js';

if (!process.env.DATABASE_URL) {
  console.error('selftest-oms03: set DATABASE_URL to a scratch database (this test reseeds it)');
  process.exit(2);
}
// Same throwaway key the other self-tests use when none is set (complaint phones).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';

const MP = '33/11 kV MAYAPUR S/s', KK = '33/11 kV KANKHAL- 2 S/s';

// Complaint intake needs pgcrypto plus the manual phone migrations (as in selftest-oms01.js).
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
async function enableComplaintPhones() {
  try {
    if (!(await db.oneOrNone("SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto'"))) return 'pgcrypto is not available';
    const sql = (file) => readFileSync(`${REPO_ROOT}db/migrations/${file}`, 'utf8');
    await db.none(sql('encrypt_phone_at_rest.sql').replace(/:key\b/g, db.$config.pgp.as.text(process.env.ENCRYPTION_KEY)));
    await db.none(sql('safe_decrypt_phone.sql'));
    return null;
  } catch (err) {
    return err.message;
  }
}

await migrate();
// job_reassignments survives reseeding (append-only), so rows from earlier runs are filtered by time.
const runStart = (await db.one('SELECT now() AS t')).t;
await seed({ force: true });
const demo = await seedOms03Demo();
await initBus();

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

const USERS = {
  op: { username: 'op.sharma', roles: ['oms_operator'], crewId: null },
  admin: { username: 'admin.joshi', roles: ['system_admin'], crewId: null },
  coord: { username: 'coord.rawat', roles: ['field_crew_coordinator'], crewId: null },
  noname: { username: undefined, roles: ['oms_operator'], crewId: null },
  c3: { username: 'crew03', roles: ['field_crew'], crewId: 'C003' },
  c4: { username: 'crew04', roles: ['field_crew'], crewId: 'C004' },
};
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = USERS[req.header('x-test-as') || 'op']; next(); });
app.use('/api', api);

const events = [];
bus.subscribe(TOPICS.DISPATCH_REBALANCE, (e) => events.push(e));

const server = app.listen(0, async () => {
  const { port } = server.address();
  const call = async (as, method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-as': as },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const job = (id) => repo.job(id);
  const crewOf = async (id) => (await job(id))?.crew_id ?? null;
  const loadOf = (wl, id) => wl.crews.find((c) => c.id === id);
  const throws = async (sql) => { try { await db.none(sql); return false; } catch { return true; } };

  try {
    console.log('-- schema and seeding on a fresh database');
    check('demo seeded', demo.seeded === true, JSON.stringify(demo));
    const cols = await db.any(`SELECT table_name || '.' || column_name c FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN ('crews','jobs')`);
    const has = (c) => cols.some((x) => x.c === c);
    check('crews has capacity/on_shift/aor', has('crews.capacity') && has('crews.on_shift') && has('crews.aor'));
    check('jobs has estimated_duration_min/required_skill/flagged_reason/flagged_at',
      ['estimated_duration_min', 'required_skill', 'flagged_reason', 'flagged_at'].every((c) => has(`jobs.${c}`)));
    const st = (await call('op', 'GET', '/dispatch/settings')).body;
    check('default workload settings', st.overloadThreshold === 1 && st.defaultCapacity === 4 && st.defaultDurationMin === 60
      && st.priorityWeights?.Critical === 3 && st.priorityWeights?.VIP === 2.5 && st.priorityWeights?.Urgent === 2 && st.priorityWeights?.Normal === 1, JSON.stringify(st));
    const base = await repo.crews();
    check('base seed: every crew has its own substation as AoR',
      ['C001', 'C002', 'C006'].every((id) => base.find((c) => c.id === id)?.aor?.length === 1) && base.every((c) => c.on_shift === true));

    console.log('-- ID sequences are past the seeded IDs');
    const maxInc = (await db.one(`SELECT max((substring(id from '[0-9]+$'))::bigint) n FROM incidents WHERE id ~ '^INC-[0-9]{4}-[0-9]+$'`)).n;
    const created = await call('op', 'POST', '/incidents', { zone: 'Mayapur', severity: 'low', cause: 'oms03 sequence check' });
    check('POST /incidents after seed -> 201 with a new id', created.status === 201 && Number(created.body.id.slice(-6)) > Number(maxInc), `${created.body.id} > ${maxInc}`);
    const phones = await enableComplaintPhones();
    if (phones) console.log(`  [SKIPPED] complaint sequence check: ${phones}`);
    else {
      const comp = await call('op', 'POST', '/complaints', { customer: 'Seq Check', phone: '9000000000', category: 'Meter', address: 'Mayapur', lat: 29.9403, lon: 78.1476 });
      check('POST /complaints after seed -> 201 with a new query id', comp.status === 201 && Number(comp.body.queryId?.slice(-6)) > 4, comp.body.queryId);
    }

    console.log('-- demo load profile');
    let wl = (await call('op', 'GET', '/dispatch/workload')).body;
    const over = wl.crews.filter((c) => c.over).map((c) => c.id);
    check('exactly one crew over 100% (C004 at 125%)', over.length === 1 && over[0] === 'C004' && loadOf(wl, 'C004').load === 1.25, JSON.stringify(over));
    check('C003 67%, C005 55%', loadOf(wl, 'C003').load === 0.6667 && loadOf(wl, 'C005').load === 0.55);
    const j102 = loadOf(wl, 'C004').jobs.find((j) => j.id === 'JOB-102');
    check('Medical call makes JOB-102 Critical (weight 1.5, medical marker)', j102?.effectivePriority === 'Critical' && j102.medical === true && j102.weight === 1.5);
    check('En Route JOB-105 is not movable', loadOf(wl, 'C004').jobs.find((j) => j.id === 'JOB-105')?.movable === false);
    check('demo crews only: C001/C002/C006 cover other substations',
      ['C001', 'C002', 'C006'].every((id) => !loadOf(wl, id).aor.includes(MP) && !loadOf(wl, id).aor.includes(KK)));

    console.log('-- roles and identity');
    check('field_crew_coordinator cannot propose (403)', (await call('coord', 'POST', '/dispatch/rebalance/propose')).status === 403);
    check('token without a username -> 401 NO_IDENTITY', (await call('noname', 'POST', '/dispatch/rebalance/propose')).body.code === 'NO_IDENTITY');
    check('crew cannot change a crew (403)', (await call('c3', 'PATCH', '/crews/C003', { capacity: 9 })).status === 403);

    console.log('-- (a) manual rebalance: minimal moves off the overloaded crew');
    let r = await call('op', 'POST', '/dispatch/rebalance/propose');
    const p1 = r.body.proposal;
    check('manual propose -> 201 proposal', r.status === 201 && p1?.status === 'proposed' && p1.trigger === 'manual' && p1.created_by === 'op.sharma');
    const m1 = p1?.result.moves || [];
    check('exactly one move: JOB-101 C004 -> C005 (overload)', m1.length === 1 && m1[0].jobId === 'JOB-101' && m1[0].fromCrew === 'C004' && m1[0].toCrew === 'C005' && m1[0].reason === 'overload', JSON.stringify(m1));
    check('nothing applied before approval', (await crewOf('JOB-101')) === 'C004');
    check('field_crew_coordinator cannot apply (403)', (await call('coord', 'POST', `/dispatch/rebalance/proposals/${p1.id}/apply`)).status === 403);
    r = await call('op', 'POST', `/dispatch/rebalance/proposals/${p1.id}/apply`);
    check('apply -> 200', r.status === 200 && r.body.proposal?.status === 'applied' && r.body.proposal.decided_by === 'op.sharma', JSON.stringify(r.body).slice(0, 200));
    check('jobs.crew_id moved', (await crewOf('JOB-101')) === 'C005');
    const inc101 = await repo.incident((await job('JOB-101')).incident_id);
    check('incidents.crew_id moved', inc101.crew_id === 'C005');
    let ras = await db.any('SELECT * FROM job_reassignments WHERE proposal_id=$1', [p1.id]);
    check('job_reassignments row: job, from, to, reason, actor, ts', ras.length === 1 && ras[0].job_id === 'JOB-101' && ras[0].from_crew === 'C004'
      && ras[0].to_crew === 'C005' && ras[0].reason === 'overload' && ras[0].actor === 'op.sharma' && !!ras[0].ts && ras[0].incident_id === inc101.id);
    check('job update + incident event + audit row written',
      (await repo.jobUpdates('JOB-101')).some((u) => /Reassigned from C004 to C005/.test(u.note || ''))
      && (await repo.incidentEvents(inc101.id)).some((e) => e.kind === 'reassigned' && e.actor === 'op.sharma')
      && !!(await db.oneOrNone("SELECT 1 FROM audit_log WHERE action='dispatch.rebalance.apply' AND target=$1", [p1.id])));
    check('crew app: C005 list has JOB-101, C004 list does not',
      (await call('op', 'GET', '/mobile/crews/C005/jobs')).body.some((j) => j.id === 'JOB-101')
      && !(await call('op', 'GET', '/mobile/crews/C004/jobs')).body.some((j) => j.id === 'JOB-101'));
    wl = (await call('op', 'GET', '/dispatch/workload')).body;
    check('after apply nobody is over 100%', wl.crews.every((c) => !c.over) && loadOf(wl, 'C004').load === 1, `C004 ${loadOf(wl, 'C004').load}`);
    check('applying again -> 409', (await call('op', 'POST', `/dispatch/rebalance/proposals/${p1.id}/apply`)).status === 409);
    r = await call('op', 'POST', '/dispatch/rebalance/propose');
    check('balanced: manual propose stores nothing', r.status === 201 && r.body.proposal === null && r.body.reason === 'balanced');

    console.log('-- crew app ownership (NOT_YOUR_JOB)');
    r = await call('c4', 'PATCH', '/mobile/jobs/JOB-101/status', { status: 'En Route' });
    check('old crew (token C004) updating a moved job -> 409 NOT_YOUR_JOB', r.status === 409 && r.body.code === 'NOT_YOUR_JOB');
    r = await call('op', 'PATCH', '/mobile/jobs/JOB-101/status', { status: 'En Route', crewId: 'C004' });
    check('demo login naming the old crew in the body -> 409 NOT_YOUR_JOB', r.status === 409 && r.body.code === 'NOT_YOUR_JOB');
    check('the job is unchanged', (await job('JOB-101')).status === 'Acknowledged');

    console.log('-- (b) C004 off shift: automatic proposal, never applied by itself');
    r = await call('op', 'PATCH', '/crews/C004', { on_shift: false });
    let p = r.body.rebalance?.proposal;
    check('PATCH on_shift=false -> crew off_shift', r.status === 200 && r.body.crew.on_shift === false && r.body.crew.status === 'off_shift');
    check('stale test proposal created (crew_off_shift)', p?.status === 'proposed' && p.trigger === 'crew_off_shift');
    // Make it stale: JOB-104 starts before the dispatcher approves.
    await call('op', 'PATCH', '/mobile/jobs/JOB-104/status', { status: 'En Route', crewId: 'C004' });
    check('job event leaves an off-shift crew off_shift', (await repo.crew('C004')).status === 'off_shift');
    r = await call('op', 'POST', `/dispatch/rebalance/proposals/${p.id}/apply`);
    check('stale proposal -> 409 STALE_PROPOSAL, nothing moved', r.status === 409 && r.body.code === 'STALE_PROPOSAL'
      && (await crewOf('JOB-102')) === 'C004' && (await repo.proposal(p.id)).status === 'stale', JSON.stringify(r.body.problems));
    await call('op', 'PATCH', '/mobile/jobs/JOB-104/status', { status: 'Acknowledged', crewId: 'C004' });

    // Back on shift (balanced, so no proposal), then off again for the reject flow.
    r = await call('op', 'PATCH', '/crews/C004', { on_shift: true });
    check('back on shift -> status from its En Route job, no proposal needed', r.body.crew.status === 'in_transit' && r.body.rebalance?.proposal === null, r.body.crew.status);
    r = await call('op', 'PATCH', '/crews/C004', { on_shift: false });
    p = r.body.rebalance?.proposal;
    r = await call('op', 'POST', `/dispatch/rebalance/proposals/${p.id}/reject`, { note: 'C004 back in 20 min' });
    check('reject -> rejected with who/when/note', r.status === 200 && r.body.proposal.status === 'rejected' && r.body.proposal.decided_by === 'op.sharma' && r.body.proposal.decision_note === 'C004 back in 20 min');
    check('rejected proposal cannot be applied (409)', (await call('op', 'POST', `/dispatch/rebalance/proposals/${p.id}/apply`)).status === 409);
    check('rejecting moved nothing', (await crewOf('JOB-102')) === 'C004');

    await call('op', 'PATCH', '/crews/C004', { on_shift: true });
    r = await call('op', 'PATCH', '/crews/C004', { on_shift: false });
    p = r.body.rebalance?.proposal;
    const moves = p?.result.moves || [], un = p?.result.unassigned || [], stuck = p?.result.stuck || [];
    const to = (id) => moves.find((m) => m.jobId === id)?.toCrew;
    check('auto proposal: trigger crew_off_shift, status proposed', p?.trigger === 'crew_off_shift' && p.status === 'proposed' && p.created_by === 'op.sharma');
    check('redistributes: JOB-102 (Medical) -> C003, JOB-104 -> C005', to('JOB-102') === 'C003' && to('JOB-104') === 'C005' && moves.every((m) => m.reason === 'crew_off_shift'), JSON.stringify(moves));
    check('JOB-103 (needs Fuse) flagged unassigned with a reason', un.length === 1 && un[0].jobId === 'JOB-103' && /Fuse/.test(un[0].reason), JSON.stringify(un));
    check('En Route JOB-105 untouched (stuck, not moved)', !moves.some((m) => m.jobId === 'JOB-105') && stuck.some((s) => s.jobId === 'JOB-105'));
    check('Critical/Medical job placed first', moves[0]?.jobId === 'JOB-102');
    check('trigger did not apply anything', (await crewOf('JOB-102')) === 'C004' && (await crewOf('JOB-103')) === 'C004');
    check('older open proposals are superseded or decided', (await repo.proposals('proposed')).length === 1);
    r = await call('admin', 'POST', `/dispatch/rebalance/proposals/${p.id}/apply`);
    check('system_admin applies -> 200', r.status === 200 && r.body.moved === 2 && r.body.unassigned === 1);
    check('DB: JOB-102 on C003, JOB-104 on C005, JOB-105 still C004',
      (await crewOf('JOB-102')) === 'C003' && (await crewOf('JOB-104')) === 'C005' && (await crewOf('JOB-105')) === 'C004');
    const j103 = await job('JOB-103');
    const inc103 = await repo.incident(j103.incident_id);
    check('DB: JOB-103 crew_id NULL with flagged reason/time', j103.crew_id === null && /Fuse/.test(j103.flagged_reason || '') && !!j103.flagged_at);
    check('DB: its incident has no crew and is open again', inc103.crew_id === null && inc103.status === 'open');
    ras = await db.any('SELECT * FROM job_reassignments WHERE proposal_id=$1 ORDER BY job_id', [p.id]);
    check('job_reassignments: 3 rows, actor admin.joshi, NULL to_crew for the flagged job',
      ras.length === 3 && ras.every((x) => x.actor === 'admin.joshi' && x.from_crew === 'C004')
      && ras.find((x) => x.job_id === 'JOB-103')?.to_crew === null && /Fuse/.test(ras.find((x) => x.job_id === 'JOB-103')?.reason || ''));
    const c3jobs = (await call('c3', 'GET', '/mobile/crews/C003/jobs')).body;
    check('GET /mobile/crews/C003/jobs shows the reassigned JOB-102', c3jobs.some((j) => j.id === 'JOB-102' && j.incident));
    const c4jobs = (await call('c4', 'GET', '/mobile/crews/C004/jobs')).body.map((j) => j.id);
    check('C004 keeps only its En Route job', c4jobs.length === 1 && c4jobs[0] === 'JOB-105', JSON.stringify(c4jobs));
    check('C004 job_id still its En Route incident, status off_shift',
      (await repo.crew('C004')).job_id === (await job('JOB-105')).incident_id && (await repo.crew('C004')).status === 'off_shift');
    r = await call('c4', 'PATCH', '/mobile/jobs/JOB-102/status', { status: 'En Route' });
    check('old crew updating JOB-102 -> 409 NOT_YOUR_JOB', r.status === 409 && r.body.code === 'NOT_YOUR_JOB');
    r = await call('c4', 'PATCH', '/mobile/jobs/JOB-103/status', { status: 'En Route' });
    check('anyone updating the unassigned JOB-103 -> 409 NOT_YOUR_JOB', r.status === 409 && r.body.code === 'NOT_YOUR_JOB');
    r = await call('c3', 'PATCH', '/mobile/jobs/JOB-102/status', { status: 'En Route', crewId: 'C003' });
    check('new crew can update it (200)', r.status === 200 && r.body.status === 'En Route');

    wl = (await call('op', 'GET', '/dispatch/workload')).body;
    check('workload lists JOB-103 as unassigned with its reason', wl.unassigned.some((j) => j.id === 'JOB-103' && /Fuse/.test(j.flagged_reason)) && wl.openProposal === null);
    const hist = (await call('op', 'GET', '/dispatch/rebalance/history')).body;
    check('history: applied, rejected and stale proposals plus reassignments',
      ['applied', 'rejected', 'stale'].every((s) => hist.proposals.some((x) => x.status === s)) && hist.reassignments.length >= 4);
    check('bus: proposed, applied, rejected and stale events', ['proposed', 'applied', 'rejected', 'stale'].every((e) => events.some((x) => x.event === e)));

    console.log('-- manual assign');
    check('assign to an off-shift crew -> 409', (await call('op', 'POST', `/incidents/${inc103.id}/assign`, { crewId: 'C004' })).status === 409);
    check('bad priority -> 400', (await call('op', 'POST', `/incidents/${inc103.id}/assign`, { crewId: 'C005', priority: 'Whenever' })).status === 400);
    r = await call('op', 'POST', `/incidents/${inc103.id}/assign`, { crewId: 'C005', requiredSkill: 'any', estimatedDurationMin: 45, priority: 'Urgent' });
    check('assigning the flagged job reuses it (no duplicate)', r.status === 200 && r.body.job.id === 'JOB-103' && r.body.job.crew_id === 'C005'
      && r.body.job.flagged_reason === null && r.body.job.required_skill === null && r.body.job.estimated_duration_min === 45 && r.body.job.priority === 'Urgent');
    check('manual_assign row in job_reassignments',
      (await db.any("SELECT 1 FROM job_reassignments WHERE job_id='JOB-103' AND reason='manual_assign' AND from_crew IS NULL AND to_crew='C005' AND actor='op.sharma' AND ts >= $1", [runStart])).length === 1);
    const a1 = await call('op', 'POST', '/incidents/INC-2026-000006/assign', { crewId: 'C001' });
    const a2 = await call('op', 'POST', '/incidents/INC-2026-000006/assign', { crewId: 'C002' });
    const a3 = await call('op', 'POST', '/incidents/INC-2026-000006/assign', { crewId: 'C001', requiredSkill: 'HV' });
    check('A -> B -> A assign does not collide on the job id', a1.status === 200 && a2.status === 200 && a3.status === 200
      && a3.body.job.id === a1.body.job.id && a3.body.job.crew_id === 'C001' && a3.body.job.required_skill === 'HV', `${a1.status}/${a2.status}/${a3.status}`);

    console.log('-- crews and settings');
    r = await call('op', 'POST', '/crews', { name: 'Crew Theta-1', lead: 'Kiran Bisht', aor: [MP], skills: ['MV', 'Fuse'], capacity: 4, lat: 29.94, lon: 78.15 });
    check('POST /crews -> 201, next id, on shift, available', r.status === 201 && r.body.crew.id === 'C007' && r.body.crew.on_shift === true
      && r.body.crew.status === 'available' && r.body.crew.skills.join() === 'MV,Fuse' && r.body.crew.aor[0] === MP && 'rebalance' in r.body, JSON.stringify(r.body).slice(0, 200));
    check('POST /crews with an unknown area -> 400', (await call('op', 'POST', '/crews', { name: 'X', aor: ['Atlantis'] })).status === 400);
    check('POST /crews duplicate id -> 409', (await call('op', 'POST', '/crews', { id: 'C001', name: 'Dup' })).status === 409);
    check('coordinator cannot add a crew (403)', (await call('coord', 'POST', '/crews', { name: 'Y' })).status === 403);
    r = await call('op', 'PATCH', '/crews/C005', { capacity: 2 });
    check('capacity change -> capacity_changed proposal', r.status === 200 && Number(r.body.crew.capacity) === 2
      && r.body.rebalance.proposal?.trigger === 'capacity_changed', JSON.stringify(r.body.rebalance).slice(0, 160));
    check('settings: threshold out of range -> 400', (await call('op', 'PUT', '/dispatch/settings', { ...st, overloadThreshold: 9 })).status === 400);
    check('settings: missing weight -> 400', (await call('op', 'PUT', '/dispatch/settings', { ...st, priorityWeights: { Critical: 3 } })).status === 400);
    r = await call('op', 'PUT', '/dispatch/settings', { ...st, overloadThreshold: 1.2 });
    check('settings saved and read back', r.status === 200 && (await call('op', 'GET', '/dispatch/settings')).body.overloadThreshold === 1.2);
    check('coordinator cannot change settings (403)', (await call('coord', 'PUT', '/dispatch/settings', st)).status === 403);
    await call('op', 'PUT', '/dispatch/settings', st);

    console.log('-- append-only reassignment log');
    check('UPDATE refused', await throws("UPDATE job_reassignments SET actor='x'"));
    check('DELETE refused', await throws('DELETE FROM job_reassignments'));
    check('TRUNCATE refused', await throws('TRUNCATE job_reassignments'));
    const nLog = Number((await db.one('SELECT count(*) n FROM job_reassignments')).n);
    const reseed = await seed({ force: true }).catch((e) => ({ error: e.message }));
    check('seed --force still works and keeps the log', reseed.seeded === true && Number((await db.one('SELECT count(*) n FROM job_reassignments')).n) === nLog, reseed.error || '');
    check('seed --force clears proposals', Number((await db.one('SELECT count(*) n FROM rebalance_proposals')).n) === 0);
  } catch (e) {
    fails++;
    console.log('  [FAIL] unexpected error', e.stack);
  }
  console.log('  ----------------------------------------');
  console.log(`  ${passes}/${passes + fails} passed`);
  server.close();
  await db.$pool.end().catch(() => {});
  process.exit(fails ? 1 : 0);
});
