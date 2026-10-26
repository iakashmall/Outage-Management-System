// OMS-03 daily work order self-test (domain/workOrder.js + routes/api.js):
// start / end of day, validation, idempotent replays, late and out-of-range
// dates, crew ownership, the end-of-day snapshot, the control room's list,
// and that the crew app's own rules and payloads (src/lib/workOrder.js) are
// what the server accepts. Runs against a scratch database:
//   DATABASE_URL=<scratch db> PORT=4100 node src/selftest-workorders.js
process.env.PORT = process.env.PORT || '4100';
import express from 'express';
import { migrate, db } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { initBus } from './domain/bus.js';
import * as wo from './domain/workOrder.js';
// The crew app's own rules (src/lib/workOrder.js has no React Native imports).
import * as crewApp from '../../src/lib/workOrder.js';

if (!process.env.DATABASE_URL) {
  console.error('selftest-workorders: set DATABASE_URL to a scratch database (this test reseeds it)');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';

await migrate();
await seed({ force: true });
await initBus();

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

const USERS = {
  op: { username: 'op.sharma', roles: ['oms_operator'], crewId: null },
  coord: { username: 'coord.rawat', roles: ['field_crew_coordinator'], crewId: null },
  c3: { username: 'crew03', roles: ['field_crew'], crewId: 'C003' },
  c4: { username: 'crew04', roles: ['field_crew'], crewId: 'C004' },
  noClaim: { username: 'crew.noclaim', roles: ['field_crew'], crewId: null },
};
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { req.user = USERS[req.header('x-test-as') || 'op']; next(); });
app.use('/api', api);

const ALL_CHECKS = { vehicle: true, tools: true, ppe: true, firstAid: true };

const server = app.listen(0, async () => {
  const { port } = server.address();
  const call = async (as, method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-as': as }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    const today = wo.workDate();
    const id3 = wo.workOrderId('C003', today);

    console.log('Rules');
    check('working day is the date in Asia/Kolkata (20:00 UTC is the next day)', wo.workDate('2026-10-14T20:00:00Z', 'Asia/Kolkata') === '2026-10-15');
    check('work order id', wo.workOrderId('C003', '2026-10-15') === 'WO-20261015-C003' && crewApp.workOrderId('C003', '2026-10-15') === 'WO-20261015-C003');
    check('isWorkDate rejects 2026-02-30, 2026-13-01 and junk', wo.isWorkDate('2026-10-15') && !wo.isWorkDate('2026-02-30') && !wo.isWorkDate('2026-13-01') && !wo.isWorkDate('15-10-2026'));
    check('app and server agree on the start-of-day checks', JSON.stringify(crewApp.START_CHECKS.map((c) => c.key)) === JSON.stringify(wo.START_CHECK_KEYS));
    check('app and server agree on the carry-over reasons', JSON.stringify(crewApp.CARRY_REASONS.map((r) => r.value)) === JSON.stringify(wo.CARRY_REASONS));
    const ordered = wo.orderOpen([
      { id: 'A', status: 'Acknowledged', priority: 'Normal' },
      { id: 'B', status: 'Acknowledged', priority: 'Urgent', call_categories: ['Medical'] },
      { id: 'C', status: 'On Site', priority: 'Normal' },
    ]);
    check('server order: job under way first, then Medical (Critical), then Normal', ordered.map((j) => j.id).join() === 'C,B,A');
    const appOrdered = crewApp.orderOpen([
      { id: 'A', status: 'Acknowledged', priority: 'Normal' },
      { id: 'B', status: 'Acknowledged', priority: 'Critical' },
      { id: 'C', status: 'Work Started', priority: 'Normal' },
    ]);
    check('app order: same rule', appOrdered.map((j) => j.id).join() === 'C,B,A');
    check('app: cannot start without a member or with a check missing',
      !crewApp.canStart({ members: ['  '], checks: ALL_CHECKS }) && !crewApp.canStart({ members: ['Priya'], checks: { ...ALL_CHECKS, ppe: false } })
        && crewApp.canStart({ members: ['Priya'], checks: ALL_CHECKS }));
    check('app: every open job needs a carry-over reason', crewApp.missingReasons([{ id: 'J1' }, { id: 'J2' }], { J1: 'material' }).map((j) => j.id).join() === 'J2');

    console.log('Start of day');
    let r = await call('c3', 'GET', '/mobile/crews/C003/work-order');
    check('GET before the start: not_started placeholder with today\'s id', r.status === 200 && r.body.workOrder.status === 'not_started' && r.body.workOrder.id === id3, `(${r.status})`);
    check('the day lists C003\'s open job JOB-004', r.body.jobs.open.some((j) => j.id === 'JOB-004') && r.body.summary.open >= 1);
    check('GET with a bad date -> 400 BAD_DATE', (await call('c3', 'GET', '/mobile/crews/C003/work-order?date=2026-13-01')).body.code === 'BAD_DATE');

    check('another crew -> 403 NOT_YOUR_CREW', (await call('c4', 'GET', '/mobile/crews/C003/work-order')).body.code === 'NOT_YOUR_CREW');
    check('field_crew login without crew id -> 403 NO_CREW_ID', (await call('noClaim', 'GET', '/mobile/crews/C003/work-order')).body.code === 'NO_CREW_ID');
    check('unknown crew -> 404', (await call('op', 'GET', '/mobile/crews/C999/work-order')).status === 404);

    const body = (extra = {}) => ({ ...crewApp.startPayload({ crewId: 'C003', date: today, members: ['Priya Singh', ' Ravi '], checks: ALL_CHECKS, note: 'fuel low', location: { lat: 29.94, lon: 78.15 } }), ...extra });
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', body({ members: [] }));
    check('no crew member -> 400', r.status === 400, `(${r.status} ${r.body.message})`);
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', body({ checks: { ...ALL_CHECKS, firstAid: false } }));
    check('a check not done -> 400 CHECKS_INCOMPLETE', r.status === 400 && r.body.code === 'CHECKS_INCOMPLETE', `(${r.body.message})`);
    r = await call('c4', 'POST', '/mobile/crews/C003/work-order/start', body());
    check('start for another crew -> 403', r.status === 403);
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', body({ date: '2020-01-01' }));
    check('a long-past day -> applied:false, nothing stored', r.status === 200 && r.body.applied === false && !(await repo.workOrder('C003', '2020-01-01')), `(${r.body.reason})`);
    const tomorrow = wo.workDate(new Date(Date.now() + 86400000));
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', body({ date: tomorrow }));
    check('a future day -> applied:false', r.body.applied === false);

    const startBody = body();
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', startBody);
    check('app start payload -> 201 applied, started', r.status === 201 && r.body.applied === true && r.body.workOrder.status === 'started', `(${r.status} ${r.body.message || ''})`);
    const row = await repo.workOrder('C003', today);
    check('stored: members trimmed, checks, note, position, who', row && JSON.stringify(row.members) === '["Priya Singh","Ravi"]' && row.start_checks.ppe === true
      && row.start_note === 'fuel low' && row.start_lat === 29.94 && row.started_by === 'crew03');
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', startBody);
    check('same start resent (pending sync) -> 200 applied, duplicate', r.status === 200 && r.body.applied === true && r.body.duplicate === true);
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', body());
    check('a second, different start -> applied:false "day already started"', r.body.applied === false && r.body.reason === 'day already started');
    check('one work order row for the day', Number((await db.one('SELECT count(*) n FROM daily_work_orders WHERE crew_id=$1', ['C003'])).n) === 1);

    console.log('End of day');
    r = await call('c4', 'POST', '/mobile/crews/C004/work-order/close', crewApp.closePayload({ crewId: 'C004', date: today, open: [], signOff: { name: 'Suresh Patel' } }));
    check('end a day never started -> applied:false "day not started"', r.body.applied === false && r.body.reason === 'day not started');

    // A job finished today shows under done; JOB-004 is still open.
    await db.none(`INSERT INTO jobs (id, incident_id, crew_id, priority, status, address, updated_at, completed_at)
      VALUES ('JOB-WO-DONE', 'INC-2026-000004', 'C003', 'Normal', 'Work Complete', 'test', now(), now())`);
    r = await call('c3', 'GET', '/mobile/crews/C003/work-order');
    check('a job finished today is listed as done', r.body.jobs.done.some((j) => j.id === 'JOB-WO-DONE') && r.body.summary.done === 1);

    const dayNow = (await call('c3', 'GET', '/mobile/crews/C003/work-order')).body.jobs.open;
    const closeBody = (extra = {}) => ({
      ...crewApp.closePayload({ crewId: 'C003', date: today, open: dayNow, reasons: Object.fromEntries(dayNow.map((j) => [j.id, 'material'])), notes: { 'JOB-004': 'jointing kit' }, remarks: 'rain from 15:00', signOff: { name: 'Priya Singh', signedAt: new Date().toISOString() } }),
      ...extra,
    });
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/close', closeBody({ signOff: null }));
    check('no sign-off -> 400', r.status === 400);
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/close', closeBody({ carryOver: [{ jobId: 'JOB-004', reason: 'lunch' }] }));
    check('unknown carry-over reason -> 400', r.status === 400);

    const closeOnce = closeBody();
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/close', closeOnce);
    check('app end-of-day payload -> 200 applied, closed', r.status === 200 && r.body.applied === true && r.body.workOrder.status === 'closed', `(${r.status} ${r.body.message || r.body.reason || ''})`);
    const closed = await repo.workOrder('C003', today);
    const carried = closed.close_snapshot?.carriedOver?.find((c) => c.jobId === 'JOB-004');
    check('snapshot: JOB-004 carried over with reason and note; JOB-WO-DONE done', carried?.reason === 'material' && carried.note === 'jointing kit'
      && closed.close_snapshot.done.some((d) => d.jobId === 'JOB-WO-DONE'));
    check('stored: remarks, sign-off, who', closed.close_remarks === 'rain from 15:00' && closed.close_sign_off.name === 'Priya Singh' && closed.closed_by === 'crew03');
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/close', closeOnce);
    check('same end of day resent -> 200 applied, duplicate', r.body.applied === true && r.body.duplicate === true);
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/close', closeBody());
    check('a second, different end of day -> applied:false "day already ended"', r.body.applied === false && r.body.reason === 'day already ended');
    r = await call('c3', 'POST', '/mobile/crews/C003/work-order/start', body());
    check('start after the day ended -> applied:false "day already ended"', r.body.applied === false && r.body.reason === 'day already ended');

    console.log('Control room');
    r = await call('op', 'GET', '/work-orders');
    const mine = r.body.crews?.find((c) => c.crew.id === 'C003');
    check('operator sees every crew\'s day; C003 closed, C004 not started', r.status === 200 && mine?.workOrder.status === 'closed'
      && r.body.crews.find((c) => c.crew.id === 'C004')?.workOrder.status === 'not_started');
    check('field crew coordinator may read it', (await call('coord', 'GET', '/work-orders')).status === 200);
    check('a crew login may not (403)', (await call('c3', 'GET', '/work-orders')).status === 403);
    const audits = await db.any("SELECT action FROM audit_log WHERE target=$1 ORDER BY ts", [id3]);
    check('audited once each: work_order.start, work_order.close', audits.map((a) => a.action).join() === 'work_order.start,work_order.close');

    await db.none("DELETE FROM jobs WHERE id='JOB-WO-DONE'");
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
