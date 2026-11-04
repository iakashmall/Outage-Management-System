# Deploy OMS on the shared Ubuntu server (replaces the old OMS on port 8080)

Everything runs in Docker: Postgres/PostGIS/TimescaleDB, Redis, the backend and the web app (nginx).
Other apps on the server (HRMS, Caddy on ports 80/443, tile server) are not touched, and no volumes are deleted.

0. Export the required passwords (see **Required settings** below). `replace-old-oms.sh` checks both before it
   does anything else, so a missing password stops it before the old OMS is removed. Without them `docker compose`
   also stops, with "set a strong password in the environment".
1. Copy `OMS-deploy.zip` to the server and unzip it (e.g. `~/Desktop/OMS-deploy`).
2. `cd` into that folder and run:
   ```bash
   bash deploy/ubuntu/replace-old-oms.sh
   ```
   It removes only `oms-app-web` and `oms-app-backend`, builds the new images, starts the stack, loads the demo
   data and checks health. The first build takes several minutes.
3. Open `https://<server-ip>:8443` (self-signed certificate: Advanced > Proceed). Port 8080 answers on the server only.

| Task | Command (from the project folder) |
|---|---|
| Logs | `docker compose -f docker-compose.deploy.yml logs -f oms-backend` |
| Status | `docker compose -f docker-compose.deploy.yml ps` |
| Update after new code | `docker compose -f docker-compose.deploy.yml up -d --build` |
| Stop | `docker compose -f docker-compose.deploy.yml down` |
| Back up the databases | `bash deploy/ubuntu/backup-db.sh` (see **Backups**) |
| Wipe ALL data (photos, scans, logins too) | `docker compose -f docker-compose.deploy.yml down -v` (never on a live server) |

Optional settings (map server, e-mail, reports): create `backend/.env.deploy` with `MAP_*`, `BREVO_*`, `NOTIFY_*`,
`REPORT_*` lines, then run the update command. The map falls back to OpenStreetMap (needs internet).
The database is not exposed outside Docker.

## Required settings
`docker-compose.deploy.yml` has no default passwords. Export both before any `docker compose` command (or put them in a
`.env` file next to `docker-compose.deploy.yml`, readable only by you; `replace-old-oms.sh` still needs them exported
in the shell, it does not read `.env`):
```bash
export OMS_DB_PASSWORD='<strong password>'        # Postgres user "oms" (backend and Keycloak use it)
export OMS_KC_ADMIN_PASSWORD='<strong password>'  # Keycloak "admin" user
```
- **Both only take effect on a fresh start.** Postgres sets its password when the `pgdata` volume is first created,
  and Keycloak creates `admin` only once. On a server that already ran with the old defaults (`oms` / `admin`),
  either set the variables to the current passwords, or change them first (`ALTER USER oms PASSWORD '...'` in
  Postgres, and the admin password in Keycloak). Otherwise the backend and Keycloak can no longer log in to the database.
- **`OMS_HOST` is required too** for any `docker compose` command run by hand: export it, or add `OMS_HOST=<server-ip>`
  to that `.env` file. `replace-old-oms.sh` sets it itself, but plain compose falls back to `localhost`: Caddy then
  serves only `https://localhost:8443` (wrong certificate, no answer on the server's IP), and a rebuilt web app sends
  sign-in to `https://localhost:8443`.
- **Load the topology after the schema migration.** The `network.*` tables start empty. Once
  `db/migrations/network_topology_schema.sql` has been applied, load them with `deploy/ubuntu/load-topology.sh`.
  Without it, trace to source, switching plans and the map's topology layer have no graph.
- The backend runs with `SIMULATOR=off`: no fake crew GPS, alarms or calls are mixed into real data.
- Keep `backend/.env.deploy` and `infra/keycloak-realm.deploy.json` on the server only (both are in `.gitignore`).
- **Seed and importer runs need `-e PG_STATEMENT_TIMEOUT_MS=`** (blank = no limit). The backend service applies a
  60 s statement timeout to everything run in its container, so a long seed or network import would be cancelled:
  ```bash
  docker compose -f docker-compose.deploy.yml run --rm -e PG_STATEMENT_TIMEOUT_MS= oms-backend node src/infra/seed.js
  docker compose -f docker-compose.deploy.yml run --rm -e PG_STATEMENT_TIMEOUT_MS= oms-backend node src/infra/importHaridwarInferred.js ...
  ```
- **Redis has no append-only file, by design.** It holds only live tag values and short-lived caches, capped at
  128 MB; Postgres is the system of record. A restart can lose the last few minutes of tag values, which the next
  SCADA readings replace.

## Complaint intake API (`POST /api/complaints`)
For the external complaint service. The caller needs a token with the `call_centre_attendant`, `oms_operator` or
`system_admin` role. Every complaint goes into the durable intake queue (Postgres `intake_queue`), which the
`oms-worker` service processes. The API waits up to `INTAKE_SYNC_WAIT_MS` (default 15000 ms) for the result, then answers:

| Status | Body | Meaning |
|---|---|---|
| `201` | `queryId`, `externalId`, `action` (`created` / `merged`), `incidentId`, `feeder`, `substation`, `complaint`, and `plannedOutage` when it joined one | Processed: stored and linked to an incident. |
| `200` | the stored complaint's fields, plus `duplicate: true` | That `externalId` is already stored. Nothing new was created; resending is safe. |
| `202` | `queryId`, `externalId`, `status: 'queued'` | Accepted and safely queued, but not processed within `INTAKE_SYNC_WAIT_MS`. It will be processed; do not resend with a new `externalId`. Resending the same `externalId` later answers `200`, `duplicate: true` once it is processed. |

Rejected requests never reach the queue: `401` without a valid token, `403` for any other role, `429` (with
`Retry-After`) above `INTAKE_RATE_LIMIT_PER_MIN` per client, `413` for a body over 64 KB and `400` for invalid fields.
A `202` while `oms-worker` is running usually means the queue is backed up: check the queue depth at `/api/health`.
If `oms-worker` is stopped, every complaint answers `202` and waits in the queue until a worker starts again.

Settings (all optional; put them in `backend/.env.deploy`):

| Variable | Default | What it does |
|---|---|---|
| `ROLE` | `all` | `api`, `worker` or `all`; the compose file already sets `api` for `oms-backend` and `worker` for `oms-worker` |
| `INTAKE_SYNC_WAIT_MS` | `15000` | how long `POST /complaints` waits for the queue before answering `202` |
| `INTAKE_RATE_LIMIT_PER_MIN` / `SCADA_RATE_LIMIT_PER_MIN` | `6000` / `120000` | per-client limits (`0` turns a limit off) |
| `ENABLE_SIMULATORS` | `false` | keep `false`: otherwise `/complaints/simulate` and `/scada/simulate` are open |
| `INTAKE_COALESCE` | on | `off` stops repeated queued SCADA events for the same tag and state from being merged. Applies to SCADA events arriving on the event bus (DNP3 adapter, Kafka); since F5, `POST /scada/fault` writes in batches and does not coalesce |
| `QUEUE_POLL_MS`, `QUEUE_LEASE_MS`, `QUEUE_MAX_ATTEMPTS`, `QUEUE_BACKOFF_BASE_MS`, `QUEUE_BACKOFF_MAX_MS` | 250, 10000, 8, 1000, 300000 | queue worker tuning; after `QUEUE_MAX_ATTEMPTS` an item moves to `intake_dead_letter`. *(changed 4 Nov 2026: the lease was 60000)* A live worker renews the lease of the items it holds (heartbeat), so the lease only matters when a worker dies or stalls: its items are taken over within about one lease |
| `QUEUE_HEARTBEAT_MS` | `QUEUE_LEASE_MS / 3` | how often a worker renews the leases it holds (at least 200) |
| `MIGRATION_LOCK_TIMEOUT_MS` | `2000` | `lock_timeout` for the schema migration, which runs only when the database's schema version is older than the code's. A longer lock wait fails the migration step instead of queueing live traffic behind it; the step is then retried |
| `STARTUP_RETRY_ATTEMPTS`, `STARTUP_RETRY_DELAY_MS` | 5, 2000 | a startup step that fails (schema migration, first-run seed) is retried with a delay that doubles each time (at most 30 s). After the last attempt the process exits with code 1, so `restart: unless-stopped` starts it again |
| `INTAKE_RETRY_ATTEMPTS`, `INTAKE_RETRY_BASE_MS` | 3, 100 | retries of one intake transaction (deadlock, serialization failure) |
| `JOB_LOCK_RETRY_MS` | `15000` | how often a standby worker tries to take over a background job |

Intake throughput, read protection and fail-fast settings (load-test fixes F3 to F6, 3 Nov 2026). All optional; each must be a positive whole number, and anything else falls back to the default:

| Variable | Default | What it does |
|---|---|---|
| `PG_POOL_MAX` | `10` | *(changed meaning)* size of the process's main pool: API routes, background jobs, `/api/health`. The intake consumer no longer uses it |
| `QUEUE_PG_POOL_MAX` | `8` | size of the intake consumer's own pool, created only in a process that runs the consumer (`ROLE=worker` or `all`); it also takes `PG_CONNECT_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`, `PG_IDLE_TX_TIMEOUT_MS` and `PG_IDLE_TIMEOUT_MS` |
| `QUEUE_CONCURRENCY` | `4` | *(changed meaning)* worker loops in the SCADA lane (every queued kind except complaints); each loop claims up to `QUEUE_BATCH_MAX` items at a time. Capped by the pool, see below |
| `QUEUE_COMPLAINT_CONCURRENCY` | `2` | worker loops in the complaint lane, which claims only complaints, one at a time, so a complaint never waits behind a SCADA backlog |
| `QUEUE_BATCH_MAX` | `200` | queue items one SCADA-lane loop claims at once (only the oldest item of each SCADA tag is ever claimed); claimed trips of the same feeder are processed in one transaction. A claim takes whole feeder groups, see the next two rows |
| `QUEUE_CLAIM_SCAN` | `10 × QUEUE_BATCH_MAX` | oldest claimable SCADA-lane items one claim looks at; they are grouped by the feeder the event names (its `feeder` field, else the first two tag tokens) and whole groups are claimed, the group with the oldest item first. Never below `QUEUE_BATCH_MAX` |
| `QUEUE_GROUP_MAX` | `50` | most items of one feeder group in one claim |
| `SCADA_BATCH_MAX` | `500` | `POST /scada/fault` requests written in one transaction (alarm rows, queue items and audit rows as multi-row inserts) |
| `SCADA_BATCH_WAIT_MS` | `5` | how long the first request of a write batch waits for others before the batch is written |
| `HEALTH_REFRESH_MS` | `2000` | how often a background read refreshes the queue figures that `/api/health` answers with; the endpoint itself never waits on Postgres or Redis |
| `HEALTH_QUEUE_TIMEOUT_MS` | `1500` | *(changed: was `2000`, a wait inside each request)* time limit for each background read; on failure `/api/health` still answers at once, with the last figures marked `stale: true` and the error |
| `REDIS_COMMAND_TIMEOUT_MS` | `250` | longest any cache call (tag write or read, cache read, write or delete) waits for Redis; a call over the limit is treated as a cache miss or a skipped write, never as an error |
| `REDIS_CONNECT_TIMEOUT_MS` | `1000` | time limit for opening a connection to Redis |
| `SCADA_TEST_CRASH_AFTER_COMMIT` | unset | test only (`selftest-loadfixes.js`): kills the process after a SCADA write batch commits. Ignored when `NODE_ENV=production`; never set it on the server |

Fixed in the code (no variable):
- `/api/health` marks the queue figures stale once they are older than 3 × `HEALTH_REFRESH_MS` (6 s by default) or the last read failed.
- Consumer loops leave 2 connections of the consumer pool free: the complaint lane gets at most half of the rest, and the SCADA lane at most what is left; each lane gets at least 1 loop. With the defaults (pool 8) that is 2 complaint loops and 4 SCADA loops. A smaller `QUEUE_PG_POOL_MAX` silently lowers both, whatever `QUEUE_CONCURRENCY` and `QUEUE_COMPLAINT_CONCURRENCY` say.
- The complaint lane claims 1 item per claim.
- SCADA trips are grouped by the feeder and substation named in the event; reclose events, non-outage conditions and events with an equipment mRID are always processed one at a time. If a group's transaction fails, its items are retried one at a time.
- Redis has no offline queue: a call made while Redis is disconnected fails at once.
- Before the first successful connection, Redis is retried 4 times after the first attempt (5 attempts) and then given up until the next restart, so boot never hangs. After it has connected once, the client reconnects for ever, waiting (attempt + 1) × 100 ms between tries, at most 2 s.
- The HTTP listen backlog is Node's default (511); `index.js` does not set it.

Database connections at most, with the defaults:
- `ROLE=api`: `PG_POOL_MAX` + 1 notice listener (used by `POST /complaints` to wait for its result), which is 11.
- `ROLE=worker`: `PG_POOL_MAX` + `QUEUE_PG_POOL_MAX`, which is 18.
- `ROLE=all`: both, which is 19.

The compose file's `oms-backend` (api) and `oms-worker` (worker) together use at most 29.

## First start of this version (schema version, phone encryption, rollback)
This version (burst-safe intake, November 2026) changes the database schema once, on its first start. Do these in order.

**1. Before the update: back up and keep the previous images and folder.**
```bash
bash deploy/ubuntu/backup-db.sh                       # note the file: ~/oms-backups/oms_<date>.dump
docker compose -f docker-compose.deploy.yml images    # the names of the images now running
docker tag oms-oms-backend:latest oms-oms-backend:pre-update
docker tag oms-oms-web:latest oms-oms-web:pre-update
```
`oms-oms-backend` and `oms-oms-web` are Compose's names for the built images (project `oms`, then the service). If the
`images` command shows other names, tag those. `up -d --build` re-uses the `latest` tag, so without these tags the
previous images cannot be started again. Keep the previous `OMS-deploy` folder; unzip the new version into a new one.
Note the time of the update: anything received after it is not in this backup.

**2. Set `ENCRYPTION_KEY` before the first start.** Put it in `backend/.env.deploy`, using the key the server
already uses. On the first start the migration converts `complaints.phone` from TEXT to encrypted `bytea`:
- values already encrypted by the app (hex text) are decoded, not encrypted twice;
- plain-text phones are encrypted with `ENCRYPTION_KEY`.

**If the key is missing on the first start, the phone column stays TEXT: the phones are not encrypted at rest.** The
log shows `[migrate] complaints.phone is still TEXT and ENCRYPTION_KEY is not set` once. Adding the key later and
restarting converts the column then, because the key is part of the schema version. The conversion cannot be undone
without the backup, and the phones can be read again only with the same key. To check after the start:
```bash
docker compose -f docker-compose.deploy.yml exec postgres psql -U oms -d oms -tAc \
  "SELECT data_type FROM information_schema.columns WHERE table_name = 'complaints' AND column_name = 'phone'"   # bytea
```

**3. What the first start does: the schema version is created and the migration runs once, under a lock.**
- **The database has no `oms_schema_version` table yet**, so both `oms-backend` and `oms-worker` find the schema
  version missing.
- **Each takes the advisory lock (41000, 1).** The first one runs the whole migration once: the schema statements,
  the id-counter sync (which only ever moves a counter forward), and the phone conversion. It then writes the new
  version to `oms_schema_version`.
- **The other waits for the lock,** finds the version current and runs no schema statements.
- **Expected log lines:** `[schema] migrated (none) -> <version> in <n> ms` from one process, and
  `[schema] version <version> is current: no DDL (another process migrated it)` from the other. Every later start
  logs `[schema] version <version> is current: no DDL`, and takes no lock and runs no DDL. To check:
  ```bash
  docker compose -f docker-compose.deploy.yml logs oms-backend oms-worker | grep '\[schema\]'
  docker compose -f docker-compose.deploy.yml exec postgres psql -U oms -d oms -c 'SELECT * FROM oms_schema_version'
  ```
- **Lock waits are short.** The migration waits at most `MIGRATION_LOCK_TIMEOUT_MS` (2 s) for each table lock, so
  it never queues live traffic behind it. If a lock is busy for longer, the step fails and is retried with a
  doubling delay (2, 4, 8, 16 s; `STARTUP_RETRY_ATTEMPTS`, `STARTUP_RETRY_DELAY_MS`). After the last attempt the
  process exits with code 1 and Docker starts it again. Update at a quiet time so the first attempt gets its locks.
- **Statement timeout.** The backend containers apply a 60 s statement timeout, and the phone conversion rewrites the
  whole `complaints` table. If the log shows `canceling statement due to statement timeout` during the migration,
  stop both services and run the migration once without the limit, then start them:
  ```bash
  docker compose -f docker-compose.deploy.yml stop oms-backend oms-worker
  docker compose -f docker-compose.deploy.yml run --rm -e PG_STATEMENT_TIMEOUT_MS= oms-backend \
    node --input-type=module -e "const { ensureSchema } = await import('./src/infra/db.js'); await ensureSchema(); process.exit(0)"
  docker compose -f docker-compose.deploy.yml start oms-backend oms-worker
  ```
- **Later versions:** any later version whose migration code changes migrates once on its first start in the same
  way. A version with unchanged migration code runs no DDL.

**4. Rollback: restore the pre-update dump and run the previous images.** The migration changes the schema (the
phone column's type, new tables, the schema version). The previous code was not tested against the new schema, so
restoring the database is part of the rollback. Complaints and events received after the update are not in the
dump; export what you need first.
```bash
# in THIS version's folder
docker compose -f docker-compose.deploy.yml stop oms-backend oms-worker oms-web
docker compose -f docker-compose.deploy.yml rm -f oms-worker
PG=$(docker compose -f docker-compose.deploy.yml ps -q postgres)
docker exec -i "$PG" psql -U oms -d postgres -c 'DROP DATABASE oms' -c 'CREATE DATABASE oms'
docker exec -i "$PG" psql -U oms -d oms -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()'
docker exec -i "$PG" pg_restore -U oms -d oms --no-owner < ~/oms-backups/oms_<date>.dump    # the dump from step 1
docker exec -i "$PG" psql -U oms -d oms -c 'SELECT timescaledb_post_restore()'
docker tag oms-oms-backend:pre-update oms-oms-backend:latest
docker tag oms-oms-web:pre-update oms-oms-web:latest
# in the PREVIOUS version's folder (same project name, oms)
docker compose -f docker-compose.deploy.yml up -d --no-build oms-backend oms-web
```
Then check `https://<server-ip>:8443` and `docker compose -f docker-compose.deploy.yml logs -f oms-backend`. Keycloak
is not changed by this version, so its database needs no restore.

## Load the network topology
**Required after the first deploy, and again after any change to `backend/src/infra/importHaridwarInferred.js`.**
`replace-old-oms.sh` does not do it. Without it the `network.*` tables are missing or empty: trace to source,
sectionalising, simulate opening and switching plans have no graph, and the map has no topology layer. The backend
says so at startup (`docker compose -f docker-compose.deploy.yml logs oms-backend | grep topology`):
`[topology] network.* schema MISSING`, `... is EMPTY`, or `network.conducting_equipment: <n> rows`.

From the project folder, first without `--write`:
```bash
bash deploy/ubuntu/load-topology.sh            # backup, schema, importer --dry-run (no topology rows written)
bash deploy/ubuntu/load-topology.sh --write    # the same, then the import (one transaction)
docker compose -f docker-compose.deploy.yml restart oms-backend
```
What it runs (no passwords needed; containers are found by their compose labels, like `backup-db.sh`):
1. `deploy/ubuntu/backup-db.sh`.
2. `db/migrations/network_topology_schema.sql` with `psql` in the postgres container (idempotent: `IF NOT EXISTS` only).
   Stops first if PostGIS is not enabled.
3. `node src/infra/importHaridwarInferred.js --dry-run` in the backend container (WORKDIR `/app/backend`). The importer
   reads `/app/backend/src/infra/network.json`, the copy baked into the image, so a new `network.json` needs an image
   rebuild (`docker compose -f docker-compose.deploy.yml up -d --build`) before re-running this.
4. With `--write`: `node src/infra/importHaridwarInferred.js --write`, then the row counts.

**Expected counts** (Haridwar, importer from PR #49, current `network.json`):

| Table | Rows |
|---|---|
| `network.substations` | 15 |
| `network.feeders` | 257 |
| `network.conducting_equipment` | 10,168 (ACLineSegment 5,997 · PowerTransformer 1,549 · Disconnector 1,220 · Fuse 1,080 · Switch 322) |
| `network.connectivity_nodes` | 4,623 |
| `network.terminals` | 16,168 |

These are the importer's own rows. If the Dehradun CIM model has also been imported (`importCimNetwork.js`), the
tables hold those rows on top.

**PR #49 check, before `--write`:** the dry-run output must show the capped importer, otherwise the image is older than
PR #49 and must not write over a capped graph:
- `line joins:` includes `refusedByNodeSpanCap` and `refusedCrossFeederBare`;
- `Connected components`: `total: 611`, `substationAnchored: { components: 10 ... }`, `orphanedFragments: { components: 601 ... }`;
- the last line says `--write would proceed`, not `--write WOULD BE REFUSED`.

## Crew app (phones)
The crew app talks to the server over **plain HTTP** on two ports:
- **4000**: the OMS backend API.
- **18080**: Keycloak sign-in, through Caddy. Only the `oms-upcl` login pages are served there; the master realm and
  the admin console answer 404.

`docker-compose.deploy.yml` publishes both on the network. The web app does not use them: it goes through Caddy on 8443.
Traffic on these ports is not encrypted. Published Docker ports bypass `ufw`, so a `ufw` rule alone does not limit them.
- Keycloak's admin console is on this server only, at `127.0.0.1:18081`. From a laptop:
  `ssh -L 18081:127.0.0.1:18081 <user>@<server>`, then open `http://localhost:18081/admin/`.
- Admin scripts (below) use `KEYCLOAK_URL=http://127.0.0.1:18081`; through `:18080` they get 404.
- Build the APK with `EXPO_PUBLIC_OMS_SERVER=<server-ip>`, or type the server IP on the app's sign-in screen.
- One crew login works on one phone at a time: signing in on a second phone signs the first one out (within 5
  minutes). Set it up once (and again only if the realm is re-imported):
  ```bash
  docker run --rm --network host -v "$PWD/backend:/app" -w /app \
    -e KEYCLOAK_URL=http://127.0.0.1:18081 -e KEYCLOAK_ADMIN_PASSWORD="$OMS_KC_ADMIN_PASSWORD" \
    node:20-alpine node scripts/setup-crew-session-limit.mjs
  ```
  It only changes the sign-in flow for `field_crew` users; operators and passwords are not touched.
- Photos and QR scans go straight into the `oms` database (table `job_photos`, about 100-200 KB per photo, and
  `asset_scans`). Taken offline, they wait on the phone and upload when it is back online.

## Backups
Everything the OMS keeps, including every crew photo and QR asset scan, is in the `pgdata` volume. Keep it:
- Never run `down -v`, and always use this folder's `docker-compose.deploy.yml` (project name `oms`); another
  project name starts with a new, empty volume.
- Back up nightly with `deploy/ubuntu/backup-db.sh`. It saves `oms_<date>.dump` and `keycloak_<date>.dump` to
  `~/oms-backups` (set `OMS_BACKUP_DIR` to change) and deletes backups older than 14 days (`OMS_BACKUP_KEEP_DAYS`).
  It needs no passwords. Add it to cron (`crontab -e`):
  ```
  30 2 * * * bash /path/to/OMS-deploy/deploy/ubuntu/backup-db.sh >> $HOME/oms-backups/backup.log 2>&1
  ```
- Copy `~/oms-backups` to another machine regularly; a backup on the same disk is lost with the disk.
- Restore (into an empty `oms` database, with the backend and the worker stopped; `DROP DATABASE` fails while
  either still holds a connection):
  ```bash
  docker compose -f docker-compose.deploy.yml stop oms-backend oms-worker
  PG=$(docker compose -f docker-compose.deploy.yml ps -q postgres)
  docker exec -i "$PG" psql -U oms -d postgres -c 'DROP DATABASE oms' -c 'CREATE DATABASE oms'
  docker exec -i "$PG" psql -U oms -d oms -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()'
  docker exec -i "$PG" pg_restore -U oms -d oms --no-owner < ~/oms-backups/oms_<date>.dump
  docker exec -i "$PG" psql -U oms -d oms -c 'SELECT timescaledb_post_restore()'
  docker compose -f docker-compose.deploy.yml start oms-backend oms-worker
  ```

## Map server (in-house map on this same server)
The map server listens on 127.0.0.1:8095 only, so the OMS reaches it through the tunnel-only login `mapdev`, as other
devices do (the `map-tunnel` container). One-time setup on the server, from the project folder:
```bash
mkdir -p deploy/map-tunnel/keys
ssh-keygen -t ed25519 -N "" -C "oms-container-tunnel" -f deploy/map-tunnel/keys/id_ed25519
# allow that key to log in as mapdev, for the map tunnel only (needs sudo)
echo "restrict,port-forwarding,permitopen=\"127.0.0.1:8095\" $(cat deploy/map-tunnel/keys/id_ed25519.pub)" | sudo tee -a ~mapdev/.ssh/authorized_keys
sudo chown mapdev: ~mapdev/.ssh/authorized_keys && sudo chmod 600 ~mapdev/.ssh/authorized_keys
```
Put the map API key (the `MAP_API_KEY` from the working `backend/.env`) in `backend/.env.deploy` on the server:
```
MAP_API_KEY=<your key>
```
Then `docker compose -f docker-compose.deploy.yml up -d --build`. Check: `docker compose -f docker-compose.deploy.yml logs map-tunnel`.

## Road graph for crew directions (optional)
`docker-compose.deploy.yml` mounts `backend/tiles` (on the server, next to the compose file) read-only into the
backend. Without `roads.json` there the crew app draws a straight line to the site. To build it, from `backend/`:
```bash
curl -L -o tile-server/uttarakhand.osm.pbf https://download.openstreetmap.fr/extracts/asia/india/uttarakhand-latest.osm.pbf
npm run roads:build    # writes backend/tiles/roads.json and adds it to backend/tiles/manifest.json
```
No restart needed: the backend reloads `roads.json` when the file changes. `backend/tiles/` is in `.gitignore`.
