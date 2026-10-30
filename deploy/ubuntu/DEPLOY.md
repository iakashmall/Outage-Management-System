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
- The backend runs with `SIMULATOR=off`: no fake crew GPS, alarms or calls are mixed into real data.
- Keep `backend/.env.deploy` and `infra/keycloak-realm.deploy.json` on the server only (both are in `.gitignore`).

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
- Restore (into an empty `oms` database, with the backend stopped):
  ```bash
  docker compose -f docker-compose.deploy.yml stop oms-backend
  PG=$(docker compose -f docker-compose.deploy.yml ps -q postgres)
  docker exec -i "$PG" psql -U oms -d postgres -c 'DROP DATABASE oms' -c 'CREATE DATABASE oms'
  docker exec -i "$PG" psql -U oms -d oms -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()'
  docker exec -i "$PG" pg_restore -U oms -d oms --no-owner < ~/oms-backups/oms_<date>.dump
  docker exec -i "$PG" psql -U oms -d oms -c 'SELECT timescaledb_post_restore()'
  docker compose -f docker-compose.deploy.yml start oms-backend
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
