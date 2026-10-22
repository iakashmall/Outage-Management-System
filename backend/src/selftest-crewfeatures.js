// Crew app features of 2026-10-19 (routes/api.js): new-job "received /
// opened" on the dashboard, On Site / Work Started only at the site, the
// crew's reassignment request (operator grants or declines), a cancelled
// incident cancelling the crew's job, crew -> operator messages, the asset
// scans list for the network map, and the photo stage watermark.
// Runs against a scratch database:
//   DATABASE_URL=<scratch db> node src/selftest-crewfeatures.js
process.env.PORT = process.env.PORT || '4100';
import express from 'express';
import sharp from 'sharp';
import { migrate, db } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { initBus, bus, TOPICS } from './domain/bus.js';

if (!process.env.DATABASE_URL) {
  console.error('selftest-crewfeatures: set DATABASE_URL to a scratch database (this test reseeds it)');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
delete process.env.SITE_RADIUS_M; // the default 100 m

await migrate();
await seed({ force: true });
await initBus();
await db.none("UPDATE crews SET on_shift=true WHERE id IN ('C003','C004','C005')");

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

const USERS = {
  op: { username: 'op.sharma', roles: ['oms_operator'], crewId: null },
  c3: { username: 'crew03', roles: ['field_crew'], crewId: 'C003' },
  c4: { username: 'crew04', roles: ['field_crew'], crewId: 'C004' },
};
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => { req.user = USERS[req.header('x-test-as') || 'op']; next(); });
app.use('/api', api);

const photoUrl = 'data:image/jpeg;base64,' + (await sharp({ create: { width: 400, height: 300, channels: 3, background: '#556677' } }).jpeg().toBuffer()).toString('base64');
const SITE = { lat: 29.9457, lon: 78.1642 }; // Haridwar
const near = { lat: SITE.lat + 0.0004, lon: SITE.lon }; // ~45 m
const far = { lat: SITE.lat + 0.01, lon: SITE.lon };    // ~1.1 km

// Everything the bus publishes, to check what the dashboard is told.
const published = [];
const origPublish = bus.publish.bind(bus);
bus.publish = (topic, payload) => { published.push({ topic, payload }); return origPublish(topic, payload); };

const server = app.listen(0, async () => {
  const { port } = server.address();
  const call = async (as, method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-as': as }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const status = (jobId, s, at, as = 'c3') => call(as, 'PATCH', `/mobile/jobs/${jobId}/status`,
    { status: s, lat: at?.lat ?? null, lon: at?.lon ?? null, crewId: USERS[as].crewId, ts: new Date().toISOString(), sentAt: new Date().toISOString() });
  const newJob = async (crewId = 'C003', pos = SITE) => {
    const inc = (await call('op', 'POST', '/incidents', { zone: 'Mayapur', severity: 'high', type: 'Power Outage', cause: 'selftest-crewfeatures', ...pos })).body;
    const asg = await call('op', 'POST', `/incidents/${inc.id}/assign`, { crewId });
    return { inc: inc.id, job: asg.body.job.id };
  };

  try {
    console.log('-- received / opened');
    const A = await newJob();
    let r = await call('c3', 'POST', `/mobile/jobs/${A.job}/seen`, { event: 'delivered' });
    check('delivered sets delivered_at', r.body.changed === true && !!r.body.job.delivered_at && !r.body.job.opened_at);
    r = await call('c3', 'POST', `/mobile/jobs/${A.job}/seen`, { event: 'delivered' });
    check('delivered again changes nothing', r.body.changed === false);
    r = await call('c3', 'POST', `/mobile/jobs/${A.job}/seen`, { event: 'opened' });
    check('opened sets opened_at', r.body.changed === true && !!r.body.job.opened_at);
    check('another crew cannot mark it', (await call('c4', 'POST', `/mobile/jobs/${A.job}/seen`, { event: 'opened' })).status === 403);
    check('the operator calling it records nothing', (await call('op', 'POST', `/mobile/jobs/${A.job}/seen`, { event: 'opened' })).body.changed === false);

    console.log('-- On Site / Work Started only at the site');
    check('En Route from anywhere', (await status(A.job, 'En Route', far)).body.applied === true);
    r = await status(A.job, 'On Site', far);
    check('On Site 1 km away -> 409 NOT_ON_SITE', r.status === 409 && r.body.code === 'NOT_ON_SITE' && r.body.distance > 900, JSON.stringify(r.body));
    r = await status(A.job, 'On Site', null);
    check('On Site without a position -> 409 NO_LOCATION', r.status === 409 && r.body.code === 'NO_LOCATION');
    check('job still En Route', (await repo.job(A.job)).status === 'En Route');
    check('On Site 45 m away -> applied', (await status(A.job, 'On Site', near)).body.applied === true);
    check('Work Started far away -> 409', (await status(A.job, 'Work Started', far)).status === 409);
    check('the operator is not checked', (await call('op', 'PATCH', `/mobile/jobs/${A.job}/status`, { status: 'Work Started', crewId: 'C003' })).body.applied === true);
    // POST /incidents fills in the zone's position, so clear it afterwards.
    const noPos = await newJob('C003');
    await db.none('UPDATE incidents SET lat=NULL, lon=NULL WHERE id=$1', [noPos.inc]);
    await status(noPos.job, 'En Route', far);
    check('a site with no position is never blocked', (await status(noPos.job, 'On Site', far)).body.applied === true);

    console.log('-- reassignment request');
    const B = await newJob('C003');
    await status(B.job, 'En Route', far);
    await status(B.job, 'On Site', near);
    check('request without a reason -> 400', (await call('c3', 'POST', `/mobile/jobs/${B.job}/reassign-request`, { reason: ' ' })).status === 400);
    r = await call('c3', 'POST', `/mobile/jobs/${B.job}/reassign-request`, { reason: 'no ladder for this pole' });
    check('request created', r.status === 201 && r.body.request.status === 'open' && r.body.request.crew_id === 'C003');
    check('dashboard told (crew.job.updated with reassignRequest)', published.some((p) => p.topic === TOPICS.JOB_UPDATED && p.payload.reassignRequest?.job_id === B.job));
    check('a second request returns the open one', (await call('c3', 'POST', `/mobile/jobs/${B.job}/reassign-request`, { reason: 'again' })).body.duplicate === true);
    check('another crew cannot ask for it', (await call('c4', 'POST', `/mobile/jobs/${B.job}/reassign-request`, { reason: 'x' })).status === 403);
    const list = (await call('op', 'GET', '/reassign-requests')).body;
    check('operator lists it', list.some((x) => x.job_id === B.job && x.job_status === 'On Site'));
    r = await call('op', 'POST', `/incidents/${B.inc}/assign`, { crewId: 'C004' });
    const moved = await repo.job(B.job);
    check('assign moves the started job on request', r.status === 200 && moved.crew_id === 'C004' && moved.status === 'Acknowledged' && !moved.delivered_at, JSON.stringify({ crew: moved.crew_id, status: moved.status }));
    check('request closed as reassigned', (await call('c4', 'GET', `/mobile/jobs/${B.job}/reassign-request`)).body.request?.status === 'reassigned');
    const C = await newJob('C003');
    await status(C.job, 'En Route', far);
    await status(C.job, 'On Site', near);
    check('without a request a started job still cannot move', (await call('op', 'POST', `/incidents/${C.inc}/assign`, { crewId: 'C004' })).body.code === 'JOB_IN_PROGRESS');
    const req2 = (await call('c3', 'POST', `/mobile/jobs/${C.job}/reassign-request`, { reason: 'vehicle breakdown' })).body.request;
    r = await call('op', 'POST', `/reassign-requests/${req2.id}/dismiss`, { note: 'no other crew nearby' });
    check('operator declines', r.status === 200 && r.body.request.status === 'dismissed');
    const thread = (await call('c3', 'GET', `/mobile/jobs/${C.job}/messages`)).body;
    check('the crew is told in its job thread', thread.some((m) => /declined/.test(m.body) && /no other crew nearby/.test(m.body)));
    check('job stays with the crew', (await repo.job(C.job)).crew_id === 'C003');

    console.log('-- crew -> operator messages');
    r = await call('c3', 'POST', `/mobile/jobs/${C.job}/messages`, { body: 'Need a bucket truck' });
    check('crew message stored as field_crew with its job', r.status === 201 && r.body.sender_role === 'field_crew' && r.body.job_id === C.job);
    check('published with crew and job for the dashboard toast', published.some((p) => p.topic === TOPICS.MESSAGE_POSTED && p.payload.body === 'Need a bucket truck' && p.payload.crew_id === 'C003'));
    const inbox = (await call('c3', 'GET', '/mobile/crews/C003/messages')).body;
    check('crew inbox messages name their job', inbox.length > 0 && inbox.every((m) => m.job_id));

    console.log('-- cancelled incident');
    const D = await newJob('C003');
    await status(D.job, 'En Route', far);
    r = await call('op', 'PATCH', `/incidents/${D.inc}/status`, { status: 'cancelled' });
    check('cancel accepted', r.status === 200 && r.body.status === 'cancelled');
    check('crew job -> Cancelled', (await repo.job(D.job)).status === 'Cancelled');
    const jobs = (await call('c3', 'GET', '/mobile/crews/C003/jobs')).body;
    const dj = jobs.find((j) => j.id === D.job);
    check('the phone still gets it, marked cancelled and locked', dj?.status === 'Cancelled' && dj.locked === true && dj.cancelled === true);
    r = await status(D.job, 'On Site', near);
    check('a queued update for it -> applied:false (the queue drops it)', r.status === 200 && r.body.applied === false && /cancelled/.test(r.body.reason), r.body.reason);
    r = await call('c3', 'POST', `/mobile/jobs/${D.job}/photos`, { dataUrl: photoUrl, lat: near.lat, lon: near.lon });
    check('a photo for it is kept but not applied', r.body.applied === false);
    check('cannot ask to reassign a cancelled job', (await call('c3', 'POST', `/mobile/jobs/${D.job}/reassign-request`, { reason: 'x' })).body.code === 'JOB_NOT_ACTIVE');

    console.log('-- photo stage watermark');
    r = await call('c3', 'POST', `/mobile/jobs/${C.job}/photos`, { dataUrl: photoUrl, lat: near.lat, lon: near.lon, metadata: { stage: 'work_started' } });
    check('photo stored with its stage', r.status === 201 && r.body.metadata.stage === 'work_started' && r.body.metadata.watermarked === true);
    r = await call('c3', 'POST', `/mobile/jobs/${C.job}/photos`, { dataUrl: photoUrl, lat: near.lat, lon: near.lon, metadata: { stage: 'nonsense' } });
    check('an unknown stage is dropped', r.status === 201 && r.body.metadata.stage === null);

    console.log('-- asset scans for the network map');
    await call('c3', 'POST', `/mobile/jobs/${C.job}/assets/scans`, { rawValue: 'POLE-77', lat: near.lat, lon: near.lon });
    const scans = (await call('op', 'GET', '/asset-scans?days=7')).body;
    check('recent scans list carries lat/lon and incident', scans.some((s) => s.asset_id === 'POLE-77' && s.incident_id === C.inc && Number.isFinite(s.lat)));
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
