// What the public outage-status page (/api/public/outage-status, no login)
// shows. Pure: index.js passes the incidents and the planned outages in.
//
// Fault incidents: exactly the fields the page always had. A planned outage
// (OMS-01) additionally says it is planned, in plain words, with its window,
// and is hidden once cancelled (it never interrupted anyone).

const PLANNED_LABEL = {
  scheduled: 'Planned shutdown - scheduled',
  notified: 'Planned shutdown - customers notified',
  isolating: 'Planned shutdown - supply being switched off',
  in_progress: 'Planned shutdown - work in progress',
  restoring: 'Planned shutdown - supply being restored',
};
const DONE = ['resolved', 'restored', 'closed'];

// plannedByIncident: Map incident_id -> planned outage row (window_start, window_end)
export function publicOutages(incidents, plannedByIncident = new Map(), { ref, zone } = {}) {
  let list = incidents.filter((i) => !DONE.includes((i.status || '').toLowerCase()));
  list = list.filter((i) => !(plannedByIncident.has(i.id) && i.status === 'cancelled'));
  if (ref) list = list.filter((i) => i.id.toLowerCase() === String(ref).toLowerCase());
  else if (zone) list = list.filter((i) => (i.zone || '').toLowerCase().includes(String(zone).toLowerCase()));
  return list.map((i) => {
    const base = { ref: i.id, zone: i.zone, status: i.status, customersAffected: i.customers, estimatedRestoration: i.ert, since: i.opened_at };
    const po = plannedByIncident.get(i.id);
    if (!po) return base;
    return { ...base, planned: true, statusLabel: PLANNED_LABEL[i.status] || 'Planned shutdown', plannedStart: po.window_start, plannedEnd: po.window_end };
  });
}
