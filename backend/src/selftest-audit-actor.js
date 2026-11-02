// Audit names self-test: audit_log and incident_events name the verified
// token's user, never the x-user header, and record the role apart from the
// login (incident_events.actor_role). Every call below sends a forged
// "x-user: mallory"; it must never reach either table. Same style as
// selftest-oms03.js: real DB, real routes, identities injected the way
// requireAuth would attach them.
// Run: DATABASE_URL=<scratch db> node src/selftest-audit-actor.js
// Destructive: it runs seed --force. It does not read .env.
import express from 'express';
import { migrate, db } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { initBus } from './domain/bus.js';

if (!process.env.DATABASE_URL) {
  console.error('selftest-audit-actor: set DATABASE_URL to a scratch database (this test reseeds it)');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';

await migrate();
const runStart = (await db.one('SELECT now() AS t')).t;
await seed({ force: true });
await initBus();

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

// A free, on-shift crew for the new job; the crew login carries its id.
const crew = (await repo.crews()).find((c) => c.on_shift !== false && c.status === 'available') || (await repo.crews())[0];
const USERS = {
  op: { username: 'op.sharma', roles: ['oms_operator'], crewId: null },
  cc: { username: 'cc.negi', roles: ['call_centre_attendant'], crewId: null },
  crew: { username: 'crew.audit', roles: ['field_crew'], crewId: crew.id },
  noname: { username: undefined, roles: ['oms_operator'], crewId: null },
};
const FORGED = 'mallory';
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = USERS[req.header('x-test-as') || 'op']; next(); });
app.use('/api', api);

const server = app.listen(0, async () => {
  const { port } = server.address();
  // Every request carries the forged header.
  const call = async (as, method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-as': as, 'x-user': FORGED },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const auditRows = () => db.any('SELECT actor, action, target FROM audit_log WHERE ts >= $1', [runStart]);
  const auditBy = async (action, target) => (await auditRows()).filter((a) => a.action === action && (!target || String(a.target).startsWith(target)));

  try {
    console.log('-- schema');
    const col = await db.oneOrNone(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'incident_events' AND column_name = 'actor_role'`);
    check('incident_events has actor_role', !!col);

    console.log('-- control room, forged x-user on every call');
    let r = await call('op', 'POST', '/incidents', { zone: 'Audit check', severity: 'low', cause: 'audit actor check' });
    check('POST /incidents -> 201', r.status === 201, String(r.status));
    const incId = r.body.id;
    r = await call('op', 'PATCH', `/incidents/${incId}/status`, { status: 'dispatched' });
    check('PATCH status open -> dispatched -> 200', r.status === 200, String(r.status));
    r = await call('op', 'PATCH', `/incidents/${incId}/ert`, { ert: new Date(Date.now() + 3600e3).toISOString() });
    check('PATCH ert -> 200', r.status === 200, String(r.status));
    r = await call('op', 'POST', `/incidents/${incId}/assign`, { crewId: crew.id });
    check(`assign to ${crew.id} -> 200`, r.status === 200, String(r.status));
    const job = (await repo.jobsForIncident(incId)).find((j) => j.crew_id === crew.id);
    check('job created for the crew', !!job);

    console.log('-- crew, forged x-user on every call');
    r = await call('crew', 'POST', `/mobile/jobs/${job.id}/seen`, { event: 'opened' });
    check('crew opens the job -> changed', r.status === 200 && r.body.changed === true, String(r.status));
    for (const status of ['En Route', 'On Site', 'Work Started', 'Work Complete']) {
      r = await call('crew', 'PATCH', `/mobile/jobs/${job.id}/status`, { status });
      check(`crew status ${status} -> applied`, r.status === 200 && r.body.applied !== false, `${r.status} ${r.body.reason || ''}`);
    }
    r = await call('crew', 'POST', `/mobile/jobs/${job.id}/messages`, { body: 'audit check message' });
    check('crew message -> 201', r.status === 201, String(r.status));

    console.log('-- control room again');
    r = await call('op', 'POST', `/incidents/${incId}/return-for-correction`, { reason: 'audit check' });
    check('return for correction -> 200', r.status === 200, String(r.status));
    const alarm = (await repo.alarms())[0];
    r = await call('op', 'POST', `/alarms/${alarm.id}/ack`);
    check('alarm ack -> 200', r.status === 200, String(r.status));
    r = await call('cc', 'POST', '/calls', { customer: 'Audit Check', phone: '9000000001', address: 'Mayapur', category: 'Normal' });
    check('call centre logs a call -> 201', r.status === 201, String(r.status));
    const callId = r.body.id;
    r = await call('cc', 'POST', `/calls/${callId}/reject`, { reason: 'audit check, not an outage' });
    check('call centre rejects it -> rejected_by cc.negi', r.status === 200 && r.body.rejected_by === 'cc.negi', `${r.status} ${r.body.rejected_by}`);
    r = await call('noname', 'POST', `/alarms/${alarm.id}/ack`);
    check('alarm ack by a token without a username -> 200', r.status === 200, String(r.status));

    console.log('-- audit_log names the token user');
    const expectOp = [['incident.create', incId], ['incident.status', `${incId}:dispatched`], ['incident.ert', incId],
      ['dispatch.assign', incId], ['incident.return_for_correction', incId], ['alarm.ack', alarm.id]];
    for (const [action, target] of expectOp) {
      const rows = await auditBy(action, target);
      check(`${action} by op.sharma`, rows.some((a) => a.actor === 'op.sharma'), JSON.stringify(rows.map((a) => a.actor)));
    }
    const callRows = await auditBy('call.create', callId);
    check('call.create by cc.negi', callRows.length === 1 && callRows[0].actor === 'cc.negi', JSON.stringify(callRows));
    const rejectRows = await auditBy('call.reject', callId);
    check('call.reject by cc.negi', rejectRows.length === 1 && rejectRows[0].actor === 'cc.negi', JSON.stringify(rejectRows));
    check('token without a username is logged as "unknown", not the header',
      (await auditBy('alarm.ack', alarm.id)).some((a) => a.actor === 'unknown'));
    const forgedAudit = (await db.one('SELECT count(*)::int n FROM audit_log WHERE actor ILIKE $1', [`%${FORGED}%`])).n;
    check('forged x-user never appears in audit_log', forgedAudit === 0, `rows=${forgedAudit}`);

    console.log('-- incident_events name the login and keep the role apart');
    const ev = await repo.incidentEvents(incId);
    const by = (actor) => ev.filter((e) => e.actor === actor);
    const forgedEv = (await db.one('SELECT count(*)::int n FROM incident_events WHERE actor ILIKE $1', [`%${FORGED}%`])).n;
    check('forged x-user never appears in incident_events', forgedEv === 0, `rows=${forgedEv}`);
    check('no role names as actors on this incident (Dispatcher, Crew, operator, Control room)',
      !ev.some((e) => ['dispatcher', 'crew', 'operator', 'control room'].includes(String(e.actor).toLowerCase())), JSON.stringify(ev.map((e) => e.actor)));
    const opKinds = new Set(by('op.sharma').map((e) => e.kind));
    check('control-room events by op.sharma (created, status, ert, assigned)',
      ['created', 'status', 'ert', 'assigned'].every((k) => opKinds.has(k)), JSON.stringify([...opKinds]));
    check('op.sharma events carry actor_role oms_operator', by('op.sharma').length > 0 && by('op.sharma').every((e) => e.actor_role === 'oms_operator'));
    const crewEv = by('crew.audit');
    const crewNotes = crewEv.map((e) => e.note).join(' | ');
    check('crew events by crew.audit: opened, each status, work complete, message',
      /opened job/.test(crewNotes) && ['En Route', 'On Site', 'Work Started', 'Work Complete'].every((s) => crewNotes.includes(`Status: ${s}`))
      && /Work complete - awaiting verification/.test(crewNotes) && crewEv.some((e) => e.kind === 'message'), crewNotes.slice(0, 300));
    check('crew events carry actor_role field_crew', crewEv.length > 0 && crewEv.every((e) => e.actor_role === 'field_crew'));
    check('every event on this incident has a role', ev.every((e) => e.actor_role), JSON.stringify(ev.filter((e) => !e.actor_role).map((e) => e.actor)));
    const newRoleNames = (await db.one(`SELECT count(*)::int n FROM incident_events
      WHERE ts >= $1 AND lower(actor) IN ('dispatcher','crew','operator','control room')`, [runStart])).n;
    check('no new incident_events anywhere use a role name as the actor', newRoleNames === 0, `rows=${newRoleNames}`);
  } catch (err) {
    fails++;
    console.log('  [FAIL] threw:', err.stack || err.message);
  } finally {
    console.log(`\n${passes} passed, ${fails} failed`);
    server.close();
    await db.$pool.end();
    process.exit(fails ? 1 : 0);
  }
});
