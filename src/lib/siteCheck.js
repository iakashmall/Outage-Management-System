// src/lib/siteCheck.js
// On Site and Work Started only from the site itself: within SITE_RADIUS_M of
// the job's location, by the phone's GPS. The server checks the same rule
// (backend/src/domain/geofence.js) on the position sent with the update.

export const SITE_RADIUS_M = 100;
export const SITE_STATUSES = ["On Site", "Work Started"];

const finite = (n) => typeof n === "number" && Number.isFinite(n);

export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// null when the crew may go ahead, else the message to show. A job with no
// known location is never blocked (there is nothing to measure against).
export function siteBlock(job, nextStatus, location) {
  if (!SITE_STATUSES.includes(nextStatus) || job?.planned) return null;
  const site = job?.coordinates;
  if (!finite(site?.lat) || !finite(site?.lon)) return null;
  if (!finite(location?.lat) || !finite(location?.lon)) {
    return `Can't confirm you are at the site: no GPS position. Turn on Location and try again outdoors.`;
  }
  const d = Math.round(distanceM(location, site));
  if (d <= SITE_RADIUS_M) return null;
  const away = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${d} m`;
  return `You are ${away} from the site. ${nextStatus} is allowed only within ${SITE_RADIUS_M} m of the incident. Go to the site first (use Navigate).`;
}
