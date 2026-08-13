// Incident state machine — FR-OMS-006 / SDP §2.3 OMS Lifecycle State Machine.
// Open → Dispatched → In-Progress → Pending Verification → Resolved → Closed
// with Cancelled and Scheduled branches.
export const TRANSITIONS = {
  scheduled:   ['open', 'cancelled'],
  open:        ['dispatched', 'cancelled'],
  dispatched:  ['in_progress', 'open', 'cancelled'],
  in_progress: ['pending', 'cancelled'],
  pending:     ['resolved', 'in_progress'],   // FR-OMS-010: needs restoration confirmation
  resolved:    ['closed'],
  closed:      [],
  cancelled:   [],
};

export const LABELS = {
  scheduled: 'Scheduled', open: 'Open', dispatched: 'Dispatched',
  in_progress: 'In Progress', pending: 'Pending Verification',
  resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled',
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function nextStates(from) {
  return TRANSITIONS[from] || [];
}
