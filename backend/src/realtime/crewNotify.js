// Tells the crew what the control room is told about it. The crew app has no
// push channel: it reads its jobs' incident message threads every few seconds
// and raises a phone notification for each new message that it did not send
// itself (src/lib/alerts.js). So a notice for the crew is a message from
// "Control room" on the incident its job belongs to; the dashboard's incident
// drawer shows the same thread, so dispatch sees what the crew was told.
import { bus, TOPICS } from '../domain/bus.js';
import { repo } from '../infra/repo.js';
import { isActive } from '../domain/rebalance.js';

const SENDER = 'Control room';
const ROLE = 'system';

// One message on one incident's thread.
export async function notifyCrew(incidentId, body) {
  if (!incidentId || !body) return null;
  try {
    const msg = await repo.addMessage(incidentId, SENDER, ROLE, body);
    bus.publish(TOPICS.MESSAGE_POSTED, msg);
    return msg;
  } catch (err) {
    console.error('[crewNotify] could not post:', err.message);
    return null;
  }
}

// A notice about the crew itself (not one job): on the thread of each job
// it is working. A crew with no job has no thread to reach it on.
export async function notifyCrewJobs(crewId, body) {
  const jobs = (await repo.jobsForCrew(crewId)).filter((j) => j.incident_id && isActive(j));
  for (const incidentId of new Set(jobs.map((j) => j.incident_id))) await notifyCrew(incidentId, body);
}

// The dashboard's crew alerts (App.jsx toasts) that are about the crew's own
// phone also go to that phone.
export function startCrewNotifications() {
  bus.subscribe(TOPICS.CREW_TRACKING_CHANGED, async (p) => {
    if (!p?.crewId) return;
    if (p.alert) await notifyCrewJobs(p.crewId, `The control room sees your location tracking is OFF${p.reasonText ? ` (${p.reasonText})` : ''}. Turn it back on in the app.`);
    else if (p.state === 'on') await notifyCrewJobs(p.crewId, 'The control room is receiving your location again.');
  });
  bus.subscribe(TOPICS.CREW_LOCATION_STALE, async (p) => {
    if (!p?.crewId) return;
    if (p.stale) await notifyCrewJobs(p.crewId, `The control room has had no location from your phone for ${p.minutes} min. Check that Location is on and the app is open.`);
    else await notifyCrewJobs(p.crewId, 'The control room is receiving your location again.');
  });
}
