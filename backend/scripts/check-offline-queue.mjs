// Checks the crew app's Pending sync (src/lib/offlineQueue.js) for OMS-03
// completion forms, without a phone or a server.
//
//   node backend/scripts/check-offline-queue.mjs
//
// The real offlineQueue.js and jobFlow.js are copied next to fake
// AsyncStorage, expo-file-system and api modules and bundled with esbuild
// (npx, no new dependency). The fake api answers the way the server does.
// The real api.js is also bundled once, with a fake session and server, to
// check that postJobCompletion throws 401 when signed out instead of
// reporting success.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/lib');
const dir = mkdtempSync(join(tmpdir(), 'oms-queue-'));

const FAKES = {
  'fake-async-storage.js': `
const store = new Map();
export const __store = store;
export default {
  async getItem(k) { return store.has(k) ? store.get(k) : null; },
  async setItem(k, v) { store.set(k, String(v)); },
  async removeItem(k) { store.delete(k); },
  async multiRemove(ks) { ks.forEach((k) => store.delete(k)); },
};`,
  'fake-expo-fs.js': `
export const Paths = { document: 'doc' };
export class Directory { constructor(...p) { this.uri = p.join('/'); } create() {} }
export class File {
  constructor(...p) { this.uri = p.map((x) => x.uri ?? x).join('/'); }
  get exists() { return false; }
  write() {} async text() { return ''; } delete() {}
}`,
  // The api module offlineQueue.js imports: every call goes to server.answer.
  'api.js': `
export const server = { signedIn: true, calls: [], answer: async () => ({ applied: true }) };
const call = (c) => { server.calls.push(c); return server.answer(c); };
export const isNotYourJob = (err) => err?.code === "NOT_YOUR_JOB";
export async function isSignedIn() { return server.signedIn; }
export async function postJobCompletion(id, form) {
  if (!server.signedIn) throw Object.assign(new Error("Not signed in"), { status: 401, code: "SIGNED_OUT" });
  return call({ type: "completion", id, form });
}
export async function updateJobStatus(id, status) { return call({ type: "status", id, status }); }
export async function uploadJobPhoto(id) { return call({ type: "photo", id }); }
export async function saveAssetScan(id) { return call({ type: "scan", id }); }
export async function startWorkOrder(form, crewId) { return call({ type: "wo-start", crewId, form }); }
export async function closeWorkOrder(form, crewId) { return call({ type: "wo-close", crewId, form }); }`,
  'entry.js': `
export * as queue from "./offlineQueue.js";
export * as jobFlow from "./jobFlow.js";
export * as workOrder from "./workOrder.js";
export * as woStore from "./workOrderStore.js";
export { server } from "./api.js";
export { __store } from "./fake-async-storage.js";`,
  // For the real api.js check.
  'real-api/server.js': `export const apiBase = () => "http://oms.test/api"; export async function loadServer() {}`,
  'real-api/session.js': `
export const state = { signedIn: false };
export const isAuthenticated = () => state.signedIn;
export const myCrewId = () => "C003";
export async function freshAuthHeader() { return { Authorization: "Bearer t" }; }`,
  'real-api/react-native.js': `export const Platform = { OS: "android" };`,
  'real-api/entry.js': `export { postJobCompletion } from "./api.js"; export { state } from "./session.js";`,
};

mkdirSync(join(dir, 'real-api'));
for (const [name, src] of Object.entries(FAKES)) writeFileSync(join(dir, name), src);
copyFileSync(join(lib, 'offlineQueue.js'), join(dir, 'offlineQueue.js'));
copyFileSync(join(lib, 'jobFlow.js'), join(dir, 'jobFlow.js'));
copyFileSync(join(lib, 'workOrder.js'), join(dir, 'workOrder.js'));
copyFileSync(join(lib, 'workOrderStore.js'), join(dir, 'workOrderStore.js'));
copyFileSync(join(lib, 'api.js'), join(dir, 'real-api/api.js'));

const esbuild = (entry, out, aliases) => execFileSync('npx', ['--yes', 'esbuild@0.28.2', entry, '--bundle', '--platform=node', '--format=esm',
  '--log-level=warning', `--outfile=${out}`, ...aliases.map(([from, to]) => `--alias:${from}=${to}`)], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
esbuild('entry.js', 'bundle.mjs', [['@react-native-async-storage/async-storage', './fake-async-storage.js'], ['expo-file-system', './fake-expo-fs.js']]);
esbuild('real-api/entry.js', 'real-api.mjs', [['@react-native-async-storage/async-storage', './fake-async-storage.js'], ['react-native', './real-api/react-native.js']]);

const { queue, jobFlow, workOrder, woStore, server, __store } = await import(pathToFileURL(join(dir, 'bundle.mjs')).href);
const realApi = await import(pathToFileURL(join(dir, 'real-api.mjs')).href);

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}
const reset = () => { __store.clear(); server.calls = []; server.signedIn = true; server.answer = async () => ({ applied: true }); };
const refusal = (status, message, code) => Object.assign(new Error(message), { status, code });
const JOB = 'JOB-1';
const form = (at = 1000) => jobFlow.completionPayload({ jobId: JOB, diagnosis: { cause: 'fuse', action: 'replaced' }, restored: 'yes', at: new Date(at) });
const queueFormThenStatus = async (f = form()) => {
  await queue.queueCompletion(JOB, f);
  await queue.queueUpdate({ id: JOB, status: 'Work Finished', crewId: 'C003', queuedAt: 2000 });
};
const what = (items) => items.map((i) => i.type || 'status');

try {
  console.log('Pending sync, OMS-03 completion form');

  reset();
  await queueFormThenStatus();
  let r = await queue.flushQueue();
  check('form then status: delivered in that order, queue empty',
    what(server.calls).join() === 'completion,status' && r.flushed === 2 && r.remaining === 0 && (await queue.getQueueLength()) === 0, { calls: what(server.calls), r });

  reset();
  await queueFormThenStatus();
  server.answer = async () => { throw new Error('Network request failed'); };
  r = await queue.flushQueue();
  const left = await queue.getQueueItems();
  check('no signal: one attempt, both kept in order',
    server.calls.length === 1 && what(left).join() === 'completion,status' && r.dropped.length === 0, { calls: server.calls.length, left: what(left) });

  reset();
  const f = form();
  await queueFormThenStatus(f);
  server.answer = async (c) => (c.type === 'completion' ? { applied: false, reason: 'job is On Site, not started' } : { applied: true, job: { status: 'Work Finished' } });
  r = await queue.flushQueue();
  let kept = await queue.getUndeliveredCompletion(JOB);
  check('applied:false: form kept with its original id and the reason, queue empty',
    kept?.form.clientRequestId === f.clientRequestId && kept.reason === 'job is On Site, not started' && r.remaining === 0
      && r.notApplied.some((n) => n.type === 'completion'), { kept, r });

  server.calls = [];
  server.answer = async () => ({ applied: true, duplicate: false });
  await queue.queueCompletion(JOB, kept.form);
  r = await queue.flushQueue();
  check('resend with the same id: server gets the same id, stored copy cleared',
    server.calls[0]?.form.clientRequestId === f.clientRequestId && (await queue.getUndeliveredCompletion(JOB)) === null && r.remaining === 0, { calls: server.calls, r });

  reset();
  await queue.keepUndeliveredCompletion(JOB, f, 'earlier');
  await queue.queueCompletion(JOB, f);
  server.answer = async () => ({ applied: true, duplicate: true });
  r = await queue.flushQueue();
  check('duplicate replay counts as delivered: no notice, nothing dropped, stored copy cleared',
    r.flushed === 1 && r.notApplied.length === 0 && r.dropped.length === 0 && (await queue.getUndeliveredCompletion(JOB)) === null, r);

  reset();
  await queue.queueUpdate({ id: JOB, status: 'On Site', crewId: 'C003', queuedAt: 3000 });
  server.answer = async () => ({ applied: false, reason: 'already On Site', job: { status: 'On Site' } });
  r = await queue.flushQueue();
  check('"already ..." answer: no notice, item done', r.notApplied.length === 0 && r.dropped.length === 0 && r.remaining === 0, r);

  reset();
  await queueFormThenStatus(f);
  server.answer = async (c) => { if (c.type === 'completion') throw refusal(400, 'diagnosis.cause is required'); return { applied: true }; };
  r = await queue.flushQueue();
  kept = await queue.getUndeliveredCompletion(JOB);
  check('400 on the form: kept as not delivered (same id, reason), not dropped; the status after it still goes',
    kept?.form.clientRequestId === f.clientRequestId && kept.reason === 'diagnosis.cause is required' && r.dropped.length === 0
      && r.notApplied[0]?.reason === 'not delivered: diagnosis.cause is required' && what(server.calls).join() === 'completion,status' && r.remaining === 0, { kept, r });

  reset();
  await queue.queueCompletion(JOB, f);
  server.answer = async () => { throw refusal(409, 'job is assigned to another crew', 'NOT_YOUR_JOB'); };
  r = await queue.flushQueue();
  check('409 NOT_YOUR_JOB on the form: dropped with the notice, not kept',
    r.dropped[0]?.code === 'NOT_YOUR_JOB' && (await queue.getUndeliveredCompletion(JOB)) === null && r.remaining === 0, r);

  reset();
  await queue.queueCompletion(JOB, f);
  server.answer = async () => { throw refusal(404, 'job not found'); };
  r = await queue.flushQueue();
  check('404 on the form: dropped with the notice, not kept',
    r.dropped.length === 1 && (await queue.getUndeliveredCompletion(JOB)) === null && r.remaining === 0, r);

  reset();
  await queueFormThenStatus(f);
  server.signedIn = false;
  r = await queue.flushQueue();
  const whileOut = await queue.getQueueItems();
  server.signedIn = true;
  const r2 = await queue.flushQueue();
  check('signed out: form stays queued (status after it too), sent after signing in',
    what(whileOut).join() === 'completion,status' && r.dropped.length === 0 && server.calls[0]?.form.clientRequestId === f.clientRequestId
      && r2.remaining === 0 && (await queue.getUndeliveredCompletion(JOB)) === null, { whileOut: what(whileOut), r, r2 });

  reset();
  server.signedIn = false;
  const queued = await queue.queueCompletion(JOB, f);
  check('demo mode (never signed in): the form is not queued', queued === false && (await queue.getQueueLength()) === 0);

  console.log('Pending sync, OMS-03 daily work order');
  const DAY = '2026-10-15';
  const WO = workOrder.workOrderId('C003', DAY);
  const start = workOrder.startPayload({ crewId: 'C003', date: DAY, members: ['Priya Singh'], checks: { vehicle: true, tools: true, ppe: true, firstAid: true }, at: new Date(5000) });
  const close = workOrder.closePayload({ crewId: 'C003', date: DAY, open: [{ id: JOB }], reasons: { [JOB]: 'material' }, signOff: { name: 'Priya Singh' }, at: new Date(9000) });
  const queueDay = async (kind, payload) => {
    await queue.queueWorkOrder(kind, WO, 'C003', payload);
    await woStore.setPendingWorkOrder('C003', DAY, kind, payload);
  };

  reset();
  await queueDay('start', start);
  await queue.queueUpdate({ id: JOB, status: 'Work Finished', crewId: 'C003', queuedAt: 6000 });
  await queueDay('close', close);
  let view = workOrder.viewWorkOrder({ crewId: 'C003', date: DAY, server: null, local: await woStore.getPendingWorkOrder() });
  check('offline: the day shows as ended, waiting to sync', view.status === 'closed' && view.pendingSync === true, view);
  r = await queue.flushQueue();
  check('start, job update, end of day: delivered in that order with the crew and the same ids; pending marker cleared',
    what(server.calls).join() === 'wo-start,status,wo-close' && server.calls[0].crewId === 'C003'
      && server.calls[0].form.clientRequestId === start.clientRequestId && server.calls[2].form.clientRequestId === close.clientRequestId
      && r.remaining === 0 && (await woStore.getPendingWorkOrder()) === null, { calls: what(server.calls), r });

  reset();
  await queueDay('start', start);
  server.answer = async () => ({ applied: false, reason: 'day already started' });
  r = await queue.flushQueue();
  check('start answered applied:false: done, crew told, pending marker cleared',
    r.remaining === 0 && r.notApplied[0]?.reason === 'not applied: day already started' && (await woStore.getPendingWorkOrder()) === null, r);

  reset();
  await queueDay('close', close);
  server.answer = async () => { throw refusal(400, 'the crew lead must sign off the day'); };
  r = await queue.flushQueue();
  check('end of day refused (400): dropped with the reason, pending marker cleared',
    r.dropped[0]?.message === 'the crew lead must sign off the day' && r.remaining === 0 && (await woStore.getPendingWorkOrder()) === null, r);

  reset();
  await queueDay('start', start);
  server.answer = async () => { throw new Error('Network request failed'); };
  r = await queue.flushQueue();
  check('no signal: start of day stays queued and still shows as started',
    r.remaining === 1 && workOrder.viewWorkOrder({ crewId: 'C003', date: DAY, server: null, local: await woStore.getPendingWorkOrder() }).status === 'started', r);

  reset();
  await queueDay('start', start);
  server.signedIn = false;
  r = await queue.flushQueue();
  check('signed out: start of day stays queued, nothing sent', r.remaining === 1 && server.calls.length === 0 && r.dropped.length === 0, r);
  server.signedIn = true;

  reset();
  server.signedIn = false;
  check('demo mode: the start of day is not queued', (await queue.queueWorkOrder('start', WO, 'C003', start)) === false && (await queue.getQueueLength()) === 0);

  console.log('Real api.js');
  const fetches = [];
  globalThis.fetch = async (...a) => { fetches.push(a); return { ok: true, json: async () => ({ applied: true }) }; };
  realApi.state.signedIn = false;
  const err = await realApi.postJobCompletion(JOB, f).then(() => null, (e) => e);
  check('postJobCompletion signed out: throws 401, sends nothing', err?.status === 401 && fetches.length === 0, { err: err && { status: err.status, message: err.message }, fetches: fetches.length });
  realApi.state.signedIn = true;
  const ok = await realApi.postJobCompletion(JOB, f);
  check('postJobCompletion signed in: posts the form unchanged', ok?.applied === true && fetches.length === 1
    && JSON.parse(fetches[0][1].body).clientRequestId === f.clientRequestId && fetches[0][0].endsWith(`/mobile/jobs/${JOB}/completion`));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
