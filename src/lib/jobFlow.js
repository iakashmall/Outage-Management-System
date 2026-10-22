// src/lib/jobFlow.js
// OMS-03 crew job workflow rules for the crew app, kept free of React Native
// imports so they can be tested in Node (backend/src/selftest-jobs.js).
// The server decides every status; these only decide what the crew sees and
// which calls the app makes. Planned-outage jobs never use the completion or
// reopen routes: they close out through their permit (OMS-01).

export const SUBMITTED_LABEL = "Submitted, awaiting verification";
export const RESTORED_CHOICES = [
  { value: "yes", label: "Yes" },
  { value: "partial", label: "Partly" },
  { value: "no", label: "No" },
];

const COMPLETED = ["Work Complete", "Work Finished"];
export const isCompleted = (job) => !!job && COMPLETED.includes(job.status);

// The completion form goes to the server for fault jobs only, and not once
// the job is locked (the server would answer applied:false).
export const canSendCompletion = (job) => !!job && !job.planned && !job.locked;

// Reopen (undo) while the server's undo window is open.
export function canReopen(job, now = Date.now()) {
  if (!job || job.planned || job.locked || !isCompleted(job) || !job.undoUntil) return false;
  return Date.parse(job.undoUntil) > now;
}

// Locked: completed and the undo window is over. The job screen shows the
// job read-only; only the control room can return it for correction.
export function isReadOnly(job, now = Date.now()) {
  if (!job || job.planned) return false;
  if (job.locked) return true;
  return isCompleted(job) && !!job.undoUntil && Date.parse(job.undoUntil) <= now;
}

// Body of POST /mobile/jobs/:id/completion. clientRequestId makes a resend
// (pending sync) idempotent on the server. checklist: the safety checklist
// ticked before Work Started, [{ label, checked, at }].
export function completionPayload({ jobId, diagnosis, partsUsed, restored, signOff, checklist, at = new Date() }) {
  return {
    diagnosis: diagnosis && typeof diagnosis === "object" ? diagnosis : null,
    partsUsed: Array.isArray(partsUsed) ? partsUsed.map((p) => ({ name: p.name, qty: p.qty })) : [],
    restored: RESTORED_CHOICES.some((c) => c.value === restored) ? restored : null,
    signOff: signOff ? { name: signOff.name ?? null, signedAt: signOff.signedAt ?? null } : null,
    checklist: Array.isArray(checklist) ? checklist.map((c) => ({ label: String(c.label), checked: !!c.checked, at: c.at ?? null })) : null,
    clientRequestId: `${jobId}-${at.getTime()}`,
    submittedAt: at.toISOString(),
  };
}

// A completion form the server did not apply (e.g. the job was not started
// yet on the server) is kept on the phone and may be sent again, with the
// same clientRequestId, once the job is Work Started or later.
export const canResendCompletion = (job) =>
  canSendCompletion(job) && ["Work Started", ...COMPLETED].includes(job.status);

// What a server answer means for the screen: the job fields to take over
// (the server's status, lock and undo window) and a notice when the update
// was not applied. A plain resend of what the server already has
// ("already ...") is not worth a notice.
export function serverJobUpdate(res) {
  if (!res || typeof res !== "object") return { fields: null, notice: null };
  const job = res.job && typeof res.job === "object" ? res.job : res;
  const fields = {};
  if (typeof job.status === "string") fields.status = job.status;
  if ("locked" in res) fields.locked = !!res.locked;
  if ("undoUntil" in res) fields.undoUntil = res.undoUntil ?? null;
  const notice = res.applied === false && !/^already /.test(res.reason || "")
    ? `not applied: ${res.reason || "refused"}`
    : null;
  return { fields: Object.keys(fields).length ? fields : null, notice };
}
