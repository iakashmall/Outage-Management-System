# Deploy OMS on the shared Ubuntu server (replaces the old OMS on port 8080)

Everything runs in Docker: Postgres/PostGIS/TimescaleDB, Redis, the backend and the web app (nginx).
Other apps on the server (HRMS, Caddy on ports 80/443, tile server) are not touched, and no volumes are deleted.

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
Demo-grade: HTTP only, database not exposed outside Docker. Set `OMS_DB_PASSWORD` before first start to change it.

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
