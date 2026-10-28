# GridQ OMS — Architecture

Outage Management System and Mobile Crew App for UPCL, built to `OMS_SRS_v1.0` / `OMS_SDP_v1.0`.
This document describes how the system is put together **as it runs today** and how data moves through it.

Related documents: `SERVICES.md` (running the stack), `SMS_ESCALATION.md`, `UPTIME.md`, `REPLICATION.md`,
`MAP_SERVER_INTEGRATION.md`, `OMS05_topology_limits.md`, `FEEDER_KPI.md`, `WCAG_AUDIT.md`.

---

## 1. The big picture

```
 SOURCES                          CORE                                  CONSUMERS
 ───────                          ────                                  ─────────
 SCADA field devices ─┐                                            ┌─▶ Control-room web app (React)
   (DNP3 / Kafka /    │      ┌──────────────────────────────┐      │     REST + live socket.io push
    simulator)        ├────▶ │   Backend  (Node / Express)  │ ─────┤
 Trouble calls (TCS) ─┤      │   routes ▸ domain ▸ repo     │      ├─▶ Crew mobile app (Expo / React Native)
 Customer complaints ─┤      │        │                     │      │     REST + offline queue
 Crew mobile app ─────┤      │        ▼  event bus (Kafka)  │      ├─▶ Customers: SMS / email (Hindi + English)
 Operators (web) ─────┘      │   workers: notifier, SLA     │      ├─▶ Feeder managers / officers: SMS
                             │   escalation, SCADA, KPI …   │      ├─▶ DMS: restoration commands
                             └──────────────┬───────────────┘      └─▶ Public outage portal (no login)
                                            │
     PostgreSQL + PostGIS + TimescaleDB · Redis (live tag cache) · Keycloak (login) · Map server (via proxy)
```

| Component | Tech | Local port |
|---|---|---|
| Control-room web app | React 18 + Vite (`frontend/`) | 15173 |
| Backend API + WebSocket | Node.js, Express, socket.io (`backend/`) | 14000 |
| Crew mobile app | Expo / React Native (repo root: `app.json`, `src/`) | 5174 (web build) |
| Database | PostgreSQL + PostGIS + TimescaleDB (container `oms-postgres`) | 15432 |
| Event bus | Kafka (container `oms-kafka`) or in-memory | 19092 |
| Cache | Redis (container `oms-redis`) | — |
| Identity | Keycloak, realm `oms-upcl` (container `oms-keycloak`) | 18080 |
| Map server | In-house vector-tile server, reached through an SSH tunnel (`npm run map:tunnel`) | 8095 |

---

## 2. Inside the backend

One Node process (`backend/src/index.js`) with four layers and a set of background workers:

```
                 ┌──────────────────────── backend (one Node process) ─────────────────────────┐
 HTTP request ─▶ │ 1. Gate        CORS, JSON body, Keycloak JWT check (requireAuth/requireRole) │
                 │ 2. Routes      routes/*.js: read params, call domain, call repo, reply      │
                 │ 3. Domain      domain/*.js: pure rules, no database or network              │
                 │ 4. Repo        infra/repo.js: the only SQL ─▶ PostgreSQL / TimescaleDB      │
                 │        │                                                                    │
                 │        └─▶ bus.publish('oms.incident.updated', …)   (Kafka or in-memory)    │
                 │                   │                                                         │
                 │   Workers (realtime/*.js) subscribe ◀─┘   + timers                          │
                 │   notifier · escalation · feederManagers · restoration · scada ·            │
                 │   feederKpi · uptime · socket.io bridge ─▶ browsers                         │
                 └─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Startup (`index.js`)

1. Connect to PostgreSQL; `infra/db.js` creates missing tables (`CREATE TABLE IF NOT EXISTS …`).
2. Connect Redis; initialise the event bus (`initBus()` — Kafka, falling back to memory if Kafka is unreachable).
3. Mount routes: `/api/health*` and `/api/public/*` (no login), `/portal` (static public page),
   `/api/*` behind `requireAuth`. `/api/map/*` is a proxy to the map server.
4. Start socket.io and the workers (SCADA consumer, notifier, escalation, feeder-manager alerts,
   uptime monitor, scheduled reports, simulator unless `SIMULATOR=off`).

### 2.2 Layers

| Layer | Files | Responsibility |
|---|---|---|
| Gate | `routes/auth.js` | `requireAuth` verifies the Keycloak **JWT** (RS256) against Keycloak's public keys from the **JWKS** endpoint (`KEYCLOAK_JWKS_URI`, via `jwks-rsa` + `jsonwebtoken`). Roles come from the token; `requireRole(...)` returns 403 for the wrong role, 401 for no/invalid token. |
| Routes | `routes/api.js`, `dispatch.js`, `plannedOutages.js`, `feederKpi.js`, `mapProxy.js`, `mapRegions.js` | HTTP surface: parse input, call domain + repo, publish events, reply JSON/CSV/PDF. |
| Domain | `domain/*.js` | **Pure functions, no I/O**: incident state machine (`lifecycle.js`), SLA (`sla.js`), IEEE 1366 indices (`indices.js`), reports (`standardReports.js`, `reportBuilder.js`), topology (`networkGraph.js`, `topology.js`, `supplyTrace.js`, `switchingPlan.js`), uptime maths (`uptime.js`) … Unit-tested with `node --test`, no database needed. |
| Repository | `infra/repo.js` | **The only module that writes SQL** (pg-promise). Multi-step writes run in a transaction (`db.tx`), e.g. update `incidents` + insert `incident_events` (audit trail) together. |
| Persistence | `infra/db.js`, `infra/redis.js` | Postgres pool + schema; Redis client (latest SCADA tag values). |

### 2.3 A write request, step by step

Example: dispatcher marks an incident Restored.

| Step | Where | What happens |
|---|---|---|
| Gate | `auth.js` | Token verified; user + roles attached to `req.user`; role checked. |
| Route | `routes/api.js` | Reads `:id` and body, loads the incident via repo. |
| Domain | `lifecycle.js` etc. | Is this transition allowed? SLA state, durations. |
| Repo | `repo.js` | Transaction: update incident + append `incident_events` row (who / what / when). |
| Publish | `bus.publish` | `oms.incident.updated` with the incident. |
| Reply | route | JSON back to the browser **immediately** — SMS, email etc. happen afterwards in workers. |

Reads (analytics, reports) take the same path without the publish: route → domain calculation → repo query → JSON / CSV / PDF.

---

## 3. Event bus (`domain/bus.js`)

### 3.1 Purpose

The bus is the backend's announcement system (**publish / subscribe**). Code that changes something
announces it once; every interested module reacts on its own. The publisher does not know who listens
and does not wait. A new reaction (e.g. feeder-manager SMS) is added without touching any route.

### 3.2 API

| Function | Meaning |
|---|---|
| `publish(topic, payload)` | Announce an event. Returns immediately; errors are logged, never thrown, so the bus cannot break a user's request. |
| `subscribe(topic, handler)` | Run `handler(payload)` for each event on `topic`. Returns an unsubscribe function. |
| `onAny(handler)` | Receive every topic — used by the socket.io bridge. |
| `init()` / `close()` | Connect at boot / disconnect at shutdown. |

### 3.3 Topics (`TOPICS`)

| Area | Topics |
|---|---|
| Incidents | `oms.incident.created`, `oms.incident.updated`, `oms.incident.ert_changed` |
| SCADA | `scada.alarm.raised`, `scada.alarm.acked`, `scada.analog.feeder` (high-rate, **not** broadcast to browsers) |
| Trouble calls | `tcs.call.received`, `tcs.call.updated` |
| Crews | `crew.updated`, `crew.job.updated`, `crew.tracking.changed`, `crew.location.stale` |
| Planned outages | `oms.planned.updated`, `oms.planned.notice`, `oms.permit.changed`, `oms.switching.confirmed` / `rejected`, `oms.planned.crew_report` |
| Other | `oms.message.posted`, `oms.indices.updated`, `oms.dispatch.rebalance`, `oms.sms.logged` |

### 3.4 Two drivers, one interface (`EVENT_BUS_DRIVER`)

**Memory** (default) — Node `EventEmitter`. No dependencies; good for a laptop. Events are lost on
restart and only this process hears them.

**Kafka** (production) — `kafkajs` against `KAFKA_BROKERS`:

- `init` creates missing topics plus a `<topic>.dlq` dead-letter topic for each, and joins consumer group
  `oms-backend` (`KAFKA_GROUP_ID`; a second process such as a self-test needs its own group).
- Publish = `producer.send()` with the JSON payload; Kafka stores it durably.
- Consume (`eachBatch`):
  - invalid JSON → straight to `.dlq`;
  - `scada.analog.feeder` → whole batch dispatched once (one bulk insert);
  - everything else → **in order, one at a time**, waiting for *all* subscribers (`Promise.all`);
  - the offset is committed **only after** handlers finish → a crash re-delivers, nothing is lost;
  - a slow database slows consumption (Kafka holds the backlog) instead of filling memory;
  - a failing message is retried up to `KAFKA_MAX_ATTEMPTS` (default 5), then parked in `.dlq`.
- If Kafka is unreachable at boot, `initBus()` swaps the same `bus` object to the memory driver.

---

## 4. Workers (`backend/src/realtime/`)

| Worker | Trigger | Does |
|---|---|---|
| `scada.js` | `scada.alarm.raised` (from `dnp3.js`, a Kafka gateway, or `simulator.js`) | Stores the alarm; a feeder trip **opens an incident** with predicted downstream transformers/customers; a reclose within 5 min closes it as *momentary*; live values → Redis, history → TimescaleDB; links tripped equipment by mRID. |
| `notifier.js` | incident created / updated / ERT changed, planned notices | Finds affected customers; SMS + email in **Hindi then English**; restoration callbacks; every message logged in `notifications`. |
| `feederManagers.js` | incident created / restored | One SMS per incident to the feeder's manager (deduplicated via `notifications`; `FEEDER_MANAGER_ALERTS=off` disables). |
| `escalation.js` | timer, every 60 s | SLA breach → SMS to **AE**; ≥ 60 min over → **SE**; ≥ 120 min over → **CE**. Once per level per incident; numbers from `ESCALATION_SMS_TO`; missing number recorded as `skipped-no-contact`. |
| `restoration.js` | `oms.incident.updated` | Sends a restoration command to the DMS (HTTP POST), audited so it is never sent twice. |
| `feederKpi.js` | `scada.analog.feeder` | Feeder power-quality KPIs (voltage / current events, sag, stress, imbalance). |
| `plannedNotices.js` | timers | Advance and start/end notices for planned outages. |
| `staleLocation.js` | timer | Flags crews whose GPS has gone stale. |
| `scheduledReports.js` | timer | Emails scheduled reports. |
| `uptime.js` | timer, every 30 s | `deepHealth()` → sample in `uptime_checks`; alert after 2 consecutive critical failures (see `UPTIME.md`). |
| `simulator.js`, `feederTelemetrySim.js` | timers | Fake crew GPS, alarms, calls and feeder readings for development. **`SIMULATOR=off` disables them.** |
| socket.io bridge (`index.js`) | `bus.onAny` | `io.emit(topic, payload)` to every browser (except `NOT_BROADCAST` topics). |

---

## 5. Edges to the outside world (seams / adapters)

Each external system is reached through **one module**; the rest of the app only calls that module.
Swapping a provider changes one file, and a failure is contained at the edge.

```
   routes / domain / workers
            │  call only the adapter
            ▼
   sms.js ───────────────▶ SMS gateway (console driver today)
   notifier mailer ──────▶ Brevo SMTP (email)
   mapProxy.js ──────────▶ map server (SSH tunnel locally)
   bus.js ───────────────▶ Kafka / in-memory
   auth.js (JWKS) ───────▶ Keycloak
   db.js / repo.js ──────▶ PostgreSQL + PostGIS + TimescaleDB
   redis.js ─────────────▶ Redis
   dnp3.js / scada.js ◀─── SCADA field devices
   restoration.js ───────▶ DMS
```

| Edge | Module | Notes |
|---|---|---|
| **SMS** | `realtime/sms.js` `sendSmsVia({to, body, label})` | Every SMS (customer, callback, officer, escalation, feeder manager, uptime) goes through it. `SMS_DRIVER` picks the driver; only `console` exists (prints with masked number, status `logged`). Never throws. Going live = one new driver (Brevo / MSG91 / Twilio) + Indian **DLT** sender and template registration. |
| **Email** | `notifier.js` (Brevo SMTP) | `BREVO_SMTP_HOST`, `BREVO_SMTP_PORT` (587), `BREVO_SMTP_USER`, `BREVO_SMTP_KEY`. |
| **Map** | `routes/mapProxy.js`, `mapRegions.js` | Browsers and crews only call `/api/map/*` (behind login); the backend forwards to `MAP_SERVER_URL`. Allow-list of paths (style, sprites, fonts, tiles, info, export); path tricks rejected (`safeSegment`); query strings never forwarded; `MAP_API_KEY` never leaves the backend; exports limited by role (crews: their region only). |
| **Event bus** | `domain/bus.js` | Section 3. |
| **Login** | `routes/auth.js` + Keycloak | Backend only verifies tokens; passwords and TOTP stay in Keycloak. Another OIDC provider = new JWKS URL + role mapping. |
| **Storage** | `infra/db.js`, `repo.js`, `redis.js` | All SQL in `repo.js`. Redis is non-critical: without it the app is slower, not down. Replication / failover: `REPLICATION.md`. |
| **SCADA in** | `realtime/dnp3.js`, `scada.js` | DNP3 over TCP (link layer only — real hardware needs opendnp3 or a front-end processor) or a Kafka gateway, turned into `scada.alarm.raised`. The simulator emits the same events. |
| **DMS out** | `realtime/restoration.js` | HTTP POST restore command. |

Why: providers are swappable, failures are isolated (a dead SMS gateway cannot stop incident handling),
every edge has a local stand-in so the whole system runs on a laptop, and secrets stay on the backend.

---

## 6. Data flow

### 6.1 In

| Source | Entry | Becomes |
|---|---|---|
| SCADA | Kafka `scada.*` / DNP3 / simulator → `scada.js` | Alarm; feeder trip → incident automatically |
| Trouble calls (TCS / IVR) | `POST /calls` | Call, grouped by substation; operator raises an incident or rejects with a reason |
| Complaints | `POST /complaints` | Merged with related complaints, traced to an incident |
| Operators | web app → REST | Incidents, status changes, crew assignment, planned outages, messages |
| Crews | mobile app → REST (offline queue, syncs on reconnect) | Job status (Acknowledged → En Route → On Site → Work Complete), GPS, photos, QR asset scans, checklists, messages |

### 6.2 Out

- **Control room** — each screen loads by REST; socket.io events trigger `useLiveRefresh` to reload.
- **Crews** — the app fetches its jobs; dispatch decisions arrive as job updates.
- **Customers / managers / officers** — SMS seam + Brevo email; all logged in `notifications` (Analytics ▸ SMS log).
- **Map** — browser → `/api/map/*` → map server.
- **Reports** — computed from the same tables on demand; CSV / PDF export; scheduled email.
- **Public** — `/api/public/outage-status` and `/portal`, no login.

### 6.3 One incident, end to end

1. Breaker trips → `scada.alarm.raised` → alarm stored, **incident opened** (SLA deadline set).
2. `oms.incident.created` published → at once: web screens update (Dashboard, Map, Incidents);
   customers get bilingual SMS/email; feeder manager gets an SMS; the SLA clock runs.
3. Dispatcher assigns the nearest crew → job → crew app. En Route / On Site / Work Complete each land
   on the incident timeline; GPS moves the crew on the map; photos and checklists attach to the incident.
4. If the SLA is breached first, escalation texts AE → SE → CE.
5. Crew finishes, dispatcher verifies → resolved → `oms.incident.updated` → "power restored" to customers,
   restoration SMS to the manager, callbacks to callers, restoration command to the DMS.
6. The incident now counts in SAIDI / SAIFI / CAIDI / MAIFI (cancelled incidents excluded), the standard
   reports, the report builder, MTTR and SLA compliance.

---

## 7. Frontend notes

- **Screens** (`frontend/src/screens/`): Dashboard, Network Map, Incidents, Alarms, TCS, Complaints,
  Dispatch, Dispatch Workload, Work Orders, Planned Outages, Analytics, Admin.
- **Live updates**: socket.io client; `useLiveRefresh` reloads a screen when a relevant topic arrives.
- **Analytics audience views** (Management / CE-SE / Functional-AE): a display filter, not access control.
  Management hides Feeder and Crew performance; CE-SE and Functional-AE currently show the same tabs.
- **Languages**: English + Hindi (`lib/i18n.js`, `lib/locales.js`, `lib/locales/*.js`); choice stored in
  `localStorage` `gridq.lang` and sets `<html lang>`. Customer SMS/email are bilingual on the backend.
- **Accessibility**: WCAG 2.1 AA work in `WCAG_AUDIT.md` (each table / map is one Tab stop, Enter to go in).

---

## 8. Operations

- **Health**: `/api/health` and `/api/health/ready` (probes); `/api/health/deep` (all dependencies,
  503 when a critical one is down — point an external monitor here). Admin ▸ System uptime shows the
  99.9 % report (`UPTIME.md`).
- **Run locally**: Docker containers for Postgres, Kafka, Redis, Keycloak (`docker start …`, never
  recreate `oms-postgres` — its data is in the container); then `npm run dev:backend`, `npm run dev:web`,
  `npm run map:tunnel`. Details in `SERVICES.md`.
- **Tests**: domain unit tests via `node --test`. The backend `npm test` self-tests **wipe the database
  they point at** — run them only against a scratch database (e.g. `oms_selftest`).
- **Deploy**: `docker-compose.deploy.yml`, Helm chart in `helm-oms/`, Kong config (`kong-*.yaml`).

---

## 9. Known gaps

- SMS is console-only until a provider driver and DLT registration exist.
- DNP3 adapter is link-layer only.
- Escalation chain is AE → SE → CE (no EE step).
- IVR notifications and traffic-based ETA are represented but not wired to real providers.
- Topology tracing limits for the imported network: `OMS05_topology_limits.md`.
- Uptime target can only be proven on the real servers with an external monitor (`UPTIME.md`).
