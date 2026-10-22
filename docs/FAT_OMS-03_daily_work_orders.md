# FAT OMS-03 — Daily work orders (crew app)

One work order per crew per working day (`WO-YYYYMMDD-<crew>`, e.g. `WO-20261015-C003`). The crew lead **starts the day** (who is on the crew, start-of-day checks) and **ends the day** (why each unfinished job carries over, remarks, crew-lead sign-off). In between, the **Today** tab lists the day's jobs in working order with progress. Starting the day is a reminder, not a gate: jobs can be worked before it (emergency work is never blocked).

The working day is the date in `Asia/Kolkata` on the server (`WORK_ORDER_TZ` to change it) and the phone's own date in the app. A start or end of day made offline is sent later from **Pending sync**; the server accepts it for today and the 3 days before, never for a future day.

## Setup

- Backend and crew APK built from the branch with this change (the APK needs a new build: new screen).
- Crew login `crew03` (crew `C003`). Dashboard login `test.operator` only for step 14.
- Fresh seed optional: `cd backend; npm run seed -- --force` (**wipes the database it points at**; work orders go with the crews).

## Part 1 — Start the day

| # | Action | Expected |
|---|---|---|
| 1 | Sign in as crew03. Look at **Dashboard**. | An amber card **TODAY'S WORK ORDER — Day not started. Tap to start your day.** above the job counts. The bottom bar has a **Today** tab. |
| 2 | Tap the card (or **Today**). | "Today's work order", the date and `WO-<today>-C003`. Status **Not started**. "0 of N jobs done", a progress bar, "About … of work left". **TO DO** lists C003's open jobs numbered 1, 2, …: jobs under way (En Route / On Site / Work Started) first, then by priority (Critical, VIP, Urgent, Normal). |
| 3 | Tap **Start day**. | Crew list pre-filled with the crew lead (or the names used last time). Four checks: vehicle, tools, PPE, first-aid kit. **Start day** is greyed out. |
| 4 | Add a member, tick three checks only. | **Start day** still greyed out. |
| 5 | Tick the fourth check, type a note, tap **Start day**. | Back to the work order: status **In progress**, "Started hh:mm", "Crew: …". Dashboard card: "0 of N jobs done today". |

## Part 2 — Work the day

| # | Action | Expected |
|---|---|---|
| 6 | In **Today**, tap job 1. | The normal job screen opens. Run it to **Work Finished** (OMS-03 job workflow). |
| 7 | Back in **Today**. | The job moved to **DONE TODAY** with a green tick. "1 of N jobs done", the bar moved, time left went down. |

## Part 3 — End the day

| # | Action | Expected |
|---|---|---|
| 8 | Tap **End day**. | "1 of N jobs done today." Each open job is listed with reason chips: Not reached, Waiting for permit / shutdown, Material not available, Handed to next shift, Other. **Next: sign off** greyed out with "Pick a reason for …". |
| 9 | Pick a reason for each job (one **Other**: type a note). Add remarks. **Next: sign off**. | Crew-lead sign-off: name pre-filled, the box reads "I confirm this end-of-day report is correct and every crew member is accounted for." |
| 10 | Tick the box, **Sign off & end day**. | Status **Day ended**, "Ended hh:mm". An **End-of-day report** card: each carried-over job with its reason (and note), remarks, "Signed off by …". No Start / End day buttons. |

## Part 4 — No signal

Use a second crew (e.g. `crew04` / `C004`) or the next day.

| # | Action | Expected |
|---|---|---|
| 11 | Airplane mode **on**. **Start day** as in Part 1. | Notice "No signal: the start of day is saved on the phone and will be sent automatically." Status **In progress** with **Waiting to sync**. Dashboard: **Pending sync** lists "WO-… · Start of day". |
| 12 | Still offline: move a job to **En Route**, then **End day** (Part 3). | Status **Day ended**, **Waiting to sync**. Pending sync lists, in order: start of day, the status change, end of day. |
| 13 | Airplane mode **off**; wait up to 10 s. | Pending sync empties. **Waiting to sync** disappears; the work order still shows **Day ended**. No "not applied" notice. |
| 14 | test.operator: `GET /api/work-orders` (browser dev tools or curl with the dashboard token). | C004's day: `status: closed`, started/closed at the times the crew tapped (not the sync time), the carried-over jobs with reasons. |

## Part 5 — Rules

| # | Action | Expected |
|---|---|---|
| 15 | On a second phone signed in as the same crew, **Start day** again after Part 1. | Notice "…: start of day not applied: day already started". The screen shows the day as started (from the first phone). |
| 16 | Sign out and in as crew04. | crew04 sees its own work order, not C003's. |

## Automated evidence

- `cd backend; DATABASE_URL=<scratch db> PORT=4100 node src/selftest-workorders.js` (also in CI): validation, start/close replays, late, past and future dates, ownership (403s), the end-of-day snapshot, the control room list, audit rows, and that the app's checks, reasons and payloads (`src/lib/workOrder.js`) are what the server accepts.
- `node backend/scripts/check-offline-queue.mjs`: a start / end of day made offline is sent in order behind job updates, stays queued while signed out, and an applied:false or refused one is dropped with the reason.
