// OMS-03 crew job workflow self-test (domain/jobWorkflow.js + routes/api.js):
// the app's status sequence, duplicate/out-of-order/late replays, the
// dispatcher-touched case, crew ownership, the completion form, undo, the
// lock, return for correction, the POST /incidents role guard, and that
// planned-outage jobs are untouched. Runs against a scratch database:
//   DATABASE_URL=<scratch db> PORT=4100 node src/selftest-jobs.js
process.env.PORT = process.env.PORT || '4100';
import express from 'express';
import sharp from 'sharp';
import { migrate, db } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { repo } from './infra/repo.js';
import { initBus } from './domain/bus.js';
import { decideStatus, isLocked, undoOpenUntil } from './domain/jobWorkflow.js';
// The crew app's own rules (src/lib/jobFlow.js has no React Native imports).
import * as crewApp from '../../src/lib/jobFlow.js';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) {
  console.error('selftest-jobs: set DATABASE_URL to a scratch database (this test reseeds it)');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
process.env.JOB_UNDO_WINDOW_MIN = '10';

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
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => { req.user = USERS[req.header('x-test-as') || 'op']; next(); });
app.use('/api', api);

const photoUrl = 'data:image/png;base64,' + (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } }).png().toBuffer()).toString('base64');
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

const server = app.listen(0, async () => {
  const { port } = server.address();
  const call = async (as, method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-as': as }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  // What the crew app sends for a status change (src/lib/api.js updateJobStatus).
  // Sent from the incident's own position: On Site / Work Started are only
  // accepted at the site (selftest-crewfeatures.js tests that rule).
  const sitePos = async (jobId) => {
    const inc = await repo.incident((await repo.job(jobId))?.incident_id);
    return inc?.lat != null ? { lat: inc.lat, lon: inc.lon } : { lat: 29.94, lon: 78.15 };
  };
  const appStatus = async (jobId, status, ts, as = 'c3') => call(as, 'PATCH', `/mobile/jobs/${jobId}/status`,
    { status, ...(await sitePos(jobId)), crewId: USERS[as].crewId, ts, sentAt: new Date().toISOString() });
  const events = async (incId) => (await call('op', 'GET', `/incidents/${incId}`)).body.events || [];
  const lateEvents = async (incId) => (await events(incId)).filter((e) => /late update from crew not applied/.test(e.note));
  const updatesOf = async (jobId) => db.any('SELECT * FROM job_updates WHERE job_id=$1 ORDER BY ts', [jobId]);
  // A new fault incident assigned to a crew; returns { inc, job }.
  const newJob = async (crewId = 'C003', zone = 'Mayapur') => {
    const inc = (await call('op', 'POST', '/incidents', { zone, severity: 'low', type: 'Power Outage', cause: 'selftest-jobs' })).body;
    const asg = await call('op', 'POST', `/incidents/${inc.id}/assign`, { crewId });
    return { inc: inc.id, job: asg.body.job.id };
  };

  try {
    console.log('-- rules (pure)');
    check('skip is applied with the skipped steps', JSON.stringify(decideStatus({ current: 'Acknowledged', next: 'Work Started', ts: minsAgo(0) }))
      === JSON.stringify({ applied: true, skipped: ['En Route', 'On Site'] }));
    check('backward is not applied', decideStatus({ current: 'On Site', next: 'En Route', ts: minsAgo(0) }).applied === false);
    check('identical is not applied and not reported', decideStatus({ current: 'On Site', next: 'On Site', ts: minsAgo(0) }).notify === false);
    check('older than the newest crew update is late', /newer update/.test(decideStatus({ current: 'En Route', next: 'On Site', ts: minsAgo(5), latestCrewTs: minsAgo(1) }).reason || ''));
    check('Requires Revisit restarts the ladder', decideStatus({ current: 'Requires Revisit', next: 'En Route', ts: minsAgo(0) }).applied === true);
    check('Pending Acceptance -> Acknowledged is applied', decideStatus({ current: 'Pending Acceptance', next: 'Acknowledged', ts: minsAgo(0) }).applied === true);
    const done = { status: 'Work Complete', completed_at: minsAgo(3), incident_id: 'X' };
    check('undo window open while pending and inside the window', !!undoOpenUntil(done, 'pending') && !isLocked(done, 'pending'));
    check('locked once the incident leaves pending', isLocked(done, 'resolved'));
    check('locked once the window is over', isLocked({ ...done, completed_at: minsAgo(11) }, 'pending'));

    console.log('-- crew app rules (src/lib/jobFlow.js)');
    const soon = new Date(Date.now() + 5 * 60000).toISOString();
    const fault = { id: 'J', status: 'Work Complete', planned: false, locked: false, undoUntil: soon };
    const plannedJob = { ...fault, planned: true };
    check('app: planned job never sends the completion form', crewApp.canSendCompletion(plannedJob) === false && crewApp.canSendCompletion(fault) === true);
    check('app: planned job never offers Reopen', crewApp.canReopen(plannedJob) === false && crewApp.canReopen(fault) === true);
    check('app: planned job is never shown read-only by these rules', crewApp.isReadOnly({ ...plannedJob, locked: true }) === false);
    check('app: no Reopen once locked or after the window', !crewApp.canReopen({ ...fault, locked: true }) && !crewApp.canReopen({ ...fault, undoUntil: minsAgo(1) }));
    check('app: read-only when locked, or completed with the window over', crewApp.isReadOnly({ ...fault, locked: true }) && crewApp.isReadOnly({ ...fault, undoUntil: minsAgo(1) }) && !crewApp.isReadOnly(fault));
    const payload = crewApp.completionPayload({ jobId: 'J', diagnosis: { cause: 'c', action: 'a' }, partsUsed: [{ name: 'fuse', qty: 2, extra: 1 }], restored: 'partial', signOff: { name: 'N', signedAt: minsAgo(1) }, at: new Date(0) });
    check('app: completion payload matches the server contract', payload.restored === 'partial' && payload.partsUsed[0].extra === undefined
      && payload.clientRequestId === 'J-0' && payload.submittedAt === new Date(0).toISOString());
    check('app: a not-delivered form may be resent only once the job is Work Started or later (fault jobs)',
      crewApp.canResendCompletion({ ...fault, status: 'Work Started' }) && crewApp.canResendCompletion(fault)
      && !crewApp.canResendCompletion({ ...fault, status: 'On Site' }) && !crewApp.canResendCompletion({ ...plannedJob, status: 'Work Started' })
      && !crewApp.canResendCompletion({ ...fault, locked: true }));
    check('app: unknown restored value is not sent', crewApp.completionPayload({ jobId: 'J', restored: 'maybe' }).restored === null);
    // Source check: the app calls the completion/reopen routes only behind these guards.
    const appSrc = readFileSync(new URL('../../src/NativeApp.jsx', import.meta.url), 'utf8');
    const callsOf = (name) => (appSrc.match(new RegExp(`\\b${name}\\(`, 'g')) || []).length;
    check('app source: completion sent only from sendCompletion, guarded by canSendCompletion',
      callsOf('postJobCompletion') === 1 && callsOf('queueCompletion') === 1 && /const sendCompletion = async \(form\) => \{\s*if \(!canSendCompletion\(job\)\) return;/.test(appSrc));
    check('app source: reopen called only from reopen(), guarded by canReopen',
      callsOf('reopenJob') === 1 && /const reopen = async \(\) => \{\s*if \(!canReopen\(job\)\) return;/.test(appSrc));

    console.log('-- POST /incidents role guard');
    for (const as of ['coord', 'c3', 'noClaim']) {
      const r = await call(as, 'POST', '/incidents', { zone: 'Mayapur', severity: 'low' });
      check(`${as} cannot create an incident -> 403`, r.status === 403, `(${r.status})`);
    }
    const created = await call('op', 'POST', '/incidents', { zone: 'Mayapur', severity: 'low', type: 'Power Outage' });
    check('oms_operator creates an incident -> 201', created.status === 201, `(${created.status})`);

    const A = await newJob('C003');
    console.log(`-- crew ownership (job ${A.job} on C003)`);
    const own = await call('c3', 'GET', '/mobile/crews/C003/jobs');
    const mine = own.body.find?.((j) => j.id === A.job);
    check('crew reads its own jobs, with lock state', own.status === 200 && mine && mine.locked === false && mine.planned === false);
    for (const [path, what] of [['/mobile/crews/C003/jobs', 'jobs'], ['/mobile/crews/C003', 'crew'], ['/mobile/crews/C003/messages', 'crew messages'],
      ['/mobile/crews/C003/track', 'track'], [`/mobile/jobs/${A.job}/history`, 'job history'], [`/mobile/jobs/${A.job}/photos`, 'job photos'],
      [`/mobile/jobs/${A.job}/assets/scans`, 'job scans'], [`/mobile/jobs/${A.job}/messages`, 'job messages'], [`/mobile/jobs/${A.job}/completion`, 'completion']]) {
      const r = await call('c4', 'GET', path);
      check(`another crew cannot read ${what} -> 403`, r.status === 403, `(${r.status} ${r.body.code || ''})`);
    }
    for (const [method, path, body, what] of [
      ['POST', '/mobile/crews/C003/location', { lat: 29.9, lon: 78.1 }, 'location'],
      ['POST', '/mobile/crews/C003/locations', { points: [{ id: 'p1', lat: 29.9, lon: 78.1, recordedAt: minsAgo(0) }] }, 'locations'],
      ['POST', '/mobile/crews/C003/tracking', { state: 'on' }, 'tracking'],
      ['POST', `/mobile/jobs/${A.job}/messages`, { body: 'hi' }, 'a message'],
      ['POST', `/mobile/jobs/${A.job}/photos`, { dataUrl: photoUrl }, 'a photo'],
      ['POST', `/mobile/jobs/${A.job}/assets/scans`, { rawValue: 'QR-1', lat: 29.9, lon: 78.1 }, 'a scan'],
      ['POST', `/mobile/jobs/${A.job}/completion`, {}, 'a completion'],
      ['POST', `/mobile/jobs/${A.job}/reopen`, {}, 'a reopen']]) {
      const r = await call('c4', method, path, body);
      check(`another crew cannot send ${what} -> 403`, r.status === 403, `(${r.status})`);
    }
    const noClaim = await call('noClaim', 'GET', '/mobile/crews/C003/jobs');
    check('crew login without crew_id -> 403 NO_CREW_ID', noClaim.status === 403 && noClaim.body.code === 'NO_CREW_ID', `(${noClaim.status})`);
    check('dispatcher reads any crew', (await call('op', 'GET', '/mobile/crews/C003/jobs')).status === 200 && (await call('op', 'GET', `/mobile/jobs/${A.job}/history`)).status === 200);
    check('crew still reads GET /crews and GET /incidents (crew map)', (await call('c3', 'GET', '/crews')).status === 200 && (await call('c3', 'GET', '/incidents')).status === 200);
    const scanOwn = await call('c3', 'POST', `/mobile/jobs/${A.job}/assets/scans`, { rawValue: 'QR-OWN', lat: 29.9, lon: 78.1, crewId: 'C004' });
    check("a crew's scan is recorded under the token's crew, not the body's", scanOwn.status === 201 && scanOwn.body.crew_id === 'C003', scanOwn.body.crew_id);

    console.log('-- status validation');
    const bad = await appStatus(A.job, 'Banana', minsAgo(0));
    check('unknown status -> 400 BAD_STATUS', bad.status === 400 && bad.body.code === 'BAD_STATUS', `(${bad.status})`);

    console.log("-- the crew app's current sequence, exactly as it sends it");
    const seq = [['En Route', 9], ['On Site', 8], ['Work Started', 6], ['Work Finished', 4]].map(([s, m]) => [s, minsAgo(m)]);
    const photo = await call('c3', 'POST', `/mobile/jobs/${A.job}/photos`, { dataUrl: photoUrl, lat: 29.9, lon: 78.1, capturedAt: minsAgo(7), sentAt: minsAgo(0) });
    check('site photo accepted', photo.status === 201 && photo.body.applied === true, `(${photo.status})`);
    for (const [s, ts] of seq) {
      const r = await appStatus(A.job, s, ts);
      check(`${s} -> applied`, r.status === 200 && r.body.applied === true && r.body.status === (s === 'Work Finished' ? 'Work Complete' : s), `(${r.status} ${r.body.status} ${r.body.reason || ''})`);
    }
    const jA = await repo.job(A.job);
    check('job Work Complete with a server completed_at', jA.status === 'Work Complete' && !!jA.completed_at);
    check('incident Pending Verification', (await repo.incident(A.inc)).status === 'pending');
    check('crew app gets the undo window (undoUntil) and not locked', (await call('c3', 'GET', '/mobile/crews/C003/jobs')).body.find((j) => j.id === A.job)?.undoUntil != null);
    const crewRows = (await updatesOf(A.job)).filter((u) => u.source === 'crew').length;
    check('history rows marked crew (4) and dispatch (assignment)', crewRows === 4 && (await updatesOf(A.job)).some((u) => u.source === 'dispatch'), String(crewRows));

    console.log('-- duplicate and out-of-order replay');
    const before = (await updatesOf(A.job)).length;
    const replay = [];
    for (const [s, ts] of [...seq, ...seq.slice().reverse()]) replay.push(await appStatus(A.job, s, ts));
    check('every replayed update -> 200 applied:false', replay.every((r) => r.status === 200 && r.body.applied === false), replay.map((r) => r.body.reason).join(' | '));
    check('app: an identical resend ("already ...") gives no notice, a late one does',
      crewApp.serverJobUpdate(replay[3].body).notice === null && /not applied/.test(crewApp.serverJobUpdate(replay[0].body).notice || ''));
    check('state unchanged (Work Complete, no new history rows)', (await repo.job(A.job)).status === 'Work Complete' && (await updatesOf(A.job)).length === before);
    const lateA = await lateEvents(A.inc);
    check('one timeline event per (job, status, client time), not per replay', lateA.length === 3, `${lateA.length}: ${lateA.map((e) => e.note).join(' / ')}`);

    const B = await newJob('C003', 'Kankhal');
    const onSite = await appStatus(B.job, 'On Site', minsAgo(3));
    check('skipped step applied with a note (Acknowledged -> On Site)', onSite.body.applied === true && onSite.body.skipped?.join() === 'En Route'
      && (await updatesOf(B.job)).some((u) => /skipped En Route/.test(u.note || '')));
    check('skipped On Site still moves the incident to in_progress', (await repo.incident(B.inc)).status === 'in_progress');
    const enRouteLate = await appStatus(B.job, 'En Route', minsAgo(5));
    check('older update after a newer one -> applied:false, still On Site', enRouteLate.body.applied === false && (await repo.job(B.job)).status === 'On Site', enRouteLate.body.reason);
    check('... and the dispatcher sees it on the timeline', (await lateEvents(B.inc)).length === 1);
    const backNow = await appStatus(B.job, 'En Route', minsAgo(0));
    check('a backward move sent later (not late) -> applied:false, still On Site', backNow.body.applied === false && (await repo.job(B.job)).status === 'On Site', backNow.body.reason);

    console.log('-- dispatcher touched the job after the crew acted offline');
    const C = await newJob('C003', 'Jwalapur');
    const offlineAt = minsAgo(4);
    await call('op', 'POST', `/incidents/${C.inc}/assign`, { crewId: 'C003', priority: 'Urgent' }); // touches updated_at now
    const cj = await repo.job(C.job);
    check('dispatcher write is newer than the crew action', new Date(cj.updated_at) > new Date(offlineAt));
    const synced = await appStatus(C.job, 'En Route', offlineAt);
    check("the crew's real update is still applied", synced.body.applied === true && (await repo.job(C.job)).status === 'En Route', synced.body.reason || '');
    const onBehalf = await call('op', 'PATCH', `/mobile/jobs/${C.job}/status`, { status: 'On Site', crewId: 'C003' });
    check('control room on behalf: applied, history marked dispatch', onBehalf.body.applied === true && (await updatesOf(C.job)).at(-1).source === 'dispatch');

    console.log('-- completion form');
    const form = { diagnosis: { cause: 'Blown fuse', action: 'Replaced fuse' }, partsUsed: [{ name: 'HRC fuse 63A', qty: 2 }], restored: 'yes',
      signOff: { name: 'R. Negi', signedAt: minsAgo(4) }, clientRequestId: 'cr-A-1', submittedAt: minsAgo(4), sentAt: minsAgo(0) };
    const sub = await call('c3', 'POST', `/mobile/jobs/${A.job}/completion`, form);
    check('completion saved -> 201', sub.status === 201 && sub.body.completion?.restored === 'yes', `(${sub.status})`);
    const sub2 = await call('c3', 'POST', `/mobile/jobs/${A.job}/completion`, form);
    check('same clientRequestId again -> 200, same row (idempotent)', sub2.status === 200 && sub2.body.duplicate === true && sub2.body.completion.id === sub.body.completion.id);
    check('one stored completion', (await repo.jobCompletions(A.job)).length === 1);
    check('bad restored value -> 400', (await call('c3', 'POST', `/mobile/jobs/${A.job}/completion`, { restored: 'maybe' })).status === 400);
    const early = await call('c3', 'POST', `/mobile/jobs/${C.job}/completion`, { restored: 'no' });
    check('completion before Work Started -> applied:false', early.status === 200 && early.body.applied === false, early.body.reason);
    // The app keeps such a form ("not delivered") and resends the SAME form once the job is Work Started.
    const heldForm = crewApp.completionPayload({ jobId: C.job, diagnosis: { cause: 'x', action: 'y' }, restored: 'partial', signOff: { name: 'N', signedAt: minsAgo(1) } });
    const first = await call('c3', 'POST', `/mobile/jobs/${C.job}/completion`, heldForm);
    check('form sent while the job is On Site -> applied:false, nothing stored', first.body.applied === false && (await repo.jobCompletions(C.job)).length === 0);
    await appStatus(C.job, 'Work Started', minsAgo(0));
    const resent = await call('c3', 'POST', `/mobile/jobs/${C.job}/completion`, heldForm);
    const resent2 = await call('c3', 'POST', `/mobile/jobs/${C.job}/completion`, heldForm);
    check('same form resent after Work Started -> stored once, under its clientRequestId', resent.status === 201 && resent2.status === 200
      && (await repo.jobCompletions(C.job)).length === 1 && resent.body.completion.client_request_id === heldForm.clientRequestId);

    console.log('-- undo inside the window');
    const reopen = await call('c3', 'POST', `/mobile/jobs/${A.job}/reopen`, {});
    check('crew reopens -> Work Started', reopen.body.applied === true && (await repo.job(A.job)).status === 'Work Started', reopen.body.reason || '');
    check('incident back to in_progress, dispatcher sees the reopen', (await repo.incident(A.inc)).status === 'in_progress'
      && (await events(A.inc)).some((e) => /reopened job/.test(e.note)));
    check('reopen audited', !!(await db.oneOrNone("SELECT 1 FROM audit_log WHERE action='job.reopen' AND target=$1", [A.job])));
    const oldFinish = await appStatus(A.job, 'Work Finished', seq[3][1]);
    check('the old Work Finished replayed after the reopen -> applied:false', oldFinish.body.applied === false && (await repo.job(A.job)).status === 'Work Started');
    const finish2 = await appStatus(A.job, 'Work Finished', minsAgo(0));
    check('finished again -> Work Complete, pending', finish2.body.applied === true && (await repo.incident(A.inc)).status === 'pending');

    console.log('-- undo after the window, and the lock');
    await repo.updateJob(A.job, { completed_at: minsAgo(11) });
    const late = await call('c3', 'POST', `/mobile/jobs/${A.job}/reopen`, {});
    check('reopen after the window -> applied:false job locked', late.status === 200 && late.body.applied === false && late.body.reason === 'job locked' && late.body.locked === true);
    const lockedStatus = await appStatus(A.job, 'Work Started', minsAgo(0));
    check('status on a locked job -> 200 applied:false job locked', lockedStatus.status === 200 && lockedStatus.body.applied === false && lockedStatus.body.reason === 'job locked');
    const seen = crewApp.serverJobUpdate(lockedStatus.body);
    check('app reads the locked answer: server status, locked, a notice', seen.fields?.status === 'Work Complete' && seen.fields.locked === true && /job locked/.test(seen.notice || ''));
    const lp = { dataUrl: photoUrl, lat: 29.9, lon: 78.1, capturedAt: minsAgo(1), sentAt: minsAgo(0) };
    const lockedPhoto = await call('c3', 'POST', `/mobile/jobs/${A.job}/photos`, lp);
    check('photo on a locked job -> 200 applied:false', lockedPhoto.status === 200 && lockedPhoto.body.applied === false);
    const kept = await db.oneOrNone("SELECT id FROM job_photos WHERE job_id=$1 AND not_applied_reason='job locked'", [A.job]);
    check('... the photo is kept, marked not applied', !!kept);
    check('... hidden from the crew', !(await call('c3', 'GET', `/mobile/jobs/${A.job}/photos`)).body.some((p) => p.id === kept?.id));
    check('... visible to the dispatcher', (await call('op', 'GET', `/mobile/jobs/${A.job}/photos`)).body.some((p) => p.id === kept?.id && p.not_applied_reason === 'job locked'));
    await call('c3', 'POST', `/mobile/jobs/${A.job}/photos`, lp);
    check('... resending the same photo adds no second timeline event', (await lateEvents(A.inc)).filter((e) => /photo/.test(e.note)).length === 1);
    const lockedScan = await call('c3', 'POST', `/mobile/jobs/${A.job}/assets/scans`, { rawValue: 'QR-LATE', lat: 29.9, lon: 78.1, scannedAt: minsAgo(1) });
    check('scan on a locked job -> 200 applied:false, kept for the dispatcher only', lockedScan.body.applied === false
      && !(await call('c3', 'GET', `/mobile/jobs/${A.job}/assets/scans`)).body.some((x) => x.raw_value === 'QR-LATE')
      && (await call('op', 'GET', `/mobile/jobs/${A.job}/assets/scans`)).body.some((x) => x.raw_value === 'QR-LATE'));
    const lockedMsg = await call('c3', 'POST', `/mobile/jobs/${A.job}/messages`, { body: 'forgot to mention the pole' });
    check('message on a locked job -> 200 applied:false, text on the timeline', lockedMsg.body.applied === false
      && (await lateEvents(A.inc)).some((e) => /forgot to mention the pole/.test(e.note)));
    const lockedForm = await call('c3', 'POST', `/mobile/jobs/${A.job}/completion`, { ...form, clientRequestId: 'cr-A-2' });
    check('completion on a locked job -> 200 applied:false', lockedForm.body.applied === false);
    const report = (await call('op', 'GET', `/incidents/${A.inc}/field-report`)).body.find((r) => r.job.id === A.job);
    check('field report: locked, completion, kept photo and scan', report?.locked === true && report.completions.length === 1
      && report.notApplied.photos.length === 2 && report.notApplied.scans.length === 1);

    console.log('-- undo after the dispatcher resolved');
    const finB = await appStatus(B.job, 'Work Finished', minsAgo(0));
    check('job B complete inside the window', finB.body.applied === true && finB.body.undoUntil != null);
    await call('op', 'PATCH', `/incidents/${B.inc}/status`, { status: 'resolved' });
    const reB = await call('c3', 'POST', `/mobile/jobs/${B.job}/reopen`, {});
    check('reopen after the incident was resolved -> applied:false job locked', reB.body.applied === false && reB.body.reason === 'job locked');

    console.log('-- return for correction');
    check('field_crew_coordinator cannot return -> 403', (await call('coord', 'POST', `/incidents/${A.inc}/return-for-correction`, { reason: 'x' })).status === 403);
    check('crew cannot return -> 403', (await call('c3', 'POST', `/incidents/${A.inc}/return-for-correction`, { reason: 'x' })).status === 403);
    check('reason required -> 400', (await call('op', 'POST', `/incidents/${A.inc}/return-for-correction`, { reason: ' ' })).status === 400);
    check('not Pending Verification -> 409', (await call('op', 'POST', `/incidents/${B.inc}/return-for-correction`, { reason: 'x' })).status === 409);
    const rfc = await call('op', 'POST', `/incidents/${A.inc}/return-for-correction`, { reason: 'Photo of the replaced fuse missing' });
    check('returned -> incident in_progress, job Requires Revisit', rfc.status === 200 && rfc.body.incident.status === 'in_progress' && rfc.body.job.status === 'Requires Revisit', `(${rfc.status})`);
    check('crew in_service', (await repo.crew('C003')).status === 'in_service');
    check('timeline shows the reason', (await events(A.inc)).some((e) => /Returned for correction.*replaced fuse missing/.test(e.note)));
    check('job unlocked for the crew', (await call('c3', 'GET', '/mobile/crews/C003/jobs')).body.find((j) => j.id === A.job)?.locked === false);
    const again = await appStatus(A.job, 'Work Started', minsAgo(0));
    check('crew can work it again (Requires Revisit -> Work Started)', again.body.applied === true, again.body.reason || '');

    console.log('-- planned-outage jobs are untouched');
    const po = await db.one("SELECT incident_id FROM planned_outages ORDER BY id LIMIT 1");
    await db.none(`INSERT INTO jobs (id,incident_id,crew_id,priority,status,address,updated_at) VALUES ('JOB-PLANNED-T',$1,'C003','Normal','Acknowledged','x',now())`, [po.incident_id]);
    const pEn = await appStatus('JOB-PLANNED-T', 'En Route', minsAgo(0));
    check('planned job status is answered by the planned-outage route (no applied field)', pEn.status === 200 && pEn.body.status === 'En Route' && pEn.body.applied === undefined, `(${pEn.status})`);
    check('completion on a planned job -> 409 NOT_A_FAULT_JOB', (await call('c3', 'POST', '/mobile/jobs/JOB-PLANNED-T/completion', {})).body.code === 'NOT_A_FAULT_JOB');
    check('reopen on a planned job -> 409 NOT_A_FAULT_JOB', (await call('c3', 'POST', '/mobile/jobs/JOB-PLANNED-T/reopen', {})).body.code === 'NOT_A_FAULT_JOB');
    await repo.updateJob('JOB-PLANNED-T', { status: 'Work Complete', completed_at: minsAgo(60) });
    const pPhoto = await call('c3', 'POST', '/mobile/jobs/JOB-PLANNED-T/photos', { dataUrl: photoUrl });
    check('a finished planned job is never locked (photo -> 201)', pPhoto.status === 201 && pPhoto.body.applied === true, `(${pPhoto.status})`);
    check('planned job listed with planned:true, locked:false', (await call('c3', 'GET', '/mobile/crews/C003/jobs')).body.some((j) => j.id === 'JOB-PLANNED-T' && j.planned === true && j.locked === false));
    check('return-for-correction on a planned incident -> 409', (await call('op', 'POST', `/incidents/${po.incident_id}/return-for-correction`, { reason: 'x' })).status === 409);
    await db.none("DELETE FROM jobs WHERE id='JOB-PLANNED-T'");

    console.log('Crews offered for assignment (a crew may hold several jobs)');
    if (!(await db.oneOrNone("SELECT 1 FROM pg_extension WHERE extname='postgis'"))) {
      console.log('  (skipped: needs PostGIS for distances)');
    } else {
      // Only these three crews are on shift, so the list is exactly theirs.
      await db.none('UPDATE crews SET on_shift=false');
      const incAt = async (lat, lon) => (await call('op', 'POST', '/incidents', { zone: 'Kankhal-2', severity: 'high', lat, lon })).body;
      const busyInc = await incAt(29.937, 78.174);
      await db.none(`INSERT INTO crews (id, name, lead, status, location, job_id, lat, lon, skills, on_shift) VALUES
        ('T-FREE', 'Test Free', 'A', 'available', 'far depot', NULL, 30.05, 78.30, 'MV', true),
        ('T-BUSY', 'Test Busy', 'B', 'in_service', 'site', $1, 29.9372, 78.1742, 'MV', true),
        ('T-OFF',  'Test Off',  'C', 'available', 'near', NULL, 29.9371, 78.1741, 'MV', false)`, [busyInc.id]);
      await repo.createJob({ id: 'JOB-T-BUSY', incident_id: busyInc.id, crew_id: 'T-BUSY', priority: 'Normal', status: 'On Site', address: 'x', updated_at: new Date().toISOString() });
      const target = await incAt(29.937, 78.174);
      const offer = (await call('op', 'GET', `/incidents/${target.id}/nearest-crews`)).body;
      check('busy crews are offered, off-shift ones are not', offer.map((c) => c.id).join() === 'T-FREE,T-BUSY', offer.map((c) => c.id));
      check('a free crew comes first even when farther (T-FREE ~16 km before T-BUSY ~20 m)', offer[0]?.id === 'T-FREE' && offer[0].meters_away > offer[1].meters_away, offer.map((c) => Math.round(c.meters_away)));
      check('each crew carries its active job count (T-BUSY 1, T-FREE 0)', offer.find((c) => c.id === 'T-BUSY')?.active_jobs === 1 && offer.find((c) => c.id === 'T-FREE')?.active_jobs === 0);
      const a1 = await call('op', 'POST', `/incidents/${target.id}/assign`, { crewId: 'T-BUSY' });
      const busyAfter = await repo.crew('T-BUSY');
      check('assign to a crew On Site elsewhere: job created, crew stays in_service on its current job',
        a1.status === 200 && a1.body.job?.crew_id === 'T-BUSY' && busyAfter.status === 'in_service' && busyAfter.job_id === busyInc.id, JSON.stringify({ status: busyAfter.status, job_id: busyAfter.job_id }));
      const again = (await call('op', 'GET', `/incidents/${(await incAt(29.937, 78.174)).id}/nearest-crews`)).body;
      check('T-BUSY now shows 2 active jobs', again.find((c) => c.id === 'T-BUSY')?.active_jobs === 2);
      const idleInc = await incAt(30.0, 78.25);
      await call('op', 'POST', `/incidents/${idleInc.id}/assign`, { crewId: 'T-FREE' });
      const freeAfter = await repo.crew('T-FREE');
      check('assign to an idle crew: in_transit to that incident (unchanged behaviour)', freeAfter.status === 'in_transit' && freeAfter.job_id === idleInc.id, JSON.stringify({ status: freeAfter.status, job_id: freeAfter.job_id }));
      check('assign to an off-shift crew -> 409 CREW_OFF_SHIFT', (await call('op', 'POST', `/incidents/${idleInc.id}/assign`, { crewId: 'T-OFF' })).body.code === 'CREW_OFF_SHIFT');
      await db.none("UPDATE crews SET on_shift=true WHERE id NOT LIKE 'T-%'");
    }
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
