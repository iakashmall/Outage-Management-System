// Road routing over the compact road graph built by
// backend/scripts/build-road-graph.mjs from OpenStreetMap data.
//
// Pure JavaScript with no Node or React Native APIs: the backend uses it
// for GET /api/route (online), and the crew app bundles the same file to
// route on the phone from the downloaded graph (offline), so both give the
// same answer.
//
// Graph format "oms-roads-1" (all coordinates are integers of 1e-5 degree,
// delta-encoded so the JSON stays small):
//   juncs: [dLat, dLon, ...]            junctions (way ends and crossings)
//   pts:   [dLat, dLon, ...]            interior shape points of every edge,
//                                       edge by edge, in edge order
//   edges: [from, to, nPts, kmh, oneway, ...]  5 numbers per edge; oneway=1
//                                       means only from -> to is allowed
//
// A route is the shortest path by road distance (by: 'time' gives the
// fastest instead); the result carries the road distance, an ETA from the
// road speeds and the full road geometry for drawing.

export const GRAPH_FORMAT = 'oms-roads-1';

const E = 1e5;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;
// A GPS fix further than this from any road is not routed (the result would
// be a road that has nothing to do with where the crew actually is).
const MAX_SNAP_M = 3000;
const CELL_DEG = 0.01; // spatial index cell, about 1 km
// Roads up to this much further away than the nearest one are also tried as
// the way on and off the network (at most MAX_SNAPS of them).
const SNAP_SLACK_M = 40;
const MAX_SNAPS = 6;
const OFF_ROAD_MS = 15 / 3.6; // between a fix and its road, ~15 km/h

export function createRouter(graph) {
  if (graph?.format !== GRAPH_FORMAT) throw new Error('Unsupported road graph format');

  // ---- decode junctions
  const J = graph.juncs.length / 2;
  const jLat = new Float64Array(J);
  const jLon = new Float64Array(J);
  for (let i = 0, a = 0, b = 0; i < J; i++) {
    a += graph.juncs[2 * i];
    b += graph.juncs[2 * i + 1];
    jLat[i] = a / E;
    jLon[i] = b / E;
  }

  // ---- decode shape points
  const P = graph.pts.length / 2;
  const pLat = new Float64Array(P);
  const pLon = new Float64Array(P);
  for (let i = 0, a = 0, b = 0; i < P; i++) {
    a += graph.pts[2 * i];
    b += graph.pts[2 * i + 1];
    pLat[i] = a / E;
    pLon[i] = b / E;
  }

  // ---- edges
  const EC = graph.edges.length / 5;
  const eFrom = new Int32Array(EC);
  const eTo = new Int32Array(EC);
  const ePtStart = new Int32Array(EC);
  const ePtCount = new Int32Array(EC);
  const eOneway = new Uint8Array(EC);
  const eSpeed = new Float64Array(EC); // m/s
  const eLen = new Float64Array(EC); // m
  let maxSpeed = 1;
  for (let e = 0, pt = 0; e < EC; e++) {
    eFrom[e] = graph.edges[5 * e];
    eTo[e] = graph.edges[5 * e + 1];
    ePtCount[e] = graph.edges[5 * e + 2];
    ePtStart[e] = pt;
    pt += ePtCount[e];
    eSpeed[e] = graph.edges[5 * e + 3] / 3.6;
    eOneway[e] = graph.edges[5 * e + 4];
    if (eSpeed[e] > maxSpeed) maxSpeed = eSpeed[e];
  }

  // The i-th vertex of edge e's polyline (0 = from junction, last = to junction).
  const vCount = (e) => ePtCount[e] + 2;
  const vLat = (e, i) => (i === 0 ? jLat[eFrom[e]] : i === ePtCount[e] + 1 ? jLat[eTo[e]] : pLat[ePtStart[e] + i - 1]);
  const vLon = (e, i) => (i === 0 ? jLon[eFrom[e]] : i === ePtCount[e] + 1 ? jLon[eTo[e]] : pLon[ePtStart[e] + i - 1]);

  for (let e = 0; e < EC; e++) {
    let len = 0;
    for (let i = 1; i < vCount(e); i++) len += dist(vLat(e, i - 1), vLon(e, i - 1), vLat(e, i), vLon(e, i));
    eLen[e] = len;
  }

  // ---- adjacency (CSR): arcs out of each junction; arc = edge * 2 + dir,
  // dir 0 = along the edge (from -> to), 1 = against it.
  const outCount = new Int32Array(J + 1);
  for (let e = 0; e < EC; e++) {
    outCount[eFrom[e]]++;
    if (!eOneway[e]) outCount[eTo[e]]++;
  }
  const outStart = new Int32Array(J + 1);
  for (let j = 0; j < J; j++) outStart[j + 1] = outStart[j] + outCount[j];
  const arcs = new Int32Array(outStart[J]);
  const fill = outStart.slice(0, J);
  for (let e = 0; e < EC; e++) {
    arcs[fill[eFrom[e]]++] = e * 2;
    if (!eOneway[e]) arcs[fill[eTo[e]]++] = e * 2 + 1;
  }

  // ---- spatial index of edges, for snapping a GPS fix onto the nearest road
  const grid = new Map();
  const cellKey = (cx, cy) => cx * 100000 + cy;
  for (let e = 0; e < EC; e++) {
    const seen = new Set();
    for (let i = 1; i < vCount(e); i++) {
      const x0 = Math.floor(Math.min(vLon(e, i - 1), vLon(e, i)) / CELL_DEG);
      const x1 = Math.floor(Math.max(vLon(e, i - 1), vLon(e, i)) / CELL_DEG);
      const y0 = Math.floor(Math.min(vLat(e, i - 1), vLat(e, i)) / CELL_DEG);
      const y1 = Math.floor(Math.max(vLat(e, i - 1), vLat(e, i)) / CELL_DEG);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = cellKey(cx, cy);
          if (seen.has(k)) continue;
          seen.add(k);
          const list = grid.get(k);
          if (list) list.push(e);
          else grid.set(k, [e]);
        }
      }
    }
  }

  // Every road near (lat, lon): for each edge within SNAP_SLACK_M of the
  // nearest one, its closest point -- the edge, how far along it (metres from
  // its from-junction), the snapped point and the distance d to it; nearest
  // first. More than one because the nearest line is not always the right
  // one: a divided road is two one-way lines a few metres apart, and joining
  // the wrong one means driving past the site and coming back.
  function snapAll(lat, lon) {
    const cx = Math.floor(lon / CELL_DEG);
    const cy = Math.floor(lat / CELL_DEG);
    const kx = Math.cos((lat * Math.PI) / 180) * M_PER_DEG_LON_EQ;
    const byEdge = new Map();
    let bestD = Infinity;
    const maxRing = Math.ceil(MAX_SNAP_M / (CELL_DEG * M_PER_DEG_LAT)) + 1;
    for (let r = 0; r <= maxRing; r++) {
      // Once candidates are closer than anything the next ring could hold, stop.
      if (bestD + SNAP_SLACK_M < (r - 1) * CELL_DEG * M_PER_DEG_LAT * 0.8) break;
      const checked = new Set();
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          for (const e of grid.get(cellKey(cx + dx, cy + dy)) || []) {
            if (checked.has(e)) continue;
            checked.add(e);
            let along = 0;
            for (let i = 1; i < vCount(e); i++) {
              const aLat = vLat(e, i - 1), aLon = vLon(e, i - 1), bLat = vLat(e, i), bLon = vLon(e, i);
              // Project onto the segment in a local metric plane.
              const ax = (aLon - lon) * kx, ay = (aLat - lat) * M_PER_DEG_LAT;
              const bx = (bLon - lon) * kx, by = (bLat - lat) * M_PER_DEG_LAT;
              const sx = bx - ax, sy = by - ay;
              const segLen2 = sx * sx + sy * sy;
              const t = segLen2 > 0 ? Math.max(0, Math.min(1, -(ax * sx + ay * sy) / segLen2)) : 0;
              const px = ax + t * sx, py = ay + t * sy;
              const d = Math.sqrt(px * px + py * py);
              const segLen = Math.sqrt(segLen2);
              const cur = byEdge.get(e);
              if (!cur || d < cur.d) {
                byEdge.set(e, { e, d, along: along + t * segLen, lat: aLat + t * (bLat - aLat), lon: aLon + t * (bLon - aLon) });
                if (d < bestD) bestD = d;
              }
              along += segLen;
            }
          }
        }
      }
    }
    if (bestD > MAX_SNAP_M) return [];
    return [...byEdge.values()].filter((c) => c.d <= bestD + SNAP_SLACK_M).sort((a, b) => a.d - b.d).slice(0, MAX_SNAPS);
  }
  const snap = (lat, lon) => snapAll(lat, lon)[0] || null;

  // Polyline of edge e between two along-distances, in travel order
  // (fromAlong > toAlong means travelling against the edge).
  function slice(e, fromAlong, toAlong, out) {
    const lo = Math.min(fromAlong, toAlong), hi = Math.max(fromAlong, toAlong);
    const part = [];
    let along = 0;
    for (let i = 1; i < vCount(e); i++) {
      const aLat = vLat(e, i - 1), aLon = vLon(e, i - 1), bLat = vLat(e, i), bLon = vLon(e, i);
      const len = dist(aLat, aLon, bLat, bLon);
      const next = along + len;
      if (next >= lo && along <= hi && len > 0) {
        const t0 = Math.max(0, (lo - along) / len), t1 = Math.min(1, (hi - along) / len);
        if (!part.length) part.push([aLat + t0 * (bLat - aLat), aLon + t0 * (bLon - aLon)]);
        part.push([aLat + t1 * (bLat - aLat), aLon + t1 * (bLon - aLon)]);
      }
      along = next;
    }
    if (fromAlong > toAlong) part.reverse();
    for (const p of part) out.push(p);
  }

  // ---- A* search, shortest path by distance (or fastest by time)
  const INF = Infinity;
  const gScore = new Float64Array(J);
  const viaArc = new Int32Array(J);
  const stamp = new Int32Array(J); // lazily reset per query
  let query = 0;

  function route(from, to, { by = 'distance' } = {}) {
    if (![from?.lat, from?.lon, to?.lat, to?.lon].every(Number.isFinite)) return null;
    // Already there: no detour out to the road and back.
    const direct = dist(from.lat, from.lon, to.lat, to.lon);
    if (direct < 30) {
      return { meters: Math.round(direct), seconds: Math.round(direct / (5 / 3.6)), coords: simplify([[from.lat, from.lon], [to.lat, to.lon]]), offRoadMeters: Math.round(direct) };
    }
    const S = snapAll(from.lat, from.lon);
    const T = snapAll(to.lat, to.lon);
    if (!S.length || !T.length) return null;
    query++;
    // Cost of m metres on edge e, and the matching admissible heuristic. The
    // hop between a fix and its road counts too, so a further road is only
    // taken when it really shortens the trip.
    const fastest = by === 'time';
    const cost = (e, m) => (fastest ? m / eSpeed[e] : m);
    const hop = (m) => (fastest ? m / OFF_ROAD_MS : m);
    const costPerM = fastest ? 1 / maxSpeed : 1;

    const g = (j) => (stamp[j] === query ? gScore[j] : INF);
    const heap = new MinHeap();
    const hToTarget = (j) => {
      let h = INF;
      for (const t of T) h = Math.min(h, dist(jLat[j], jLon[j], t.lat, t.lon));
      return h * costPerM;
    };
    const relax = (j, c, arc) => {
      if (c >= g(j)) return;
      stamp[j] = query;
      gScore[j] = c;
      viaArc[j] = arc;
      heap.push(c + hToTarget(j), j);
    };

    // Virtual start: from each start candidate k, leave its snapped point
    // towards either end of its edge; arc -(2k+1) = towards the to-junction,
    // -(2k+2) = towards the from-junction.
    S.forEach((s, k) => {
      relax(eTo[s.e], hop(s.d) + cost(s.e, eLen[s.e] - s.along), -(2 * k + 1));
      if (!eOneway[s.e]) relax(eFrom[s.e], hop(s.d) + cost(s.e, s.along), -(2 * k + 2));
    });

    // Virtual target: reach a target edge's from-junction and go along it, or
    // (two-way roads) its to-junction and go against it. Junction -> the
    // ways to finish from there.
    const tails = new Map();
    const addTail = (j, t, end, c) => {
      if (!tails.has(j)) tails.set(j, []);
      tails.get(j).push({ t, end, c });
    };
    for (const t of T) {
      addTail(eFrom[t.e], t, 'from', cost(t.e, t.along) + hop(t.d));
      if (!eOneway[t.e]) addTail(eTo[t.e], t, 'to', cost(t.e, eLen[t.e] - t.along) + hop(t.d));
    }

    // Start and site on the same road: straight along it.
    let best = INF;
    let bestEnd = null; // { kind: 'direct' | 'from' | 'to', t, s?, j? }
    for (const s of S) {
      for (const t of T) {
        if (s.e !== t.e) continue;
        let c = INF;
        if (t.along >= s.along) c = cost(s.e, t.along - s.along);
        else if (!eOneway[s.e]) c = cost(s.e, s.along - t.along);
        c += hop(s.d) + hop(t.d);
        if (c < best) { best = c; bestEnd = { kind: 'direct', s, t }; }
      }
    }

    while (heap.size) {
      const [f, j] = heap.pop();
      if (f >= best) break;
      const gj = g(j);
      if (f > gj + hToTarget(j) + 1e-9) continue; // stale entry
      for (const { t, end, c } of tails.get(j) || []) {
        if (gj + c < best) { best = gj + c; bestEnd = { kind: end, t, j }; }
      }
      for (let k = outStart[j]; k < outStart[j + 1]; k++) {
        const arc = arcs[k];
        const e = arc >> 1;
        const next = arc & 1 ? eFrom[e] : eTo[e];
        relax(next, gj + cost(e, eLen[e]), arc);
      }
    }
    if (best === INF) return null;

    // ---- rebuild geometry: GPS fix -> snapped start -> edges -> snapped end -> site
    const coords = [[from.lat, from.lon]];
    let drive = 0; // seconds on the roads, for the ETA
    const part = (e, a, b) => {
      slice(e, a, b, coords);
      drive += Math.abs(b - a) / eSpeed[e];
    };
    const t = bestEnd.t;
    let s;
    if (bestEnd.kind === 'direct') {
      s = bestEnd.s;
      part(s.e, s.along, t.along);
    } else {
      const chain = [];
      let j = bestEnd.j;
      for (;;) {
        const arc = viaArc[j];
        chain.push(arc);
        if (arc < 0) break;
        const e = arc >> 1;
        j = arc & 1 ? eTo[e] : eFrom[e];
      }
      chain.reverse();
      const first = -chain[0] - 1; // 2k: towards the to-junction, 2k+1: the from-junction
      s = S[first >> 1];
      part(s.e, s.along, first & 1 ? 0 : eLen[s.e]);
      for (let i = 1; i < chain.length; i++) {
        const e = chain[i] >> 1;
        if (chain[i] & 1) part(e, eLen[e], 0);
        else part(e, 0, eLen[e]);
      }
      part(t.e, bestEnd.kind === 'from' ? 0 : eLen[t.e], t.along);
    }
    coords.push([to.lat, to.lon]);

    // Road distance plus the short hops between the fixes and the road.
    let meters = 0;
    for (let i = 1; i < coords.length; i++) meters += dist(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    const offRoad = s.d + t.d;
    const seconds = drive + offRoad / OFF_ROAD_MS;
    return {
      meters: Math.round(meters),
      seconds: Math.round(seconds),
      coords: simplify(coords),
      offRoadMeters: Math.round(offRoad),
    };
  }

  return { route, snap: (lat, lon) => snap(lat, lon), stats: { junctions: J, edges: EC, points: P } };
}

// Distance in metres (equirectangular; accurate to well under 1% at city scale).
function dist(lat1, lon1, lat2, lon2) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) * Math.PI) / 360) * M_PER_DEG_LON_EQ;
  const y = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.sqrt(x * x + y * y);
}

// Drop consecutive duplicate points and round to ~1 m for a compact payload.
function simplify(coords) {
  const out = [];
  for (const [lat, lon] of coords) {
    const p = [Math.round(lat * E) / E, Math.round(lon * E) / E];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, value) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = value;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}
