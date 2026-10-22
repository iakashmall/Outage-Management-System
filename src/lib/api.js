// src/lib/api.js
//
// The SINGLE file that talks to the backend. The UI (App.jsx / NativeApp.jsx
// and their screens) should never call fetch() directly — only these
// functions. That keeps the backend swappable without touching any screen.
//
// Both builds call the same /api/mobile/... routes with a Keycloak bearer
// token (lib/session.js: expo-auth-session natively, keycloak-js on web):
//   - Web (Vite):        relative "/api/..." calls through the dev/nginx proxy
//   - Native (Expo/RN):  absolute calls to the configured server (lib/server.js)
// Signed out, both fall back to the demo crew and jobs below.
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiBase, loadServer } from "./server";
const IS_WEB = Platform.OS === "web";
const WEB_API_URL = "/api";
const JOBS_CACHE_KEY = "oms-jobs-cache";
const JOBS_CACHE_SYNCED_AT_KEY = "oms-jobs-cache-synced-at";

async function session() {
  return import("./session");
}

// Cache the last successfully-fetched job list, including coordinates, so
// the native map can render the last known work area without a network.
async function cacheJobs(jobs) {
  try {
    await AsyncStorage.setItem(JOBS_CACHE_KEY, JSON.stringify(jobs));
    await AsyncStorage.setItem(JOBS_CACHE_SYNCED_AT_KEY, String(Date.now()));
  } catch {
    // best-effort — a caching failure shouldn't block the fetch result
  }
}

async function readCachedJobs() {
  try {
    const stored = await AsyncStorage.getItem(JOBS_CACHE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

// When the cached job list was last successfully synced, or null if
// nothing has ever synced. Shown in the UI as an "offline-ready" note.
export async function getJobsLastSyncedAt() {
  try {
    const stored = await AsyncStorage.getItem(JOBS_CACHE_SYNCED_AT_KEY);
    return stored ? Number(stored) : null;
  } catch {
    return null;
  }
}

/* ========================================================
   DEMO FALLBACK DATA
   Used only when nobody is signed in, so the app is still demoable without
   a live backend/Keycloak instance. A signed-in crew never sees it.
========================================================= */

const DEMO_CREW = {
  id: "C003",
  name: "Crew Gamma-2",
  lead: "Priya Singh",
  role: "Field Technician",
  shift: "06:00–18:00",
  skills: ["HV", "Transformer"],
};

let demoJobs = [
  { id: "JOB-1005", title: "Pending Line Inspection", address: "Mussoorie Road, Dehradun", feeder: "FDR-17", severity: "High", priority: "Urgent", customers: 386, status: "Pending Acceptance", distance: "1.6 km", eta: "6 min", assignedCrewId: "C003", assignedDistance: "1.6 km", coordinates: { lat: 30.3606, lon: 78.0647 } },
  { id: "JOB-1001", title: "Transformer Failure", address: "Rajpur Road, Dehradun", feeder: "FDR-12", severity: "Critical", priority: "Urgent", customers: 842, status: "Acknowledged", distance: "2.4 km", eta: "7 min", coordinates: { lat: 30.3476, lon: 78.0808 } },
  { id: "JOB-1002", title: "Line Fault", address: "Haridwar Road, Rishikesh", feeder: "FDR-08", severity: "High", priority: "Urgent", customers: 531, status: "En Route", distance: "5.8 km", eta: "14 min", coordinates: { lat: 30.0869, lon: 78.2676 } },
  { id: "JOB-1003", title: "Fuse Failure", address: "Clock Tower, Dehradun", feeder: "FDR-03", severity: "Medium", priority: "Normal", customers: 214, status: "On Site", distance: "8.2 km", eta: "21 min", coordinates: { lat: 30.3243, lon: 78.0418 } },
  { id: "JOB-1004", title: "Cable Fault", address: "Prem Nagar, Dehradun", feeder: "FDR-21", severity: "Low", priority: "Planned", customers: 93, status: "Work Started", distance: "11.4 km", eta: "28 min", coordinates: { lat: 30.335, lon: 77.961 } },
];

/* =========================================================
   LOW-LEVEL REQUEST HELPERS
========================================================= */

async function req(path, method = "GET", body) {
  const { freshAuthHeader } = await session();
  if (!IS_WEB) await loadServer();
  const response = await fetch((IS_WEB ? WEB_API_URL : apiBase()) + path, {
    method,
    headers: { "Content-Type": "application/json", ...(await freshAuthHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    // Keep the HTTP status and the server's rule code (e.g. NOT_YOUR_JOB) so
    // callers can tell a refusal (4xx: don't retry) from a network failure.
    const text = await response.text().catch(() => "");
    let data = {};
    try { data = JSON.parse(text); } catch { /* plain-text error body */ }
    throw Object.assign(new Error(data.message || data.error || text || `HTTP ${response.status}`), { status: response.status, code: data.code });
  }
  return response.json();
}

// OMS-03: the server refused a job update because the job was reassigned to
// another crew (rebalance or manual reassign) or left unassigned.
export const isNotYourJob = (err) => err?.code === "NOT_YOUR_JOB";

// False in demo mode, and once the crew signs out (items may still be queued).
export async function isSignedIn() {
  return (await session()).isAuthenticated();
}

function normalizeOmsJob(job) {
  const lat = Number(job.lat ?? job.latitude ?? job.location?.lat ?? job.location?.latitude ?? job.incident?.lat ?? job.incident?.latitude);
  const lon = Number(job.lon ?? job.lng ?? job.longitude ?? job.location?.lon ?? job.location?.longitude ?? job.incident?.lon ?? job.incident?.longitude);
  return {
    id: job.id ?? job.jobId,
    title: job.title ?? job.incident?.type ?? "Priority outage",
    address: job.address ?? job.incident?.zone ?? job.location ?? "Location unavailable",
    feeder: job.feeder ?? job.incident?.feeder ?? job.feederId ?? "—",
    severity: job.severity ?? job.incident?.severity ?? "Medium",
    // OMS-03: the priority dispatch plans with (raised by Medical / Critical /
    // VIP trouble calls on the incident), else the job's own.
    priority: job.effectivePriority ?? job.priority ?? "Urgent",
    medical: !!job.medical,
    // OMS-03: dispatch's planning estimate in minutes, when set.
    estimatedDurationMin: job.estimated_duration_min ?? job.estimatedDurationMin ?? null,
    customers: job.customers ?? job.incident?.customers ?? job.affectedCustomers ?? 0,
    status: job.status ?? "Pending Acceptance",
    distance: job.distance ?? (job.distanceKm ? `${job.distanceKm} km` : "—"),
    eta: job.eta ?? "—",
    assignedCrewId: job.assignedCrewId ?? job.crewId ?? job.crew_id ?? null,
    assignedDistance: job.assignedDistance ?? job.distance ?? "Nearest available",
    incidentId: job.incident_id ?? job.incidentId ?? null,
    // OMS-01: a job on a planned outage gets the permit / switching gates.
    planned: job.planned === true || (job.incident?.type ?? job.incidentType) === "Scheduled",
    // OMS-03: a finished fault job can be reopened until undoUntil; after
    // that it is locked (read-only on the phone).
    locked: !!job.locked,
    undoUntil: job.undoUntil ?? null,
    // OMS-03 daily work order: when a finished job was finished ("done today").
    completedAt: job.completed_at ?? job.completedAt ?? null,
    updatedAt: job.updated_at ?? job.updatedAt ?? null,
    coordinates: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
    // Cancelled by the control room (the job, or its incident): the app lists
    // it under Pending Sync instead of My Jobs.
    cancelled: job.status === "Cancelled" || job.incident?.status === "cancelled",
    // When the phone first received it / the crew first opened it (server time).
    deliveredAt: job.delivered_at ?? null,
    openedAt: job.opened_at ?? null,
  };
}

/* =========================================================
   PUBLIC API — same function names/shapes on web and native
========================================================= */

// GET /api/mobile/crews/:crewId — the signed-in crew's record.
export async function getCurrentCrew() {
  const { isAuthenticated, myCrewId, currentUsername } = await session();
  if (!isAuthenticated()) return DEMO_CREW;
  try {
    return await req("/mobile/crews/" + myCrewId());
  } catch {
    // Signed in but the backend is unreachable: keep the real identity
    // (so tracking and uploads still go to the right crew) rather than
    // passing the demo crew off as the tester's own.
    return { ...DEMO_CREW, id: myCrewId(), name: currentUsername() || myCrewId(), lead: "", skills: [] };
  }
}

// GET /api/mobile/crews/:crewId/jobs — this crew's jobs + incidents.
// { jobs, fromServer }: fromServer is false for the demo set and the offline
// fallback, so the app can tell "the server says this job is gone" from
// "no network".
export async function fetchMyJobs() {
  const { isAuthenticated, myCrewId } = await session();
  if (!isAuthenticated()) return { jobs: demoJobs, fromServer: false };
  try {
    const jobs = await req("/mobile/crews/" + myCrewId() + "/jobs");
    const mapped = (jobs ?? []).map(normalizeOmsJob);
    await cacheJobs(mapped);
    return { jobs: mapped, fromServer: true };
  } catch {
    // No connectivity / backend unreachable — show the last real synced
    // job list (offline-ready data) so the crew still sees their actual
    // last-known assignments. A signed-in crew never gets the demo set:
    // sample jobs would look like real work and hide the outage.
    const cached = await readCachedJobs();
    return { jobs: cached ?? [], fromServer: false };
  }
}

export async function getMyJobs() {
  return (await fetchMyJobs()).jobs;
}

// PATCH /api/mobile/jobs/:id/status  { status, lat, lon, crewId, ts, sentAt }
// crewId lets the server refuse (409 NOT_YOUR_JOB) an update to a job that
// was reassigned away from this crew. A queued update passes the crew that
// made it; otherwise it is the signed-in crew.
// ts: when the crew made the change, if earlier than now (pending sync).
// sentAt lets the server correct for a phone clock that is off.
export async function updateJobStatus(id, status, location = {}, crewId, ts) {
  const { isAuthenticated, myCrewId } = await session();
  if (!isAuthenticated()) {
    // Demo mode: keep the change locally so the demo flow still advances.
    demoJobs = demoJobs.map((item) => (item.id === id ? { ...item, status } : item));
    return demoJobs.find((item) => item.id === id);
  }
  return req(`/mobile/jobs/${id}/status`, "PATCH", {
    status,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
    crewId: crewId || myCrewId(),
    ts: ts ?? null,
    sentAt: new Date().toISOString(),
  });
}

// POST /api/mobile/jobs/:id/photos  { dataUrl, lat, lon, note }
export async function uploadJobPhoto(id, dataUrl, location = {}, note, metadata = {}) {
  // Demo mode has no account to upload as; the photo stays on the device.
  if (!(await session()).isAuthenticated()) return { id: "demo-photo", job_id: id, demo: true };
  return req(`/mobile/jobs/${id}/photos`, "POST", {
    dataUrl,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
    note: note ?? null,
    ...metadata,
    sentAt: new Date().toISOString(),
  });
}

// POST /api/mobile/crews/:crewId/tracking  { state: "on" | "off", reason }
// Tells dispatch whether continuous tracking is running; an unexpected "off"
// raises an alert on the OMS dashboard. Demo mode reports nothing.
export async function reportTrackingState(crewId, state, reason) {
  if (!(await session()).isAuthenticated()) return null;
  return req(`/mobile/crews/${crewId}/tracking`, "POST", { state, reason: reason ?? null });
}

export async function getJobMessages(jobId) {
  return req(`/mobile/jobs/${jobId}/messages`);
}

export async function getCrewMessages(crewId) {
  return req(`/mobile/crews/${crewId}/messages`);
}

// POST /api/mobile/jobs/:id/messages { body } — the crew writes to the control
// room on that job's incident thread. Online only (the crew sees it failed).
export async function sendJobMessage(jobId, body) {
  if (!(await isSignedIn())) throw Object.assign(new Error("Sign in to message the control room"), { status: 401 });
  return req(`/mobile/jobs/${jobId}/messages`, "POST", { body });
}

// POST /api/mobile/jobs/:id/seen { event: 'delivered' | 'opened' } — first time only on the server.
export async function reportJobSeen(jobId, event) {
  if (!(await isSignedIn())) return null;
  return req(`/mobile/jobs/${jobId}/seen`, "POST", { event, at: new Date().toISOString(), sentAt: new Date().toISOString() });
}

// The crew asks the control room to give this job to another crew.
// POST /api/mobile/jobs/:id/reassign-request { reason } -> { request }
export async function requestReassignment(jobId, reason) {
  if (!(await isSignedIn())) throw Object.assign(new Error("Sign in to ask for a reassignment"), { status: 401 });
  return req(`/mobile/jobs/${jobId}/reassign-request`, "POST", { reason });
}

export async function getReassignRequest(jobId) {
  if (!(await isSignedIn())) return { request: null };
  return req(`/mobile/jobs/${jobId}/reassign-request`);
}

export async function getJobPhotos(jobId) {
  return req(`/mobile/jobs/${jobId}/photos`);
}

export async function saveAssetScan(jobId, scan) {
  return req(`/mobile/jobs/${jobId}/assets/scans`, "POST", { ...scan, sentAt: new Date().toISOString() });
}

// OMS-03 crew job workflow (fault jobs only; never for job.planned, see
// lib/jobFlow.js). Both answer 200 { applied:false, reason } when the
// server does not apply them, e.g. once the job is locked.
// POST /api/mobile/jobs/:id/completion { diagnosis, partsUsed, restored, signOff, clientRequestId, submittedAt }
// Signed out there is nothing to send it with: it throws 401, as the server
// would, so a queued form stays queued until the crew signs in again.
export async function postJobCompletion(jobId, form) {
  if (!(await isSignedIn())) throw Object.assign(new Error("Not signed in"), { status: 401, code: "SIGNED_OUT" });
  return req(`/mobile/jobs/${jobId}/completion`, "POST", { ...form, sentAt: new Date().toISOString() });
}

// POST /api/mobile/jobs/:id/checklist { items: [{ label, checked, at }], passedAt }
// The pre-work priority checklist, for the control room's timeline. Same
// signed-out rule as postJobCompletion.
export async function postJobChecklist(jobId, body) {
  if (!(await isSignedIn())) throw Object.assign(new Error("Not signed in"), { status: 401, code: "SIGNED_OUT" });
  return req(`/mobile/jobs/${jobId}/checklist`, "POST", { ...body, sentAt: new Date().toISOString() });
}

// POST /api/mobile/jobs/:id/reopen — undo Work Complete while the window is open. Online only.
export async function reopenJob(jobId) {
  return req(`/mobile/jobs/${jobId}/reopen`, "POST", {});
}

// OMS-03 daily work order. All three answer { workOrder, jobs, summary };
// start and close add { applied, reason? } (applied:false when the day was
// already started / ended, or not started). Demo mode keeps the day on the
// phone only. Signed out, start/close throw 401 like the completion form, so
// a queued one stays queued until the crew signs in again.
let demoWorkOrder = null;
const demoDay = (crewId, date) => ({
  workOrder: demoWorkOrder?.work_date === date ? demoWorkOrder : { id: `WO-${date.replace(/-/g, "")}-${crewId}`, crew_id: crewId, work_date: date, status: "not_started" },
});

// GET /api/mobile/crews/:crewId/work-order?date=YYYY-MM-DD
export async function getWorkOrder(date) {
  const { isAuthenticated, myCrewId } = await session();
  if (!isAuthenticated()) return demoDay(DEMO_CREW.id, date);
  return req(`/mobile/crews/${myCrewId()}/work-order?date=${encodeURIComponent(date)}`);
}

async function postWorkOrder(kind, form, crewId) {
  const { isAuthenticated, myCrewId } = await session();
  if (!isAuthenticated()) {
    const day = demoDay(DEMO_CREW.id, form.date).workOrder;
    demoWorkOrder = kind === "start"
      ? { ...day, status: "started", started_at: form.startedAt, members: form.members, start_note: form.note }
      : { ...day, status: "closed", closed_at: form.closedAt, close_remarks: form.remarks, close_sign_off: form.signOff, close_snapshot: { carriedOver: form.carryOver } };
    return { applied: true, ...demoDay(DEMO_CREW.id, form.date) };
  }
  return req(`/mobile/crews/${crewId || myCrewId()}/work-order/${kind}`, "POST", { ...form, sentAt: new Date().toISOString() });
}

// POST /api/mobile/crews/:crewId/work-order/start  (lib/workOrder.js startPayload)
export const startWorkOrder = (form, crewId) => postWorkOrder("start", form, crewId);
// POST /api/mobile/crews/:crewId/work-order/close  (lib/workOrder.js closePayload)
export const closeWorkOrder = (form, crewId) => postWorkOrder("close", form, crewId);

export async function getAssetScans(jobId) {
  return req(`/mobile/jobs/${jobId}/assets/scans`);
}

// The cached job list belongs to the crew that is signing out.
export async function clearJobCache() {
  await AsyncStorage.multiRemove([JOBS_CACHE_KEY, JOBS_CACHE_SYNCED_AT_KEY]).catch(() => {});
}

export async function logout() {
  await clearJobCache();
  const { logout: sessionLogout } = await session();
  await sessionLogout(); // on web this redirects through Keycloak's logout
}

/* =========================================================
   OMS-01 PLANNED OUTAGES
   Permit calls are online-only: a failure is thrown, never queued.
   Switching confirmations recorded offline are sent by safetyStore.js.
========================================================= */

// Like req(), but keeps what the caller needs to tell "no signal" from "the
// server refused": err.status (none if the server wasn't reached) and the
// server's rule code (e.g. PREDECESSOR_UNCONFIRMED).
async function plannedReq(path, method = "GET", body) {
  const { freshAuthHeader } = await session();
  if (!IS_WEB) await loadServer();
  const response = await fetch((IS_WEB ? WEB_API_URL : apiBase()) + path, {
    method,
    headers: { "Content-Type": "application/json", ...(await freshAuthHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.message || data.error || `HTTP ${response.status}`), { status: response.status, code: data.code });
  }
  return data;
}

const newRequestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// The job's outage as this crew sees it: steps (with "actionable"), permit.
export function getPlannedOutage(jobId) {
  return plannedReq(`/mobile/jobs/${jobId}/planned-outage`);
}

export function requestPermit(jobId) {
  return plannedReq(`/mobile/jobs/${jobId}/permit/request`, "POST", { clientRequestId: newRequestId() });
}

export function withdrawPermit(permitId) {
  return plannedReq(`/mobile/permits/${permitId}/withdraw`, "POST", {});
}

// declaration: { menWithdrawn, earthsRemoved, toolsClear, remarks }
export function returnPermit(permitId, declaration) {
  return plannedReq(`/mobile/permits/${permitId}/return`, "POST", { clientRequestId: newRequestId(), declaration });
}

// { clientConfirmationId, performedAt, lat, lon }; sentAt lets the server
// correct a phone clock that is off.
export function confirmSwitchingStep(stepId, body) {
  return plannedReq(`/mobile/switching-steps/${stepId}/confirm`, "POST", { ...body, sentAt: new Date().toISOString() });
}

// Site report (preliminary info) or delay report, online only:
// { kind: 'site_report'|'delay', note, expectedEnd?, clientReportId }.
// The caller keeps clientReportId for a retry of the same report, so a
// lost reply followed by a retry is answered as a replay, not a duplicate.
export function sendCrewReport(jobId, body) {
  return plannedReq(`/mobile/jobs/${jobId}/planned-outage/report`, "POST", body);
}

export const newReportId = newRequestId;

// Gated status change for a planned job (Work Started / Work Finished):
// online only, so a refused or unsent change is reported, never queued.
export async function updatePlannedJobStatus(id, status, location = {}) {
  const { myCrewId } = await session();
  return plannedReq(`/mobile/jobs/${id}/status`, "PATCH", { status, lat: location.lat ?? null, lon: location.lon ?? null, crewId: myCrewId() });
}
