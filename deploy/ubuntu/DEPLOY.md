# Deploy OMS on the shared Ubuntu server (replaces the old OMS on port 8080)

Everything runs in Docker: Postgres/PostGIS/TimescaleDB, Redis, the backend and the web app (nginx).
Other apps on the server (HRMS, Caddy on ports 80/443, tile server) are not touched, and no volumes are deleted.

0. Set the required passwords (see **Required settings** below). Without them `docker compose` stops with
   "set a strong password in the environment".
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
| Wipe demo data | `docker compose -f docker-compose.deploy.yml down -v` |

Optional settings (map server, e-mail, reports): create `backend/.env.deploy` with `MAP_*`, `BREVO_*`, `NOTIFY_*`,
`REPORT_*` lines, then run the update command. The map falls back to OpenStreetMap (needs internet).
The database is not exposed outside Docker.

## Required settings
`docker-compose.deploy.yml` has no default passwords. Export both before any `docker compose` command (or put them in a
`.env` file next to `docker-compose.deploy.yml`, readable only by you):
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

**This compose does not publish 4000**, and it publishes 18080 on `127.0.0.1` only, so phones can reach neither
as shipped. The web app is not affected: it goes through Caddy on 8443. To use the crew app against this
server:
- In `docker-compose.deploy.yml`, add `ports: ["4000:4000"]` to `oms-backend` and change Keycloak's port to
  `"18080:8080"`.
- Limit both in the firewall to the crew devices' network if you can. Traffic on these ports is not encrypted, and
  18080 also serves Keycloak's admin console.

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
