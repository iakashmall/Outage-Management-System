// src/lib/jobDraft.js
// What the crew has done on a job screen that the server does not hold yet
// (or holds only as a record): the priority checklist ticks, the safety
// checklist, and the completion form filled so far. Kept on the phone per
// job, so closing the app (or the OS killing it) never sends the crew back
// to the first checklist. The job's status itself comes from the server.
//
// Also the page the crew had open (tab + job), to reopen it on the next start.
import AsyncStorage from "@react-native-async-storage/async-storage";

const DRAFT_PREFIX = "oms-job-draft:";
const PAGE_KEY = "oms-last-page";

export async function loadDraft(jobId) {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_PREFIX + jobId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Merges patch into the job's draft (writes are serialised per job so two
// quick changes can't overwrite each other).
const chains = new Map();
export function saveDraft(jobId, patch) {
  const run = (chains.get(jobId) || Promise.resolve()).then(async () => {
    const next = { ...(await loadDraft(jobId)), ...patch };
    await AsyncStorage.setItem(DRAFT_PREFIX + jobId, JSON.stringify(next));
  }).catch(() => {});
  chains.set(jobId, run);
  return run;
}

export function clearDraft(jobId) {
  return AsyncStorage.removeItem(DRAFT_PREFIX + jobId).catch(() => {});
}

export function saveLastPage(page) {
  return AsyncStorage.setItem(PAGE_KEY, JSON.stringify({ tab: page.tab, jobId: page.jobId || null })).catch(() => {});
}

export async function loadLastPage() {
  try {
    const raw = await AsyncStorage.getItem(PAGE_KEY);
    const page = raw ? JSON.parse(raw) : null;
    return page && typeof page.tab === "string" ? page : null;
  } catch {
    return null;
  }
}
