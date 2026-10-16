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
3. Open `http://<server-ip>:8080`.

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

## Crew app (phones)
The crew app talks to the server over **plain HTTP** on two ports:
- **4000**: the OMS backend API.
- **18080**: Keycloak, for sign-in.

`docker-compose.deploy.yml` publishes both on the network. The web app does not use them: it goes through Caddy on 8443.
- Limit both in the firewall to the crew devices' network if you can. Traffic on these ports is not encrypted, and
  18080 also serves Keycloak's admin console.
- Build the APK with `EXPO_PUBLIC_OMS_SERVER=<server-ip>`, or type the server IP on the app's sign-in screen.
- One crew login works on one phone at a time: signing in on a second phone signs the first one out (within 5
  minutes). Set it up once (and again only if the realm is re-imported):
  ```bash
  docker run --rm --network host -v "$PWD/backend:/app" -w /app \
    -e KEYCLOAK_URL=http://127.0.0.1:18080 -e KEYCLOAK_ADMIN_PASSWORD="$OMS_KC_ADMIN_PASSWORD" \
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
# allow that key to log in as mapdev (needs sudo; keep any restrictions mapdev already has)
sudo sh -c 'cat deploy/map-tunnel/keys/id_ed25519.pub >> ~mapdev/.ssh/authorized_keys'
```
Put the map API key (the `MAP_API_KEY` from the working `backend/.env`) in `backend/.env.deploy` on the server:
```
MAP_API_KEY=<your key>
```
Then `docker compose -f docker-compose.deploy.yml up -d --build`. Check: `docker compose -f docker-compose.deploy.yml logs map-tunnel`.
