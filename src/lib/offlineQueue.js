// src/lib/offlineQueue.js
// Native offline handling with AsyncStorage. Status updates made while
// offline are queued and flushed once connectivity returns.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { updateJobStatus } from "./api";

const KEY = "oms-status-queue";

export async function queueUpdate(update) {
  const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  q.push({ ...update, queuedAt: update.queuedAt || Date.now() });
  await AsyncStorage.setItem(KEY, JSON.stringify(q));
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

// Returns the dropped items ({ ...item, code, message }) so the app can say
// which updates were not applied and why.
export async function flushQueue() {
  const q = JSON.parse((await AsyncStorage.getItem(KEY)) || "[]");
  if (!q.length) return { flushed: 0, remaining: 0, dropped: [] };

  const remaining = [];
  const dropped = [];
  for (const u of q) {
    try {
      await updateJobStatus(u.id, u.status, u.location || {}, u.crewId);
    } catch (err) {
      if (isRefusal(err)) dropped.push({ ...u, code: err.code ?? null, message: err.message });
      else remaining.push(u);
    }
  }
  await AsyncStorage.setItem(KEY, JSON.stringify(remaining));
  return { flushed: q.length - remaining.length - dropped.length, remaining: remaining.length, dropped };
}
