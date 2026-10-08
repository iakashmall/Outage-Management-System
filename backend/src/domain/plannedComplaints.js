// OMS-01: a customer complaint that arrives while a planned outage has the
// supply off on purpose. Pure decision, no DB: routes/api.js ingestComplaint
// loads the active planned outages at the complaint's substation and asks.
//
//   attach  the complaint is explained by the planned outage: link it there
//           instead of opening a fault incident (no crew is dispatched for
//           planned work).
//   note    a planned outage is active at this substation but on a different
//           feeder: open the fault incident as usual, with a timeline note.
//   none    nothing to do with planned work.
//
// Only supply symptoms can be explained by a planned outage. 'Wire Down' is
// a safety hazard, and 'Meter' / 'Other' are not supply symptoms: those
// always open their own incident.

export const PLANNED_SUPPLY_CATEGORIES = ['No Supply', 'Partial Supply', 'Voltage'];
export const ACTIVE_PLANNED_STATES = ['notified', 'isolating', 'in_progress', 'restoring'];
// Against the CURRENT window (a control-room delay moves window_end).
export const GRACE_BEFORE_MIN = 30;
export const GRACE_AFTER_MIN = 60;

const ms = (d) => new Date(d).getTime();

// complaint: { category, feeder, substation, now? }
// outages:   [{ incident_id, status, window_start, window_end, feeder, substation }]
export function plannedComplaintDecision(complaint, outages = []) {
  const { category, feeder, substation } = complaint || {};
  const now = complaint?.now ?? Date.now();
  if (!substation || !PLANNED_SUPPLY_CATEGORIES.includes(category)) return { action: 'none' };
  const inWindow = (o) => now >= ms(o.window_start) - GRACE_BEFORE_MIN * 60000 && now <= ms(o.window_end) + GRACE_AFTER_MIN * 60000;
  const active = outages.filter((o) => o.substation === substation && ACTIVE_PLANNED_STATES.includes(o.status) && inWindow(o));
  if (!active.length) return { action: 'none' };
  // Feeder decides when both sides know it; an outage without a recorded
  // feeder (or a complaint whose feeder could not be resolved) is matched on
  // the substation. Prefer an exact feeder match.
  const sameFeeder = feeder ? active.find((o) => o.feeder === feeder) : null;
  const substationWide = active.find((o) => !o.feeder || !feeder);
  const match = sameFeeder || substationWide;
  if (match) return { action: 'attach', outage: match };
  return { action: 'note', outage: active[0] };
}
