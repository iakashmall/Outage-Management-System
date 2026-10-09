# Connecting OMS to the in-house map server (Spintech-inhouse map)

Follow this **every time** you start working and want the map. The map server listens only on its own machine
(`127.0.0.1:8095` there), so this PC reaches it through an SSH tunnel. The OMS backend then serves the map to the
web and crew apps; the browser never talks to the map server directly.

```
browser -> OMS backend (:14000, /api/map/*, needs OMS login) -> tunnel 127.0.0.1:8095 -> map server
```

## One-time setup (skip if already done)

1. **SSH key** on this PC: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519`
   Send the **public** key (`~/.ssh/id_ed25519.pub`) to whoever runs the map server. They add it to the `mapdev`
   user's `authorized_keys`. Never share the private file `id_ed25519`.
2. **`backend/.env`** must contain (ask the map-server admin for the key, privately):
   ```
   MAP_SERVER_URL=http://127.0.0.1:8095
   MAP_API_KEY=mk_...
   MAP_SSH_HOST=<map server address>
   MAP_SSH_USER=mapdev
   ```
   `backend/.env` is the file the backend reads (a root `.env` is not read when running from `backend/`).
   It is git-ignored; never commit it.
3. `npm install` in the project root (installs `maplibre-gl` and the Leaflet plugin the Network Map needs).
4. Install **Docker Desktop** (the backend needs Postgres, Redis, Kafka and Keycloak from `docker-compose.yml`).

## Every time

Use separate terminals; leave them open.

| # | Terminal | Command | You should see |
|---|----------|---------|----------------|
| 1 | Docker | Start Docker Desktop, wait for "Engine running" | `docker ps` works |
| 2 | any | `docker compose up -d postgres redis kafka keycloak` | containers `healthy` / `Up` |
| 3 | **tunnel** | `npm run map:tunnel` | `tunnel is up`. **Leave this open.** If it prints `Permission denied`, see Troubleshooting |
| 4 | any | `npm run map:check` | every line `OK`, ending "The connection works" |
| 5 | **backend** | `npm run dev:backend` | backend listening on port 14000 |
| 6 | **web** | `npm run dev:web` | open `http://localhost:15173/` |

(`npm start` runs backend + web + mobile together instead of steps 5 and 6.)

7. Log in (Keycloak) and open **Network Map**. The base map and the feeders, substations, crews and incidents should
   all appear. The corner credit reads "Spintech-inhouse map".

If the tunnel window is closed, or the PC sleeps, the base map goes blank. Re-run step 3 (it also reconnects by
itself after a short drop) and refresh the page.

## First time on a fresh database only

A new Docker volume has no GIS network tables. Apply them and import the network once:

```
docker exec -i oms-postgres psql -U oms -d oms < db/migrations/network_topology_schema.sql
cd backend
node src/infra/importCimNetwork.js <path-to>/Dehradun_Rural_Ring_Road_Substation_CIM_XML.xml
```

The importer is safe to re-run. Feeder/substation drawing data itself comes from `backend/src/infra/network.json`.

## Useful commands

| Command | Purpose |
|---------|---------|
| `npm run map:check` | Read-only health check: reachable? key accepted? style available? |
| `npm run map:config` | Shows the settings in use (key masked) |
| `npm run map:tunnel` | Opens and keeps the SSH tunnel |

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `map:check`: `ECONNREFUSED 127.0.0.1:8095` | Tunnel is not open. Run `npm run map:tunnel` (step 3) |
| Tunnel: `Permission denied (publickey,password)` | The server does not have this PC's **public** key, or `~/.ssh/id_ed25519` is missing. Re-send the `.pub` key to the map-server admin; check `MAP_SSH_USER`/`MAP_SSH_HOST` |
| `map:check`: key refused / 401 | `MAP_API_KEY` in `backend/.env` is wrong or missing. Restart the backend after changing it |
| Browser: `/api/map/...` returns **502** | Backend cannot reach the map server (tunnel down) or the key is refused. Fix the tunnel, then check the backend log |
| Browser: `/api/map/...` returns **401** | Your OMS login expired. Log in again |
| Base map blank, but feeders/crews show | Map server unreachable (tunnel). The OMS layers are drawn independently of the base map |
| Vite error "Failed to resolve import maplibre-gl" | Run `npm install`, then restart `npm run dev:web` |
| Backend log: `relation "network.conducting_equipment" does not exist` | Fresh database: do "First time on a fresh database only" |
| `docker ps` fails | Docker Desktop is not running |
| Ports already in use (14000 / 15173 / 8095) | An earlier run is still alive; close that terminal or stop the process on that port |

## Do not

- Do not open port 8095 on the map server to the internet. It is bound to `127.0.0.1` on purpose; the tunnel is the way in.
- Do not commit `backend/.env` or share the private SSH key.
