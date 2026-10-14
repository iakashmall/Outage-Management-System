// OMS-03 crew job workflow: which crew status updates the server applies,
// and when a finished fault job is locked against further crew writes.
// Pure functions; routes/api.js does the I/O. Planned-outage jobs never come
// here (plannedOutages.js answers their status updates first).
//
//   Acknowledged -> En Route -> On Site -> Work Started -> Work Complete
//
// The server decides and both apps show its state. A skipped step is applied
// (with a note), never refused, so one lost update can't leave the phone and
// the server disagreeing. A backward, identical or late update changes
// nothing and is answered 200 { applied:false, reason } -- never an error the
// crew app's pending-sync queue would retry or report as a failure.

// What a crew (or the control room on its behalf) may send. 'Work Finished'
// is the app's name for Work Complete.
export const CREW_STATUSES = ['Acknowledged', 'En Route', 'On Site', 'Work Started', 'Work Complete'];
export const STATUS_ALIASES = { 'Work Finished': 'Work Complete' };

// Before the crew has moved: new or returned work, all one early rank.
// 'Requires Revisit' is set by return-for-correction (the crew starts the
// ladder again). Cancelled/Closed/Rejected are outside the ladder.
const RANK = {
  'Pending Acceptance': 0, Assigned: 0, Acknowledged: 0, 'Requires Revisit': 0,
  'En Route': 1, 'On Site': 2, 'Work Started': 3, 'Work Complete': 4,
};
const LADDER = ['En Route', 'On Site', 'Work Started', 'Work Complete'];

export const normalizeStatus = (s) => STATUS_ALIASES[s] || s;
export const isCrewStatus = (s) => CREW_STATUSES.includes(normalizeStatus(s));

// current: the job's status now. next: the requested one (normalized).
// ts: when the crew made the change. latestCrewTs: the newest update the
// crew itself made on this job (dispatcher writes don't count, so a
// dispatcher touching the job never makes a crew's real update "late").
// Returns { applied:true, skipped:[...] } or { applied:false, reason, notify }.
// notify: worth a "late update from crew not applied" timeline event (an
// identical replay is not -- that is just the queue resending).
export function decideStatus({ current, next, ts, latestCrewTs }) {
  if (current === next) return { applied: false, reason: `already ${next}`, notify: false };
  if (latestCrewTs && new Date(ts) < new Date(latestCrewTs)) {
    return { applied: false, reason: 'a newer update from the crew is already recorded', notify: true };
  }
  const from = RANK[current], to = RANK[next];
  if (from === undefined) return { applied: false, reason: `job is ${current}`, notify: true };
  if (to < from) return { applied: false, reason: `job is already ${current}`, notify: true };
  const skipped = LADDER.filter((s) => RANK[s] > from && RANK[s] < to);
  return { applied: true, skipped };
}

export const undoWindowMs = () => {
  const min = Number(process.env.JOB_UNDO_WINDOW_MIN);
  return (Number.isFinite(min) && min >= 0 ? min : 10) * 60000;
};

// A completed fault job: the crew may still undo (Reopen) until the window
// runs out or the incident leaves 'pending' (the dispatcher resolved or
// returned it), whichever comes first. completed_at is the server's time.
// A job completed before completed_at existed has no window.
export function undoOpenUntil(job, incidentStatus, now = Date.now()) {
  if (job?.status !== 'Work Complete' || !job.completed_at) return null;
  if (job.incident_id && incidentStatus !== 'pending') return null;
  const until = new Date(job.completed_at).getTime() + undoWindowMs();
  return until > now ? new Date(until).toISOString() : null;
}

// Locked: completed and the undo window is over. Crew writes (status,
// photos, scans, messages, completion) are then kept out; only the
// dispatcher can return the job for correction.
export const isLocked = (job, incidentStatus, now = Date.now()) =>
  job?.status === 'Work Complete' && !undoOpenUntil(job, incidentStatus, now);

export const RESTORED = ['yes', 'partial', 'no'];
