# FAT OMS-01 — Planned outages

Covers the FAT test sentence:

*"Create an outage schedule request; verify notifications, work permit generation, switching plan creation, status tracking through completion, and customer notification."*

Expected: *"Outage scheduling, notifications, permits, switching plans, status tracking, and work order features function correctly end-to-end."*

The requirement wording also names partial/complete de-energisation, priority management, crew delay/restoration updates, crew preliminary info and work-order closure. Each has a step below.

## Setup

| What | How | Why |
|---|---|---|
| Crew role and crew logins | `cd backend; npm run keycloak:mobile` (once per Keycloak) | `field_crew` is **not** a realm role in `infra/keycloak-realm.json`; this script creates it and the logins `crew01`–`crew06` (crew `C001`–`C006`). See `docs/MOBILE_TESTING.md`. |
| Demo data | `cd backend; npm run seed -- --force` (wipes and reseeds the `oms` database) | Seeds two planned outages through the planned-outage model: Gurukul (**Scheduled**, approved plan, in +2 days) and Kankhal-2 (**Customers notified**, in +1 day). |
| Notice recipient | Set `NOTIFY_TEST_TO` in the backend environment to a mailbox you can read | Every notice (advance, extended, cancelled, restored) goes to this single address. No customer contact data exists, so this demonstrates the mechanism, not delivery to real customers. Recipients are masked in the stored rows and the console (`f*******@example.com`). |
| Network model (optional) | `db/migrations/network_topology_schema.sql`, then `node src/infra/importCimNetwork.js <cim-file.xml>` | Only needed to demo **Draft from network trace**. Without it that button answers `NETWORK_UNAVAILABLE` and the plan is built by hand, as in this script. |
| Start | backend `npm run dev`, frontend `npm run dev`, Kafka or memory bus | |

**Who does what**

| Login | Role | Steps |
|---|---|---|
| `test.operator` | `oms_operator` | All control-room steps (browser, **Planned outages** screen). |
| `crew03` | `field_crew`, crew `C003` | Crew steps, in the crew app on a phone. `test.operator` **cannot** do them: crew routes need a crew login. |
| `crew05` | `field_crew`, crew `C005` | Negative check only (another crew's step). |

The crew-app steps (marked **phone**) need the crew app on a device. Without one, the same steps can be sent to the crew API with a crew token. The API call is given in each row.

## Part 1 — Schedule, plan, notify

| # | Login | Action | Expected |
|---|---|---|---|
| 1 | operator | Open **Planned outages**. | The list shows the two seeded outages: Gurukul *Scheduled*, Kankhal-2 *Customers notified*. |
| 2 | operator | Click **New**. Zone `FAT Laljiwala`, Substation **Laljiwala**, Feeder **LW-A**, Customers `850`, Supply off from = tomorrow 15:00, Supply back by = tomorrow 19:00, Work `Replace DT-22 HT bushings`, notice hours `24`, Priority **high**, De-energisation **Complete**. Click **Schedule outage**. | Toast "Planned outage INC-… scheduled". The detail shows status **Scheduled**, Priority high, De-energisation complete, Where "Laljiwala · feeder LW-A", Customer complaints 0, Customer notice "due …". |
| 3 | operator | Repeat step 2 with Supply off from = yesterday. | Refused with a red toast (`BAD_INPUT`): the window must start now or later and last at most 72 hours. |
| 4 | operator | (Priority management) Create a second outage at **Laljiwala** whose window overlaps the first. | It is created, and a yellow **Overlaps another planned outage** box links to the first one. It warns but does not block. Cancel this second outage (**Cancel outage…**, give a reason). |
| 5 | operator | On the first outage, **Switching plan** tab: **+ isolate step** → OPEN `CB LW-A` at `Laljiwala 33/11 kV`, **Control room**. **+ isolate step** → EARTH APPLY `DT-22` at `work site`, **Crew** C003. **+ restore step** → EARTH REMOVE `DT-22`, Crew C003. **+ restore step** → CLOSE `CB LW-A`, Control room. **Save plan**. | Toast "Plan saved". Four steps in order, two per phase. |
| 6 | operator | **Approve plan** → OK. | Toast "Plan approved". The plan is read-only and shows "Approved by test.operator". |
| 7 | operator | **Send notice now**. | Toast "Customers notified". Status **Customers notified**. Customer notice "sent …". The `NOTIFY_TEST_TO` mailbox gets "Planned power shutdown in FAT Laljiwala": "Complete shutdown in FAT Laljiwala from … to … for Replace DT-22 HT bushings (approx. 850 customers)…". |
| 8 | operator | **Crew**: choose `C003` → **Assign**. | Toast "Crew C003 assigned (Urgent)". Priority high maps to job priority Urgent. **Crew jobs** lists `JOB-…-C003`. |

## Part 2 — Isolate, permit, work

| # | Login | Action | Expected |
|---|---|---|---|
| 9 | operator | Isolate step 1 (OPEN CB LW-A): **Confirm done** → OK. | Toast "Step confirmed". Status **Isolating**. Step 1 is green with "✓ test.operator". |
| 10 | crew05 (phone) | Try to confirm isolate step 2 (C003's earth). API: `POST /api/mobile/switching-steps/<stepId>/confirm` | Refused: **403 WRONG_ASSIGNEE**. A red `step.confirm.rejected` row appears in the **Safety log**. |
| 11 | crew03 (phone) | Open the job → priority checklist → the planned-outage panel → confirm **EARTH APPLY DT-22**. API: same route as crew03. | Step 2 turns green on the control-room screen live (no reload), "✓ crew03". |
| 12 | crew03 (phone) | **Send site report** "On site: 4 men, area barricaded, earths applied both sides". API: `POST /api/mobile/jobs/<jobId>/planned-outage/report` `{kind:'site_report', note}` | Under **Crew reports**: "crew C003 · site report: On site…". Safety log `crew.site_report`. |
| 13 | crew03 (phone) | Tap **Work Started**. API: `PATCH /api/mobile/jobs/<jobId>/status {status:'Work Started'}` | Refused **409**: no permit has been issued yet. |
| 14 | crew03 (phone) | **Request work permit**. API: `POST /api/mobile/jobs/<jobId>/permit/request` | **Permits (1)** tab: `PTW-2026-…` *requested*, with **Points of isolation** and **Earths applied at** prefilled from the plan. |
| 15 | operator | **Permits** → **Issue permit** → OK. | Toast "Permit issued". Permit *issued* by test.operator. Status **In progress**. |
| 16 | crew03 (phone) | **Work Started**. | Accepted. Crew jobs shows `Work Started`. |

## Part 3 — Delay, restore, close

| # | Login | Action | Expected |
|---|---|---|---|
| 17 | crew03 (phone) | **Report delay**: expected end = window end + 90 min, note "Bushing flange seized, need 90 more minutes". API: `…/planned-outage/report` `{kind:'delay', note, expectedEnd}` | A red **DELAY REPORTED** box: "by crew C003 …: expects to finish by …". A long toast in the control room. **The window does not change and customers are not notified yet.** |
| 18 | operator | **Apply & notify…** | The form is prefilled with the crew's end time and note, both editable. |
| 19 | operator | **Apply & notify**. | Toast "Window extended; customers notified". Supply off shows the new end. The mailbox gets "Planned power shutdown in FAT Laljiwala extended": "…Supply is now expected by … (previously …). Reason: …". The report shows as *applied by test.operator*. |
| 20 | crew03 (phone) | **Work Finished** before returning the permit. | Refused **409**: return the permit first. |
| 21 | crew03 (phone) | Return the permit with the three declarations (men withdrawn, earths removed, tools clear). API: `POST /api/mobile/permits/<permitId>/return` | Permit *returned* by crew03. Status **Restoring**. |
| 22 | crew03 (phone) | **Work Finished**. Confirm restore step 1 (**EARTH REMOVE DT-22**). | Crew jobs shows `Work Complete` (green). Restore step 1 is green, "✓ crew03". |
| 23 | operator | Restore step 2 (CLOSE CB LW-A): **Confirm done** → OK. | Status **Resolved**. No DMS command is sent for a switching-plan restoration. The mailbox gets **one** notice, "Planned work complete in FAT Laljiwala". |
| 24 | operator | **Close work order**. | Toast "Work order closed". Status **Closed**. No second restoration notice. (If a crew job were still open: 409 `JOBS_OPEN`, and the operator may close anyway with a reason of at least 10 characters, which is recorded in the safety log.) |
| 25 | operator | **Safety log** tab. | One row per action from steps 2–24, each with actor and role, in time order, including the refused attempts (in red). |

## Part 4 — Everything else is unaffected

| # | Login | Action | Expected |
|---|---|---|---|
| 26 | operator | **Incidents** → **Planned outages** filter chip. | Only planned outages are listed, with badges such as "Customers notified" and "Isolating". Fault incidents are unchanged under the other chips. |
| 27 | operator | **Analytics**. | SAIDI/SAIFI/MAIFI are unplanned only. A line under them reports the planned outages separately: "SAIDI … min · SAIFI … · … customers in … planned outages". |
| 28 | operator | **TCS / IVR**. | Tabs and counts as before (FAT OMS-02 still passes). |
| 29 | operator | Browser console (F12). | No errors. |

## Complaints during a planned outage (F1)

Covered by `selftest-oms01.js` (the F1 checks). To show it by hand, send a complaint while step 15's outage is in progress, using `POST /api/complaints` (operator token):

- A **No Supply / Partial Supply / Voltage** complaint resolving to Laljiwala feeder LW-A, inside the window (−30 min / +60 min, following any applied delay), is **attached** to the planned outage. The response includes `plannedOutage: { incidentId, windowEnd, message }`, and **Customer complaints** goes up by 1. No fault incident is opened and no "crews are responding" email is sent.
- The same complaint on a **different feeder** of Laljiwala opens its own fault incident, with the timeline note "Planned outage INC-… is active at this substation on feeder LW-A".
- **Wire Down / Meter / Other** always open their own incident.
- If complaints keep arriving after the window end, the outage shows a red **Complaints are still arriving after the planned window ended** box.

## Permissions

- Control-room reads and writes (`/api/planned-outages/*`, `/api/permits/*`, `/api/switching-steps/*`): `oms_operator` or `system_admin`. A token with **only** `field_crew` gets 403.
- Crew routes (`/api/mobile/...`): `field_crew` with a `crew_id` claim, on that crew's own job only. Another crew gets 403 (`NOT_YOUR_JOB`, `WRONG_ASSIGNEE`). A crew token without a `crew_id` gets 403 `NO_CREW_ID`.

## Not verified here

- The crew-app steps (marked **phone**) have not been run on a device for this PR; they were driven through the crew API. The **Send site report** and **Report delay** buttons in the app (F5b) are untested on a phone.
- Notices go to one test address; real customer delivery needs customer-to-network data, which does not exist yet.
