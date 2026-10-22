# SMS gateway and SLA escalation (FR-OMS-021 / FR-OMS-008)

Analytics → **SMS & Escalation** used to be a mock-up: the escalation tracker
and SMS log were hard-coded sample rows and "Send" only showed a browser
`alert()`. It is now backed by real data end to end. Messages are **recorded,
not delivered**, because no SMS provider is connected yet (see "Going live").

## What it does

| Part | Behaviour |
|---|---|
| Compose SMS | Operator sends to a lineman / officer: recipient, phone (10+ digits), optional feeder and incident, message 3–500 chars. Saved to `notifications`; if linked to an incident it also appears on that incident's timeline. |
| SMS log | Every SMS the OMS has recorded, newest first, tagged by kind: `CUSTOMER` (outage notices), `CALLBACK` (restoration callbacks), `OFFICER` (composed), `ESCALATION` (automatic). Phone numbers are stored masked (`******3210`). |
| Escalation tracker | Every active incident with an SLA clock: time open, SLA, breach, current escalation level and status (`Within SLA`, `Due`, `Escalated`). Refreshes every 60 s and on incident / SMS events. |
| Auto-escalation | Every 60 s the backend escalates active incidents past their `sla_due_at`, one SMS per level, never repeated (see below). |

### Escalation ladder

| Time past SLA | Level | SMS to |
|---|---|---|
| > 0 min | Lineman → AE | AE |
| ≥ 60 min | AE → SE | SE |
| ≥ 120 min | SE → CE | CE |

Only the level reached at scan time is sent: an incident first scanned at
+130 min gets one SMS to CE, not three. Each level is claimed in
`notifications` with `contact_ref = 'ESC-<level>'` through the existing
`(incident_id, contact_ref)` unique index, so a restart, a retry or a second
backend instance can never send the same level twice. Each escalation also
writes an incident timeline event, e.g.
`SLA breached by 6 min - escalated to AE (no number configured)`.

### SLA by severity

`backend/src/domain/sla.js` is the single source, used by manual incidents
(`POST /incidents`) and SCADA auto-detected incidents (`realtime/scada.js`):

| Severity | SLA |
|---|---|
| critical | 90 min |
| high | 180 min |
| medium (default) | 360 min |
| low | 720 min |

SCADA incidents previously opened with **no** SLA clock and so were never
escalated. On startup, still-active SCADA incidents without one are
backfilled to `opened_at + SLA` (`infra/db.js`). Trouble-call and complaint
incidents keep their existing fixed 180 min.

## Code map

| File | Role |
|---|---|
| `backend/src/realtime/sms.js` | The only place an SMS leaves the system. `sendSmsVia({ to, body, label })` picks a driver from `SMS_DRIVER`; never throws. |
| `backend/src/realtime/escalation.js` | `levelFor`, `listEscalations` (tracker), `scanEscalations` (sender), `startEscalations` (60 s loop). |
| `backend/src/domain/sla.js` | Severity → SLA minutes, `slaDueAt()`. |
| `backend/src/routes/api.js` | `GET /api/sms`, `POST /api/sms` (`oms_operator`, `system_admin`), `GET /api/escalations`. |
| `backend/src/realtime/notifier.js` | Customer SMS now routed through `sms.js`. |
| `backend/src/infra/db.js` | `notifications.feeder`, `.kind`, `.sent_by` columns; SCADA SLA backfill. |
| `backend/src/infra/repo.js` | Restoration-callback queries exclude `kind = 'escalation'` rows (they share `contact_ref`). |
| `backend/src/domain/bus.js` | `SMS_LOGGED` topic (`oms.sms.logged`), broadcast to the dashboard for live refresh. |
| `frontend/src/screens/Analytics.jsx` | The tab, now on `api.smsLog()`, `api.sendSms()`, `api.escalations()`. |

### SMS status values

| Status | Meaning |
|---|---|
| `logged` | Recorded; the `console` driver printed it (no provider configured). |
| `sent` | Accepted by a real provider driver. |
| `failed` | Provider error; detail in `notifications.error` (shown as a tooltip). |
| `skipped-no-contact` | Escalation level has no number in `ESCALATION_SMS_TO`. |
| `skipped-optout` | Customer opted out of SMS. |

## Configuration

```
SMS_DRIVER=console
ESCALATION_SMS_TO=AE=+919800000001,SE=+919800000002,CE=+919800000003
```

Both are listed in `.env.example`. Without `ESCALATION_SMS_TO` escalation still
runs and is recorded as `skipped-no-contact`, so the tracker still shows it.

## Going live (not done)

1. Pick a provider (Brevo SMS, Twilio, MSG91, …) and add one entry to
   `DRIVERS` in `sms.js` that returns `{ status: 'sent' }` or throws.
   Callers and the database don't change.
2. Indian **DLT registration** (sender ID + message templates) is mandatory
   for business SMS; message bodies must match registered templates.
3. Set `SMS_DRIVER` and `ESCALATION_SMS_TO` in the deployment environment.
4. Officer numbers are a flat env list today; a per-zone/circle directory
   is a follow-up if escalation must reach the officer for that area.

## How to test

1. Restart the backend; its log shows
   `[escalation] SLA scan every 60s · N officer number(s) configured`.
2. Create a **critical** incident, then force its SLA into the past:
   ```
   docker exec oms-postgres psql -U oms -d oms -c "UPDATE incidents SET sla_due_at = now() - interval '5 min' WHERE id = 'INC-…'"
   ```
   Within a minute: tracker shows `+5 min`, `Lineman → AE`, `Escalated`;
   the log has an `ESCALATION` row; the incident timeline has the
   escalation event. Repeat with `'65 min'` to see the SE level.
3. **+ Compose SMS** with a phone and incident → toast "logged (no SMS
   gateway configured)", new `OFFICER` row at the top, timeline entry on
   the incident. A 5-digit phone or unknown incident is rejected with a
   clear message.
4. Two browser windows on the tab: sending from one updates the other.

Verified in development: 12 API checks (validation, role guard, once-per-level
escalation, masking, timeline entry) passed against a test server, and a real
escalation fired on the running backend. `selftest.js` on an isolated database:
107/109, the same two DMS-restoration failures as on the code before this
change (they collide with a backend already running on port 14000).
