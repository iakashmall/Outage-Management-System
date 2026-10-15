// src/lib/offlineQueue.js
// "Pending sync": job status changes, photos and QR asset scans made while
// the server can't be reached are kept on the phone and sent, in order, once
// it can. Each item carries when it really happened, so the server records
// that time, not the time it finally synced.
//
// Item shapes (older app versions stored status items without `type`):
//   { type: 'status', id, status, location, queuedAt }
//   { type: 'photo',  id, file, location, note, extra, queuedAt }   image in `file`
//   { type: 'scan',   id, scan, queuedAt }
//   { type: 'completion', id, form, queuedAt }   OMS-03, fault jobs only
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { updateJobStatus, uploadJobPhoto, saveAssetScan, postJobCompletion, isSignedIn, isNotYourJob } from "./api";
import { serverJobUpdate } from "./jobFlow";

const KEY = "oms-status-queue";
// OMS-03: completion forms the server answered applied:false or refused
// with a 4xx, by job id: { form, reason, at }. Kept until delivered so a
// form is never lost.
const UNDELIVERED_KEY = "oms-undelivered-completions";
// Photos are several hundred KB of base64, too big for AsyncStorage (about
// 2 MB per entry on Android), so each one waits in its own file.
const photoDir = () => new Directory(Paths.document, "pending-photos");

// Every read-modify-write of the queue runs through this chain, so an item
// queued while a flush is finishing is not overwritten by the flush.
let queueLock = Promise.resolve();
function withQueue(fn) {
  const run = queueLock.then(async () => {
    const next = await fn(await readQueue());
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  });
  queueLock = run.catch(() => {});
  return run;
}

async function readQueue() {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  } catch {
    return [];
  }
}

async function push(item) {
  await withQueue((q) => [...q, { ...item, queuedAt: item.queuedAt || Date.now() }]);
}

// A refusal will be refused again, so a 4xx drops the item instead of
// retrying it forever (e.g. 409 NOT_YOUR_JOB once the job was reassigned).
// No status (network) and 5xx are retried, and so are 401/408/429, which
// clear on their own (token refresh, timeout, rate limit).
const RETRYABLE_4XX = new Set([401, 408, 429]);
export const isRefusal = (err) => err?.status >= 400 && err.status < 500 && !RETRYABLE_4XX.has(err.status);
// Worth queueing and retrying: anything that is not a refusal.
export const isRetryable = (err) => !isRefusal(err);

// Status updates carry the crew that made them, so the server can refuse
// one for a job that has since been reassigned.
export async function queueUpdate(update) {
  await push({ type: "status", ...update });
}

export async function queuePhoto(jobId, dataUrl, location, note, extra) {
  const dir = photoDir();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `${jobId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  file.write(dataUrl);
  await push({ type: "photo", id: jobId, file: file.uri, location, note: note ?? null, extra: extra ?? {} });
}

export async function queueScan(jobId, scan) {
  await push({ type: "scan", id: jobId, scan });
}

// The crew's completion form (OMS-03). Callers check canSendCompletion(job)
// first: never queued for a planned-outage job. Demo mode (not signed in)
// has no server to deliver it to, so it is not queued there.
export async function queueCompletion(jobId, form) {
  if (!(await isSignedIn())) return false;
  await push({ type: "completion", id: jobId, form });
  return true;
}

async function readUndelivered() {
  try {
    return JSON.parse((await AsyncStorage.getItem(UNDELIVERED_KEY)) || "{}");
  } catch {
    return {};
  }
}

// The form is stored as it was (same clientRequestId), with why it was not applied.
export async function keepUndeliveredCompletion(jobId, form, reason) {
  const all = await readUndelivered();
  all[jobId] = { form, reason: reason || "not applied", at: Date.now() };
  await AsyncStorage.setItem(UNDELIVERED_KEY, JSON.stringify(all));
}

export async function getUndeliveredCompletion(jobId) {
  return (await readUndelivered())[jobId] || null;
}

export async function clearUndeliveredCompletion(jobId) {
  const all = await readUndelivered();
  if (!(jobId in all)) return;
  delete all[jobId];
  await AsyncStorage.setItem(UNDELIVERED_KEY, JSON.stringify(all));
}

export async function getQueueLength() {
  return (await readQueue()).length;
}

// Full queued items (job id, what is waiting and since when), for the
// "pending sync" list on the dashboard.
export async function getQueueItems() {
  return readQueue();
}

const deletePhotoFile = (item) => {
  if (item.type !== "photo") return;
  try { new File(item.file).delete(); } catch { /* already gone */ }
};

async function send(item) {
  const ts = new Date(item.queuedAt).toISOString();
  if (item.type === "photo") {
    const file = new File(item.file);
    if (!file.exists) return; // lost (e.g. app data cleared): nothing to send
    const dataUrl = await file.text();
    const res = await uploadJobPhoto(item.id, dataUrl, item.location || {}, item.note, { ...item.extra, capturedAt: ts });
    deletePhotoFile(item);
    return res;
  } else if (item.type === "scan") {
    return saveAssetScan(item.id, { ...item.scan, scannedAt: ts });
  } else if (item.type === "completion") {
    return postJobCompletion(item.id, item.form);
  }
  return updateJobStatus(item.id, item.status, item.location || {}, item.crewId, ts);
}

const itemKey = (u) => `${u.type || "status"}|${u.id}|${u.status ?? u.file ?? u.form?.clientRequestId ?? ""}|${u.queuedAt}`;

let flushing = null;

// Sends queued items oldest first. Stops at the first one the server can't
// be reached for (the rest would fail too, and order matters: "On Site" must
// not arrive before "En Route"). One the server refuses is dropped and
// returned in `dropped` ({ ...item, code, message }) so the app can say
// which updates were not applied and why. A refused completion form is kept
// as "not delivered" instead, unless the job is no longer the crew's (409
// NOT_YOUR_JOB, 404). Only one flush runs at a time; a
// call made meanwhile gets the running one.
export function flushQueue() {
  if (!flushing) {
    flushing = (async () => {
      const q = await readQueue();
      if (!q.length) return { flushed: 0, remaining: 0, dropped: [], notApplied: [] };
      const done = new Set();
      const dropped = [];
      // OMS-03: answered 200 { applied:false } (late, or the job is locked):
      // done, but the crew is told it did not count.
      const notApplied = [];
      for (const item of q) {
        try {
          const res = await send(item);
          const { notice } = serverJobUpdate(res);
          if (notice) notApplied.push({ ...item, reason: notice });
          // A completion form the server did not apply stays on the phone
          // ("not delivered") so the crew can send it again.
          if (item.type === "completion") {
            if (res?.applied === false) await keepUndeliveredCompletion(item.id, item.form, res.reason);
            else await clearUndeliveredCompletion(item.id);
          }
          done.add(itemKey(item));
        } catch (err) {
          if (!isRefusal(err)) break;
          if (item.type === "completion" && !isNotYourJob(err) && err.status !== 404) {
            await keepUndeliveredCompletion(item.id, item.form, err.message);
            notApplied.push({ ...item, reason: `not delivered: ${err.message}` });
            done.add(itemKey(item));
            continue;
          }
          dropped.push({ ...item, code: err.code ?? null, message: err.message });
          deletePhotoFile(item);
          done.add(itemKey(item));
        }
      }
      // Re-read rather than overwrite: items queued during the flush stay.
      let remaining = 0;
      await withQueue((current) => {
        const left = current.filter((u) => !done.has(itemKey(u)));
        remaining = left.length;
        return left;
      });
      return { flushed: done.size - dropped.length, remaining, dropped, notApplied };
    })().finally(() => { flushing = null; });
  }
  return flushing;
}
