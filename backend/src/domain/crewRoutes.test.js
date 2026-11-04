// node --test src/domain/crewRoutes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, GRAPH_FORMAT } from './roadRouter.js';
import { createCrewRoutes, simplifyPath, meters, MOVE_THRESHOLD_M } from './crewRoutes.js';

// A tiny "oms-roads-1" graph: a 2 km east-west road along lat 30.0 (the first
// edge has 9 collinear shape points) and, 11 km north, a separate road that
// no road connects to.
function delta(points) {
  const out = [];
  let a = 0, b = 0;
  for (const [lat, lon] of points) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    out.push(la - a, lo - b);
    a = la; b = lo;
  }
  return out;
}
const juncs = [[30, 78], [30, 78.01], [30, 78.02], [30.1, 78], [30.1, 78.01]];
const pts = Array.from({ length: 9 }, (_, i) => [30, 78 + (i + 1) * 0.001]);
const graph = {
  format: GRAPH_FORMAT,
  juncs: delta(juncs),
  pts: delta(pts),
  edges: [0, 1, 9, 36, 0, 1, 2, 0, 36, 0, 3, 4, 0, 36, 0],
};
const router = createRouter(graph);

// Counts real routing work (each call to roadRouter.route()).
function counted() {
  const r = { ...router, calls: 0 };
  r.route = (a, b) => { r.calls++; return router.route(a, b); };
  return r;
}
const incident = (lat, lon, extra = {}) => ({ id: 'INC-1', status: 'dispatched', lat, lon, ...extra });
const crew = (lat, lon, extra = {}) => ({ id: 'C1', job_id: 'INC-1', lat, lon, ...extra });
// A point `m` metres east of (lat, lon).
const east = (lat, lon, m) => lon + m / (Math.cos((lat * Math.PI) / 180) * 111320);

test('routes a crew parked mid-block to its incident along the road', () => {
  const routes = createCrewRoutes({ getRouter: () => router });
  // Crew 20 m north of the road, between junctions; incident near the east end.
  const [r] = routes.compute([crew(30.00018, 78.0042)], [incident(30.0001, 78.0185)]);
  assert.equal(r.state, 'ok');
  assert.equal(r.crewId, 'C1');
  assert.equal(r.incidentId, 'INC-1');
  // ~1.39 km along the road, plus the two short hops onto it
  assert.ok(r.meters > 1350 && r.meters < 1450, `meters ${r.meters}`);
  assert.ok(r.seconds > 100 && r.seconds < 250, `seconds ${r.seconds}`);
  // Starts at the crew and ends at the incident, not at a junction.
  assert.deepEqual(r.coords[0], [30.00018, 78.0042]);
  assert.deepEqual(r.coords.at(-1), [30.0001, 78.0185]);
  assert.ok(r.computedAt);
});

test('no route found: the roads at either end are not connected', () => {
  const routes = createCrewRoutes({ getRouter: () => router });
  const [r] = routes.compute([crew(30, 78.005)], [incident(30.1, 78.005)]);
  assert.equal(r.state, 'no_route');
  assert.equal(r.coords, undefined);
});

test('crew off the road network (more than 3 km from any road)', () => {
  const routes = createCrewRoutes({ getRouter: () => router });
  const [r] = routes.compute([crew(30.05, 78.05)], [incident(30, 78.005)]);
  assert.equal(r.state, 'off_network');
  const [r2] = routes.compute([crew(30, 78.005)], [incident(30.05, 78.05)]);
  assert.equal(r2.state, 'incident_off_network');
});

test('crew and incident at the same point', () => {
  const r0 = counted();
  const routes = createCrewRoutes({ getRouter: () => r0 });
  const [r] = routes.compute([crew(30, 78.005)], [incident(30, 78.005)]);
  assert.equal(r.state, 'at_site');
  assert.equal(r.meters, 0);
  assert.equal(r.seconds, 0);
  assert.equal(r0.calls, 0);
});

test('normal states: no position, no incident location, no crew, closed incident, no graph', () => {
  const routes = createCrewRoutes({ getRouter: () => router });
  assert.equal(routes.compute([crew(null, null)], [incident(30, 78.01)])[0].state, 'no_position');
  assert.equal(routes.compute([crew(30, 78.01)], [incident(null, null)])[0].state, 'no_incident_location');
  // A job with no crew, and a crew with no job: nothing to draw.
  assert.deepEqual(routes.compute([crew(30, 78.01, { job_id: null })], [incident(30, 78.02)]), []);
  assert.deepEqual(routes.compute([crew(30, 78.01)], [incident(30, 78.02, { status: 'resolved' })]), []);
  const noGraph = createCrewRoutes({ getRouter: () => null });
  assert.equal(noGraph.compute([crew(30, 78.001)], [incident(30, 78.02)])[0].state, 'no_graph');
});

test('many crews at once each get their own route', () => {
  const routes = createCrewRoutes({ getRouter: () => router });
  const crews = Array.from({ length: 6 }, (_, i) => ({ id: `C${i}`, job_id: `INC-${i}`, lat: 30, lon: 78.001 + i * 0.001 }));
  const incidents = crews.map((c, i) => incident(30, 78.019 - i * 0.0005, { id: `INC-${i}` }));
  const out = routes.compute(crews, incidents);
  assert.equal(out.length, 6);
  assert.deepEqual(out.map((r) => r.crewId), crews.map((c) => c.id));
  assert.ok(out.every((r) => r.state === 'ok'));
});

test('simplifyPath drops collinear points and keeps corners', () => {
  const straight = Array.from({ length: 11 }, (_, i) => [30, 78 + i * 0.001]);
  assert.deepEqual(simplifyPath(straight), [straight[0], straight[10]]);
  // An L-shaped path keeps its corner.
  const corner = [[30, 78], [30, 78.005], [30, 78.01], [30.005, 78.01], [30.01, 78.01]];
  assert.deepEqual(simplifyPath(corner), [[30, 78], [30, 78.01], [30.01, 78.01]]);
  // A 2 m wiggle is under the tolerance; a 50 m one is not.
  assert.equal(simplifyPath([[30, 78], [30.00002, 78.005], [30, 78.01]]).length, 2);
  assert.equal(simplifyPath([[30, 78], [30.00045, 78.005], [30, 78.01]]).length, 3);
  assert.deepEqual(simplifyPath([[30, 78]]), [[30, 78]]);
  assert.deepEqual(simplifyPath([]), []);
});

test('the returned route is simplified (the collinear shape points are gone)', () => {
  const routes = createCrewRoutes({ getRouter: () => router });
  const [r] = routes.compute([crew(30, 78.0001)], [incident(30, 78.0199)]);
  assert.equal(r.state, 'ok');
  assert.ok(r.coords.length <= 3, `got ${r.coords.length} points`);
});

test('cache: under the movement threshold the cached route is reused; past it, recomputed', () => {
  const r0 = counted();
  const routes = createCrewRoutes({ getRouter: () => r0 });
  const inc = [incident(30, 78.019)];
  const first = routes.compute([crew(30, 78.001)], inc)[0];
  assert.equal(r0.calls, 1);
  // 40 m: same route object back, no routing.
  const again = routes.compute([crew(30, east(30, 78.001, 40))], inc)[0];
  assert.equal(r0.calls, 1);
  assert.equal(again, first);
  // 80 m from where it was routed: recomputed.
  const moved = routes.compute([crew(30, east(30, 78.001, 80))], inc)[0];
  assert.equal(r0.calls, 2);
  assert.ok(moved.meters < first.meters);
});

test('cache: a new job, a moved incident or a new road graph recomputes at once', () => {
  let current = counted();
  const routes = createCrewRoutes({ getRouter: () => current });
  routes.compute([crew(30, 78.001)], [incident(30, 78.019)]);
  assert.equal(current.calls, 1);
  routes.compute([crew(30, 78.001, { job_id: 'INC-2' })], [incident(30, 78.015, { id: 'INC-2' })]);
  assert.equal(current.calls, 2);
  routes.compute([crew(30, 78.001, { job_id: 'INC-2' })], [incident(30, 78.012, { id: 'INC-2' })]);
  assert.equal(current.calls, 3);
  const before = current;
  current = counted();
  routes.compute([crew(30, 78.001, { job_id: 'INC-2' })], [incident(30, 78.012, { id: 'INC-2' })]);
  assert.equal(before.calls, 3);
  assert.equal(current.calls, 1);
});

test('a burst of GPS ticks produces ONE recompute', () => {
  const r0 = counted();
  const routes = createCrewRoutes({ getRouter: () => r0 });
  const inc = [incident(30, 78.019)];
  routes.compute([crew(30, 78.001)], inc); // the initial route
  assert.equal(r0.calls, 1);
  // 15 ticks of 6 m each (90 m in all), every one followed by a dashboard
  // fetch as if nothing were coalesced: only the tick that crosses 75 m routes.
  for (let i = 1; i <= 15; i++) routes.compute([crew(30, east(30, 78.001, i * 6))], inc);
  assert.equal(r0.calls, 2);
  assert.equal(MOVE_THRESHOLD_M, 75);
});

test('meters() matches the road router distance scale', () => {
  const d = meters({ lat: 30, lon: 78 }, { lat: 30, lon: east(30, 78, 100) });
  assert.ok(Math.abs(d - 100) < 0.5);
});
