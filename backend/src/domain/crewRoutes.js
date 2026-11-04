// Live road routes from each crew to its assigned incident, for the dashboard
// Network Map (GET /api/crew-routes).
//
// Wraps the shared road router (roadRouter.js). That file is also bundled
// into the crew app, so nothing here changes it:
//  - crew.updated fires on every GPS tick, so a crew's route is recomputed
//    only once the crew has moved MOVE_THRESHOLD_M from where it was last
//    routed (or its job, the incident position or the road graph changed);
//    every tick in between is served from the cache
//  - the polyline is simplified (Ramer–Douglas–Peucker) before it is returned
//  - "no route" is reported as a state, never as an error

export const MOVE_THRESHOLD_M = 75;
export const SIMPLIFY_TOLERANCE_M = 4;
// Same as roadRouter's "already there" and the crew app's ARRIVED_M.
const AT_SITE_M = 30;
const DONE_INCIDENT = ['resolved', 'closed', 'cancelled'];

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;

// Distance in metres (equirectangular, as in roadRouter.js).
export function meters(a, b) {
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) * Math.PI) / 360) * M_PER_DEG_LON_EQ;
  const y = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.sqrt(x * x + y * y);
}

// Ramer–Douglas–Peucker on [[lat, lon], ...] with the tolerance in metres.
// Points are projected onto a local metric plane around the first point;
// iterative, so a long route cannot overflow the stack.
export function simplifyPath(coords, toleranceM = SIMPLIFY_TOLERANCE_M) {
  if (!Array.isArray(coords) || coords.length <= 2) return coords || [];
  const kx = Math.cos((coords[0][0] * Math.PI) / 180) * M_PER_DEG_LON_EQ;
  const x = coords.map((p) => p[1] * kx);
  const y = coords.map((p) => p[0] * M_PER_DEG_LAT);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const dx = x[b] - x[a], dy = y[b] - y[a];
    const len2 = dx * dx + dy * dy;
    let worst = -1, worstD = toleranceM;
    for (let i = a + 1; i < b; i++) {
      // distance from point i to segment a-b
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x[i] - x[a]) * dx + (y[i] - y[a]) * dy) / len2)) : 0;
      const d = Math.hypot(x[i] - (x[a] + t * dx), y[i] - (y[a] + t * dy));
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

const point = (o) => {
  const lat = o?.lat == null ? NaN : Number(o.lat), lon = o?.lon == null ? NaN : Number(o.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
};

// getRouter() returns the current road router, or null when the road graph
// has not been generated. A new router instance (graph regenerated) drops
// every cached route.
export function createCrewRoutes({ getRouter, thresholdM = MOVE_THRESHOLD_M, now = () => new Date() }) {
  const cache = new Map(); // crew id -> { incidentId, from, to, router, result }
  const stats = { computes: 0 };

  function routeFor(router, from, to) {
    stats.computes++;
    // Tell "too far from any road" apart from "no path between the roads":
    // roadRouter.route() returns null for both.
    if (!router.snap(from.lat, from.lon)) return { state: 'off_network' };
    if (!router.snap(to.lat, to.lon)) return { state: 'incident_off_network' };
    const r = router.route(from, to);
    if (!r || !Array.isArray(r.coords) || r.coords.length < 2) return { state: 'no_route' };
    return { state: 'ok', meters: r.meters, seconds: r.seconds, coords: simplifyPath(r.coords) };
  }

  // One entry per crew that has an assigned (open) incident. A job with no
  // crew has nothing to draw and is simply not listed.
  function compute(crews, incidents) {
    const byId = new Map(incidents.map((i) => [i.id, i]));
    const router = getRouter();
    const out = [];
    const live = new Set();
    for (const c of crews) {
      const inc = c.job_id ? byId.get(c.job_id) : null;
      if (!inc || DONE_INCIDENT.includes(inc.status)) continue;
      live.add(c.id);
      const base = { crewId: c.id, incidentId: inc.id };
      const from = point(c), to = point(inc);
      if (!from) { out.push({ ...base, state: 'no_position' }); continue; }
      if (!to) { out.push({ ...base, state: 'no_incident_location' }); continue; }
      const direct = meters(from, to);
      if (direct < AT_SITE_M) {
        cache.delete(c.id);
        out.push({ ...base, state: 'at_site', meters: Math.round(direct), seconds: 0, coords: [], computedAt: now().toISOString() });
        continue;
      }
      if (!router) { out.push({ ...base, state: 'no_graph' }); continue; }

      const hit = cache.get(c.id);
      const fresh = hit && hit.router === router && hit.incidentId === inc.id
        && meters(hit.to, to) < 1 && meters(hit.from, from) < thresholdM;
      if (fresh) { out.push(hit.result); continue; }
      const result = { ...base, ...routeFor(router, from, to), computedAt: now().toISOString() };
      cache.set(c.id, { incidentId: inc.id, from, to, router, result });
      out.push(result);
    }
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    return out;
  }

  return { compute, stats };
}
