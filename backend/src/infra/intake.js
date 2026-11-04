// Burst-safe intake helpers (runbook v2, WP1).
//
// Every SCADA fault and every complaint decides "merge into an open incident,
// or open a new one" inside one transaction that first takes an advisory lock
// for its scope, so two events for the same feeder can never both see "no
// open incident" and both create one.
//
// Scope (decision D2): an event merges into an open incident on the same
// feeder; when either feeder is unknown, at the same substation. Feeder and
// substation are the canonical keys from infra/networkIdentity.js
// (resolveScope), never raw text. The locks match:
//   - feeder known:   SHARED lock on its substation, then EXCLUSIVE on the feeder
//   - feeder unknown: EXCLUSIVE lock on the substation
// (a known-feeder event can join an unknown-feeder incident at its substation:
// the exclusive substation lock of unknown-feeder events serialises the two)
// so events on different feeders of one substation still run in parallel,
// while a substation-only event waits for (and is waited on by) every feeder
// of that substation. Locks are always taken in the order external id ->
// substation -> feeder, so two intakes can never deadlock on them.
// xact locks release at COMMIT/ROLLBACK, including when the process dies.
import { db } from './db.js';

// Two-int advisory keys: a namespace plus hashtext() of the name. A hash
// collision only makes two unrelated scopes wait for each other.
const NS = { substation: 41001, feeder: 41002, externalId: 41003 };

export async function lockScope(t, { feederKey, substationKey } = {}) {
  if (feederKey) {
    if (substationKey) await t.any('SELECT pg_advisory_xact_lock_shared($1, hashtext($2))', [NS.substation, substationKey]);
    await t.any('SELECT pg_advisory_xact_lock($1, hashtext($2))', [NS.feeder, feederKey]);
  } else if (substationKey) {
    await t.any('SELECT pg_advisory_xact_lock($1, hashtext($2))', [NS.substation, substationKey]);
  }
  // neither known: nothing to merge with (D2), so nothing to serialise
}

// Serialises intakes that carry the same external id (idempotency, G3).
export async function lockExternalId(t, externalId) {
  if (externalId) await t.any('SELECT pg_advisory_xact_lock($1, hashtext($2))', [NS.externalId, String(externalId)]);
}

// D2 (4 Nov 2026): an intake item that must not be stored and must not be
// retried (its outcome would be the same). The intake queue moves it straight
// to intake_dead_letter with this message as the reason, and logs it.
export class IntakeRejected extends Error {
  constructor(message) { super(message); this.name = 'IntakeRejected'; this.deadLetter = true; }
}

// Bounded retry with exponential back-off and jitter. Every failed attempt is
// logged; after the last one the error is rethrown, never swallowed.
export async function withRetry(fn, { label = 'intake', attempts = Number(process.env.INTAKE_RETRY_ATTEMPTS) || 3,
  baseMs = Number(process.env.INTAKE_RETRY_BASE_MS) || 100, maxMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn(i);
    } catch (err) {
      if (err?.deadLetter) throw err; // IntakeRejected: the same input fails the same way, do not retry
      if (i >= attempts) {
        console.error(`[${label}] failed after ${i} attempt(s), giving up:`, err.message);
        throw err;
      }
      const wait = Math.min(maxMs, baseMs * 2 ** (i - 1)) * (0.5 + Math.random() / 2);
      console.warn(`[${label}] attempt ${i}/${attempts} failed (${err.message}); retrying in ${Math.round(wait)} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Runs work(t) in a transaction on cx (the pool, or a savepoint inside the
// caller's transaction, e.g. the intake queue's), retried as a whole, then
// runs the post-commit effects it returned (bus publishes, cache drops).
// work returns { result, effects: [() => ...] }.
export async function runIntake(label, work, { cx = db, runEffects = true } = {}) {
  const out = await withRetry(() => cx.tx(label, (t) => work(t)), { label });
  if (runEffects) await runEffectsSafely(label, out.effects);
  return runEffects ? out.result : out;
}

// Post-commit effects must not undo or fail the intake that already
// committed; a failure is logged loudly.
export async function runEffectsSafely(label, effects = []) {
  for (const fx of effects) {
    try { await fx(); } catch (err) { console.error(`[${label}] post-commit effect failed:`, err.message); }
  }
}

// Test-only fault injection (selftest-intake.js). Each hook, when set, is
// awaited at its point inside the intake transaction and may throw.
export const intakeTestHooks = { afterIncidentInsert: null };
