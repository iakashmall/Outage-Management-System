# WCAG 2.1 AA manual test script (P8.7a)

The automated pass is done: axe-core reports 0 WCAG 2.1 A/AA violations on
all 15 views (see `WCAG_AUDIT.md`, round 3). Automated tools catch roughly
30-40% of real problems. This script covers the rest: what a keyboard user,
a screen-reader user and a low-vision user actually experience.

Run it once end to end, fill in the **Result** column (Pass / Fail +
note), and attach screenshots for every Fail. Expect about **2-3 hours**
for all four parts.

## Setup

- Windows, Chrome or Edge, app at `http://localhost:15173`, a real
  `oms_operator` login (password + OTP).
- [NVDA](https://www.nvaccess.org/download/) (free) for part B. Key
  commands: **Insert** is the NVDA key; **Ctrl** stops speech;
  **Insert+F7** lists links/headings/form fields; **H** / **Shift+H** next /
  previous heading; **D** next landmark; **F** next form field; **Tab** next
  focusable control. Turn on *Speech viewer* (NVDA menu → Tools) so you can
  read and screenshot what was spoken.
- Before each part: reload the page, and **put the mouse aside**. If you
  need the mouse to continue, that step is a Fail.

How to mark a step:

| Mark | When |
|---|---|
| Pass | Worked with the stated input only, and you could always see where focus was |
| Fail | Could not do it, focus was lost / invisible / trapped, or something was announced wrongly or not at all |
| N/A | Step doesn't apply (e.g. no crews available) - say why |

---

## Part A - Keyboard only: full incident lifecycle

WCAG: 2.1.1 Keyboard, 2.1.2 No keyboard trap, 2.4.3 Focus order, 2.4.7
Focus visible, 3.2.1/3.2.2 no unexpected context change.

| # | Do (keyboard only) | Expected | Result |
|---|---|---|---|
| A1 | Log in: Tab through username, password, Sign in; then the OTP field | Every field reachable, focus always visible, Enter submits | |
| A2 | Press **Tab** from the top of the app | First stop is in the left navigation rail; a visible outline on each nav button | |
| A3 | Tab to **Incidents**, press **Enter** | Incidents screen opens; focus stays sensible (not thrown to the bottom of the page) | |
| A4 | Tab to **New incident**, **Enter** | Drawer opens, focus on its **Close (X)** | |
| A5 | Fill the form: zone, severity, type, feeder, customers, cause. Use arrow keys in selects | Every field reachable in a logical top-to-bottom order; Tab wraps inside the drawer, never to the page behind | |
| A6 | Tab to **Create incident**, **Enter** | Incident is created, a toast appears, drawer closes, focus returns to **New incident** | |
| A7 | Use the search box to find the new incident (type its ID), then Tab to it in the list and press **Enter** | Incident detail drawer opens | |
| A8 | In the drawer, Tab through everything | Status buttons, ETA field, **Update ETA**, crew buttons, message box, photos - all reachable, focus visible, nothing skipped | |
| A9 | Under **Assign crew - nearest first**, Tab to a crew button, **Enter** | Crew assigned, status moves to dispatched, toast announces it | |
| A10 | Change status with the status buttons (e.g. In progress → Resolved / Accept - verified restored) | Each change works with Enter / Space; the timeline updates | |
| A11 | Type a message in **Message the crew** and send with Enter | Message posted | |
| A12 | Close the drawer with **Esc** | Drawer closes; focus returns to the incident row you opened | |
| A13 | **Dispatch** screen: use **Select nearest crew to assign** on any open incident (arrow keys + Enter) | Selection works without a mouse | |
| A14 | **TCS / IVR**: on a call, open **Reject**, type a reason, submit; then open another and press **Esc** | Drawer works fully by keyboard; Esc closes and returns focus | |
| A15 | **Analytics**: switch tabs; in **Feeder PQ KPIs** change View / Period / Phase; in **SMS & Escalation** use **+ Compose SMS** and Tab into the scrollable tables, scroll them with arrow keys | All controls reachable; tables scroll with arrows once focused | |
| A16 | Throughout: was there **any** moment the focus outline disappeared or you didn't know where you were? | No | |

---

## Part B - NVDA screen reader

WCAG: 1.1.1 Non-text content, 1.3.1 Info and relationships, 2.4.2 Page
titled, 2.4.6 Headings and labels, 3.3.1/3.3.2 errors and labels, 4.1.2
Name, role, value, 4.1.3 Status messages.

Start NVDA, open the app, keep **Speech viewer** open.

| # | Do | Expected announcement | Result |
|---|---|---|---|
| B1 | Load the app | Page title is read (not just "localhost") | |
| B2 | **D** (landmarks) | "Primary navigation" landmark, then the main content | |
| B3 | **Tab** through the nav rail | Each button read by name, current screen announced as current ("Incidents, current page" or similar) | |
| B4 | **H** on Dashboard, Incidents, Analytics | Headings exist and describe the sections; nothing important is only visual | |
| B5 | Dashboard: Tab into the **Active incidents table** region, then use **Ctrl+Alt+arrows** in the table | Region named; table headers read with each cell (ID, Severity, Zone…) | |
| B6 | Severity / status badges in any table | Read as words ("critical", "open"), not just colour | |
| B7 | Open **New incident** | "New incident, dialog" announced; each field read with its label | |
| B8 | Submit **New incident** with a required field empty | The error is announced without moving focus by hand | |
| B9 | Create an incident / assign a crew | The toast ("Crew assigned", errors) is **spoken automatically** | |
| B10 | Open an incident row | "Incident INC-… details, dialog" announced | |
| B11 | Photo thumbnail (incident with a photo) | "Open photo: Taken by … at …, button"; in the viewer the image is described | |
| B12 | **Analytics → SMS & Escalation → + Compose SMS** | Each field read with its label ("Phone, required, edit"); sending announces the result | |
| B13 | **Feeder PQ KPIs** toggles | Read as buttons with pressed state ("Daily, toggle button, pressed") | |
| B14 | Charts (KPI trend lines, reliability rings) | Values are available as text somewhere (labels, legend, or a table); a chart that is only a picture is a Fail | |
| B15 | **About** (SpinTech logo, bottom of rail) | "About GridQ, dialog"; content readable; Esc returns to the logo | |
| B16 | Live updates: wait for a new alarm / call / incident while on another screen | Is anything announced? Note what. (Silent live updates may be acceptable for a control room with sound alarms - record what happens) | |

---

## Part C - Network Map

WCAG: 1.4.1 Use of colour, 1.4.11 Non-text contrast, 2.1.1 Keyboard,
2.5.x pointer alternatives.

| # | Do | Expected | Result |
|---|---|---|---|
| C1 | Tab into the map | The map area receives visible focus | |
| C2 | Arrow keys | Map pans | |
| C3 | **+** / **-** keys, and Tab to the **zoom buttons** (top right) + Enter | Map zooms both ways | |
| C4 | Layer panel: Tab to each layer checkbox, toggle with **Space** | Layers switch; NVDA reads each checkbox name and state | |
| C5 | Reach an incident / crew / asset marker **without the mouse** | Possible, and its details panel opens (if impossible: Fail, note which marker types) | |
| C6 | Details panel: **Trace electrical section** and the panel's **Close** | Both work by keyboard; NVDA reads the panel content | |
| C7 | Colour only? Look at incident markers, crew symbols, feeder lines | Severity / crew status is also shown by **shape, icon or label**, not by colour alone (the legend shows shapes for crews - check incidents and feeders too) | |
| C8 | Markers against the base map | Markers and lines are distinguishable from the map (≥ 3:1 visually; use a contrast checker on a screenshot if unsure) | |
| C9 | With the map focused, does Tab still get **out** of it to the rest of the page? | Yes - no keyboard trap | |

---

## Part D - Zoom, reflow and text spacing

WCAG: 1.4.4 Resize text, 1.4.10 Reflow, 1.4.12 Text spacing, 1.3.4
Orientation.

| # | Do | Expected | Result |
|---|---|---|---|
| D1 | Browser zoom **200%** (Ctrl +), visit every screen | Nothing cut off or overlapping; all functions still usable | |
| D2 | Zoom **400%** (or a 1280 px window at 400% ≈ 320 px wide) on Dashboard, Incidents, New incident drawer | Content reflows to one column without **horizontal** scrolling, except data tables and the map (allowed) | |
| D3 | Text spacing: run the [text spacing bookmarklet](https://www.html5accessibility.com/tests/tsbookmarklet.html) on Dashboard, Incidents, Analytics | No text is clipped or overlaps | |
| D4 | Windows **High contrast / Contrast themes** on | Focus outlines, buttons and badges still visible | |

---

## Recording the outcome

1. Fill in every **Result** cell, date the run and name the tester.
2. For each Fail: screenshot, screen, step, what happened. Raise it as an
   issue or hand it back for fixing.
3. Add a **"Round 4 - manual walkthrough"** section to `WCAG_AUDIT.md` with
   the counts (Pass / Fail / N/A per part) and the open Fails.
4. P8.7a can be marked **Done** when parts A-D have no unresolved Fails
   (or the remaining ones are accepted and documented as known
   limitations). An external audit / SOC 2 track is P8.7b.

| Run | Date | Tester | A (16) | B (16) | C (9) | D (4) | Open Fails |
|---|---|---|---|---|---|---|---|
| 1 | | | /16 | /16 | /9 | /4 | |
