// OMS-01 planned-outage safety rules: switching-plan order, work permits and
// the automatic incident transitions they drive. Pure functions over rows
// already loaded (and locked) by repo.js -- no SQL here, so every rule can be
// tested without a database. See docs/OMS-01-DESIGN.md §3.
//
// Each check returns null when allowed, { replay: true } for an idempotent
// retry of something already done, or a rejection { code, message, status }.
// repo.js writes every rejection to safety_log: a crew trying to confirm a
// step out of order is as much a part of the safety record as a success.
import { canTransition } from './lifecycle.js';

export const STEP_ACTIONS = ['open', 'close', 'rack_out', 'rack_in', 'test_dead', 'earth_apply', 'earth_remove', 'tag_apply', 'tag_remove'];
export const PHASES = ['isolate', 'restore'];
export const ASSIGNEES = ['control_room', 'crew'];
const OPEN_PERMIT = ['requested', 'issued'];
// Priority of the outage (stored as the incident's severity; planned
// outages are excluded from the reliability indices whatever it is).
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
// Complete = everything downstream of the isolation points is off;
// partial = only the named section is.
export const DEENERGISATION = ['complete', 'partial'];
export const LIMITS = Object.freeze({
  maxWindowHours: 72, // longest supply-off window in one outage
  pastToleranceMin: 5, // a window may not start in the past (clock skew allowance)
  maxNoticeLeadMinutes: 7 * 24 * 60,
  maxCustomers: 1000000,
  maxText: 500, // descriptions, reasons, notes, permit points
  maxLabel: 200, // step device/location, zone, feeder, substation, mRID
});

const reject = (code, message, status = 409) => ({ code, message, status });
const tooLong = (v, max = LIMITS.maxText) => v != null && (typeof v !== 'string' || v.length > max);
const badInput = (message) => reject('BAD_INPUT', message, 400);
const intIn = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max; };

// actor = { username, roles[], crewId } from the verified token (never the
// x-user header).
export const isOperator = (actor) => !!actor?.roles?.some((r) => r === 'oms_operator' || r === 'system_admin');
export const isCrew = (actor) => !!actor?.roles?.includes('field_crew') && !!actor?.crewId;
export function primaryRole(actor) {
  if (actor?.roles?.includes('system')) return 'system';
  if (actor?.roles?.includes('system_admin')) return 'system_admin';
  if (actor?.roles?.includes('oms_operator')) return 'oms_operator';
  if (actor?.roles?.includes('field_crew')) return 'field_crew';
  return 'unknown';
}

const byPhase = (steps, phase) => steps.filter((s) => s.phase === phase).sort((a, b) => a.seq - b.seq);
const allConfirmed = (steps) => steps.every((s) => s.state === 'confirmed');
const openPermits = (permits) => permits.filter((p) => OPEN_PERMIT.includes(p.state));
const blank = (v) => typeof v !== 'string' || !v.trim();

// ---- switching plan ------------------------------------------------------

// Shape of the steps an operator saves into a draft plan. Seq is contiguous
// 1..n per phase so "the step before" is never ambiguous.
export function checkDraftSteps(steps) {
  if (!Array.isArray(steps)) return reject('BAD_STEPS', 'steps must be an array', 400);
  for (const [i, s] of steps.entries()) {
    const where = `step ${i + 1}`;
    if (!PHASES.includes(s.phase)) return reject('BAD_STEPS', `${where}: phase must be one of ${PHASES.join(', ')}`, 400);
    if (!STEP_ACTIONS.includes(s.action)) return reject('BAD_STEPS', `${where}: action must be one of ${STEP_ACTIONS.join(', ')}`, 400);
    if (!ASSIGNEES.includes(s.assignee)) return reject('BAD_STEPS', `${where}: assignee must be control_room or crew`, 400);
    if (s.assignee === 'crew' && blank(s.assignee_crew_id)) return reject('BAD_STEPS', `${where}: a crew step needs assignee_crew_id`, 400);
    if (blank(s.device_label) || blank(s.location)) return reject('BAD_STEPS', `${where}: device_label and location are required`, 400);
    if (tooLong(s.device_label, LIMITS.maxLabel) || tooLong(s.location, LIMITS.maxLabel) || tooLong(s.device_mrid, LIMITS.maxLabel)) {
      return reject('BAD_STEPS', `${where}: device, location and mRID are limited to ${LIMITS.maxLabel} characters`, 400);
    }
  }
  for (const phase of PHASES) {
    const seqs = byPhase(steps, phase).map((s) => s.seq);
    if (seqs.some((n, i) => n !== i + 1)) return reject('BAD_STEPS', `${phase} steps must be numbered 1..${seqs.length} with no gaps or repeats`, 400);
  }
  return null;
}

export function checkEditPlan({ plan, actor }) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room edits switching plans', 403);
  if (plan.state !== 'draft') return reject('PLAN_NOT_DRAFT', 'an approved plan cannot be edited; return it to draft first');
  return null;
}

export function checkApprovePlan({ plan, steps, actor }) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room approves switching plans', 403);
  if (plan.state !== 'draft') return reject('PLAN_NOT_DRAFT', 'plan is not a draft');
  if (!byPhase(steps, 'isolate').length || !byPhase(steps, 'restore').length) {
    return reject('PLAN_INCOMPLETE', 'a plan needs at least one isolate and one restore step');
  }
  return checkDraftSteps(steps);
}

export function checkUnapprovePlan({ plan, steps, actor }) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room changes switching plans', 403);
  if (plan.state !== 'approved') return reject('PLAN_NOT_APPROVED', 'plan is not approved');
  if (steps.some((s) => s.state === 'confirmed')) return reject('SWITCHING_STARTED', 'switching has started; the plan can no longer change');
  return null;
}

// Confirming one switching step (§3.2). Order of checks matters: an
// idempotent replay must succeed even after later steps were confirmed.
export function checkConfirmStep({ incident, plan, steps, permits, step, actor, clientConfirmationId, onBehalfNote }) {
  if (blank(clientConfirmationId)) return reject('CLIENT_ID_REQUIRED', 'clientConfirmationId is required', 400);
  if (tooLong(clientConfirmationId, LIMITS.maxLabel) || tooLong(onBehalfNote)) return badInput(`clientConfirmationId or note too long (note max ${LIMITS.maxText} characters)`);
  if (step.state === 'confirmed') {
    return step.client_confirmation_id === clientConfirmationId
      ? { replay: true }
      : reject('ALREADY_CONFIRMED', 'this step was already confirmed');
  }
  if (plan.state !== 'approved') return reject('PLAN_NOT_APPROVED', 'switching plan is not approved');

  const activeFor = step.phase === 'isolate' ? ['notified', 'isolating'] : ['isolating', 'in_progress', 'restoring'];
  if (!activeFor.includes(incident.status)) {
    return reject('OUTAGE_NOT_ACTIVE', `a ${step.phase} step cannot be confirmed while the outage is ${incident.status}`);
  }

  // A crew acting on a step that isn't theirs is refused as forbidden (403);
  // an operator recording a crew step without saying who reported it is a
  // missing detail (409), as before.
  if (step.assignee === 'crew') {
    const ownCrew = isCrew(actor) && actor.crewId === step.assignee_crew_id;
    const onBehalf = isOperator(actor) && !blank(onBehalfNote);
    if (!ownCrew && !onBehalf) {
      return isOperator(actor)
        ? reject('WRONG_ASSIGNEE', 'this is a crew step: record it only with a note saying who reported it')
        : reject('WRONG_ASSIGNEE', `this step belongs to crew ${step.assignee_crew_id}`, 403);
    }
  } else if (!isOperator(actor)) {
    return reject('WRONG_ASSIGNEE', 'this step belongs to the control room', 403);
  }

  const phaseSteps = byPhase(steps, step.phase);
  const pending = phaseSteps.find((s) => s.seq < step.seq && s.state !== 'confirmed');
  if (pending) return reject('PREDECESSOR_UNCONFIRMED', `${step.phase} step ${pending.seq} (${pending.device_label}) is not confirmed yet`);

  if (step.phase === 'restore') {
    if (!allConfirmed(byPhase(steps, 'isolate'))) return reject('ISOLATION_INCOMPLETE', 'isolation is not complete');
    const open = openPermits(permits);
    if (open.length) return reject('PERMIT_OUTSTANDING', `permit ${open[0].permit_no} is ${open[0].state}; it must be returned before restoring`);
  }
  return null;
}

// Which steps the given actor could confirm right now (for the crew app's
// list; the server re-checks on confirm).
export function actionableStepIds(ctx, actor) {
  return ctx.steps
    .filter((s) => s.state !== 'confirmed')
    .filter((s) => !checkConfirmStep({ ...ctx, step: s, actor, clientConfirmationId: 'probe', onBehalfNote: null }))
    .map((s) => s.id);
}

// ---- work permits (§3.4) -------------------------------------------------

export function checkRequestPermit({ incident, steps, permits, job, actor, clientRequestId }) {
  if (blank(clientRequestId)) return reject('CLIENT_ID_REQUIRED', 'clientRequestId is required', 400);
  if (tooLong(clientRequestId, LIMITS.maxLabel)) return badInput('clientRequestId too long');
  if (!isCrew(actor) || actor.crewId !== job.crew_id) return reject('NOT_YOUR_JOB', 'only the crew assigned to this job can request its permit', 403);
  const mine = permits.filter((p) => p.job_id === job.id);
  const replay = mine.find((p) => p.request_client_id === clientRequestId);
  if (replay) return { replay: true, permit: replay };
  if (openPermits(mine).length) return reject('PERMIT_ALREADY_OPEN', 'this job already has a permit requested or issued');
  if (!['isolating', 'in_progress'].includes(incident.status)) return reject('OUTAGE_NOT_ISOLATING', `no permit can be requested while the outage is ${incident.status}`);
  if (byPhase(steps, 'restore').some((s) => s.state === 'confirmed')) return reject('OUTAGE_RESTORING', 'restoration has started');
  const ownIsolation = byPhase(steps, 'isolate').filter((s) => s.assignee === 'crew' && s.assignee_crew_id === actor.crewId);
  if (!allConfirmed(ownIsolation)) return reject('ISOLATION_INCOMPLETE', 'confirm your own isolation steps first');
  return null;
}

export function checkIssuePermit({ steps, permit, actor, isolationPoints, earthingPoints }) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room issues permits', 403);
  if (permit.state !== 'requested') return reject('PERMIT_NOT_REQUESTED', `permit is ${permit.state}`);
  if (!allConfirmed(byPhase(steps, 'isolate'))) return reject('ISOLATION_INCOMPLETE', 'every isolation step must be confirmed before a permit is issued');
  if (byPhase(steps, 'restore').some((s) => s.state === 'confirmed')) return reject('OUTAGE_RESTORING', 'restoration has started');
  if (blank(isolationPoints) || blank(earthingPoints)) return reject('DETAILS_REQUIRED', 'isolation points and earthing points are required on the permit', 400);
  if (tooLong(isolationPoints) || tooLong(earthingPoints)) return badInput(`isolation and earthing points are limited to ${LIMITS.maxText} characters each`);
  return null;
}

export function checkRefusePermit({ permit, actor, reason }) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room refuses permits', 403);
  if (permit.state !== 'requested') return reject('PERMIT_NOT_REQUESTED', `permit is ${permit.state}`);
  if (blank(reason)) return reject('REASON_REQUIRED', 'a reason is required', 400);
  if (tooLong(reason)) return badInput(`reason is limited to ${LIMITS.maxText} characters`);
  return null;
}

export function checkWithdrawPermit({ permit, actor }) {
  if (permit.state === 'withdrawn') return { replay: true };
  if (!isCrew(actor) || actor.crewId !== permit.crew_id) return reject('NOT_YOUR_PERMIT', 'only the crew holding this permit can withdraw it', 403);
  if (permit.state !== 'requested') return reject('PERMIT_NOT_REQUESTED', `permit is ${permit.state}; an issued permit can only be returned`);
  return null;
}

// Returning the permit is the crew's declaration that the line is safe to
// re-energise from their side. All three must be explicitly true.
export function checkReturnPermit({ permit, actor, declaration, clientRequestId, onBehalfNote }) {
  if (blank(clientRequestId)) return reject('CLIENT_ID_REQUIRED', 'clientRequestId is required', 400);
  if (tooLong(clientRequestId, LIMITS.maxLabel) || tooLong(onBehalfNote) || tooLong(declaration?.remarks)) {
    return badInput(`clientRequestId, note or remarks too long (max ${LIMITS.maxText} characters)`);
  }
  if (permit.state === 'returned') {
    return permit.return_client_id === clientRequestId ? { replay: true } : reject('PERMIT_NOT_ISSUED', 'permit was already returned');
  }
  if (permit.state !== 'issued') return reject('PERMIT_NOT_ISSUED', `permit is ${permit.state}`);
  const holder = isCrew(actor) && actor.crewId === permit.crew_id;
  const onBehalf = isOperator(actor) && !blank(onBehalfNote);
  if (!holder && !onBehalf) {
    return reject('NOT_YOUR_PERMIT', isOperator(actor)
      ? 'record a return on the crew\'s behalf only with a note saying who reported it'
      : 'only the crew holding this permit can return it', 403);
  }
  const d = declaration || {};
  if (d.menWithdrawn !== true || d.earthsRemoved !== true || d.toolsClear !== true) {
    return reject('DECLARATION_INCOMPLETE', 'all men withdrawn, all earths removed and tools clear must each be confirmed', 400);
  }
  return null;
}

// ---- outage-level actions ------------------------------------------------

// The advance-notice scheduler acts as this; it may only mark notices sent.
export const SYSTEM_ACTOR = Object.freeze({ username: 'system', roles: ['system'], crewId: null });
const isSystem = (actor) => !!actor?.roles?.includes('system');

const validDate = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function checkCreateOutage(input, actor, now = Date.now()) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room schedules outages', 403);
  const i = input || {};
  if (blank(i.zone)) return badInput('zone is required');
  if (blank(i.workDescription)) return badInput('workDescription is required');
  if (tooLong(i.zone, LIMITS.maxLabel) || tooLong(i.feeder, LIMITS.maxLabel) || tooLong(i.substation, LIMITS.maxLabel) || tooLong(i.workMrid, LIMITS.maxLabel)) {
    return badInput(`zone, feeder, substation and mRID are limited to ${LIMITS.maxLabel} characters`);
  }
  if (tooLong(i.workDescription)) return badInput(`workDescription is limited to ${LIMITS.maxText} characters`);
  if (i.severity != null && !PRIORITIES.includes(i.severity)) return badInput(`priority must be one of ${PRIORITIES.join(', ')}`);
  if (i.deenergisation != null && !DEENERGISATION.includes(i.deenergisation)) return badInput('deenergisation must be complete or partial');
  if (i.deenergisation === 'partial' && blank(i.affectedSection)) return badInput('a partial de-energisation needs the affected section');
  if (tooLong(i.affectedSection)) return badInput(`affectedSection is limited to ${LIMITS.maxText} characters`);
  if (i.customers != null && i.customers !== '' && !intIn(i.customers, 0, LIMITS.maxCustomers)) return badInput(`customers must be a whole number from 0 to ${LIMITS.maxCustomers}`);
  if (i.noticeLeadMinutes != null && !intIn(i.noticeLeadMinutes, 0, LIMITS.maxNoticeLeadMinutes)) return badInput(`noticeLeadMinutes must be a whole number from 0 to ${LIMITS.maxNoticeLeadMinutes}`);
  return checkWindow(i, now);
}

// A planned window starts now or later and lasts at most maxWindowHours.
export function checkWindow({ windowStart, windowEnd }, now = Date.now()) {
  if (!validDate(windowStart) || !validDate(windowEnd)) return badInput('windowStart and windowEnd must be ISO date-times');
  const start = Date.parse(windowStart), end = Date.parse(windowEnd);
  if (end <= start) return badInput('windowEnd must be after windowStart');
  if (start < now - LIMITS.pastToleranceMin * 60000) return badInput('windowStart is in the past');
  if (end - start > LIMITS.maxWindowHours * 3600000) return badInput(`a planned window may last at most ${LIMITS.maxWindowHours} hours`);
  return null;
}

export function checkNotify({ incident, plan, actor, skip, reason }) {
  if (!isOperator(actor) && !(isSystem(actor) && !skip)) return reject('FORBIDDEN', 'only the control room sends notices', 403);
  if (incident.status !== 'scheduled') return reject('NOT_SCHEDULED', `outage is ${incident.status}`);
  if (plan.state !== 'approved') return reject('PLAN_NOT_APPROVED', 'approve the switching plan before notifying customers');
  if (skip && blank(reason)) return reject('REASON_REQUIRED', 'skipping the notice needs a reason', 400);
  if (tooLong(reason)) return badInput(`reason is limited to ${LIMITS.maxText} characters`);
  return null;
}

export function checkReschedule({ incident, steps, actor, windowStart, windowEnd, workDescription }, now = Date.now()) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room reschedules', 403);
  const badWindow = checkWindow({ windowStart, windowEnd }, now);
  if (badWindow) return badWindow;
  if (tooLong(workDescription)) return badInput(`workDescription is limited to ${LIMITS.maxText} characters`);
  if (!['scheduled', 'notified'].includes(incident.status)) return reject('SWITCHING_STARTED', `outage is ${incident.status}`);
  if (steps.some((s) => s.state === 'confirmed')) return reject('SWITCHING_STARTED', 'switching has started');
  return null;
}

// Cancel only before any switching. After the first isolation step the only
// way out is restoring.
export function checkCancel({ incident, steps, actor, reason }) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room cancels', 403);
  if (!['scheduled', 'notified'].includes(incident.status) || steps.some((s) => s.state === 'confirmed')) {
    return reject('SWITCHING_STARTED', 'switching has started; restore supply instead of cancelling');
  }
  if (blank(reason)) return reject('REASON_REQUIRED', 'a reason is required', 400);
  if (tooLong(reason)) return badInput(`reason is limited to ${LIMITS.maxText} characters`);
  return null;
}

// Closing the work order. Every crew job on the outage must be Work Complete;
// the control room may force it with a reason (>= 10 chars), which is
// recorded as such.
export const FORCE_REASON_MIN = 10;
export function checkClose({ incident, actor, jobs = [], force = false, reason = null }) {
  if (!isOperator(actor)) return reject('FORBIDDEN', 'only the control room closes outages', 403);
  if (incident.status !== 'resolved') return reject('NOT_RESOLVED', `outage is ${incident.status}`);
  const open = jobs.filter((j) => j.status !== 'Work Complete');
  if (open.length && !force) {
    return reject('JOBS_OPEN', `crew job(s) not complete: ${open.map((j) => `${j.id} (${j.status})`).join(', ')}. Complete them, or force the close with a reason`);
  }
  if (open.length && (blank(reason) || reason.trim().length < FORCE_REASON_MIN)) {
    return reject('REASON_REQUIRED', `closing with open jobs needs a reason of at least ${FORCE_REASON_MIN} characters`, 400);
  }
  if (tooLong(reason)) return badInput(`reason is limited to ${LIMITS.maxText} characters`);
  return null;
}

// A crew job on a planned outage: Work Started only under an issued permit;
// Work Complete once its permit is returned, or -- when the outage was
// aborted or ended without this job ever holding an open permit -- once the
// outage is restoring, resolved, closed or cancelled.
export const JOB_COMPLETE_WITHOUT_PERMIT = ['restoring', 'resolved', 'closed', 'cancelled'];
export function checkJobStatus({ status, permit, incidentStatus }) {
  if (status === 'Work Started' && permit?.state !== 'issued') {
    return reject('PERMIT_NOT_ISSUED', 'work can start only under an issued permit');
  }
  if (status === 'Work Complete' && permit?.state !== 'returned') {
    const noOpenPermit = !permit || !OPEN_PERMIT.includes(permit.state);
    if (!(noOpenPermit && JOB_COMPLETE_WITHOUT_PERMIT.includes(incidentStatus))) {
      return reject('PERMIT_NOT_RETURNED', 'return the permit before completing the job');
    }
  }
  return null;
}

// ---- automatic incident transitions (§3.1) -------------------------------

// The incident status the plan and permits now imply, one step at a time.
// repo.js applies it through lifecycle.js and loops until it returns null.
export function nextAutomaticStatus({ incident, steps, permits }) {
  const isolate = byPhase(steps, 'isolate');
  const restore = byPhase(steps, 'restore');
  const any = (list) => list.some((s) => s.state === 'confirmed');
  let to = null;
  switch (incident.status) {
    case 'notified':
      if (any(isolate)) to = 'isolating';
      break;
    case 'isolating':
      if (any(restore)) to = 'restoring'; // aborted before work
      else if (allConfirmed(isolate) && permits.some((p) => p.state === 'issued')) to = 'in_progress';
      break;
    case 'in_progress':
      if (!openPermits(permits).length && (permits.some((p) => p.state === 'returned') || any(restore))) to = 'restoring';
      break;
    case 'restoring':
      if (restore.length && allConfirmed(restore)) to = 'resolved';
      break;
    default:
      break;
  }
  return to && canTransition(incident.status, to, true) ? to : null;
}
