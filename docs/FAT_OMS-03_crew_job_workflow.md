# FAT OMS-03 — Crew job workflow (fault jobs)

Covers the crew job life cycle on a fault incident: Acknowledged → En Route → On Site → Work Started → Work Complete, the field completion report, undo (Reopen), the lock, return for correction, late or offline updates, and crew ownership. Planned-outage jobs keep their OMS-01 permit flow (Part 7 checks they are untouched).

The server decides every status. Both the crew app and the dashboard show the server's state. An update that is not applied (late, backward, or the job is locked) is answered `applied:false`, and the dispatcher sees it on the incident timeline as "late update from crew not applied: …".

## Setup

- Backend, dashboard and the crew APK built from `master` after PR C. The APK must be built from the repo root (`npx expo prebuild --clean`, then the usual EAS/Gradle build).
- For the demo, shorten the undo window: `JOB_UNDO_WINDOW_MIN=2` in `backend/.env`, then restart the backend. The default is 10 minutes.
- Fresh seed if you want a clean list: `cd backend; npm run seed -- --force`. **This wipes the database it points at.**

| Login | Roles | Used for |
|---|---|---|
| `test.operator` | `oms_operator` | Every dashboard step (browser, **Incidents** screen). |
| `crew03` | `field_crew`, crew `C003` | Crew steps on phone A. |
| `crew04` | `field_crew`, crew `C004` | Ownership check on phone B (or phone A after signing out). |

`test.operator` cannot do the crew steps: the crew routes need a crew login with a crew id.

## Part 1 — Normal job, completion report

| # | Who | Action | Expected |
|---|---|---|---|
| 1 | test.operator | **Incidents** → **New incident**: zone `Mayapur`, severity `high`, **Create**. | Toast "Incident created". The drawer opens on the new incident, status **Open**. |
| 2 | test.operator | In the drawer, **Assign crew** → the **C003** button. | Toast "Crew assigned". Status **Dispatched**. |
| 3 | crew03 (phone A) | Open **Jobs** (the list refreshes by itself within 30 s). Open the new job. Complete the priority checklist. | Job status **Acknowledged**. The **En Route →** button shows. |
| 4 | crew03 | Tap **En Route →**, then **On Site →**. | The status changes each time. On the dashboard (no reload) the timeline shows "Status: En Route", then "Status: On Site", and the incident becomes **In Progress**. |
| 5 | crew03 | **Open camera** → take a site photo. Tap **Work Started →** → pass the safety checklist. | "Photo 1 of 25 stored". Status **Work Started**. |
| 6 | crew03 | Tap **Work Finished →**: fault diagnosis → parts used → **Supply restored? Yes** → crew-lead sign-off. | The summary reads **"Submitted, awaiting verification"** (not "Job closed out"), with cause, parts, "Supply restored: Yes" and the sign-off. A **Reopen job (undo, until hh:mm)** button shows. |
| 7 | test.operator | Look at the incident drawer. | Status **Pending Verification**. Header badge **"Crew can undo until hh:mm"**. A **Field completion report** panel shows the job: diagnosis, parts, supply restored **Yes**, signed off by, submitted time. The timeline shows "Field completion report submitted …" and "Work complete - awaiting verification". |

## Part 2 — Undo inside the window

| # | Who | Action | Expected |
|---|---|---|---|
| 8 | crew03 | Within the window, tap **Reopen job (undo …)**. | "Job reopened…". Status **Work Started**. The **Work Finished →** button is back. |
| 9 | test.operator | Drawer (no reload). | Incident **In Progress**. Timeline: "Crew reopened job … (undo of Work Complete)". The undo badge is gone. |
| 10 | crew03 | Finish again (step 6). | "Submitted, awaiting verification" again. Dashboard: **Pending Verification**. The report notes "2 forms (job was reopened)". |

## Part 3 — Lock after the window

| # | Who | Action | Expected |
|---|---|---|---|
| 11 | both | Wait until the undo time has passed (2 minutes with the demo setting). | Dashboard badge switches to **Locked** by itself (no reload). |
| 12 | crew03 | Wait up to 30 s for the job list to refresh, open the job. | Summary **"Submitted, awaiting verification (locked)"** plus the control-room note. No Reopen button. **Open camera** and **Scan QR asset tag** are greyed out. No status button. |
| 13 | crew03 | Before step 11, switch phone A to **airplane mode**, take one photo (it goes to **Pending sync**). After the lock, switch airplane mode off and wait for the sync (up to 30 s). | A notice: "… photo not applied: job locked". The item leaves Pending sync (no endless retry). |
| 14 | test.operator | Drawer → photos. | The late photo shows with a **Late** chip; its tooltip says "Not applied - job locked". Timeline: "late update from crew not applied: job locked (… photo (kept …))". |

## Part 4 — Return for correction

| # | Who | Action | Expected |
|---|---|---|---|
| 15 | test.operator | Pending Verification incident → **Return for correction**. Leave the reason empty. | **Return to crew** stays disabled. "Deny - send crew back" is not shown for this incident. |
| 16 | test.operator | Type `Photo of the replaced fuse missing` → **Return to crew**. | Toast "… returned to the crew for correction". Incident **In Progress**. The job in the report shows **Requires Revisit**, not locked. Timeline: "Returned for correction (job …): Photo of the replaced fuse missing". |
| 17 | crew03 | Wait up to 30 s, open the job. | Status **Requires Revisit**. The **En Route →** button shows again; camera and QR scan are enabled. Finish the job again (steps 4–6). |

## Part 5 — Offline and late updates

| # | Who | Action | Expected |
|---|---|---|---|
| 18 | test.operator | New incident, assign **C003** (as in steps 1–2). | — |
| 19 | crew03 | Airplane mode **on**. Open the job: **En Route →**, **On Site →**, take a photo. | Each change shows on the phone at once. **Pending sync** lists the items in order. |
| 20 | test.operator | While the phone is offline: drawer → **Assign crew → C003** again (touches the job). | — |
| 21 | crew03 | Airplane mode **off**; wait for the sync. | Pending sync empties. Dashboard timeline: "Status: En Route", "Status: On Site" **at the times the crew tapped them** (not the sync time). The dispatcher's touch did **not** swallow them. No "not applied" notice. |
| 22 | crew03 | Leave Pending sync alone; the app resends nothing that is already on the server. | No duplicate timeline entries. |

## Part 6 — Ownership (crew sees only its own work)

| # | Who | Action | Expected |
|---|---|---|---|
| 23 | crew04 (phone B) | Sign in, open **Jobs**. | Only C004's jobs. None of C003's jobs from this test appear. |
| 24 | crew04 | Open **Map** (new map). | Crews and open incidents still show (the crew map reads `GET /crews` and `GET /incidents`, which stay open to crews). |

## Part 7 — Planned-outage jobs untouched

| # | Who | Action | Expected |
|---|---|---|---|
| 25 | crew03 | Open a planned-outage job (OMS-01 FAT, `docs/FAT_OMS-01_planned_outages.md`) and run it to Work Finished with the permit. | Same as OMS-01: permit gates apply. **No** "Supply restored?" choice and **no** Reopen button. The job is never shown as locked. |
| 26 | test.operator | That planned incident's drawer. | No **Return for correction** button. Its own planned-outage text and buttons are unchanged. |

## Part 8 — Who may create incidents

| # | Who | Action | Expected |
|---|---|---|---|
| 27 | test.operator | **Incidents** screen. | **New incident** button visible. |
| 28 | a login without `oms_operator`/`system_admin` (e.g. a call-centre attendant) | **Incidents** screen. | No **New incident** button. The API also refuses `POST /incidents` with 403. |

## Automated evidence

`cd backend; DATABASE_URL=<scratch db> PORT=4100 node src/selftest-jobs.js`, also run in CI. It covers the app's exact status sequence, duplicate/out-of-order/late replays, the dispatcher-touched case, ownership (403s), the completion form (idempotent), undo inside and after the window and after the dispatcher resolved, every locked write, return for correction, the `POST /incidents` role guard, planned jobs untouched, and the crew app's own rules (`src/lib/jobFlow.js`: planned jobs never send the completion form or offer Reopen).
