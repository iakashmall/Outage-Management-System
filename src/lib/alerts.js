// src/lib/alerts.js
// New work and new messages for the crew: a phone notification with sound
// (also when the app is in the background, from the tracking task) and a
// "delivered" report to the OMS so the dashboard shows the crew's phone got
// the job. There is no push channel: the app checks every few seconds while
// open, and the background tracking task checks on its wake-ups.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { fetchMyJobs, getCrewMessages, reportJobSeen } from "./api";

const KNOWN_JOBS_KEY = "oms-alert-known-jobs"; // { crewId, ids: [] }
const LAST_MESSAGE_KEY = "oms-alert-last-message"; // { crewId, ts, ids: [] }
const JOB_CHANNEL = "oms-new-jobs";
const MESSAGE_CHANNEL = "oms-messages";
const BACKGROUND_GAP_MS = 30000;
const isNative = Platform.OS === "android" || Platform.OS === "ios";

// A message the crew app sent itself (POST /mobile/jobs/:id/messages).
export const isOwnMessage = (m) => m?.sender_role === "field_crew";
// A job the crew can still work (a cancelled one goes to Pending Sync).
const isLiveJob = (job) => !job.cancelled;

let ready = null;
// Once per app run: how notifications show while the app is open, and the
// Android channels (high importance = sound + heads-up banner).
export function setupAlerts() {
  if (!isNative) return Promise.resolve(false);
  if (!ready) {
    ready = (async () => {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
      });
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync(JOB_CHANNEL, {
          name: "New jobs", importance: Notifications.AndroidImportance.MAX, sound: "default",
          vibrationPattern: [0, 400, 250, 400], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        });
        await Notifications.setNotificationChannelAsync(MESSAGE_CHANNEL, {
          name: "Control room messages", importance: Notifications.AndroidImportance.HIGH, sound: "default",
          vibrationPattern: [0, 250],
        });
      }
      const current = await Notifications.getPermissionsAsync();
      if (current.granted) return true;
      if (!current.canAskAgain) return false;
      return (await Notifications.requestPermissionsAsync()).granted;
    })().catch((err) => {
      console.warn("[alerts] setup failed:", err?.message);
      ready = null;
      return false;
    });
  }
  return ready;
}

async function notify(channelId, title, body, data) {
  if (!isNative || !(await setupAlerts())) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data, sound: "default", priority: Notifications.AndroidNotificationPriority.MAX },
    trigger: Platform.OS === "android" ? { channelId } : null,
  }).catch((err) => console.warn("[alerts] notify failed:", err?.message));
}

// One check at a time (the open app and the background task share this).
let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function readJson(key) {
  try {
    return JSON.parse((await AsyncStorage.getItem(key)) || "null");
  } catch {
    return null;
  }
}

// Jobs on the server's list the phone has not seen before. The first list
// after installing (or for a crew new to this phone) only sets the baseline,
// so a crew is not alerted about work it already had.
export function findNewJobs(crewId, jobs) {
  return serial(async () => {
    const live = jobs.filter(isLiveJob);
    const known = await readJson(KNOWN_JOBS_KEY);
    const baseline = !known || known.crewId !== crewId;
    const knownIds = new Set(baseline ? [] : known.ids);
    const fresh = baseline ? [] : live.filter((job) => !knownIds.has(job.id));
    // Keep only ids still on the list, so a job that comes back counts as new.
    await AsyncStorage.setItem(KNOWN_JOBS_KEY, JSON.stringify({ crewId, ids: live.map((j) => j.id) })).catch(() => {});
    return fresh;
  });
}

// Control-room messages newer than the last one the phone has seen.
export function findNewMessages(crewId, messages) {
  return serial(async () => {
    const last = await readJson(LAST_MESSAGE_KEY);
    const baseline = !last || last.crewId !== crewId;
    const seen = new Set(baseline ? [] : last.ids);
    const fresh = baseline ? [] : messages.filter((m) => !isOwnMessage(m) && !seen.has(m.id));
    const ids = messages.slice(-200).map((m) => m.id);
    await AsyncStorage.setItem(LAST_MESSAGE_KEY, JSON.stringify({ crewId, ids })).catch(() => {});
    return fresh;
  });
}

const jobLine = (job) => [job.severity, job.title, job.address].filter(Boolean).join(" · ");

export async function alertNewJobs(jobs) {
  if (!jobs.length) return;
  const title = jobs.length === 1 ? `New job assigned: ${jobs[0].id}` : `${jobs.length} new jobs assigned`;
  const body = jobs.length === 1 ? jobLine(jobs[0]) : jobs.map((j) => j.id).join(", ");
  await notify(JOB_CHANNEL, title, body, { kind: "job", jobId: jobs[0].id });
}

export async function alertNewMessages(messages) {
  if (!messages.length) return;
  const m = messages[messages.length - 1];
  const title = messages.length === 1 ? `Message from ${m.sender || "control room"}` : `${messages.length} new messages`;
  await notify(MESSAGE_CHANNEL, title, `${m.job_id ? m.job_id + ": " : ""}${m.body}`, { kind: "message", jobId: m.job_id || null });
}

// Tell the OMS the phone has the job ('delivered', first time only on the
// server). Remembered per run so the same job is not reported every poll.
const reported = new Set();
export function reportDelivered(jobs) {
  for (const job of jobs) {
    if (!isLiveJob(job) || job.deliveredAt || reported.has(job.id)) continue;
    reported.add(job.id);
    reportJobSeen(job.id, "delivered").catch(() => reported.delete(job.id));
  }
}

// Background tracking task: same checks, at most every 30 s, only when the
// app is not open (the open app does its own, faster checks).
let lastBackground = 0;
export async function backgroundCheck(crewId, appActive) {
  if (appActive || !crewId || Date.now() - lastBackground < BACKGROUND_GAP_MS) return;
  lastBackground = Date.now();
  try {
    const { jobs, fromServer } = await fetchMyJobs();
    if (fromServer) {
      reportDelivered(jobs);
      await alertNewJobs(await findNewJobs(crewId, jobs));
    }
    const messages = await getCrewMessages(crewId).catch(() => null);
    if (Array.isArray(messages)) await alertNewMessages(await findNewMessages(crewId, messages));
  } catch (err) {
    console.warn("[alerts] background check failed:", err?.message);
  }
}
