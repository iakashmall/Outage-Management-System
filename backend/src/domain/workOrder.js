// OMS-03 daily work orders: one per crew per working day. The crew lead
// starts the day (who is on the crew, vehicle / tools / PPE / first-aid
// checks) and ends it (why each unfinished job carries over, remarks,
// sign-off). Pure rules; the routes are in routes/api.js, the crew app's
// side in src/lib/workOrder.js.
import { isActive, priorityInfo, PRIORITY_CLASSES } from './rebalance.js';

// The working day is the date in the utility's time zone, not the server's.
export const workOrderTz = () => process.env.WORK_ORDER_TZ || 'Asia/Kolkata';

export function workDate(at = new Date(), tz = workOrderTz()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

export const workOrderId = (crewId, date) => `WO-${date.replace(/-/g, '')}-${crewId}`;

// A real calendar date: 2026-02-30 and 2026-13-01 are not.
export function isWorkDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// A start or end of day may arrive late from the phone's pending sync, so
// the last few days are accepted; a future day never is.
export const MAX_DAYS_BACK = 3;
export function dateAllowed(date, now = new Date(), tz = workOrderTz()) {
  for (let back = 0; back <= MAX_DAYS_BACK; back++) {
    if (workDate(new Date(now.getTime() - back * 86400000), tz) === date) return true;
  }
  return false;
}

// Same keys as START_CHECKS in src/lib/workOrder.js; all must be ticked.
export const START_CHECK_KEYS = ['vehicle', 'tools', 'ppe', 'firstAid'];
// Same values as CARRY_REASONS in src/lib/workOrder.js.
export const CARRY_REASONS = ['not_reached', 'awaiting_permit', 'material', 'next_shift', 'other'];
export const MAX_MEMBERS = 20;
export const MAX_TEXT = 500;
export const DEFAULT_JOB_MIN = 60;

// When a finished job was finished, for "done today".
const finishedAt = (job) => job.completed_at || job.updated_at || null;

// The crew's work for one day: open = every active job now (unfinished work
// is carried into each day until it is done), done = jobs finished on that day.
export function dayJobs(jobs, date, tz = workOrderTz()) {
  const open = [];
  const done = [];
  for (const job of jobs) {
    if (isActive(job)) open.push(job);
    else if (job.status === 'Work Complete' && finishedAt(job) && workDate(finishedAt(job), tz) === date) done.push(job);
  }
  return { open: orderOpen(open), done };
}

const STARTED = ['En Route', 'On Site', 'Work Started'];
const rank = (job) => PRIORITY_CLASSES.indexOf(priorityInfo(job).priority);

// Working order: jobs already under way first, then highest priority, then
// the oldest, then by id (the same data always gives the same order).
export function orderOpen(jobs) {
  return [...jobs].sort((a, b) =>
    (STARTED.includes(b.status) - STARTED.includes(a.status))
    || (rank(a) - rank(b))
    || (Date.parse(a.updated_at || 0) - Date.parse(b.updated_at || 0))
    || String(a.id).localeCompare(String(b.id)));
}

export function summarize({ open, done }) {
  return {
    total: open.length + done.length,
    done: done.length,
    open: open.length,
    estRemainingMin: open.reduce((sum, j) => sum + (Number(j.estimated_duration_min) || DEFAULT_JOB_MIN), 0),
  };
}

const text = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : '');

// Start-of-day body -> { error } or { members, checks, note }.
export function parseStart(body) {
  const b = body || {};
  if (!Array.isArray(b.members)) return { error: 'members must be a list of names' };
  const members = b.members.map(text).filter(Boolean);
  if (!members.length) return { error: 'name at least one crew member' };
  if (members.length > MAX_MEMBERS) return { error: `at most ${MAX_MEMBERS} crew members` };
  const checks = b.checks && typeof b.checks === 'object' ? b.checks : {};
  const missing = START_CHECK_KEYS.filter((k) => checks[k] !== true);
  if (missing.length) return { error: `checks not done: ${missing.join(', ')}`, code: 'CHECKS_INCOMPLETE' };
  return { members, checks: Object.fromEntries(START_CHECK_KEYS.map((k) => [k, true])), note: text(b.note) || null };
}

// End-of-day body -> { error } or { carryOver: Map(jobId -> {reason, note}), remarks, signOff }.
export function parseClose(body) {
  const b = body || {};
  const signOff = b.signOff && typeof b.signOff === 'object' ? b.signOff : null;
  if (!signOff || !text(signOff.name)) return { error: 'the crew lead must sign off the day' };
  if (b.carryOver != null && !Array.isArray(b.carryOver)) return { error: 'carryOver must be a list' };
  const carryOver = new Map();
  for (const c of b.carryOver || []) {
    if (!c || typeof c.jobId !== 'string') return { error: 'each carryOver entry needs a jobId' };
    if (!CARRY_REASONS.includes(c.reason)) return { error: `carryOver reason must be one of: ${CARRY_REASONS.join(', ')}` };
    carryOver.set(c.jobId, { reason: c.reason, note: text(c.note) || null });
  }
  return {
    carryOver,
    remarks: text(b.remarks) || null,
    signOff: { name: text(signOff.name), signedAt: typeof signOff.signedAt === 'string' ? signOff.signedAt : null },
  };
}

// What the day looked like when the crew ended it, kept on the work order.
// Open jobs the crew gave no reason for (e.g. assigned after the phone went
// offline) are listed with reason null.
export function closeSnapshot(day, carryOver) {
  return {
    done: day.done.map((j) => ({ jobId: j.id, incidentId: j.incident_id ?? null })),
    carriedOver: day.open.map((j) => ({
      jobId: j.id, incidentId: j.incident_id ?? null, status: j.status,
      reason: carryOver.get(j.id)?.reason ?? null, note: carryOver.get(j.id)?.note ?? null,
    })),
  };
}
