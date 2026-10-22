#!/usr/bin/env node
// Crew app <-> OMS dashboard workflow check.
//
// Replays what the crew app does against the real backend API (the same
// /api/mobile routes the phone and the browser crew app call) while reading
// back what the control-room dashboard would see. It checks that both sides
// agree about the job and incident life cycle, and reports places where the
// backend works but is weaker than it should be.
//
// IT WRITES TO THE DATABASE. It creates two low-severity incidents whose cause
// starts with "WORKFLOW-CHECK" (low severity is excluded from SAIDI/SAIFI),
// assigns them to two crews and walks them to Closed. It leaves each crew's
// job_id/location pointing at the test incident; re-run `npm run seed` in
// backend/ to reset. Use it on a development stack only.
//
// Results:  PASS     the two sides agree
//           FAIL     the workflow is broken (exit code 1)
//           FINDING  it works, but a protection you would expect is missing
//           SKIP     not run (needs a crew token)
//
// Usage (PowerShell, from backend/):
//   $env:OPERATOR_PASSWORD = "<test.operator password>"
//   node scripts/check-crew-workflow.mjs
//
// Environment:
//   API_URL            default http://localhost:4000/api   (the crew app's port)
//   KEYCLOAK_URL       default http://localhost:18080     KEYCLOAK_REALM default oms-upcl
//   OPERATOR_USER      default test.operator              OPERATOR_PASSWORD (or OPERATOR_TOKEN)
//   OPERATOR_TOTP      the current 6-digit authenticator code, if test.operator has one-time codes enabled
//   CREW_TOTP          same, for CREW_USER (rarely needed)
//   CREW_TOKEN         optional: a crew's bearer token copied from the running crew app.
//                      Without it the crew steps are replayed with the operator token and the
//                      crew-identity checks are skipped. (CREW_USER + CREW_PASSWORD also work,
//                      but only if "Direct access grants" is enabled for the oms-mobile client.)
//   CREW_ID            crew used for the workflow, default C004
//   OTHER_CREW_ID      crew used for the isolation checks, default C005
//   ALLOW_REMOTE=1     required if API_URL is not localhost / 127.0.0.1

const API = (process.env.API_URL || 'http://localhost:4000/api').replace(/\/$/, '');
const KC = (process.env.KEYCLOAK_URL || 'http://localhost:18080').replace(/\/$/, '');
const REALM = process.env.KEYCLOAK_REALM || 'oms-upcl';
const CREW_ID = process.env.CREW_ID || 'C004';
const OTHER_CREW_ID = process.env.OTHER_CREW_ID || 'C005';
const AUTH_MODE = process.env.AUTH_MODE || 'keycloak'; // 'header' is used only by the repo's own test harness
const TAG = 'WORKFLOW-CHECK ' + new Date().toISOString();
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const results = [];
const record = (level, name, detail = '') => {
  results.push({ level, name, detail });
  const tag = { PASS: 'PASS   ', FAIL: 'FAIL   ', FINDING: 'FINDING', SKIP: 'SKIP   ' }[level];
  console.log(`  [${tag}] ${name}${detail ? '  -> ' + detail : ''}`);
};
const check = (ok, name, detail = '', failLevel = 'FAIL') => record(ok ? 'PASS' : failLevel, name, detail);
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

async function passwordToken(clientId, username, password, totp) {
  const res = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password, ...(totp ? { totp } : {}) }),
  }).catch((e) => { throw new Error(`cannot reach Keycloak at ${KC} (${e.cause?.code || e.message})`); });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = body.error === 'invalid_grant'
      ? ` -- wrong password, OR the account needs a one-time code: set ${clientId === 'oms-mobile' ? 'CREW_TOTP' : 'OPERATOR_TOTP'} to the current 6-digit authenticator code, or skip passwords by setting ${clientId === 'oms-mobile' ? 'CREW_TOKEN' : 'OPERATOR_TOKEN'} (copy it from the app's browser DevTools)`
      : body.error === 'unauthorized_client'
      ? ` -- client "${clientId}" does not allow password grants. Use CREW_TOKEN instead, or enable "Direct access grants" for that client in the Keycloak admin console (testing only).`
      : '';
    throw new Error(`token request for ${username} failed: ${res.status} ${body.error || ''} ${body.error_description || ''}${hint}`);
  }
  return body.access_token;
}

// An "actor" is who is calling: a bearer token (real mode) or test headers (harness mode).
const bearer = (label, token) => ({ label, token, claims: decodeJwt(token) });
const headerActor = (label, user, roles, crew) => ({ label, headers: { 'x-test-user': user, 'x-test-roles': roles, ...(crew ? { 'x-test-crew': crew } : {}) }, claims: { realm_access: { roles: roles.split(',') }, crew_id: crew || undefined } });

async function call(actor, method, path, body) {
  const headers = { 'content-type': 'application/json', ...(actor.token ? { authorization: `Bearer ${actor.token}` } : actor.headers) };
  let res;
  try { res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { throw new Error(`cannot reach the backend at ${API} (${e.cause?.code || e.message}). Is it running on that port?`); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  const host = new URL(API).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.ALLOW_REMOTE !== '1') {
    console.error(`Refusing to run against ${host}: this script writes test data. Set ALLOW_REMOTE=1 only for a dev stack.`);
    process.exit(2);
  }
  console.log(`Crew app <-> OMS dashboard workflow check\n  API: ${API}\n  workflow crew: ${CREW_ID}   isolation crew: ${OTHER_CREW_ID}   tag: ${TAG}`);

  // ---- who is calling ------------------------------------------------------------------
  let operator, crew = null;
  if (AUTH_MODE === 'header') {
    operator = headerActor('operator', 'test.operator', 'oms_operator,system_admin');
    if (process.env.WITH_CREW === '1') crew = headerActor('crew', 'crew04', 'field_crew', CREW_ID);
  } else {
    const opToken = process.env.OPERATOR_TOKEN
      || await passwordToken('oms-web', process.env.OPERATOR_USER || 'test.operator', process.env.OPERATOR_PASSWORD || (() => { throw new Error('set OPERATOR_PASSWORD (or OPERATOR_TOKEN)'); })(), process.env.OPERATOR_TOTP);
    operator = bearer('operator', opToken);
    const crewToken = process.env.CREW_TOKEN
      || (process.env.CREW_USER ? await passwordToken('oms-mobile', process.env.CREW_USER, process.env.CREW_PASSWORD || 'crew123', process.env.CREW_TOTP) : null);
    if (crewToken) crew = bearer('crew', crewToken);
  }

  section('0. Sign-in and identity');
  const roles = operator.claims?.realm_access?.roles || [];
  check(roles.includes('oms_operator') || roles.includes('system_admin'), 'operator token carries a dispatcher role', roles.filter((r) => /oms|system/.test(r)).join(', '));
  if (crew) {
    const cr = crew.claims?.realm_access?.roles || [];
    check(cr.includes('field_crew'), 'crew token carries the field_crew role', cr.join(', '));
    check(crew.claims?.crew_id === CREW_ID, `crew token carries crew_id = ${CREW_ID}`, `crew_id claim: ${crew.claims?.crew_id ?? 'missing'} (the oms-mobile mapper decides this)`);
  } else record('SKIP', 'crew identity checks', 'no CREW_TOKEN given; crew steps are replayed with the operator token');
  const crewApp = crew && crew.claims?.crew_id === CREW_ID ? crew : operator; // who plays the phone
  record('PASS', `crew steps are performed by: ${crewApp.label}`);

  // ---- dispatcher creates and assigns --------------------------------------------------
  section('1. Dashboard: create an incident and dispatch it');
  const crews0 = (await call(operator, 'GET', '/crews')).body;
  const me0 = Array.isArray(crews0) && crews0.find((c) => c.id === CREW_ID);
  check(!!me0, `crew ${CREW_ID} exists in the dashboard's crew list`, me0 ? `status=${me0.status}` : 'missing; run npm run seed');
  if (!me0) return;

  const created = await call(operator, 'POST', '/incidents', { zone: 'Workflow Check', severity: 'low', type: 'Power Outage', cause: TAG, customers: 1 });
  check(created.status === 201 || created.status === 200, 'create incident', `HTTP ${created.status} ${created.body?.id || JSON.stringify(created.body).slice(0, 120)}`);
  const inc = created.body;
  if (!inc?.id) return;
  check(inc.status === 'open', 'new incident starts Open', inc.status);

  const assigned = await call(operator, 'POST', `/incidents/${inc.id}/assign`, { crewId: CREW_ID, priority: 'Normal' });
  check(assigned.status === 200, 'assign incident to the crew', `HTTP ${assigned.status}`);
  const job = assigned.body?.job;
  check(!!job?.id, 'assignment creates a job', job?.id || 'no job returned');
  if (!job?.id) return;
  check(assigned.body.incident?.status === 'dispatched', 'incident becomes Dispatched', assigned.body.incident?.status);
  check(assigned.body.crew?.status === 'in_transit', 'crew becomes in_transit', assigned.body.crew?.status);
  check(job.status === 'Acknowledged', 'job starts as Acknowledged', job.status);

  // ---- crew app sees it ---------------------------------------------------------------
  section('2. Crew app: the job arrives');
  const jobsRes = await call(crewApp, 'GET', `/mobile/crews/${CREW_ID}/jobs`);
  const mine = Array.isArray(jobsRes.body) ? jobsRes.body.find((j) => j.id === job.id) : null;
  check(jobsRes.status === 200 && !!mine, 'job appears in the crew app job list', `HTTP ${jobsRes.status}`);
  check(mine?.incident?.id === inc.id, 'job carries the right incident', mine?.incident?.id);
  check(mine?.address === 'Workflow Check', 'job carries the incident zone as its address', mine?.address);
  const meRes = await call(crewApp, 'GET', `/mobile/crews/${CREW_ID}`);
  check(meRes.status === 200 && meRes.body?.id === CREW_ID, 'crew profile loads', `HTTP ${meRes.status}`);

  // ---- status workflow, field -> control room ------------------------------------------
  section('3. Crew app advances the job; dashboard follows');
  const steps = [
    ['En Route', 'in_transit', 'dispatched'],
    ['On Site', 'in_service', 'in_progress'],
    ['Work Started', 'in_service', 'in_progress'],
    ['Work Complete', 'available', 'pending'],
  ];
  for (const [status, expCrew, expInc] of steps) {
    const r = await call(crewApp, 'PATCH', `/mobile/jobs/${job.id}/status`, { status, lat: 29.9457, lon: 78.1642, note: 'workflow check' });
    await sleep(150);
    const incNow = (await call(operator, 'GET', `/incidents/${inc.id}`)).body;
    const crewNow = (await call(operator, 'GET', '/crews')).body.find((c) => c.id === CREW_ID);
    const sawEvent = (incNow.events || []).some((e) => String(e.note || e.message || '').includes('Status: ' + status));
    check(r.status === 200 && r.body?.status === status, `crew sets "${status}"`, `HTTP ${r.status}`);
    check(crewNow?.status === expCrew, `  dashboard crew status is ${expCrew}`, crewNow?.status);
    check(incNow?.status === expInc, `  dashboard incident is ${expInc}`, incNow?.status);
    check(sawEvent, '  incident timeline records the step', sawEvent ? '' : 'no "Status: ' + status + '" event');
  }
  const hist = await call(crewApp, 'GET', `/mobile/jobs/${job.id}/history`);
  const seq = Array.isArray(hist.body) ? hist.body.map((h) => h.status) : [];
  check(['Acknowledged', 'En Route', 'On Site', 'Work Started', 'Work Complete'].every((s) => seq.includes(s)), 'job history holds every step with its timestamp', seq.join(' > '));
  check(Array.isArray(hist.body) && hist.body.filter((h) => h.lat != null).length >= 4, 'steps carry the GPS fix the phone sent');

  // ---- location and tracking -----------------------------------------------------------
  section('4. Location and tracking: crew app -> dashboard map');
  const pid = 'chk' + Math.random().toString(36).slice(2, 12);
  const loc = await call(crewApp, 'POST', `/mobile/crews/${CREW_ID}/locations`, { points: [{ id: pid, lat: 29.9501, lon: 78.1700, accuracy: 8, speed: 0, heading: 0, recordedAt: Date.now() }] });
  check(loc.status === 200 && loc.body?.inserted === 1 && (loc.body.ack || []).includes(pid), 'GPS batch accepted and acknowledged', JSON.stringify(loc.body));
  const crewPos = (await call(operator, 'GET', '/crews')).body.find((c) => c.id === CREW_ID);
  check(Math.abs(crewPos?.lat - 29.9501) < 1e-6 && Math.abs(crewPos?.lon - 78.1700) < 1e-6, 'dashboard crew marker moved to the reported position', `${crewPos?.lat}, ${crewPos?.lon}`);
  const trail = await call(operator, 'GET', `/mobile/crews/${CREW_ID}/track`);
  check(Array.isArray(trail.body) && trail.body.length >= 1, 'breadcrumb trail is available to dispatch', `${trail.body?.length ?? 0} point(s)`);
  const bad = await call(crewApp, 'POST', `/mobile/crews/${CREW_ID}/locations`, { points: [{ id: 'x', lat: 999, lon: 0, recordedAt: Date.now() }] });
  check(bad.status === 200 && bad.body?.rejected === 1, 'invalid GPS points are rejected, not stored', JSON.stringify(bad.body));
  const off = await call(crewApp, 'POST', `/mobile/crews/${CREW_ID}/tracking`, { state: 'off', reason: 'turned_off' });
  check(off.status === 200 && off.body?.changed === true, 'tracking-off is accepted (dispatch alert)', JSON.stringify(off.body));
  const crewOff = (await call(operator, 'GET', `/mobile/crews/${CREW_ID}`)).body;
  check(crewOff?.tracking_state === 'off' && crewOff?.tracking_reason === 'turned_off', 'dashboard sees tracking off and the reason', `${crewOff?.tracking_state}/${crewOff?.tracking_reason}`);
  const badReason = await call(crewApp, 'POST', `/mobile/crews/${CREW_ID}/tracking`, { state: 'off', reason: 'because' });
  check(badReason.status === 400, 'unknown tracking-off reason is rejected', `HTTP ${badReason.status}`);
  const on = await call(crewApp, 'POST', `/mobile/crews/${CREW_ID}/tracking`, { state: 'on' });
  check(on.status === 200 && on.body?.changed === true, 'tracking back on is accepted', JSON.stringify(on.body));

  // ---- photos and messages --------------------------------------------------------------
  section('5. Photos and messages');
  const ph = await call(crewApp, 'POST', `/mobile/jobs/${job.id}/photos`, { dataUrl: PNG_1X1, lat: 29.95, lon: 78.17, note: 'workflow check', technicianId: CREW_ID });
  check(ph.status === 201, 'photo upload accepted (server compresses it)', `HTTP ${ph.status} ${ph.status === 201 ? '' : JSON.stringify(ph.body).slice(0, 100)}`);
  const phList = await call(crewApp, 'GET', `/mobile/jobs/${job.id}/photos`);
  check(Array.isArray(phList.body) && phList.body.length >= 1, 'uploaded photo is listed for the job', `${phList.body?.length ?? 0} photo(s)`);
  const phBad = await call(crewApp, 'POST', `/mobile/jobs/${job.id}/photos`, { dataUrl: 'data:image/png;base64,AAAA' });
  check(phBad.status === 400, 'a corrupt image is rejected with 400', `HTTP ${phBad.status}`);
  const msg = await call(crewApp, 'POST', `/mobile/jobs/${job.id}/messages`, { body: 'workflow check message' });
  check(msg.status === 201, 'crew message accepted', `HTTP ${msg.status}`);
  const dashMsgs = await call(operator, 'GET', `/incidents/${inc.id}/messages`);
  check(Array.isArray(dashMsgs.body) && dashMsgs.body.some((m) => m.body === 'workflow check message'), 'dashboard sees the crew message on the incident', `${dashMsgs.body?.length ?? 0} message(s)`);

  // ---- dispatcher closes the loop --------------------------------------------------------
  section('6. Dashboard verifies restoration and closes');
  const res1 = await call(operator, 'PATCH', `/incidents/${inc.id}/status`, { status: 'resolved' });
  check(res1.status === 200, 'dispatcher resolves the pending incident', `HTTP ${res1.status}`);
  const res2 = await call(operator, 'PATCH', `/incidents/${inc.id}/status`, { status: 'closed' });
  check(res2.status === 200, 'dispatcher closes it', `HTTP ${res2.status}`);
  const finalInc = (await call(operator, 'GET', `/incidents/${inc.id}`)).body;
  check(finalInc?.status === 'closed', 'final incident state is Closed', finalInc?.status);
  const finalCrew = (await call(operator, 'GET', '/crews')).body.find((c) => c.id === CREW_ID);
  check(finalCrew?.status === 'available', 'crew is available again', finalCrew?.status);

  // ---- who may do what -------------------------------------------------------------------
  section('7. Who may do what (crew isolation)');
  if (!crew || crew.claims?.crew_id !== CREW_ID) {
    record('SKIP', 'isolation checks', 'need CREW_TOKEN for ' + CREW_ID + ' (copy it from the running crew app)');
  } else {
    // An empty body creates nothing: a guarded route answers 403, an unguarded one answers 400 (fields missing).
    const opOnly = await call(crew, 'POST', '/incidents', {});
    check(opOnly.status === 403, 'a crew token cannot create incidents (dispatcher-only)', `HTTP ${opOnly.status}${opOnly.status === 400 ? ' (the route has no role check)' : ''}`, 'FINDING');
    const otherLoc = await call(crew, 'POST', `/mobile/crews/${OTHER_CREW_ID}/locations`, { points: [{ id: 'abcdefgh1', lat: 29.9, lon: 78.1, recordedAt: Date.now() }] });
    check(otherLoc.status === 403, `a crew cannot report GPS for another crew (${OTHER_CREW_ID})`, `HTTP ${otherLoc.status}`);
    const otherTrack = await call(crew, 'POST', `/mobile/crews/${OTHER_CREW_ID}/tracking`, { state: 'on' });
    check(otherTrack.status === 403, 'a crew cannot change another crew\'s tracking state', `HTTP ${otherTrack.status}`);
    const otherJobs = await call(crew, 'GET', `/mobile/crews/${OTHER_CREW_ID}/jobs`);
    check(otherJobs.status === 403, `a crew cannot read another crew's job list (${OTHER_CREW_ID})`, `HTTP ${otherJobs.status} (the route has no ownership check)`, 'FINDING');
    // cross-crew WRITE: give the other crew a real job, then try to move it with this crew's token
    const inc2 = (await call(operator, 'POST', '/incidents', { zone: 'Workflow Check 2', severity: 'low', type: 'Power Outage', cause: TAG + ' (isolation)', customers: 1 })).body;
    const asg2 = inc2?.id ? (await call(operator, 'POST', `/incidents/${inc2.id}/assign`, { crewId: OTHER_CREW_ID })).body : null;
    if (asg2?.job?.id) {
      const hijack = await call(crew, 'PATCH', `/mobile/jobs/${asg2.job.id}/status`, { status: 'On Site' });
      check(hijack.status === 403, `a crew cannot change another crew's job status`, `HTTP ${hijack.status} (the route has no ownership check)`, 'FINDING');
      const junk = await call(crew, 'PATCH', `/mobile/jobs/${asg2.job.id}/status`, { status: 'banana' });
      check(junk.status === 400, 'an unknown job status is rejected', `HTTP ${junk.status} (any text is accepted today)`, 'FINDING');
      await call(operator, 'PATCH', `/mobile/jobs/${asg2.job.id}/status`, { status: 'Work Complete' });
      await call(operator, 'PATCH', `/incidents/${inc2.id}/status`, { status: 'resolved' });
      await call(operator, 'PATCH', `/incidents/${inc2.id}/status`, { status: 'closed' });
    } else record('SKIP', 'cross-crew write checks', `could not create a job for ${OTHER_CREW_ID}`);
  }
}

main().then(() => {
  const n = (l) => results.filter((r) => r.level === l).length;
  console.log(`\n==== SUMMARY: ${n('PASS')} passed, ${n('FAIL')} failed, ${n('FINDING')} findings, ${n('SKIP')} skipped ====`);
  for (const r of results.filter((x) => x.level === 'FAIL')) console.log(`  FAIL     ${r.name}  ${r.detail}`);
  for (const r of results.filter((x) => x.level === 'FINDING')) console.log(`  FINDING  ${r.name}  ${r.detail}`);
  console.log(n('FAIL') ? '\nWorkflow is NOT consistent between the crew app and the dashboard.' : '\nCrew app and dashboard agree on the workflow.' + (n('FINDING') ? `\n${n('FINDING')} finding(s) above are protections the backend does not enforce yet.` : ''));
  process.exit(n('FAIL') ? 1 : 0);
}).catch((e) => { console.error('\nCheck aborted: ' + e.message); process.exit(2); });
