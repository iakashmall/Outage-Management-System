# OMS Platform — Architecture

Reference implementation of the Outage Management System and Mobile Crew App described in
`OMS_SRS_v1.0` and `OMS_SDP_v1.0`, scoped to the UPCL Ganga Corridor (Dehradun / Haridwar / Rishikesh).

The build is deliberately **runnable today with zero infrastructure** while keeping the exact seams
where the production stack from the SDP (PostgreSQL/PostGIS, Kafka, TimescaleDB, Keycloak, Kong, K8s)
drops in. Nothing about the domain logic changes when those are swapped in — only the adapters.

## Components

```
                    ┌──────────────────────────────┐
   Control room ───▶│  frontend/  (React + Vite)    │  :5173
                    │  8 screens, live WebSocket tape│
                    └───────────────┬────────────────┘
                                    │  REST + socket.io
                    ┌───────────────▼────────────────┐
   Field crews  ───▶│  backend/   (Node + Express)   │  :4000
                    │  domain ▸ repo ▸ event bus     │
                    │  SCADA simulator (live feed)   │
                    └───────────────┬────────────────┘
                                    │  same REST API
                    ┌───────────────▼────────────────┐
                    │  mobile/    (React PWA)         │  :5174
                    │  offline queue, GPS, job flow  │
                    └────────────────────────────────┘
```

## Layers in the backend

| Layer   | File(s)             | Responsibility                  | Swap seam |
|---      |---                  |---                               |---|
| Routes | `src/routes/api.js` | HTTP surface, request validation | Kong/API-gateway sits in front unchanged |
| Domain | `src/domain/lifecycle.js`, `indices.js` | State machine, IEEE 1366 math — **pure, no I/O** | Never changes across deployments |
| Events | `src/domain/bus.js` | Publish/subscribe topics | Replace EventEmitter with KafkaJS producer/consumer |
| Repository | `src/infra/repo.js` | **Only** module that speaks SQL | Replace body with Prisma/pg against PostgreSQL |
| Persistence | `src/infra/db.js` | SQLite bootstrap + schema | Becomes migrations against PostgreSQL/PostGIS + TimescaleDB |
| Realtime | `src/realtime/simulator.js` | Synthetic SCADA/DMS feed | Replace with Kafka consumer of real `scada.*` topics |

### Why these seams hold

- **The domain layer imports nothing from infra.** `lifecycle.js` and `indices.js` are pure functions.
  Moving from SQLite to Postgres cannot break the state machine because the state machine never sees a database.
- **`repo.js` is the single SQL chokepoint.** Every route calls `repo.*`, never raw SQL. Re-implementing
  `repo.js` against `pg`/Prisma is the entire database migration — no route or domain file is touched.
- **The bus already speaks in Kafka topic names** (`oms.incident.created`, `scada.alarm.raised`, …).
  `bus.publish(topic, payload)` maps 1:1 onto a Kafka producer send; subscribers map onto consumer groups.

## Upgrade path to the SDP production stack

1. **PostgreSQL + PostGIS** — swap `db.js`/`repo.js` for a `pg` pool + SQL migrations. Incident/crew geometry
   becomes real `geography` columns; the GIS map query becomes a `ST_DWithin` bounding-box lookup.
2. **Kafka** — replace `bus.js` internals with KafkaJS. Topics are already named. The SCADA simulator is
   deleted and a real consumer of `scada.*` takes its place; ingestion dedup (FR-OMS-003) becomes a
   windowed stream operation.
3. **TimescaleDB** — telemetry/alarm history lands in a hypertable; reliability indices query continuous aggregates.
4. **Keycloak + Kong** — the Admin RBAC roles map onto Keycloak realm roles; Kong enforces JWT at the edge.
   The frontend gains an OIDC login; the mobile app's crew picker becomes real biometric + token auth (FR-APP-001/002).
5. **Kubernetes** — each of backend/frontend/mobile is already an independent deployable; add Dockerfiles + Helm.

A `docker-compose.yml` at the repo root sketches the Postgres/Kafka topology for local parity.

## SRS compliance — what is implemented here

| Requirement | Where |
|---|---|
| FR-OMS-002 manual outage creation (mandatory fields) | Incidents screen ▸ New incident; `POST /incidents` validates zone + severity |
| FR-OMS-004 severity classification | `severity` on ingest; SCADA sim raises critical/major/minor |
| FR-OMS-005 customer-reported outages | TCS screen ▸ "Raise incident"; `POST /calls/:id/to-incident` |
| FR-OMS-006 incident state machine | `domain/lifecycle.js` — Open→Dispatched→In-Progress→Pending Verification→Resolved→Closed (+Cancelled) |
| FR-OMS-007 every transition logged | `incident_events` + `audit_log`; visible in Incident drawer timeline + Admin audit |
| FR-OMS-011/012 crew assignment + availability | Dispatch console; `POST /incidents/:id/assign` |
| FR-OMS-016–020 GIS map | Network map screen — georeferenced SVG, severity markers, live crew, layer toggles |
| FR-OMS-026/027 dashboards + SAIDI/SAIFI/CAIDI | Analytics screen; `domain/indices.js` (IEEE 1366) |
| FR-APP-001/003 crew login + roles | Mobile crew picker |
| FR-APP-005/007/008 job list + status flow + GPS | Mobile job detail — Acknowledged→…→Work Complete, GPS attached per update |
| FR-APP-010/011/012 offline operation | Mobile localStorage queue, connectivity indicator, pending-sync count, auto-drain on reconnect |

## Known scope boundaries (honest gaps)

- **No CIM/RDF network-model import.** Feeders/zones are seeded, not parsed from an IEC 61970 model. The
  repository seam is where a CIM loader would populate assets.
- **No load-flow / topology tracing.** Severity and customer counts are attributes, not derived from a
  connectivity model (that's the SDP's Python + NetworkX/OpenDSS service, not built here).
- **Notifications (FR-OMS-021–025), SLA escalation (FR-OMS-008), and traffic-based ETA (FR-OMS-013)** are
  represented in the UI/state but not wired to real SMS/IVR/traffic providers.
- **Auth is a role picker,** not Keycloak/biometric. The RBAC model and audit trail are real; the identity
  provider is the swap.
