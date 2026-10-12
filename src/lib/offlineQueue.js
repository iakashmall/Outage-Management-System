// src/lib/offlineQueue.js
// Native offline handling with AsyncStorage. Status updates made while
// offline are queued and flushed once connectivity returns.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { updateJobStatus } from "./api";

const KEY = "oms-status-queue";

// Every read-modify-write of the queue runs through this chain, so an update
// queued while a flush is finishing is not overwritten by the flush.
let queueLock = Promise.resolve();
function withQueue(fn) {
  const run = queueLock.then(async () => {
    const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
    const next = await fn(q);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  });
  queueLock = run.catch(() => {});
  return run;
}

export async function queueUpdate(update) {
  await withQueue((q) => [...q, { ...update, queuedAt: update.queuedAt || Date.now() }]);
}

export async function getQueueLength() {
  const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  return q.length;
}

// Full queued items (job id, status they're stuck trying to sync, and
// when they were queued) — used to render a "pending sync" list on the
// dashboard, not just a count badge.
export async function getQueueItems() {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  } catch {
    return [];
  }
}

// A refusal will be refused again, so a 4xx drops the item instead of
// retrying it forever (e.g. 409 NOT_YOUR_JOB once the job was reassigned).
// No status (network) and 5xx are retried, and so are 401/408/429, which
// clear on their own (token refresh, timeout, rate limit).
const RETRYABLE_4XX = new Set([401, 408, 429]);
export const isRefusal = (err) => err?.status >= 400 && err.status < 500 && !RETRYABLE_4XX.has(err.status);

const itemKey = (u) => `${u.id}|${u.status}|${u.queuedAt}`;

// Returns the dropped items ({ ...item, code, message }) so the app can say
// which updates were not applied and why. Only one flush runs at a time: on
// a slow network the poll would otherwise start a second one that sends the
// same updates again. A call made meanwhile does nothing ({ busy: true }).
let flushing = false;
export async function flushQueue() {
  if (flushing) return { flushed: 0, remaining: null, dropped: [], busy: true };
  flushing = true;
  try {
    const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
    if (!q.length) return { flushed: 0, remaining: 0, dropped: [] };

    const done = new Set();
    const dropped = [];
    for (const u of q) {
      try {
        await updateJobStatus(u.id, u.status, u.location || {}, u.crewId);
        done.add(itemKey(u));
      } catch (err) {
        if (isRefusal(err)) {
          dropped.push({ ...u, code: err.code ?? null, message: err.message });
          done.add(itemKey(u));
        }
      }
    }
    // Re-read rather than overwrite: items queued during the flush stay.
    let remaining = 0;
    await withQueue((current) => {
      const left = current.filter((u) => !done.has(itemKey(u)));
      remaining = left.length;
      return left;
    });
    return { flushed: done.size - dropped.length, remaining, dropped };
  } finally {
    flushing = false;
  }
}
