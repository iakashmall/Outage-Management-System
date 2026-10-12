# OMS-03 — Crew workload balancing

Dispatch can see how loaded each crew is, and the system proposes moving
unstarted jobs off crews that are overloaded or have gone off shift. A
dispatcher reviews the proposal and applies or rejects it. Nothing moves
until someone applies it, and every move is logged.

| Part | Where |
|---|---|
| Engine (pure, unit tested) | `backend/src/domain/rebalance.js`, `rebalance.test.js` |
| API and triggers | `backend/src/routes/dispatch.js` (mounted from `routes/api.js`) |
| Data access, transactional apply | `backend/src/infra/repo.js` |
| Schema | `migrate()` in `backend/src/infra/db.js` |
| Demo scenario | `backend/src/infra/seedOms03.js` (`npm run seed:oms03`) |
| DB self-test | `backend/src/selftest-oms03.js` (`npm run test:oms03:db`) |
| Control room UI | Dispatch tab: `frontend/src/screens/Dispatch.jsx` |
| Crew app | root Expo app: `src/NativeApp.jsx`, `src/lib/api.js`, `src/lib/offlineQueue.js` |

## Model

**Priority class**, from high to low: `Critical`, `VIP`, `Urgent`, `Normal`.
A job's effective priority is the highest of:

- the job's own `priority` (Urgent or Normal today; Critical and VIP are accepted too)
- the categories of trouble calls linked to the job's incident
  (`trouble_calls.linked_id = jobs.incident_id`): `Medical` → Critical (shown
  with a Medical marker), `Critical` → Critical, `Premium-VIP` → VIP,
  `Normal` → Normal.

**Job weight** = `priorityWeights[class] × duration / 60`, where duration is
`jobs.estimated_duration_min`, or `defaultDurationMin` when that is not set.

**Crew load** = sum of the weights of the crew's active jobs ÷ crew capacity
(`crews.capacity`, else `defaultCapacity`). Load is a ratio: 1.0 is 100%. A
job is active unless it is `Work Complete`, `Cancelled`, `Closed` or
`Rejected`. A crew is overloaded when its load is above `overloadThreshold`.

**Movable jobs.** Only unstarted jobs move: status `Acknowledged`,
`Pending Acceptance` or `Assigned`, on a crew, and not part of a planned
outage. Jobs that are En Route, On Site or Work Started never move.

**Eligible target crew.** The crew is on shift, and:

- **Area of responsibility.** `crews.aor` is a list of substation names, the
  same strings as `incidents.substation`. A job's area is its incident's
  substation. A job with no area can go to any crew. A crew with no AoR is
  unrestricted (legacy crews). Otherwise the job's area must be in the
  crew's AoR.
- **Skill.** `jobs.required_skill` empty or `any` means no requirement.
  Otherwise the skill must be in the crew's skills (`crews.skills`,
  comma-separated, case-insensitive).

**Proposal algorithm** (deterministic: the same data always gives the same
proposal):

1. **Crew off shift.** Every movable job of an off-shift crew is placed,
   highest priority first, then heaviest, then by job id. Each goes to the
   eligible crew whose load after the move is lowest, preferring crews that
   stay at or under the threshold. Ties go to the nearest crew (straight-line
   km from the crew's position to the incident; no position sorts last),
   then the lowest crew id. A job no on-shift crew can take is listed as
   **unassigned**, with the reason. Started jobs stay with the crew and are
   listed as **stuck**, with a warning. Reason code: `crew_off_shift`.
2. **Overload.** On-shift crews over the threshold are relieved, most
   overloaded first, with as few moves as possible. If one job's removal is
   enough, the lightest such job moves; otherwise the heaviest job moves, and
   this repeats. A move is only made if the target stays at or under the
   threshold, so overload is never just shifted to another crew. A crew that
   cannot be relieved is listed as stuck. Reason code: `overload`.

A job moves at most once per proposal. The proposal holds the load of every
crew before and after, the moves, the unassigned jobs, the stuck jobs and
the warnings.

## Settings and defaults

Stored in `oms_settings` under the key `workload`. The default row is
inserted by `migrate()` and never overwrites an existing one.

| Setting | Default | Rule on save |
|---|---|---|
| `priorityWeights` | Critical 3, VIP 2.5, Urgent 2, Normal 1 | All four present, each > 0 |
| `defaultDurationMin` | 60 | > 0 |
| `defaultCapacity` | 4 (also the capacity of a new crew if none is given) | > 0 |
| `overloadThreshold` | 1.0 (100%) | 0.1 to 5 |

Change them in the Dispatch tab's settings editor, or with
`PUT /api/dispatch/settings`. Saving settings is audited, but it does not
create a proposal. Each proposal stores the settings it was computed with.

Per-crew values: `capacity`, `on_shift`, `aor`, `skills`. Per-job values:
`estimated_duration_min` and `required_skill`. Set the job values in the
assign form, or with `requiredSkill` / `estimatedDurationMin` on
`POST /api/incidents/:id/assign`.

## Triggers

A resource change runs the engine at once:

| Trigger | Cause |
|---|---|
| `crew_added` | `POST /api/crews` |
| `crew_off_shift` / `crew_on_shift` | `PATCH /api/crews/:id` with `on_shift` |
| `capacity_changed` | `PATCH /api/crews/:id` with a different `capacity` |
| `crew_updated` | `PATCH /api/crews/:id` with `aor` / `skills` only |
| `manual` | The **Rebalance** button, `POST /api/dispatch/rebalance/propose` |

If the result moves or unassigns at least one job, it is saved as a proposal
with status `proposed`, and any older open proposal becomes `superseded`. If
nothing would change, nothing is saved: the response is
`{ proposal: null, reason: 'balanced' }`, and any open proposal is
superseded. **A trigger never applies anything.**

Taking a crew off shift also sets `crews.status` to `off_shift`. Job status
updates from the field do not change that status while the crew is off
shift. Putting the crew back on shift sets the status from its active jobs
(`available` when there are none).

## Endpoints

All are under `/api` and need a signed-in user. Reads are open to any
signed-in user. Writes need `oms_operator` or `system_admin`, plus a username
in the token (`401 NO_IDENTITY` without one). `field_crew_coordinator` has
no dispatch rights.

| Method and path | Purpose |
|---|---|
| `GET /dispatch/workload` | Settings, crews with load / weight / over and their jobs (effective priority, Medical marker, weight, movable, area, skill), the flagged unassigned jobs, and the open proposal |
| `GET /dispatch/settings` / `PUT /dispatch/settings` | Read / save the settings (`400 INVALID` on a bad value) |
| `POST /crews` | Add a crew `{ id?, name, lead, skills, aor, capacity, lat, lon }`. Starts on shift and `available`. Triggers `crew_added` |
| `PATCH /crews/:id` | `{ on_shift?, capacity?, aor?, skills? }`. AoR entries must be known substations |
| `POST /dispatch/rebalance/propose` | Manual proposal `{ note? }` |
| `GET /dispatch/rebalance/proposals?status=` | List proposals |
| `GET /dispatch/rebalance/proposals/:id` | One proposal |
| `POST /dispatch/rebalance/proposals/:id/apply` | Apply. Answers `409 STALE_PROPOSAL` (with `problems`) when anything changed since the proposal was made |
| `POST /dispatch/rebalance/proposals/:id/reject` | Reject `{ note? }` |
| `GET /dispatch/rebalance/history` | Applied, rejected and stale proposals, and reassignment rows, newest first (200 max each) |

**Apply** runs in one transaction. Every move is checked again: the job is
still on its source crew and unstarted, and the target is still on shift and
eligible. If any check fails, nothing is applied, the proposal is marked
`stale`, and the dispatcher proposes again. Otherwise, for each move:

- the job's crew and the incident's crew change
- a job update ("Reassigned from X to Y (reason)") and an incident event are written
- a `job_reassignments` row is added

Each unassigned job loses its crew and gets `flagged_reason` / `flagged_at`,
and its incident goes from `dispatched` back to `open`. The flagged jobs
appear in the Dispatch tab's **Unassigned jobs** card with the reason.
Assigning one from there clears the flag (reason `manual_assign`).
`crews.job_id` and crew status are kept in line with each crew's remaining
work. After the commit, `JOB_UPDATED`, `CREW_UPDATED` and `INCIDENT_UPDATED`
are published, plus `oms.dispatch.rebalance`
(`proposed` / `applied` / `rejected` / `stale` / `superseded`), which the
Dispatch tab listens to.

**Field status guard.** `PATCH /api/mobile/jobs/:id/status` answers
`409 NOT_YOUR_JOB` when the crew sending the update (the token's `crew_id`
claim, else `crewId` in the body) no longer holds the job, or the job has no
crew. The write is conditional on the crew, so a rebalance that commits at
the same moment wins. A `field_crew` login without a crew id gets
`403 NO_CREW_ID`.

## Audit log

Every move is recorded twice:

- **`job_reassignments`**: one row per job moved or unassigned: `job_id`,
  `incident_id`, `from_crew`, `to_crew` (NULL = left unassigned), `reason`
  (`overload`, `crew_off_shift`, the unassignable reason, or
  `manual_assign`), `actor` (the dispatcher's username), `proposal_id`, `ts`.
  The table is append-only: a trigger created in `migrate()` refuses
  UPDATE, DELETE and TRUNCATE. The seed does not clear it either.
- **`audit_log`**: `dispatch.rebalance.propose`, `dispatch.rebalance.apply`,
  `dispatch.rebalance.reject`, `dispatch.settings`, `crew.create`,
  `crew.update` and `dispatch.assign`, each with the actor.

Both are shown in the Dispatch tab's history.

## Crew app behaviour

The crew APK is the Expo app at the repo root (see `LEGACY.md` and
`docs/MOBILE_TESTING.md`). It has no push channel: it polls.

- Every 10 s (`JOB_POLL_INTERVAL_MS` in `src/config.js`, was 30 s), the app
  sends its queued status updates and reads its job list again. A job moved
  to this crew appears within that time, and a job moved away disappears,
  even when it was the crew's last job.
- If the open job screen shows a job that is no longer this crew's, it
  closes with the notice "This job was reassigned".
- Status updates carry `crewId`. A live update refused with `NOT_YOUR_JOB`
  is not queued: the status is put back, a notice is shown and the list is
  read again.
- The offline queue drops updates the server refuses (4xx other than 401,
  408 and 429) instead of retrying them forever, and says which ones were
  dropped and why. Network errors and 5xx are still retried.
- Job cards and the job screen show priority and estimated duration when
  set.

**These app changes need a new EAS build**
(`eas build --profile test --platform android`). Until then, installed
phones keep the 30 s poll and the stale-job behaviour. They also do not send
`crewId`, so for logins without a `crew_id` claim (demo accounts mapped by
username) the server cannot refuse their stale updates.

## Known issues

- **`audit_log` is cleared by the seed.** `seed.js --force` deletes
  `audit_log` (pre-existing; its immutability trigger lives only in a manual
  migration, `db/migrations/audit_log_immutable.sql`). Left unchanged on
  purpose. `job_reassignments` is not affected.
- **Daily work order management is partial.** OMS-03's "manage daily work
  orders" is not built. Work is managed per job, with the fields above.
- **Hard-coded ports, from before OMS-03.** These were there before and are
  unchanged: backend `db.js`, `auth.js`, `index.js` (4000), Kafka, Redis,
  map proxy; `frontend/vite.config.js` and `frontend/src/lib/auth.js`; crew
  app `src/config.js` (LAN IP default, 4000 / 18080, http). OMS-03 adds none.
- **Crew app offline queue.** A flush reads and rewrites the whole queue.
  An update queued while a flush is still running can be lost (pre-existing;
  the shorter poll makes this a bit more likely).

## FAT demo steps

TODO: added by the coordinator.
