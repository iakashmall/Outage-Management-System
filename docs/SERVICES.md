# OMS platform: services and components

Everything the Outage Management System (OMS) and the crew app (Android APK) run on or talk to.
Written from the repo (`docker-compose*.yml`, `package.json` files, `backend/src`, `frontend/src`, `src/`,
`docs/`) on 13 Oct 2026, master `46f1665`. Ports are the host ports used on the dev PC.

## 1. Big picture

```
 Control-room browser            Crew phone (APK)             Public / customers
 frontend/ (React+Vite)          root Expo app                /portal, /api/public/outage-status
        |                              |                               |
        +---------- REST + socket.io --+-------------------------------+
                               |
                    OMS backend (Node + Express)  :4000 (default; :14000 on this PC via .env)
        +-----------+----------+-----------+------------+-------------+--------------+
     Postgres     Redis      Kafka      Keycloak    Map server     SMTP (Brevo)    DMS REST
  (+PostGIS,    (cache)  (SCADA events)  (login)   (via SSH tunnel)  (notices)     (restoration)
   Timescale)
```


Five things are deployed by the project itself: **backend**, **control-room web app**, **crew app (APK)**,
**crew web PWA** (`mobile/`, not the APK) and the **Docker infrastructure services**.

## 2. Application services

| Service | Where | Tech | Port | What it does |
|---|---|---|---|---|
| OMS backend | `backend/` | Node 22, Express 4, socket.io 4, pg-promise, kafkajs, redis, jsonwebtoken + jwks-rsa, nodemailer, node-cron, pdfkit, sharp, fast-xml-parser | 4000 (default `PORT`) | REST API under `/api` (JWT required), WebSocket live feed, domain logic, background jobs (section 5) |
| Control-room web app | `frontend/` | React 18, Vite 8, Tailwind 4, shadcn/radix, Leaflet + MapLibre GL, keycloak-js, socket.io-client | 5173 (15173 on this PC) | Operator UI: Dashboard, Incidents, Dispatch, Dispatch workload, Planned outages, Network map, Alarms, TCS, Complaints, Analytics, Admin |
| **Crew app (APK)** | repo root: `index.js` -> `src/NativeApp.jsx`, `app.json`, `app.config.js`, `eas.json` | Expo 57, React Native 0.86, React 19. Package `com.omscrew.mobile`, name "OMS Crew" | none (client) | Crew jobs, status flow, planned-outage panel, safety checklist, fault diagnosis, parts, QR scan, photos, messages, offline map and routing, background GPS, biometric lock. See section 4 |
| Crew web PWA | `mobile/` | React 18, Vite, keycloak-js | 5174 | Browser version of the crew app. **Not the APK** (see `LEGACY.md`) |
| Legacy / stale | `server/`, `mobile-native-fixed/`, `mobile_backup/`, `mobile_pre_adeeb_merge/` | | | Pre-Phase-8 prototype (photo upload server) and old copies. Do not build or fix |

## 3. Infrastructure services (`docker-compose.yml`)

| Service | Image | Host port | Purpose | Needed for demo? |
|---|---|---|---|---|
| `postgres` (`oms-postgres`) | `timescale/timescaledb-ha:pg16` (Postgres 16 + PostGIS + TimescaleDB) | 127.0.0.1:15432 | Main database: incidents, crews, jobs, planned outages, audit log, `network.*` CIM topology | Yes |
| `postgres-replica` | same image | 127.0.0.1:15433 | Streaming replica (failover practice) | No |
| `redis` | `redis:7-alpine` | 127.0.0.1:16379 | Cache. The backend continues if Redis is unreachable | Recommended |
| `kafka` | `apache/kafka:3.7.1` | 127.0.0.1:19092 | Event bus when `EVENT_BUS_DRIVER=kafka`; SCADA fault events (`scada.alarm.raised`) | No (memory bus is the default) |
| `kafka-ui` | `provectuslabs/kafka-ui` | 127.0.0.1:18085 | Browse Kafka topics | No |
| `keycloak` (`oms-keycloak`) | `quay.io/keycloak/keycloak:24.0` | 127.0.0.1:18080 (0.0.0.0 with `docker-compose.mobile.yml`) | Login (OIDC + PKCE). Realm `oms-upcl`, clients `oms-web` and `oms-mobile` | Yes |

`docker-compose.override.yml` adjusts Kafka and kafka-ui. `docker-compose.mobile.yml` re-binds Keycloak to all interfaces so a phone can sign in.

Volumes: `pgdata`, `pgdata_replica`, `redisdata`, `kafkadata`.

### Authentication and roles
- Keycloak realm `oms-upcl` (`infra/keycloak-realm.json`, login theme in `keycloak-themes/` and `infra/keycloak-theme`).
- The backend verifies the bearer token against Keycloak's JWKS endpoint (`KEYCLOAK_JWKS_URI`).
- Roles: `oms_operator`, `system_admin`, `field_crew`. Crew routes also need a `crew_id` token claim.
- `npm run keycloak:mobile` (in `backend/`) creates the `oms-mobile` client, the `crew_id` claim, the `field_crew` role and the logins `crew01`-`crew06` (crew `C001`-`C006`).

## 4. Crew app (APK) in detail

**Build:** EAS Build (Expo cloud). Profiles in `eas.json`: `development`, `preview`, `production`, and `test`
(extends `preview` and sets `OMS_ALLOW_CLEARTEXT=1`). Use **`test`** for a LAN setup: it is the only profile that
allows plain HTTP. `app.config.js` adds `expo-build-properties` with cleartext traffic only for that profile.
EAS project ID is in `app.json` (`extra.eas.projectId`).

**Talks to:**
- OMS backend on `:4000` (REST, bearer token), address set at runtime on the sign-in screen (default from `src/config.js`, `EXPO_PUBLIC_OMS_SERVER`)
- Keycloak on `:18080` (realm `oms-upcl`, client `oms-mobile`, redirect scheme `omscrew`)
- Optional standalone map/tracking test server (`EXPO_PUBLIC_MAP_TEST_SERVER`, development only, no auth)

**Expo modules / device services:** expo-auth-session and expo-web-browser (login), expo-secure-store (tokens),
expo-local-authentication (biometric), expo-location + expo-task-manager (background GPS tracking),
expo-camera (QR scan, photos), expo-image-picker, expo-sqlite and AsyncStorage (offline queue, offline map),
expo-file-system, expo-network, react-native-webview (map), react-native-safe-area-context.

**Android permissions:** camera, fine/coarse/background location, foreground service (location), biometric/fingerprint,
record audio, boot completed, wake lock.

**Behaviour that matters for operations:**
- Job list and queued status updates sync every 10 s (`JOB_POLL_INTERVAL_MS`). There is no push channel to the phone.
- Offline: status updates and GPS trail are queued and sent later. Switching-step confirmations are stored but shown as "not sent" until the server acknowledges them. Permit calls and Work Started/Finished on planned jobs are online only.
- Offline map pack and offline road routing come from the backend tile endpoints (section 6).

## 5. Backend internals

Layers: `routes/` (HTTP) -> `domain/` (pure rules, no I/O) -> `infra/repo.js` (the only SQL) -> Postgres.

**Route groups** (`backend/src/routes`): `api.js` (about 65 endpoints: incidents, crews, calls/TCS, complaints, alarms,
analytics, reports, network, tiles, route, scada, dms, notify, audit, `mobile/*` for the crew app), `plannedOutages.js`
(OMS-01 control-room and crew routes), `dispatch.js` (OMS-03 workload and rebalance), `mapProxy.js` (`/api/map/*`),
`mapRegions.js`, `auth.js` (JWT check). Public, unauthenticated: `/api/health`, `/api/health/ready`,
`/api/public/outage-status`, static `/portal`.

**Domain modules:** incident `lifecycle`, `indices` (SAIDI/SAIFI/CAIDI/MAIFI, IEEE 1366), `prediction` (SCADA trip
prediction), `plannedOutage`, `plannedComplaints`, `switchingPlan`, `rebalance` (OMS-03 engine), `topology` and
`sectionalize` (network trace), `roadRouter`, `callState`, `locations`, `photos`, `publicStatus`, `reports`, `bus`.

**Background workers** (`backend/src/realtime`, started at boot):

| Worker | What it does | Config |
|---|---|---|
| `scada.js` | Consumes SCADA fault events and opens incidents automatically | `EVENT_BUS_DRIVER`, `KAFKA_BROKERS` |
| `restoration.js` | POSTs a restoration command to the DMS when an incident is resolved | `DMS_RESTORATION_URL`, `DMS_API_TOKEN` |
| `notifier.js` | Sends email notices (crew responding, restored, planned outage) | SMTP vars below, `NOTIFY_FROM`, `NOTIFY_TEST_TO` |
| `plannedNotices.js` | Every minute, sends planned-outage advance/extension notices that are due | uses notifier |
| `scheduledReports.js` | Weekly regulatory report by email (default Monday 06:00) | `REPORT_CRON`, `REPORT_RECIPIENTS` |
| `simulator.js` | Fake crew GPS, alarms, calls | `SIMULATOR=off` disables it (current setting) |
| `dnp3.js` | DNP3-over-IP adapter stub (INT-003). Its own header says it is not a full implementation | |

**Data layer:** `infra/db.js` (migrations), `seed.js` (Ganga Corridor demo data, includes two planned outages),
`seedOms03.js` (OMS-03 scenario), `redis.js`. SQL migrations in `db/migrations`: immutable audit log, phone encryption
at rest (`ENCRYPTION_KEY`), sequence-based ID generation, network topology schema.

**Environment variables read by the backend:** `PORT`, `DATABASE_URL`, `REDIS_URL`, `EVENT_BUS_DRIVER`, `KAFKA_BROKERS`,
`KEYCLOAK_JWKS_URI`, `DMS_RESTORATION_URL`, `DMS_API_TOKEN`, `BREVO_SMTP_HOST/PORT/USER/KEY`, `NOTIFY_FROM`,
`NOTIFY_TEST_TO`, `OMS_PUBLIC_URL`, `REPORT_CRON`, `REPORT_RECIPIENTS`, `SIMULATOR`, `ENABLE_SCADA_SIMULATION`,
`MOMENTARY_MAX_MIN`, `CUSTOMERS_SERVED`, `ENCRYPTION_KEY`, `TILES_DIR`, `MAP_SERVER_URL`, `MAP_API_KEY`. The
backend reads `backend/.env` (git-ignored). The seed script does not load it: run it with `node --env-file=.env`.

## 6. Map services

| Piece | Source | How it reaches the app |
|---|---|---|
| Base map (vector) | In-house map server at `122.184.90.67`, file `india.mbtiles`, zoom 0-14 | Browser -> backend `/api/map/*` (login needed, allowlist) -> SSH tunnel `127.0.0.1:8095` -> map server. Tunnel: `npm run map:tunnel`; verify with `npm run map:check`. Needs `MAP_SSH_HOST`, `MAP_SSH_USER`, `MAP_API_KEY`, SSH key `~/.ssh/id_ed25519` |
| Region exports | map server | `/api/map/regions`, used for crew offline packs |
| Crew offline map tiles | `backend/tiles/` (WebP, not in git) | `/api/tiles/manifest`, `/api/tiles/:z/:x/:y` |
| Road graph / routing | `backend/tiles/` + `npm run roads:build` (OSM extract `uttarakhand-latest.osm.pbf`) | `/api/route`, plus on-phone routing |
| Haridwar network layers | `backend/src/infra/network.json` (1 MB: 15 substations, 30 power txr, 1,519 distribution txr, 1,555 switches, 249 RMUs, 1,080 fuses, 4,635 HT lines, 262 feeder lines). Probable raw source: `Haridwar__Data_11062025.mdb` | `/api/network` |
| Dehradun CIM topology | CIM RDF/XML file imported by `backend/src/infra/importCimNetwork.js` into Postgres `network.*` | `/api/network/topology`, `/api/network/section/:mrid` |
| Live layers | Postgres incidents, crews, GPS trail | REST + WebSocket |
| Optional fallback | OpenStreetMap, only with `VITE_BASEMAP_FALLBACK=osm` | Off by default |

Other map tools: `backend/map-test-server` (standalone map and tracking test server), `backend/tile-server`
(its own docker-compose for rendering tiles), `backend/scripts/fetch-tiles.mjs`.

## 7. External systems and integrations

| System | Direction | Status |
|---|---|---|
| SCADA / DMS fault events | in, via Kafka topic `scada.alarm.raised` | Consumer implemented; the real feed is a simulator unless Kafka is connected |
| DMS restoration | out, REST POST | Implemented, bearer token optional |
| Email (Brevo SMTP) | out | Notices go only to `NOTIFY_TEST_TO` (no customer contact data exists) |
| In-house map server | in, over SSH tunnel | Working (checked 13 Oct) |
| Expo EAS Build | build time | Account and project access needed (see the APK build notes) |
| Public outage status | out, unauthenticated | `/portal` and `/api/public/outage-status` |
| DNP3 outstation | in | Stub only |
| IVR | | Not integrated. The TCS screen handles trouble calls entered by operators |

## 8. Deployment and ops

- **Local:** `docker compose up -d postgres redis keycloak`, then `npm start` from the repo root (backend + web + PWA). Add `kafka`
  when `EVENT_BUS_DRIVER=kafka`.
- **Container:** `backend/Dockerfile` (multi-stage, Node 22, **build with the repo root as context**).
- **Kubernetes:** `helm-oms/` (backend and frontend Deployments, Services, HPAs). `kong-routes.yaml` and `kong-jwt.yaml`
  put Kong in front with rate limiting (300/min per credential), JWT check and TLS. `tls.crt`/`tls.key` are self-signed test certificates.
- **Load tests:** `loadtest-dashboard.js`, `loadtest-scada-kafka.js`, `loadtest-cross-source-correlation.js` (k6-style;
  results in `docs/P8_6_*`). Replication notes: `docs/REPLICATION.md`.
- **Tests:** `cd backend && npm test` runs the OMS-03 unit tests and self-tests (`selftest*.js`), which need a database.

## 9. Related documents

`docs/ARCHITECTURE.md`, `docs/OMS-01-DESIGN.md`, `docs/FAT_OMS-01_planned_outages.md`, `docs/FAT_OMS-02_*.md`,
`docs/OMS03_WORKLOAD_BALANCING.md`, `docs/MOBILE_TESTING.md`, `docs/MAP_CONNECT_README.md`,
`docs/MAP_SERVER_INTEGRATION.md`, `docs/AUDIT_RETENTION.md`, `docs/REPLICATION.md`, `docs/WCAG_AUDIT.md`, `LEGACY.md`.

## 10. Not verified when writing this

- Which services run in production versus only on dev PCs. This is the repo view, not a deployment inventory.
- `docs/ARCHITECTURE.md` still describes the original SQLite prototype in places. The code now uses Postgres.
- The mobile PWA, `server/` and `tile-server` were read only at the manifest level.
