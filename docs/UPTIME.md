# Availability monitoring (P8.6g, 99.9% uptime)

The SRS asks for 99.9% availability. That is about **43 minutes of downtime a
month** (8 h 46 min a year). It can only be shown by measuring a real
deployment over weeks; this document describes what is built in the app and
what to add on the UPCL (DCC) servers.

## What the app does (built)

| Piece | Where | What it does |
|---|---|---|
| Deep health check | `GET /api/health/deep` (no login) | Checks the API, PostgreSQL, Keycloak, Kafka (critical) and Redis, map server (non-critical) with a 3 s timeout each. Returns `up`, `degraded` (a non-critical one failed) or `down` (a critical one failed, **HTTP 503**), with per-service response times. No secrets in the output. |
| Recorder | `backend/src/realtime/uptime.js` | Stores one sample every `UPTIME_INTERVAL_S` seconds (default 30) in `uptime_checks`; keeps 400 days. |
| Alerts | same | After 2 failed checks in a row of a critical service: an SMS to each number in `UPTIME_ALERT_TO` (through the SMS gateway seam, console-only until a provider is set), a warning in the log and an audit-log entry. One more message when it recovers. |
| Uptime maths | `backend/src/domain/uptime.js` (+ unit tests) | Uptime % = up samples / expected samples. A **missing** sample (server or recorder not running) counts as **down**, so a crash is not invisible. Outage periods = runs of `down` samples, plus gaps longer than two intervals. |
| Report | `GET /api/uptime`, Admin -> **System uptime** | Live status of each service; uptime for 24 h / 7 d / 30 d against 99.9% with the minutes the target allows; per-service uptime; the outage log with cause. |

Environment variables (backend `.env`):

```
UPTIME_INTERVAL_S=30                       # sample interval, minimum 10
UPTIME_ALERT_TO=+91XXXXXXXXXX,+91YYYYYYYYYY  # on-call numbers (optional)
UPTIME_MONITOR=off                         # disable the recorder (tests, dev)
```

## Why an external monitor is still needed

A monitor inside the server cannot report its own crash: the recorder shows
the gap afterwards, but nobody is alerted while the whole server is down. On
the real servers, add one monitor that runs **somewhere else** and polls
`https://<oms-host>/api/health/deep` every 30-60 s, alerting on a non-200
reply or no reply:

- **Uptime Kuma** (one container, web UI, SMS/email/Telegram alerts) is the
  simplest. Add an HTTP monitor with "accepted status codes: 200".
- or **Prometheus blackbox_exporter + Alertmanager** if Prometheus/Grafana is
  being set up anyway (P7.7).

Use the external monitor's monthly report as the formal 99.9% evidence, and
the in-app report (which names the failing service) to explain each outage.

## Agree with UPCL before measuring

1. **What counts as down:** proposed = any critical service failing (API,
   database, login, event bus). Redis and the map server only degrade the
   system.
2. **Planned maintenance:** excluded from the target or not? If excluded,
   maintenance windows must be announced in advance and logged.
3. **Measurement period:** calendar month is usual.

## Supporting evidence already in place

- Database replication / failover tested within the 15-minute RTO (P8.2,
  `docs/REPLICATION.md`).
- Nightly database backup.
- Container restart policies in `docker-compose.deploy.yml`.

## Still to do (needs real servers and time)

- Deploy on the DCC servers, add the external monitor, set `UPTIME_ALERT_TO`.
- Run for at least one full month; report uptime per month to UPCL.
