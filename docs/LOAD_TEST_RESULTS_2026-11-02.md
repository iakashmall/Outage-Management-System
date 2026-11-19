# Load, burst and chaos test results (WP6), 2 Nov 2026

Label: pilot with hardened intake. These are laptop results, not production measurements.

Status: the harness was checked against `origin/master` (29e103e) with short smoke runs (section 3). On 3 Nov 2026 it ran at full scale against Window A's branch `feat/burst-safe-intake` at 3821223 (WP1, WP2 and WP4). Results are in section 4. The 1-hour soak was **not** run (Akash's decision for this round).

## 1. Harness

Scripts are in `backend/scripts/loadtest/` on branch `feat/load-tests`:

- `run.mjs` is the orchestrator: it runs the scenarios and checks the database.
- `lib.mjs` holds the helpers: auth, HTTP, load generation, processes and Docker.
- `report.mjs` turns the JSON results into the markdown used here.

How it works:

- **Isolation.** Every scenario gets a fresh PostGIS scratch database (`oms_scratch_lt_<scenario>_<run>`), created in a throwaway `timescale/timescaledb-ha:pg16` container and dropped afterwards. It also gets a flushed throwaway Redis and its own backend process on `PORT=4100`, started from the backend folder given with `--backend`. The harness refuses any database or container whose name lacks `scratch`, and any backend folder that has a `.env`, which it never reads. It waits while port 4100 is in use, because other windows' selftests bind it too. A health answer only counts while the harness's own backend process is alive.
- **Database setup, the way a deployment does it:**
  - the extensions from `db/init/00-init.sql` plus `pgcrypto`;
  - the backend's own `migrate()` and `seed()`;
  - `db/migrations/encrypt_phone_at_rest.sql` and `safe_decrypt_phone.sql`.

  The network topology (`network.*`) is not loaded, so the downstream prediction runs without it.
- **Real authentication path.** The harness serves its own JWKS endpoint and mints RS256 tokens. The backend's `requireAuth` verifies them through `KEYCLOAK_JWKS_URI`. No Keycloak password or real token is used.
- **Backend settings:** `SIMULATOR=off`, `EVENT_BUS_DRIVER=memory`, `NODE_ENV=production`, and a test-only `ENCRYPTION_KEY`. No SMTP is configured, so e-mail failures in the log are expected; they are counted apart from real errors.
- **Load model.** Load is open-loop: arrivals do not slow down when the server does. At most 4,000 requests are in flight; anything over that is counted as "not sent", never hidden. The senders behave like a real gateway: network errors, 5xx and 429 are retried with capped back-off for up to 60 s (90 s in the chaos tests), resending the same body with the same id. A retry after a lost response is how duplicates would appear.
- **Verification after the backlog has drained.** The harness waits until `/api/health` queue depth is 0 (when it reports one) and the processed count is unchanged three times in a row. Then it checks:
  - **SCADA:** each acknowledged event is one `alarms` row, using a tag unique per event, or an event-id column if the schema has one. The row must exist (otherwise "lost"), appear exactly once (otherwise "duplicate rows") and carry an `incident_id` (otherwise "never processed").
  - **Complaints:** each acknowledged `externalId` is exactly one `complaints` row, linked to an incident. For incidents opened by the run's complaints, `customers` must equal the number of distinct complaints.
  - **Incidents:** active incidents created during the run, per feeder (D2) and per substation.
  - **Queue tables:** row counts for `*queue*`, `*dead*`, `*dlq*` and `*outbox*` tables.
  - **Backend log:** `[fatal]`, errors, Redis, database and queue lines, and process exits.
- **Gates.** Each gate is computed from those numbers:
  - no loss and no duplicates (including "rejected after retries" and the customer-count check);
  - one active incident per feeder;
  - p95 under 3 s for writes and for reads during a burst;
  - memory growth under 10% in the soak: the median RSS of the last 5 minutes against the median of minutes 5 to 10.

| Scenario | What it does |
|---|---|
| `scada` | 1,000 SCADA trips/s for 60 s (`POST /api/scada/fault`), a unique tag per event, 20 feeders across the substations; 5 read probes (dashboard reads every 2 s) |
| `complaints` | 50 complaints/s for 5 min (`POST /api/complaints`), 2% resent with an already-used `externalId`; 5 read probes |
| `dashboard` | 100 dashboard sessions for 120 s. Each is one Socket.IO connection plus the control room's reads: the initial load of 7 lists, then incidents, indicators and alarms every 5 s. Complaints at 50/s from 30 s to 90 s give a "burst" window. |
| `soak` | 100 SCADA trips/s for 1 hour on a fixed set of 8 breaker tags per feeder (count-based accounting); RSS sampled every 30 s |
| `chaos-kill` | SCADA 200/s + complaints 50/s for 60 s; at 15 s the backend (or the worker, when split) gets SIGKILL (TerminateProcess on Windows) and is restarted 2 s later |
| `chaos-pg` | the same load; at 15 s, `docker restart` of the scratch Postgres container |
| `chaos-redis` | the same load; scratch Redis stopped at 15 s and started at 45 s |

Run it like this (the password is the throwaway scratch container's own):

```
LOADTEST_PG_URL_BASE=postgres://oms:<scratch pw>@127.0.0.1:25434 LOADTEST_PG_CONTAINER=oms-scratch-winc \
LOADTEST_REDIS_CONTAINER=oms-scratch-winc-redis LOADTEST_REDIS_URL=redis://127.0.0.1:26381 \
node scripts/loadtest/run.mjs --backend ../../oms-burst-intake/backend --label wp2 \
  --scenarios scada,complaints,dashboard,chaos-kill,chaos-pg,chaos-redis,soak --out <dir>
node scripts/loadtest/report.mjs --in <dir> --label wp2
```

`--scale 0.25` shortens every duration for a smoke run. The result files record the scale.

## 2. Host

Windows 11 laptop. Node v24.19.0. Postgres and Redis run in Docker Desktop (WSL2). The load generator, the backend and the databases all share the same machine, so the latencies include contention between them.

## 3. Baseline: origin/master 29e103e, smoke runs (reduced scale, not gate results)

These runs checked the harness, and they show the problems WP1 and WP2 are meant to fix. They are short:

- SCADA ran at full rate (1,000/s) for 6 s instead of 60 s.
- The other scenarios ran at a quarter of their duration. The chaos faults hit about 6 s into a 15 s load.

**SCADA, 1,000/s for 6 s (6,000 events):**
- All 6,000 got `202`. None was lost, duplicated or left unprocessed.
- They opened **55 incidents on 13 feeders (42 extra)**. 13 feeders had their events spread over more than one incident. This is the check-then-create race that WP1/G1 addresses.
- Write latency: p50 4,228 / **p95 8,906** / p99 9,353 / max 9,409 ms.
- Read probes during the burst: **p95 7,347 ms**. Both exceed the 3 s gate.
- Backend RSS went from 159 MB to 274 MB.
- In this first run, `GET /api/complaints` answered 500 because the scratch database had no `pgcrypto`. The harness now applies the phone migrations; this was not a code fault.

**Complaints, 50/s for 75 s (3,750 requests, 90 of them resends of an existing `externalId`):**
- 0 lost.
- **90 duplicate rows:** master has no idempotency on `external_id`.
- **9 of 9 complaint-opened incidents have `customers` different from their distinct complaints**, because of the read-modify-write count. This is what WP1/G2 addresses.
- Write latency p95 39 ms, reads p95 8 ms.

**Dashboard, 100 sessions for 30 s, complaints at 50/s for 15 s:**
- All 100 sessions connected, with 0 errors and 0 disconnects. They received 74,564 Socket.IO events.
- Reads: quiet p95 5 ms, burst p95 16 ms. Writes: p95 127 ms.
- 6 complaint incidents had a customer-count mismatch.

**chaos-kill:**
- The backend was killed at 6 s and was healthy again 1.0 s after its restart; the longest gap in `/api/health` was 3 s.
- Senders saw 2,215 + 562 `ECONNREFUSED` and 13 `ECONNRESET`. The retries delivered everything: 3,000 SCADA and 750 complaints acknowledged, 0 lost, 0 duplicated, 0 unprocessed.
- **11 active incidents on 9 feeders (2 extra):** the in-memory dedup index is lost on restart, and the DB check misses incidents still being created.
- Writes p95 732 ms. No `[fatal]` lines.

**chaos-pg:**
- The Postgres container restarted in 1.2 s.
- `/api/health` answered 100% of the time. 0 lost, 0 duplicated, one incident per feeder.
- Writes p95 509 ms, max 1,776 ms. No `[fatal]` lines.

**chaos-redis:**
- Redis was down for 5.3 s. `/api/health` answered 100% of the time and every write succeeded: 3,000 + 750, all `2xx`.
- The log says so clearly: `[redis] tag write failed (connect ECONNREFUSED ...) - continuing without it` and `[redis] cache delete failed ... - continuing without it`.
- 2 extra incidents (the same race as above). Writes p95 181 ms.

## 4. Results: Window A branch `feat/burst-safe-intake` (WP1 + WP2 + WP4)

Run on 3 Nov 2026 against `../oms-burst-intake` at commit 3821223 (pushed; `origin/feat/burst-safe-intake`, the same commit). The worktree had no `backend/.env`.

- **Host:** Windows 11 (10.0.26200), i7-13700HX with 24 logical CPUs, 16 GB RAM, Node v24.19.0. Load generator, backend, Postgres and Redis share the machine.
- **Settings:** full scale (`--scale 1`), 20 feeders, the branch's default settings: DB pool 10 (`PG_POOL_MAX`), complaints sync wait 15 s (`INTAKE_SYNC_WAIT_MS`), rate limits of 6,000 complaints and 120,000 SCADA events a minute per user. The harness overrides nothing.
- **Dev stack:** stopped throughout (`oms-postgres`, `oms-redis` and `oms-keycloak` exited; nothing else on ports 4100 and 4101).
- **Runs:**
  - Single process (`ROLE=all`): run id 0HXRQC, label `wp2`, six scenarios.
  - `--roles split` (`ROLE=api` on 4100 and `ROLE=worker` on 4101): run id 0IO66Q, label `wp4split`, `scada` and `chaos-kill` only.
- **Not run:** the 1-hour soak, so the "memory growth < 10%" gate has no result.

### 4.1 Gate summary

| Mode | Scenario | Gate | Result | Numbers |
|---|---|---|---|---|
| single | scada | no loss, no duplicates | PASS | 55,147 acked; lost 0, duplicate rows 0, never processed 0, rejected after retries 0 |
| single | scada | one active incident per feeder | PASS | 17 new incidents on 17 feeders, 0 extra (the other 3 feeders merged into seeded open incidents, see 4.3) |
| single | scada | writes p95 < 3 s | **FAIL** | 5,182 ms |
| single | scada | reads during burst p95 < 3 s | **FAIL** | 4,375 ms |
| single | complaints | no loss, no duplicates | PASS | 14,714 unique acked, 286 resends answered `200` duplicate; lost 0, duplicate rows 0, unlinked 0; customer-count mismatches 0 |
| single | complaints | one active incident per feeder | PASS | 17 on 17 feeders, 0 extra |
| single | complaints | writes p95 < 3 s | PASS | 47 ms |
| single | complaints | reads during burst p95 < 3 s | PASS | 6 ms |
| single | dashboard | no loss, no duplicates | PASS | 3,000 acked; lost 0, duplicate rows 0; customer-count mismatches 0 |
| single | dashboard | one active incident per feeder | PASS | 17 on 17 feeders, 0 extra |
| single | dashboard | writes p95 < 3 s | PASS | 80 ms |
| single | dashboard | quiet reads p95 < 3 s | PASS | 4 ms |
| single | dashboard | burst reads p95 < 3 s | PASS | 7 ms |
| single | chaos-kill | SCADA: no loss, no duplicates | **FAIL** | 12,000 acked; lost 0, **duplicate rows 2**, never processed 0 |
| single | chaos-kill | complaints: no loss, no duplicates | PASS | 3,000 acked; lost 0, duplicate rows 0; customer-count mismatches 0 |
| single | chaos-kill | one active incident per feeder | PASS | 17 on 17 feeders, 0 extra |
| single | chaos-kill | kept serving /api/health | n/a | single process: the killed process is the server. 73.2% of 56 samples, longest gap 51 s |
| single | chaos-kill | no `[fatal]` lines | PASS | 0 |
| single | chaos-kill | writes p95 < 3 s | **FAIL** | 25,838 ms |
| single | chaos-pg | SCADA: no loss, no duplicates | PASS | 12,000 acked; lost 0, duplicate rows 0, never processed 0 |
| single | chaos-pg | complaints: no loss, no duplicates | PASS | 3,000 acked; lost 0, duplicate rows 0; customer-count mismatches 0 |
| single | chaos-pg | one active incident per feeder | PASS | 17 on 17 feeders, 0 extra |
| single | chaos-pg | kept serving /api/health | **FAIL** | 85.7% of 56 samples, longest gap 36 s |
| single | chaos-pg | no `[fatal]` lines | PASS | 0 |
| single | chaos-pg | writes p95 < 3 s | **FAIL** | 24,935 ms |
| single | chaos-redis | SCADA: no loss, no duplicates | PASS | 12,000 acked; lost 0, duplicate rows 0, never processed 0 |
| single | chaos-redis | complaints: no loss, no duplicates | PASS | 3,000 acked; lost 0, duplicate rows 0; customer-count mismatches 0 |
| single | chaos-redis | one active incident per feeder | PASS | 17 on 17 feeders, 0 extra |
| single | chaos-redis | kept serving /api/health | **FAIL** | 93.0% of 57 samples, longest gap 16 s |
| single | chaos-redis | no `[fatal]` lines | PASS | 0 |
| single | chaos-redis | writes p95 < 3 s | **FAIL** | 17,953 ms |
| split | scada | no loss, no duplicates | PASS | 38,610 acked; lost 0, duplicate rows 0, never processed 0 |
| split | scada | one active incident per feeder | PASS | 17 on 17 feeders, 0 extra |
| split | scada | writes p95 < 3 s | **FAIL** | 11,268 ms |
| split | scada | reads during burst p95 < 3 s | **FAIL** | 9,298 ms |
| split | chaos-kill (worker killed) | SCADA: no loss, no duplicates | PASS | 12,000 acked; lost 0, duplicate rows 0, never processed 0 |
| split | chaos-kill (worker killed) | complaints: no loss, no duplicates | PASS | 3,000 acked; lost 0, duplicate rows 0; customer-count mismatches 0 |
| split | chaos-kill (worker killed) | one active incident per feeder | PASS | 17 on 17 feeders, 0 extra |
| split | chaos-kill (worker killed) | kept serving /api/health | **FAIL** | 90.9% of 55 samples, longest gap 21 s; the API process never exited |
| split | chaos-kill (worker killed) | no `[fatal]` lines | PASS | 0 |
| split | chaos-kill (worker killed) | writes p95 < 3 s | **FAIL** | 19,253 ms |
| — | soak | memory growth < 10% | not run | the soak was skipped by decision |

**Overall:**
- Loss, duplicates and one incident per feeder: PASS in every scenario except single-process `chaos-kill`, which has **2 duplicate SCADA alarm rows**.
- Latency (p95 < 3 s): FAIL in every SCADA-heavy scenario. PASS for complaints alone and for the dashboard.
- "Kept serving /api/health": FAIL in chaos-pg, chaos-redis and split chaos-kill.
- Customer count: always matched the distinct complaints (G2 behaviour holds under load).

### 4.2 Numbers per scenario

**scada, single process.** 1,000/s for 60 s.
- Load: 55,147 issued in 60 s (919/s achieved). 4,853 were not sent because 4,000 requests were already in flight, so the backend did not accept the full 1,000/s at this latency.
- Statuses: `202` × 55,147 and `500` × 43, all 43 retried and accepted.
- Writes: p50 3,612 / p95 5,182 / p99 5,329 / max 5,690 ms. Probe reads: p50 700 / p95 4,375 / max 5,009 ms.
- Backlog: queue depth 59,027 right after the load. It reached 0 after **284 s**, which is about 195 items/s of processing against 919/s accepted.
- Memory: RSS 154 MB to 424 MB.
- Log: 0 `[fatal]`. 43 `duplicate key value violates unique constraint "alarms_pkey"` (see 4.3).

**complaints, single process.** 50/s for 5 min, 2% resends.
- Load: 15,000 issued at 50/s, 0 skipped. Statuses: `201` × 14,714, `200` (duplicate) × 286, which are exactly the 286 resends.
- Writes: p50 20 / p95 47 / p99 91 / max 412 ms. Reads: p95 6 ms.
- Backlog: drained 6.5 s after the load.
- Memory: RSS 149 MB to 220 MB. Log: 0 errors.

**dashboard, single process.** 100 sessions for 120 s, complaints at 50/s from 30 s to 90 s.
- Sessions: 100 of 100 connected at the end, 0 connect errors, 0 disconnects, 300,100 Socket.IO events received.
- Reads: quiet p95 4 ms, burst p95 7 ms. Writes: p95 80 ms; 3,000 of 3,000 `201`.
- Memory: RSS 154 MB to 195 MB.

**chaos-kill, single process.** SCADA 200/s and complaints 50/s for 60 s; the backend gets SIGKILL at 15.4 s.
- Timeline: restarted at 17.7 s, healthy again at 19.3 s (1.6 s after the restart).
- Sender errors: SCADA saw 2,240 `ECONNREFUSED`, 4 `ECONNRESET` and 2 `500`. Complaints saw 1,410 `ECONNREFUSED`, 281 `ECONNRESET` and 311 client timeouts (30 s).
- Retries delivered everything: SCADA 12,000 `202`; complaints 607 `201`, 590 `200` (duplicate, meaning the first attempt had been stored), and 1,803 `202` (still queued after the 15 s sync wait).
- Writes p95 by kind: SCADA 19,435 ms, complaints 31,026 ms.
- Backlog: drained 6.6 s after the load. Memory: RSS 155 MB to 347 MB.
- The /api/health gap (51 s) is much longer than the 1.6 s restart: health answers stayed over the harness's 2 s timeout while the restarted process worked through the retry storm.

**chaos-pg, single process.** `docker restart` of Postgres at 15.3 s.
- Timeline: the restart returned at 16.7 s and Postgres accepted connections at 18.0 s.
- The log shows the retry path working: `[scada] attempt N/N failed (terminating connection due to administrator command); retrying in N ms` and `[complaint] attempt N/N failed (Connection terminated unexpectedly)`.
- Statuses: SCADA `202` × 12,000 and `500` × 7. Complaints `201` × 1,090, `202` × 1,892, `200` × 18, and 18 client timeouts.
- Writes p95 by kind: SCADA 16,099 ms, complaints 31,026 ms.
- Backlog: drained 6.6 s after the load. RSS max 317 MB. The process never exited.

**chaos-redis, single process.** Redis stopped at 15.3 s and started at 45.3 s, so it was down for 30 s.
- The log says so clearly: `[redis] client error: Socket closed unexpectedly`, `[redis] tag write failed (...) — continuing without it`, `[redis] cache delete failed (...) — continuing without it`.
- Statuses: SCADA `202` × 12,000 and `500` × 3. Complaints `201` × 3,000.
- Writes p95 by kind: SCADA 8,353 ms (p50 14 ms), complaints 20,676 ms.
- RSS max 254 MB. The process never exited.

**scada, split (api + worker).** 1,000/s for 60 s.
- Load: 38,610 issued in 60.6 s (637/s achieved); 21,390 not sent because of the in-flight limit. Statuses: `202` × 38,610 and `500` × 11.
- Writes: p50 6,945 / p95 11,268 / max 14,239 ms. Probe reads: p95 9,298 ms.
- Backlog: depth 25,819 after the load, drained after 162 s.
- RSS of both processes: 308 MB to 732 MB.
- In this run, split mode accepted fewer events per second than the single process.

**chaos-kill, split.** The worker gets SIGKILL at 15.6 s.
- Timeline: restarted at 18.3 s, worker healthy at 19.8 s. Processes alive at the end: `api` and `worker (restarted)`. The API process was never killed.
- Statuses: SCADA `202` × 12,000 and `500` × 1. Complaints `201` × 2,999 and `202` × 1. There were **no connection errors at all**: the API kept accepting while the worker was down.
- Writes p95 by kind: SCADA 9,798 ms (p50 164 ms), complaints 23,317 ms.
- Backlog: drained 7.2 s after the load. RSS max 552 MB.

### 4.3 Findings

1. **SCADA alarm id collisions (`500`).** `ingestScadaEvent` in `backend/src/routes/api.js` builds the alarm id as `'ALM-' + Math.random().toString(36).slice(2, 7)`. That is 5 base-36 characters, about 60 million values. At tens of thousands of events, ids collide on `alarms_pkey`:
   - Occurrences: 43 in the 55,147-event burst, 11 in the split burst, and 1 to 7 in each chaos run.
   - With the harness's retries nothing was lost, but a sender that does not retry would get a `500` and lose the event.
2. **SCADA duplicates after a crash (single-process chaos-kill, 2 rows).**
   - The route writes the `alarms` row and the queue item before it answers `202`, and it ignores the `eventId` / `external_id` the sender supplies.
   - If the process dies after the write but before the response reaches the sender (4 `ECONNRESET` here), the sender's retry creates a second alarm row for the same event.
   - Both rows linked to the same incident, so the incident count stayed right. But G6-style "exactly once" does not hold for SCADA intake across a crash of the API process.
   - Complaints are idempotent on `externalId` and had 0 duplicates in every run.
   - In split mode the API process was not killed, so this path was not exercised there.
3. **Processing throughput sets the latency.** The queue consumer worked off about 195 SCADA items/s (single process).
   - Under 200 SCADA/s plus 50 complaints/s, write latency climbs steadily from the first 10-second window, before any fault is injected. For example, chaos-redis p95 by window: 900, 3,813, 6,906, 10,096 ... 21,151 ms.
   - Complaints wait in the same queue for up to 15 s (`INTAKE_SYNC_WAIT_MS`) before they are answered, so their p95 reaches 20 to 31 s.
   - The chaos p95 failures are therefore mainly load-driven, not fault-driven.
   - The DB pool is 10 connections per process.
4. **"Kept serving /api/health" failures are slow answers, not outages.** In chaos-pg, chaos-redis and split chaos-kill, the process serving port 4100 never exited.
   - The failing samples are health requests that took longer than the harness's 2 s timeout while the pool was saturated (`/api/health` reads queue stats from the database).
   - The harness stores only the summary of these samples, not each one, so "slow" and "error" are not split out.
5. **20 feeders, 17 new incidents: correct.** A separate 6-second check (`--keep-db`, run 0IMRO8, database dropped afterwards) showed what happens to the other 3 feeders:
   - `seed()` leaves open sample incidents on UPCL-IA-B, UPCL-JW-B and UPCL-BC-A, and the run's events on those feeders merged into them (decision D2).
   - Each of the 20 feeders had exactly one active incident.
   - "Per substation: 4 extra" is expected: several harness feeders share a substation, and D2 merges per feeder.
6. Queue and dead-letter tables were empty at the end of every run: `intake_queue` 0 rows, `intake_dead_letter` 0 rows. Nothing was dead-lettered.

### 4.4 Harness changes made during this run (deviations)

Two harness bugs appeared only against this branch at full scale. Each fix is one line and changes no test logic:

- `run.mjs` `schemaInfo()`: the queue-table query aliased its column `t`, the same name as `q()`'s subquery alias. `json_agg(t)` then aggregated bare strings and the next query read `FROM undefined`. Master has no queue tables, so the smoke runs never reached this. The column alias is now `tbl`.
- `lib.mjs` `docker()` / `psqlScript()`: `execFileSync`'s default 1 MB output buffer was too small for the 60,000-event verification query (`ENOBUFS`). It is now 512 MB.

The first two full-scale attempts stopped at the SCADA verification step because of these bugs. Their databases were dropped and their numbers are not used here. Every number above comes from the third attempt (run 0HXRQC) and the split run (0IO66Q). All `oms_scratch_lt_*` databases were dropped; the scratch containers `oms-scratch-winc` and `oms-scratch-winc-redis` are still running.

## 5. Deviations and limits

- The tests ran on the laptop, not the server. Load generator, backend, Postgres and Redis compete for the same CPUs.
- The network topology (`network.*`) is not loaded on the scratch databases.
- Kafka is not tested (decision D1). The bus runs with the in-memory driver.
- On Windows, "kill -9" is `TerminateProcess` (Node's `SIGKILL`). The effect is the same: no clean-up runs.
- With a single backend process, killing it necessarily stops the API until the restart. "Kept serving" for `chaos-kill` is only meaningful once the API and the worker run as separate processes (WP4). With `--roles split` the harness starts `ROLE=api` on port 4100 and `ROLE=worker` on port 4101, and kills the worker. This was run on 3 Nov for `scada` and `chaos-kill` (section 4). The `spec` text in the split chaos-kill result still says "SIGKILL the backend"; the timeline shows the worker was the process killed.
- Chaos runs inject one fault each. Combined faults were not tested.
- The 1-hour soak was not run, so memory growth over time is unmeasured.
- Health availability counts any `/api/health` answer slower than 2 s as a miss.
