// A crew may only mark a fault job On Site / Work Started from the site
// itself. The phone checks first (src/lib/siteCheck.js, same radius); this is
// the server's check, on the position the phone sent with the update.

export const SITE_STATUSES = ['On Site', 'Work Started'];

export const siteRadiusM = () => {
  const m = Number(process.env.SITE_RADIUS_M);
  return Number.isFinite(m) && m > 0 ? m : 100;
};

const finite = (n) => n !== null && n !== '' && Number.isFinite(Number(n));

export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// null when the update may go ahead, else { code, message, distance }.
// A site with no known position is never blocked (nothing to measure against).
export function siteCheck({ status, site, lat, lon, radius = siteRadiusM() }) {
  if (!SITE_STATUSES.includes(status)) return null;
  if (!site || !finite(site.lat) || !finite(site.lon)) return null;
  if (!finite(lat) || !finite(lon)) {
    return { code: 'NO_LOCATION', message: `${status} needs the phone's GPS position to confirm the crew is at the site` };
  }
  const distance = Math.round(distanceM({ lat: Number(lat), lon: Number(lon) }, { lat: Number(site.lat), lon: Number(site.lon) }));
  if (distance <= radius) return null;
  return { code: 'NOT_ON_SITE', distance, message: `the crew is ${distance} m from the site; ${status} is allowed within ${radius} m` };
}
