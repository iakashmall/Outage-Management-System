// src/lib/workOrder.js
// OMS-03 daily work order rules for the crew app, kept free of React Native
// imports so they can be tested in Node (backend/src/selftest-workorders.js).
// The crew lead starts the day (who is on the crew and the start-of-day
// checks) and ends it (why each unfinished job carries over, remarks,
// sign-off). The server keeps the work order (backend/src/domain/workOrder.js);
// the day's job list is worked out here from the jobs the phone already has,
// so it also works offline.

// Same keys as START_CHECK_KEYS on the server.
export const START_CHECKS = [
  { key: "vehicle", label: "Vehicle checked (fuel, tyres, lights)" },
  { key: "tools", label: "Tools and testing kit on board" },
  { key: "ppe", label: "PPE for every crew member" },
  { key: "firstAid", label: "First-aid kit on board" },
];

// Same values as CARRY_REASONS on the server.
export const CARRY_REASONS = [
  { value: "not_reached", label: "Not reached" },
  { value: "awaiting_permit", label: "Waiting for permit / shutdown" },
  { value: "material", label: "Material not available" },
  { value: "next_shift", label: "Handed to next shift" },
  { value: "other", label: "Other" },
];
export const carryReasonLabel = (value) => CARRY_REASONS.find((r) => r.value === value)?.label ?? "No reason given";

export const DEFAULT_JOB_MIN = 60;
const PRIORITIES = ["Critical", "VIP", "Urgent", "Normal"];
const STARTED = ["En Route", "On Site", "Work Started"];
const DONE = ["work finished", "work complete", "completed", "closed"];
const GONE = ["cancelled", "rejected"];
const statusOf = (job) => String(job?.status ?? "").toLowerCase();
export const isDone = (job) => DONE.includes(statusOf(job));

const pad = (n) => String(n).padStart(2, "0");
// The phone's own date: the crew works in the utility's time zone.
export function localDate(at = new Date()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const workOrderId = (crewId, date) => `WO-${date.replace(/-/g, "")}-${crewId}`;

const rank = (job) => {
  const i = PRIORITIES.indexOf(job?.priority);
  return i < 0 ? PRIORITIES.length : i;
};

// The crew's day: open = every unfinished job (carried into each day until
// done), in working order; done = jobs finished on that date.
export function dayJobs(jobs, date) {
  const open = [];
  const done = [];
  for (const job of jobs || []) {
    if (GONE.includes(statusOf(job))) continue;
    if (!isDone(job)) open.push(job);
    else {
      const at = job.completedAt || job.updatedAt;
      if (at && localDate(at) === date) done.push(job);
    }
  }
  return { open: orderOpen(open), done };
}

// Jobs already under way first, then highest priority, then by id. Same
// idea as the server's order (which also uses the time last updated).
export function orderOpen(jobs) {
  return [...jobs].sort((a, b) =>
    (STARTED.includes(b.status) - STARTED.includes(a.status))
    || (rank(a) - rank(b))
    || String(a.id).localeCompare(String(b.id)));
}

export function summarize({ open, done }) {
  return {
    total: open.length + done.length,
    done: done.length,
    open: open.length,
    estRemainingMin: open.reduce((sum, j) => sum + (Number(j.estimatedDurationMin) || DEFAULT_JOB_MIN), 0),
  };
}

export function formatMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const cleanMembers = (members) => (members || []).map((m) => String(m ?? "").trim()).filter(Boolean);
export const checksDone = (checks) => START_CHECKS.every((c) => checks?.[c.key] === true);
export const canStart = ({ members, checks }) => cleanMembers(members).length > 0 && checksDone(checks);
// Every unfinished job needs a reason before the day can end.
export const missingReasons = (open, reasons) => open.filter((j) => !CARRY_REASONS.some((r) => r.value === reasons?.[j.id]));

// Bodies of POST /mobile/crews/:id/work-order/start and /close.
// clientRequestId makes a resend from pending sync a replay on the server.
export function startPayload({ crewId, date, members, checks, note, location, at = new Date() }) {
  return {
    date,
    members: cleanMembers(members),
    checks: Object.fromEntries(START_CHECKS.map((c) => [c.key, checks?.[c.key] === true])),
    note: note ? String(note).trim() || null : null,
    lat: location?.lat ?? null,
    lon: location?.lon ?? null,
    clientRequestId: `${workOrderId(crewId, date)}-start-${at.getTime()}`,
    startedAt: at.toISOString(),
  };
}

export function closePayload({ crewId, date, open, reasons, notes, remarks, signOff, at = new Date() }) {
  return {
    date,
    carryOver: open.map((j) => ({ jobId: j.id, reason: reasons?.[j.id] ?? "other", note: notes?.[j.id] ? String(notes[j.id]).trim() || null : null })),
    remarks: remarks ? String(remarks).trim() || null : null,
    signOff: signOff ? { name: signOff.name ?? null, signedAt: signOff.signedAt ?? null } : null,
    clientRequestId: `${workOrderId(crewId, date)}-close-${at.getTime()}`,
    closedAt: at.toISOString(),
  };
}

// The work order to show: the server's, plus a start or end of day the phone
// made that is still waiting in pending sync (local = { crewId, date, start,
// close } with the payloads), marked pendingSync so the crew isn't asked to
// start the same day twice.
export function viewWorkOrder({ crewId, date, server, local }) {
  let view = server && server.crew_id === crewId && server.work_date === date
    ? server
    : { id: workOrderId(crewId, date), crew_id: crewId, work_date: date, status: "not_started" };
  if (!local || local.crewId !== crewId || local.date !== date) return view;
  if (local.start && view.status === "not_started") {
    view = { ...view, status: "started", started_at: local.start.startedAt, members: local.start.members, start_note: local.start.note, pendingSync: true };
  }
  if (local.close && view.status !== "closed") {
    view = {
      ...view, status: "closed", closed_at: local.close.closedAt, close_remarks: local.close.remarks, close_sign_off: local.close.signOff,
      close_snapshot: { carriedOver: local.close.carryOver }, pendingSync: true,
    };
  }
  return view;
}
