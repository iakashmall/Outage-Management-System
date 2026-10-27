// OMS-05: infers a network.* connectivity graph for Haridwar from the flat
// GIS extract (backend/src/infra/network.json), which has positions but no
// topology, instead of waiting for a vendor CIM export. Same target schema
// as importCimNetwork.js (db/migrations/network_topology_schema.sql).
//
// Everything here is INFERRED from geometry, and labelled as such: every
// cim_mrid is synthetic (prefixed per class, like 'RMU:' in
// backfillRmusToProtectionAssets.js), every row keeps its original record
// verbatim in raw_attrs.original, and the open/closed reading is stored as
// raw_attrs.gis_inferred_state -- a messy GIS attribute, NOT SCADA telemetry.
// The diagnostic numbers behind every rule below come from
// scripts/haridwar-data-audit.mjs, which imports these same rules.
//
// How the graph is built (all decisions 2026-10-26):
//   * Lines: every htLines and feederLines path is an ACLineSegment. Line
//     ends within LINE_JOIN_M of another line join it (end-to-end, or a
//     T onto the other line's interior, which splits it there) -- closest
//     candidate first, and never so that a node spans more than
//     NODE_MAX_SPAN_M. A bare join between different feeders (no device
//     near it) is made only up to CROSS_FEEDER_BARE_JOIN_M (2026-10-27).
//   * Devices connect by THEIR OWN position only: the nearest point on any
//     line segment, <=SNAP_M snap, <=FLAG_M snap + flag, beyond that not
//     snapped. A device id's prefix is never used to place it next to its
//     "siblings" -- a shared prefix does not mean colocated (07H0711RMUT001's
//     18 switches span ~2 km). The only use of a prefix is the switch
//     fallback below, an id -> substation lookup that is still confirmed by
//     the device's own distance to that substation.
//   * Line ends 10-30 m from another line are NOT joined: they are listed as
//     join candidates for human review (raw_attrs.join_candidates), the same
//     two tiers as device snapping. A false join between unrelated lines is
//     worse than an honest fragment for a tool that informs switching.
//   * A switch or fuse that lands inside a line is inserted IN-LINE: the line
//     is cut there and the device bridges the two halves, so sectionalize.js
//     sees it as a real boundary. Devices sharing one cut point (a compact
//     substation's switch row) are placed in parallel across it, flagged --
//     the extract does not say how they are arranged. A device that lands on
//     a line END attaches with one terminal: which side of a junction it
//     sits on is unknowable, so it is not invented. Transformers always
//     attach with one terminal (the HV side; the LV side is not modelled).
//
//     KNOWN GAP (accepted 2026-10-26, OMS-05 follow-up): in this extract most
//     switches and fuses sit on a line end -- a dead end or a junction of 3+
//     lines -- so most get ONE terminal and do not act as section boundaries
//     for sectionalize.js; only the in-line ones do. Deliberately not patched
//     with a "device where exactly 2 line ends meet" heuristic (it would
//     recover ~151 devices for fragile logic).
//   * Power transformers (powerTx) are substation equipment, not line
//     devices: each attaches to its substation's bus, the substation found
//     from its id prefix ('07H122' -> '07H12') AND its name code
//     ('UPCL-JT-PT-1' -> 'UPCL-JT'), which must agree, confirmed by distance.
//   * A switch >FLAG_M from every line attaches to its own substation's bus
//     (id prefix -> substation, within SUB_NEAR_M of it); a feederLine
//     attaches its end nearest its substation (explicit `ss` field) the
//     same way. A component containing a substation bus is
//     "substation-anchored"; one without is an "orphaned fragment".
//   * RMUs are not equipment here: they stay protection_assets via
//     backfillRmusToProtectionAssets.js (status always blank, no signal).
//
// Idempotent by construction: every mRID is derived from the source data
// (a hash of a line's source, feeder and path; a device's own id), so a
// re-run over the same file produces the same ids.
//
// Writes: one transaction, every insert ON CONFLICT (cim_mrid) DO UPDATE --
// all-or-nothing and safe to re-run. Rows this importer wrote on an earlier
// run that the current build no longer produces (e.g. a line piece that a
// rule change removed) are DELETED in the same transaction, before the
// inserts -- left behind, a stale terminal would keep an old join alive.
// Only rows this importer owns are touched (ownedStale below: its mRID
// prefixes, and a node only when no other importer's terminal uses it);
// never the Dehradun CIM rows, network.protection_assets, or anything else.
// If any stale row is still referenced (an incident, a switching step, a
// planned outage, the safety log, an asset scan or a protection asset),
// the whole run is refused and rolled back, naming the rows.
// The network.* schema must already exist (db/migrations/
// network_topology_schema.sql is applied separately, as for importCimNetwork.js).
//
// Run: node src/infra/importHaridwarInferred.js            (in-memory build + summary, writes nothing)
//      node src/infra/importHaridwarInferred.js --join=1   (same, with a different LINE_JOIN_M)
//      node src/infra/importHaridwarInferred.js --dry-run  (build, then report what --write would write and delete; read-only)
//      node src/infra/importHaridwarInferred.js --write    (build, summary, then write to DATABASE_URL)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const _dir = dirname(fileURLToPath(import.meta.url));
const NET_PATH = join(_dir, 'network.json');

// ---- Rules (shared with scripts/haridwar-data-audit.mjs) ----

// Two states per class. Lines are 'connected'/'disconnected' (energised
// segment or not); switches and fuses are 'closed'/'open' (conducting or
// not). Every mapped value carries a confidence: 'reported' when the source
// states it, 'assumed' when it does not, so an assumed state is never
// mistaken downstream for a real reading. A raw value not in the map is
// 'UNMAPPED' -- never defaulted.
//   htLines 'Select' -- the GIS form's dropdown placeholder, never chosen.
//   fuses   ''       -- blank.
// Numeric codes: '1' = closed, '0' = open.
const R = 'reported';
const A = 'assumed';
export const STATUS_MAP = {
  htLines: {
    Connected: { state: 'connected', confidence: R },
    CONNECTED: { state: 'connected', confidence: R },
    Operational: { state: 'connected', confidence: R },
    Disconnted: { state: 'disconnected', confidence: R }, // [sic] in source
    DISCONNECTED: { state: 'disconnected', confidence: R },
    Select: { state: 'connected', confidence: A },
  },
  // feederLines carry 'Live' only (checked by the audit); same meaning.
  feederLines: {
    Live: { state: 'connected', confidence: R },
  },
  switches: {
    Closed: { state: 'closed', confidence: R },
    CLOSED: { state: 'closed', confidence: R },
    1: { state: 'closed', confidence: R },
    Open: { state: 'open', confidence: R },
  },
  fuses: {
    Closed: { state: 'closed', confidence: R },
    CLOSED: { state: 'closed', confidence: R },
    closed: { state: 'closed', confidence: R },
    1: { state: 'closed', confidence: R },
    0: { state: 'open', confidence: R },
    '': { state: 'closed', confidence: A },
  },
  powerTx: {
    Live: { state: 'connected', confidence: R },
    Dead: { state: 'disconnected', confidence: R },
  },
};

export function normalizeStatus(cls, raw) {
  const key = raw == null ? '' : String(raw);
  const hit = Object.hasOwn(STATUS_MAP[cls], key) ? STATUS_MAP[cls][key] : null;
  return hit ? { raw: key, ...hit } : { raw: key, state: 'UNMAPPED', confidence: null };
}

// One htLine each, read as a section id typed into the feeder field; merged
// into the parent feeder, original string kept in raw_attrs.
export const FEEDER_MERGES = {
  'UPCL-BW-B-1-041': 'UPCL-BW-B',
  'UPCL-BW-D-1-030': 'UPCL-BW-D',
};
export const feederCode = (raw) => FEEDER_MERGES[raw] ?? raw;

// feederLines name their feeder in words with no UPCL-* code, and the name
// alone is not unique ('11 kV I/C From PTR-1' is a bay at all 15
// substations), so: 'FDR:<substation id>:<slug of name>', the substation
// resolved from the line's own ss field ('?' if it does not resolve --
// counted, never guessed). The slug folds case/space/dash variants of one
// name ('SPARE-2' vs 'SPARE 2').
export const slugFeederName = (name) => String(name ?? '').toUpperCase()
  .replace(/(\d+)\s*KV\b/g, '$1KV').replace(/\//g, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const feederLineCode = (line, subIdByName) => `FDR:${subIdByName.get(line.ss) ?? '?'}:${slugFeederName(line.feeder)}`;

// Raw ids collide across classes in this file, so every class gets its own
// namespace.
export const MRID_PREFIX = { switches: 'SW:', fuses: 'FUSE:', distTx: 'DT:', rmus: 'RMU:' };
const PT_PREFIX = 'PT:';

export const SNAP_M = 10;
export const FLAG_M = 30;
// "Near its own substation": the >30 m switches' distance to their prefix
// substation breaks at ~300 m (45 within it, next tier ~400 m).
export const SUB_NEAR_M = 300;
// Line end -> other line. 77% of line ends match another exactly; the rest
// spread from 0.1 to 30 m with no clean break, so the device snap tolerance
// is reused. The summary prints the component count at 1/10/30 m.
export const LINE_JOIN_M = 10;
// Diameter cap (decided 2026-10-27): a node may not span more than this.
// Joins chain -- A joins B, B joins C -- so without a cap one node grew to
// ~20 m and swallowed unrelated lines (135 nodes over 10 m). A join is made
// only if the line end is within this of EVERY join point already in the
// node. Candidate joins are applied closest first (ties by mRID), so the
// result does not depend on the order of the file.
export const NODE_MAX_SPAN_M = 10;
// A join between lines of DIFFERENT feeders with no device within
// BARE_JOIN_DEVICE_M of it is made only at this gap or less; beyond it, it
// goes into raw_attrs.join_candidates. Two feeders meeting with nothing there
// is most often two lines drawn close together, not a tie point; a real tie
// has a switch or fuse at it. (Measured: halves the bare cross-feeder nodes,
// 342 -> 141, with no component split and no switch changing behaviour.)
export const CROSS_FEEDER_BARE_JOIN_M = 3;
export const BARE_JOIN_DEVICE_M = 10;
// A device whose nearest line point is within this of the line's end is ON
// that end (a node), not inside the line.
const AT_END_M = 1;
// Devices whose cut points on one line are within this of each other share
// the cut (parallel), rather than forming a series chain of 0 m lines.
const SAME_CUT_M = 1;
// Two records sharing an id are the same record repeated only when every
// non-position field matches and they are within this distance.
export const DUP_SAME_M = 1;

export function bucketOf(m) {
  if (m == null) return 'noPosition';
  if (m <= SNAP_M) return 'snap';
  if (m <= FLAG_M) return 'snapFlagged';
  return 'unconnected';
}

// Local equirectangular metres -- exact enough below ~1 km, which is all
// that is ever measured here. Path points are [lat, lon].
const K = 111320;
const pm = (a, b) => Math.hypot((a[1] - b[1]) * K * Math.cos(a[0] * Math.PI / 180), (a[0] - b[0]) * K);
// Distance from point p ([lat, lon]) to segment a-b, and where along it (t).
export function project(p, a, b) {
  const c = Math.cos(p[0] * Math.PI / 180);
  const ax = (a[1] - p[1]) * K * c, ay = (a[0] - p[0]) * K, bx = (b[1] - p[1]) * K * c, by = (b[0] - p[0]) * K;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return { m: Math.hypot(ax + t * dx, ay + t * dy), t };
}

// Collapses repeated records; suffixes '#2' onto genuinely different
// devices sharing an id. Returns both lists so nothing is dropped silently.
export function dedupe(cls, list) {
  const byId = new Map();
  for (const r of list) (byId.get(r.id) || byId.set(r.id, []).get(r.id)).push(r);
  const out = [];
  const repeats = [];
  const shared = [];
  const strip = ({ lat: _a, lon: _b, ...rest }) => JSON.stringify(rest);
  for (const [id, group] of byId) {
    const kept = [];
    for (const r of group) {
      const twin = kept.find((k) => strip(r) === strip(k.rec) && pm([r.lat, r.lon], [k.rec.lat, k.rec.lon]) <= DUP_SAME_M);
      if (twin) { repeats.push({ id, apartM: +pm([r.lat, r.lon], [twin.rec.lat, twin.rec.lon]).toFixed(2) }); continue; }
      const mrid = MRID_PREFIX[cls] + id + (kept.length ? `#${kept.length + 1}` : '');
      if (kept.length) shared.push({ id, mrid, apartM: +pm([r.lat, r.lon], [kept[0].rec.lat, kept[0].rec.lon]).toFixed(1) });
      kept.push({ rec: r, mrid });
    }
    out.push(...kept.map((k) => ({ ...k.rec, mrid: k.mrid })));
  }
  return { out, repeats, shared };
}

// Air Break Switches are gang-operated isolators -- in CIM a Disconnector.
// The other type codes ('0', '1', 'NV') are undocumented, so they get the
// generic Switch class rather than a guessed one; all of these are in
// sectionalize.js's SWITCH_CLASSES, so tracing treats them alike.
const SWITCH_CLASS_BY_TYPE = { ABS: 'Disconnector' };
const switchClass = (type) => SWITCH_CLASS_BY_TYPE[type] ?? 'Switch';

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
// A raw line's topology mRID, from its own source record. Exported because it
// is also the link back from topology to raw GIS (src/domain/topology.js):
// a line cut into pieces gets '<this>/<n>', so the part before '/' is the link.
export const lineMrid = (source, l) => `LINE:${hash(`${source}|${l.feeder}|${JSON.stringify(l.path)}`)}`;
const hasPos = (r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon);
const GIS_NOTE = 'inferred from a flat GIS extract attribute, not SCADA telemetry';

// ---- In-memory build ----

export function buildGraph(net, { lineJoinM = LINE_JOIN_M } = {}) {
  const report = { warnings: [] };
  const subById = new Map((net.substations || []).map((s) => [s.id, s]));
  const subIdByName = new Map((net.substations || []).map((s) => [s.name, s.id]));
  const busKey = (subId) => `BUS:${subId}`;

  // -- Substations --
  const substations = (net.substations || []).map((s) => ({
    mrid: `SS:${s.id}`, name: s.name, code: s.code, lat: s.lat, lon: s.lon,
    raw_attrs: { source: 'network.json#substations', original: s },
  }));

  // -- Lines --
  const lines = [];
  const badPath = { htLines: 0, feederLines: 0 };
  for (const source of ['htLines', 'feederLines']) {
    for (const l of net[source] || []) {
      const p = l.path || [];
      if (p.length < 2 || p.some((e) => !Number.isFinite(e?.[0]) || !Number.isFinite(e?.[1]))) { badPath[source]++; continue; }
      const feeder = source === 'htLines' ? feederCode(l.feeder) : feederLineCode(l, subIdByName);
      const raw_attrs = {
        source: `network.json#${source}`,
        original: l,
        gis_inferred_state: { ...normalizeStatus(source, l.status), note: GIS_NOTE },
      };
      if (source === 'htLines' && FEEDER_MERGES[l.feeder]) raw_attrs.feeder_merged_from = l.feeder;
      lines.push({ source, feeder, path: p, mrid: lineMrid(source, l), raw_attrs, cuts: [] });
    }
  }
  report.linesWithBadPath = badPath;
  const dupLine = lines.length - new Set(lines.map((l) => l.mrid)).size;
  if (dupLine) report.warnings.push(`${dupLine} lines share an mRID (identical source, feeder and path)`);

  const nearestOn = (line, p) => { // nearest point on one line: metres and position s = segment index + t
    let best = { m: Infinity, s: 0 };
    for (let i = 1; i < line.path.length; i++) {
      const { m, t } = project(p, line.path[i - 1], line.path[i]);
      if (m < best.m) best = { m, s: i - 1 + t };
    }
    return best;
  };
  const endS = (line) => line.path.length - 1;
  // Snap a position to the line's end when it is within AT_END_M of it.
  const settle = (line, s) => {
    const at = pointAt(line.path, s);
    if (pm(at, line.path[0]) <= AT_END_M) return 0;
    if (pm(at, line.path.at(-1)) <= AT_END_M) return endS(line);
    return s;
  };

  // Node keys are unioned into connectivity nodes at the end. Each line end
  // and each cut gets a key; a cut that hosts in-line devices has a left and
  // a right key (the device bridges them).
  const uf = new UnionFind();
  // Where each key sits, for the diameter cap: a line end's point, a cut's point.
  const keyPoint = new Map();
  lines.forEach((l, i) => {
    l.idx = i;
    uf.add(`L${i}@0`); uf.add(`L${i}@${endS(l)}`);
    keyPoint.set(`L${i}@0`, l.path[0]); keyPoint.set(`L${i}@${endS(l)}`, l.path.at(-1));
  });
  // The join points of each node (by union-find root), and the cap check:
  // two nodes merge only if every pair of their join points is within NODE_MAX_SPAN_M.
  const setPts = new Map();
  const ptsOf = (k) => setPts.get(uf.find(k)) || [keyPoint.get(k)];
  const fits = (P1, P2) => P1.every((x) => P2.every((y) => pm(x, y) <= NODE_MAX_SPAN_M));
  const capUnion = (k1, k2) => {
    if (uf.find(k1) === uf.find(k2)) return true;
    const P1 = ptsOf(k1), P2 = ptsOf(k2);
    if (!fits(P1, P2)) return false;
    uf.union(k1, k2); setPts.set(uf.find(k1), [...P1, ...P2]);
    return true;
  };

  // Devices near a point (any class, by raw position) -- the cross-feeder rule.
  const devicePoints = ['switches', 'fuses', 'rmus', 'distTx', 'powerTx'].flatMap((c) => (net[c] || []).filter(hasPos).map((r) => [r.lat, r.lon]));
  const GRID = 0.0002; // degrees, ~20 m: a device within BARE_JOIN_DEVICE_M is in this cell or a neighbour
  const cellOf = (q) => `${Math.floor(q[0] / GRID)},${Math.floor(q[1] / GRID)}`;
  const deviceGrid = new Map();
  for (const d of devicePoints) (deviceGrid.get(cellOf(d)) || deviceGrid.set(cellOf(d), []).get(cellOf(d))).push(d);
  const deviceNear = (q) => {
    const [i, j] = cellOf(q).split(',').map(Number);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const d of deviceGrid.get(`${i + di},${j + dj}`) || []) if (pm(q, d) <= BARE_JOIN_DEVICE_M) return true;
    }
    return false;
  };

  // -- Line ends -> other lines --
  // Every candidate (a line end within lineJoinM of another line) is
  // collected first, then applied closest first, ties by mRID: the outcome
  // of the diameter cap then does not depend on the order of the file.
  let endToEnd = 0;
  let endToInterior = 0;
  let capRefused = 0;
  let crossFeederRefused = 0;
  const joinCandidates = []; // not joined: 10-30 m away, or a bare cross-feeder join over CROSS_FEEDER_BARE_JOIN_M
  const recordCandidate = (a, end, line, m, reason) => {
    const c = { end: end === 0 ? 'start' : 'end', nearestLine: line.mrid, nearestLineFeeder: line.feeder, distanceM: +m.toFixed(1), ...(reason ? { reason } : {}) };
    (a.raw_attrs.join_candidates ??= []).push(c);
    joinCandidates.push({ line: a.mrid, feeder: a.feeder, ...c, sameFeeder: a.feeder === line.feeder });
  };
  const joins = [];
  for (const a of lines) {
    for (const end of [0, endS(a)]) {
      const p = a.path[end];
      let any = false;
      let candidate = null;
      for (const b of lines) {
        if (b === a) continue;
        const near = nearestOn(b, p);
        if (near.m > lineJoinM) {
          if (near.m <= FLAG_M && (!candidate || near.m < candidate.m || (near.m === candidate.m && b.mrid < candidate.line.mrid))) candidate = { m: near.m, line: b };
          continue;
        }
        any = true;
        joins.push({ a, end, b, s: settle(b, near.s), gap: near.m, p });
      }
      if (!any && candidate) recordCandidate(a, end, candidate.line, candidate.m);
    }
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  joins.sort((x, y) => (x.gap - y.gap) || cmp(x.a.mrid, y.a.mrid) || (x.end - y.end) || cmp(x.b.mrid, y.b.mrid) || (x.s - y.s));
  for (const { a, end, b, s, gap, p } of joins) {
    if (a.feeder !== b.feeder && gap > CROSS_FEEDER_BARE_JOIN_M && !deviceNear(p)) {
      crossFeederRefused++;
      recordCandidate(a, end, b, gap, `different feeders, no device within ${BARE_JOIN_DEVICE_M} m, over ${CROSS_FEEDER_BARE_JOIN_M} m: not joined`);
      continue;
    }
    const aKey = `L${a.idx}@${end}`;
    if (s === 0 || s === endS(b)) {
      if (capUnion(aKey, `L${b.idx}@${s}`)) endToEnd++; else capRefused++;
      continue;
    }
    // A T onto b's interior: checked before the cut is made, so a refused
    // join leaves no empty cut (and no extra line piece) behind.
    const at = pointAt(b.path, s);
    const existing = b.cuts.find((x) => pm(pointAt(b.path, x.s), at) <= SAME_CUT_M);
    if (uf.find(aKey) !== (existing && uf.find(existing.left)) && !fits(ptsOf(aKey), existing ? ptsOf(existing.left) : [at])) { capRefused++; continue; }
    capUnion(aKey, addCut(b, s, null));
    endToInterior++;
  }
  report.lineJoins = { lineJoinM, endToEnd, endToInteriorT: endToInterior, refusedByNodeSpanCap: capRefused, refusedCrossFeederBare: crossFeederRefused };
  report.joinCandidates = joinCandidates;

  // -- feederLines: the end nearest their own substation joins its bus --
  const feederLineToBus = { attached: 0, tooFar: [], unresolved: 0 };
  for (const l of lines.filter((x) => x.source === 'feederLines')) {
    const sub = subById.get(subIdByName.get(l.raw_attrs.original.ss));
    if (!sub) { feederLineToBus.unresolved++; continue; }
    const ends = [0, endS(l)].map((e) => ({ e, m: pm(l.path[e], [sub.lat, sub.lon]) })).sort((x, y) => x.m - y.m);
    if (ends[0].m <= SUB_NEAR_M) { uf.union(`L${l.idx}@${ends[0].e}`, busKey(sub.id)); feederLineToBus.attached++; }
    else feederLineToBus.tooFar.push({ line: l.mrid, feeder: l.feeder, nearestEndM: Math.round(ends[0].m) });
  }
  report.feederLineToBus = feederLineToBus;

  // -- Devices --
  const equipment = [];
  const terminals = [];
  const deviceModes = {};
  const flagged = [];
  const unconnected = [];
  const feederMismatchDt = [];
  const dedupReport = {};
  const countMode = (cls, mode) => { deviceModes[cls] ??= {}; deviceModes[cls][mode] = (deviceModes[cls][mode] || 0) + 1; };

  for (const cls of ['switches', 'fuses', 'distTx']) {
    const d = dedupe(cls, net[cls] || []);
    dedupReport[cls] = { in: (net[cls] || []).length, out: d.out.length, sameRecordRepeated: d.repeats.length, differentDevicesSharingId: d.shared.length };
    for (const r of d.out) {
      const { mrid, ...original } = r;
      const cim_class = cls === 'switches' ? switchClass(r.type) : cls === 'fuses' ? 'Fuse' : 'PowerTransformer';
      const raw_attrs = { source: `network.json#${cls}`, original };
      if (cls !== 'distTx') raw_attrs.gis_inferred_state = { ...normalizeStatus(cls, r.status), note: GIS_NOTE };
      if (original.id !== mrid.slice(MRID_PREFIX[cls].length)) raw_attrs.shares_raw_id_with_another_device = true;
      const eq = { mrid, cim_class, name: r.name ?? null, lat: r.lat, lon: r.lon, feeder: cls === 'distTx' ? feederCode(r.feeder) : null, raw_attrs };
      equipment.push(eq);
      if (!hasPos(r)) { raw_attrs.placement = { mode: 'no_position' }; countMode(cls, 'no_position'); unconnected.push({ mrid, why: 'no position' }); continue; }

      // Nearest line, by this device's own position only.
      const p = [r.lat, r.lon];
      let best = { m: Infinity, s: 0, line: null };
      for (const l of lines) { const n = nearestOn(l, p); if (n.m < best.m) best = { ...n, line: l }; }

      if (best.m <= FLAG_M) {
        const l = best.line;
        const s = settle(l, best.s);
        const atEnd = s === 0 || s === endS(l);
        const inline = !atEnd && cls !== 'distTx';
        const mode = atEnd ? 'at_line_end' : inline ? 'inline' : 'tap';
        raw_attrs.placement = { mode, line: l.mrid, distanceM: +best.m.toFixed(2), flagged: best.m > SNAP_M };
        if (best.m > SNAP_M) flagged.push({ mrid, m: +best.m.toFixed(1) });
        if (!eq.feeder) { eq.feeder = l.feeder; raw_attrs.feeder_inferred_from = 'snapped line'; }
        else if (eq.feeder !== l.feeder) feederMismatchDt.push({ mrid, own: eq.feeder, snappedLine: l.feeder });
        countMode(cls, mode);
        if (atEnd) terminals.push({ eq: mrid, seq: 1, key: `L${l.idx}@${s}` });
        else if (!inline) terminals.push({ eq: mrid, seq: 1, key: addCut(l, s, null) });
        else {
          const cut = addCut(l, s, mrid);
          terminals.push({ eq: mrid, seq: 1, key: cut.left }, { eq: mrid, seq: 2, key: cut.right });
        }
        continue;
      }
      // Switch fallback: its own substation (id prefix), confirmed by distance.
      if (cls === 'switches') {
        const sub = subById.get(String(r.id).slice(0, 5));
        const subM = sub ? pm(p, [sub.lat, sub.lon]) : null;
        if (subM != null && subM <= SUB_NEAR_M) {
          raw_attrs.placement = { mode: 'substation_bus', substation: sub.id, distanceM: Math.round(subM), nearestLineM: Math.round(best.m) };
          countMode(cls, 'substation_bus');
          terminals.push({ eq: mrid, seq: 1, key: busKey(sub.id) });
          continue;
        }
      }
      raw_attrs.placement = { mode: 'unconnected', nearestLineM: Math.round(best.m) };
      countMode(cls, 'unconnected');
      unconnected.push({ mrid, why: `nearest line ${Math.round(best.m)} m` });
    }
  }

  // -- Power transformers: to their own substation's bus --
  const subByCode = new Map((net.substations || []).map((s) => [s.code, s]));
  const powerTx = { attached: 0, rejected: [] };
  for (const r of net.powerTx || []) {
    const mrid = PT_PREFIX + r.id;
    const byId = subById.get(String(r.id).slice(0, 5));
    const byName = subByCode.get(String(r.name ?? '').split('-').slice(0, 2).join('-'));
    const m = byId && hasPos(r) ? pm([r.lat, r.lon], [byId.lat, byId.lon]) : null;
    const raw_attrs = { source: 'network.json#powerTx', original: r, gis_inferred_state: { ...normalizeStatus('powerTx', r.status), note: GIS_NOTE } };
    equipment.push({ mrid, cim_class: 'PowerTransformer', name: r.name ?? null, lat: r.lat, lon: r.lon, feeder: null, raw_attrs });
    if (byId && byId === byName && m != null && m <= SUB_NEAR_M) {
      raw_attrs.placement = { mode: 'substation_bus', substation: byId.id, distanceM: Math.round(m) };
      terminals.push({ eq: mrid, seq: 1, key: busKey(byId.id) });
      countMode('powerTx', 'substation_bus');
      powerTx.attached++;
    } else {
      const why = !byId ? 'id prefix matches no substation' : byId !== byName ? `id says ${byId.id}, name says ${byName?.id ?? 'none'}` : `${Math.round(m)} m from its substation`;
      raw_attrs.placement = { mode: 'unconnected', why };
      countMode('powerTx', 'unconnected');
      unconnected.push({ mrid, why });
      powerTx.rejected.push({ mrid, why });
    }
  }
  report.powerTx = powerTx;

  // -- Cut lines into ACLineSegment pieces --
  let parallelCuts = 0;
  for (const l of lines) {
    const cuts = l.cuts.sort((a, b) => a.s - b.s);
    const bounds = [{ s: 0, right: `L${l.idx}@0` }, ...cuts, { s: endS(l), left: `L${l.idx}@${endS(l)}` }];
    for (const c of cuts) if (c.devices.length > 1) parallelCuts++;
    for (let k = 0; k < bounds.length - 1; k++) {
      const from = bounds[k];
      const to = bounds[k + 1];
      const piece = subPath(l.path, from.s, to.s);
      const mrid = bounds.length > 2 ? `${l.mrid}/${k + 1}` : l.mrid;
      equipment.push({
        mrid, cim_class: 'ACLineSegment', name: null, feeder: l.feeder, lat: piece[0][0], lon: piece[0][1], path: piece,
        raw_attrs: { ...l.raw_attrs, ...(bounds.length > 2 ? { piece: { of: l.mrid, index: k + 1, pieces: bounds.length - 1 } } : {}) },
      });
      terminals.push({ eq: mrid, seq: 1, key: from.right }, { eq: mrid, seq: 2, key: to.left });
    }
  }
  // Mark co-cut devices (parallel across one cut) so a reader knows.
  for (const l of lines) for (const c of l.cuts) if (c.devices.length > 1) {
    for (const m of c.devices) equipment.find((e) => e.mrid === m).raw_attrs.placement.parallel_with = c.devices.filter((x) => x !== m);
  }

  // -- Connectivity nodes --
  // One node per union-find set; its mRID is derived from the set's
  // smallest member key, which only depends on the source data.
  for (const t of terminals) uf.add(t.key);
  const groups = new Map();
  for (const k of uf.keys()) { const r = uf.find(k); (groups.get(r) || groups.set(r, []).get(r)).push(k); }
  const nodeMridOf = new Map();
  const nodes = [];
  const lineMridByIdx = (i) => lines[i].mrid;
  for (const members of groups.values()) {
    const bus = members.find((k) => k.startsWith('BUS:'));
    // Keys name a line by index; the mRID uses the line's own mRID instead,
    // so it does not depend on the order of the file.
    const stable = members.map((k) => k.replace(/^L(\d+)@/, (_m, i) => `${lineMridByIdx(+i)}@`)).sort();
    const mrid = bus ? `CN:SS:${bus.slice(4)}` : `CN:${hash(stable[0])}`;
    for (const k of members) nodeMridOf.set(k, mrid);
    nodes.push({ mrid, isBus: !!bus, members: members.length });
  }
  const nodeFeeder = new Map(); // first line feeder seen at a node
  const eqByMrid = new Map(equipment.map((e) => [e.mrid, e]));
  const termRows = terminals.map((t) => {
    const node = nodeMridOf.get(t.key);
    const e = eqByMrid.get(t.eq);
    if (e.cim_class === 'ACLineSegment' && !nodeFeeder.has(node)) nodeFeeder.set(node, e.feeder);
    return { mrid: `${t.eq}#T${t.seq}`, eq: t.eq, node, seq: t.seq };
  });
  for (const n of nodes) n.feeder = n.isBus ? null : nodeFeeder.get(n.mrid) ?? null;

  // -- Feeders --
  const feeders = new Map();
  for (const l of lines) {
    if (feeders.has(l.feeder)) continue;
    let sub = null;
    if (l.source === 'feederLines') sub = subById.get(subIdByName.get(l.raw_attrs.original.ss)) ?? null;
    else sub = subByCode.get(l.feeder.split('-').slice(0, 2).join('-')) ?? null; // 'UPCL-BW-B' -> 'UPCL-BW'
    feeders.set(l.feeder, {
      mrid: l.source === 'feederLines' ? l.feeder : `FEEDER:${l.feeder}`, code: l.feeder, substation: sub?.id ?? null,
      raw_attrs: { source: `network.json#${l.source}`, ...(l.source === 'feederLines' ? { names: [] } : {}) },
    });
  }
  for (const l of lines.filter((x) => x.source === 'feederLines')) {
    const n = feeders.get(l.feeder).raw_attrs.names;
    if (!n.includes(l.raw_attrs.original.feeder)) n.push(l.raw_attrs.original.feeder);
  }
  const dtFeeders = new Set((net.distTx || []).map((r) => feederCode(r.feeder)));
  for (const f of feeders.values()) {
    if (f.mrid.startsWith('FEEDER:') && !dtFeeders.has(f.code)) f.raw_attrs.gap = 'feeder exists, no distTx records found';
  }
  report.feedersWithoutSubstation = [...feeders.values()].filter((f) => !f.substation).map((f) => f.code);

  // -- Connected components (union-find over nodes, through equipment) --
  const cc = new UnionFind();
  for (const n of nodes) cc.add(n.mrid);
  const termsByEq = new Map();
  for (const t of termRows) (termsByEq.get(t.eq) || termsByEq.set(t.eq, []).get(t.eq)).push(t.node);
  for (const ns of termsByEq.values()) for (let i = 1; i < ns.length; i++) cc.union(ns[0], ns[i]);
  const comps = new Map();
  for (const n of nodes) {
    const r = cc.find(n.mrid);
    const c = comps.get(r) || comps.set(r, { equipment: 0, byClass: {}, substations: [] }).get(r);
    if (n.isBus) c.substations.push(n.mrid.slice(6));
  }
  for (const [eq, ns] of termsByEq) {
    const c = comps.get(cc.find(ns[0]));
    const cls = eqByMrid.get(eq).cim_class;
    c.equipment++;
    c.byClass[cls] = (c.byClass[cls] || 0) + 1;
  }
  const components = [...comps.values()].filter((c) => c.equipment).sort((a, b) => b.equipment - a.equipment);

  return {
    substations, feeders: [...feeders.values()], equipment, nodes, terminals: termRows, components,
    report: { ...report, dedup: dedupReport, deviceModes, flagged, unconnected, feederMismatchDt, parallelCuts },
  };

  // Registers a cut on a line at position s and returns its key (or, for an
  // in-line device, its { left, right } keys). Cuts within SAME_CUT_M share.
  function addCut(line, s, deviceMrid) {
    const at = pointAt(line.path, s);
    let c = line.cuts.find((x) => pm(pointAt(line.path, x.s), at) <= SAME_CUT_M);
    if (!c) {
      const id = `L${line.idx}@${s.toFixed(6)}`;
      c = { s, left: `${id}<`, right: `${id}>`, devices: [] };
      uf.add(c.left); uf.add(c.right);
      keyPoint.set(c.left, at); keyPoint.set(c.right, at);
      // A cut with no in-line device is just a node: both sides are one key.
      uf.union(c.left, c.right);
      line.cuts.push(c);
    }
    if (!deviceMrid) return c.left;
    // The first in-line device separates the two sides; the cut was created
    // joined, so rebuild it split. (Only possible while nothing else has
    // been unioned into it, which holds: devices are placed after line joins
    // only add T-cuts, and a T-cut that also hosts a device stays joined --
    // the device then sits on a junction and is treated as on it, not across it.)
    if (!c.devices.length && !c.split && uf.size(c.left) === 2) {
      uf.split(c.left, c.right);
      c.split = true;
    }
    c.devices.push(deviceMrid);
    return c;
  }
}

function pointAt(path, s) {
  const i = Math.min(Math.floor(s), path.length - 2);
  const t = s - i;
  const [a, b] = [path[i], path[i + 1]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function subPath(path, s0, s1) {
  const out = [pointAt(path, s0)];
  for (let i = Math.floor(s0) + 1; i < s1; i++) out.push(path[i]);
  out.push(pointAt(path, s1));
  return out;
}

class UnionFind {
  constructor() { this.p = new Map(); this.n = new Map(); }
  add(k) { if (!this.p.has(k)) { this.p.set(k, k); this.n.set(k, 1); } }
  find(k) { this.add(k); let r = k; while (this.p.get(r) !== r) r = this.p.get(r); while (this.p.get(k) !== r) { const nx = this.p.get(k); this.p.set(k, r); k = nx; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra === rb) return; const [big, small] = this.n.get(ra) >= this.n.get(rb) ? [ra, rb] : [rb, ra]; this.p.set(small, big); this.n.set(big, this.n.get(big) + this.n.get(small)); }
  size(k) { return this.n.get(this.find(k)); }
  // Undo a union of exactly two fresh keys (used only by addCut).
  split(a, b) { this.p.set(a, a); this.p.set(b, b); this.n.set(a, 1); this.n.set(b, 1); }
  keys() { return this.p.keys(); }
}

// ---- Database writes ----

const feederMridOf = (g) => {
  const m = new Map(g.feeders.map((f) => [f.code, f.mrid]));
  return (code) => (code == null ? null : m.get(code) ?? null);
};
const wkt = (path) => `SRID=4326;LINESTRING(${path.map(([la, lo]) => `${lo} ${la}`).join(',')})`;

// Rows this importer owns, by mRID prefix. A 'CN:' node is owned only when
// no terminal of another source uses it (a selftest or another import may
// also name nodes 'CN:...'). The Dehradun CIM rows use none of these
// prefixes; network.protection_assets ('RMU:', the RMU backfill) is never
// written or deleted here.
const OWNED = {
  substations: ['SS:%'],
  feeders: ['FEEDER:%', 'FDR:%'],
  conducting_equipment: ['LINE:%', 'SW:%', 'FUSE:%', 'DT:%', 'PT:%'],
  connectivity_nodes: ['CN:%'],
  terminals: ['LINE:%', 'SW:%', 'FUSE:%', 'DT:%', 'PT:%'],
};
const TABLES = ['terminals', 'conducting_equipment', 'connectivity_nodes', 'feeders', 'substations']; // delete order

// The run refused: stale rows that something still references. Nothing was written.
export class ImportRefused extends Error {
  constructor(references) {
    super(`refused: ${references.length} reference(s) to rows this run would delete -- nothing written, rolled back`);
    this.references = references;
  }
}

const builtMrids = (g) => ({
  substations: g.substations.map((s) => s.mrid), feeders: g.feeders.map((f) => f.mrid),
  conducting_equipment: g.equipment.map((e) => e.mrid), connectivity_nodes: g.nodes.map((n) => n.mrid), terminals: g.terminals.map((x) => x.mrid),
});

// This importer's rows that the build no longer produces: { table: [{ id, cim_mrid }] },
// plus how many 'CN:' nodes were left alone because another source's terminal uses them.
async function ownedStale(t, built) {
  const stale = {};
  for (const table of ['terminals', 'conducting_equipment', 'feeders', 'substations']) {
    stale[table] = await t.any(`SELECT id, cim_mrid FROM network.${table} WHERE cim_mrid LIKE ANY($1) AND NOT (cim_mrid = ANY($2)) ORDER BY cim_mrid`, [OWNED[table], built[table]]);
  }
  const nodes = await t.any(
    `SELECT n.id, n.cim_mrid, EXISTS (SELECT 1 FROM network.terminals x WHERE x.connectivity_node_id = n.id AND NOT (x.cim_mrid LIKE ANY($3))) AS foreign_use
     FROM network.connectivity_nodes n WHERE n.cim_mrid LIKE ANY($1) AND NOT (n.cim_mrid = ANY($2)) ORDER BY n.cim_mrid`,
    [OWNED.connectivity_nodes, built.connectivity_nodes, OWNED.terminals]);
  stale.connectivity_nodes = nodes.filter((n) => !n.foreign_use).map(({ id, cim_mrid }) => ({ id, cim_mrid }));
  return { stale, nodesLeftAlone: nodes.filter((n) => n.foreign_use).length };
}

// Everything that still points at a stale row. A check whose column (or
// table) does not exist in this database is skipped and listed as such.
async function staleReferences(t, stale) {
  const has = async (schema, table, column) => !!(await t.oneOrNone(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [schema, table, column]));
  const ids = (table) => stale[table].map((r) => r.id);
  const eqMrids = stale.conducting_equipment.map((r) => r.cim_mrid);
  const allMrids = TABLES.flatMap((table) => stale[table].map((r) => r.cim_mrid));
  const rawIds = eqMrids.filter((m) => !m.startsWith('LINE:')).map((m) => m.slice(m.indexOf(':') + 1).split('#')[0]);
  const refs = [];
  const skipped = [];
  const checked = [];
  const check = async (label, [schema, table, column], sql, params) => {
    if (!(await has(schema, table, column))) { skipped.push(`${label}: ${schema}.${table}.${column} does not exist in this database`); return; }
    checked.push(label);
    for (const r of await t.any(sql, params)) refs.push({ check: label, row: r.row, references: r.ref });
  };
  await check('incident tripped equipment', ['public', 'incidents', 'tripped_equipment_id'],
    `SELECT 'incidents ' || i.id AS row, ce.cim_mrid AS ref FROM incidents i JOIN network.conducting_equipment ce ON ce.id = i.tripped_equipment_id WHERE i.tripped_equipment_id = ANY($1::bigint[])`, [ids('conducting_equipment')]);
  // switching_plans hold no device mRID themselves; a plan refers to devices through its steps
  await check('switching plan step device', ['public', 'switching_steps', 'device_mrid'],
    `SELECT 'switching_steps ' || s.id || ' (plan ' || s.plan_id || ')' AS row, s.device_mrid AS ref FROM switching_steps s WHERE s.device_mrid = ANY($1)`, [eqMrids]);
  await check('planned outage work device', ['public', 'planned_outages', 'work_mrid'],
    `SELECT 'planned_outages ' || id AS row, work_mrid AS ref FROM planned_outages WHERE work_mrid = ANY($1)`, [eqMrids]);
  await check('safety log details', ['public', 'safety_log', 'details'],
    `SELECT 'safety_log ' || l.id AS row, m AS ref FROM safety_log l, unnest($1::text[]) m WHERE strpos(l.details::text, '"' || m || '"') > 0`, [allMrids]);
  await check('asset scan', ['public', 'asset_scans', 'asset_id'],
    `SELECT 'asset_scans ' || id AS row, coalesce(asset_id, raw_value) AS ref FROM asset_scans WHERE asset_id = ANY($1) OR raw_value = ANY($1) OR asset_id = ANY($2) OR raw_value = ANY($2)`, [eqMrids, rawIds]);
  await check('protection asset equipment', ['network', 'protection_assets', 'equipment_id'],
    `SELECT 'protection_assets ' || pa.cim_mrid AS row, ce.cim_mrid AS ref FROM network.protection_assets pa JOIN network.conducting_equipment ce ON ce.id = pa.equipment_id WHERE pa.equipment_id = ANY($1::bigint[])`, [ids('conducting_equipment')]);
  await check('protection asset terminal', ['network', 'protection_assets', 'terminal_id'],
    `SELECT 'protection_assets ' || pa.cim_mrid AS row, x.cim_mrid AS ref FROM network.protection_assets pa JOIN network.terminals x ON x.id = pa.terminal_id WHERE pa.terminal_id = ANY($1::bigint[])`, [ids('terminals')]);
  // network.* rows of another source pointing at one of ours
  await check('another source\'s network row', ['network', 'terminals', 'equipment_id'],
    `SELECT 'network.terminals ' || x.cim_mrid AS row, ce.cim_mrid AS ref FROM network.terminals x JOIN network.conducting_equipment ce ON ce.id = x.equipment_id
       WHERE x.equipment_id = ANY($1::bigint[]) AND NOT (x.cim_mrid LIKE ANY($4))
     UNION ALL SELECT 'network.conducting_equipment ' || ce.cim_mrid, f.cim_mrid FROM network.conducting_equipment ce JOIN network.feeders f ON f.id = ce.feeder_id
       WHERE ce.feeder_id = ANY($2::bigint[]) AND NOT (ce.cim_mrid LIKE ANY($5))
     UNION ALL SELECT 'network.connectivity_nodes ' || n.cim_mrid, f.cim_mrid FROM network.connectivity_nodes n JOIN network.feeders f ON f.id = n.feeder_id
       WHERE n.feeder_id = ANY($2::bigint[]) AND NOT (n.cim_mrid LIKE ANY($6))
     UNION ALL SELECT 'network.feeders ' || f.cim_mrid, s.cim_mrid FROM network.feeders f JOIN network.substations s ON s.id = f.substation_id
       WHERE f.substation_id = ANY($3::bigint[]) AND NOT (f.cim_mrid LIKE ANY($7))`,
    [ids('conducting_equipment'), ids('feeders'), ids('substations'), OWNED.terminals, OWNED.conducting_equipment, OWNED.connectivity_nodes, OWNED.feeders]);
  return { refs, checked, skipped };
}

// Writes the build in one transaction: stale rows of this importer are
// deleted first (refused, with the references, if anything still uses
// them), then everything is upserted and read back. { dryRun: true } runs
// the same planning in a READ ONLY transaction and writes nothing.
export async function writeGraph(g, { dryRun = false, endPool = true } = {}) {
  const { db } = await import('./db.js'); // only the write path needs a database
  const ready = await db.one(`SELECT to_regclass('network.conducting_equipment') IS NOT NULL AS ok`);
  if (!ready.ok) throw new Error('network.* schema not found -- apply db/migrations/network_topology_schema.sql first');
  const feederMrid = feederMridOf(g);
  const CHUNK = 2000;
  const chunks = (rows) => Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_v, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK));
  const built = builtMrids(g);

  try {
  return await db.tx('import-haridwar-inferred', async (t) => {
    if (dryRun) await t.none('SET TRANSACTION READ ONLY');
    const { stale, nodesLeftAlone } = await ownedStale(t, built);
    const { refs, checked, skipped } = await staleReferences(t, stale);
    const toDelete = Object.fromEntries(TABLES.map((table) => [table, stale[table].length]));

    if (dryRun) {
      const existing = {};
      for (const table of TABLES) {
        existing[table] = (await t.one(`SELECT count(*)::int n FROM network.${table} WHERE cim_mrid = ANY($1)`, [built[table]])).n;
      }
      return {
        dryRun: true,
        wouldWrite: Object.fromEntries(TABLES.map((table) => [table, { total: built[table].length, update: existing[table], insert: built[table].length - existing[table] }])),
        wouldDelete: toDelete,
        wouldDeleteExamples: Object.fromEntries(TABLES.map((table) => [table, stale[table].slice(0, 5).map((r) => r.cim_mrid)])),
        nodesLeftAlone, referencesChecked: checked, referenceChecksSkipped: skipped,
        wouldRefuse: refs.length > 0, references: refs,
      };
    }
    if (refs.length) throw new ImportRefused(refs);

    // Our own rows that are rewritten below but still point at a stale row
    // are unhooked first; the upserts re-point them. (Another source's rows
    // pointing at ours were refused above.)
    const staleIds = (table) => stale[table].map((r) => r.id);
    await t.none(`UPDATE network.terminals SET connectivity_node_id = NULL WHERE connectivity_node_id = ANY($1::bigint[])`, [staleIds('connectivity_nodes')]);
    await t.none(`UPDATE network.conducting_equipment SET feeder_id = NULL WHERE feeder_id = ANY($1::bigint[]) AND cim_mrid LIKE ANY($2)`, [staleIds('feeders'), OWNED.conducting_equipment]);
    await t.none(`UPDATE network.connectivity_nodes SET feeder_id = NULL WHERE feeder_id = ANY($1::bigint[]) AND cim_mrid LIKE ANY($2)`, [staleIds('feeders'), OWNED.connectivity_nodes]);
    await t.none(`UPDATE network.feeders SET substation_id = NULL WHERE substation_id = ANY($1::bigint[]) AND cim_mrid LIKE ANY($2)`, [staleIds('substations'), OWNED.feeders]);
    const deleted = {};
    for (const table of TABLES) {
      deleted[table] = (await t.result(`DELETE FROM network.${table} WHERE id = ANY($1::bigint[])`, [staleIds(table)])).rowCount;
      if (deleted[table] !== stale[table].length) throw new Error(`${table}: meant to delete ${stale[table].length}, deleted ${deleted[table]} -- rolled back`);
    }

    await t.none(
      `INSERT INTO network.substations (cim_mrid, name, code, geog, raw_attrs)
       SELECT r.mrid, r.name, r.code, ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)::geography, r.attrs
       FROM jsonb_to_recordset($1::jsonb) AS r(mrid text, name text, code text, lon float8, lat float8, attrs jsonb)
       ON CONFLICT (cim_mrid) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code, geog=EXCLUDED.geog, raw_attrs=EXCLUDED.raw_attrs`,
      [JSON.stringify(g.substations.map((s) => ({ mrid: s.mrid, name: s.name, code: s.code, lon: s.lon, lat: s.lat, attrs: s.raw_attrs })))]
    );
    await t.none(
      `INSERT INTO network.feeders (cim_mrid, name, code, substation_id, raw_attrs)
       SELECT r.mrid, r.name, r.code, s.id, r.attrs
       FROM jsonb_to_recordset($1::jsonb) AS r(mrid text, name text, code text, sub text, attrs jsonb)
       LEFT JOIN network.substations s ON s.cim_mrid = r.sub
       ON CONFLICT (cim_mrid) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code,
         substation_id=EXCLUDED.substation_id, raw_attrs=EXCLUDED.raw_attrs`,
      [JSON.stringify(g.feeders.map((f) => ({ mrid: f.mrid, name: f.raw_attrs.names?.[0] ?? f.code, code: f.code, sub: f.substation ? `SS:${f.substation}` : null, attrs: f.raw_attrs })))]
    );
    for (const rows of chunks(g.equipment)) {
      await t.none(
        `INSERT INTO network.conducting_equipment (cim_mrid, cim_class, name, feeder_id, geog, path_geog, raw_attrs)
         SELECT r.mrid, r.cls, r.name, f.id,
           CASE WHEN r.lat IS NULL OR r.lon IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)::geography END,
           CASE WHEN r.wkt IS NULL THEN NULL ELSE ST_GeogFromText(r.wkt) END, r.attrs
         FROM jsonb_to_recordset($1::jsonb) AS r(mrid text, cls text, name text, feeder text, lon float8, lat float8, wkt text, attrs jsonb)
         LEFT JOIN network.feeders f ON f.cim_mrid = r.feeder
         ON CONFLICT (cim_mrid) DO UPDATE SET cim_class=EXCLUDED.cim_class, name=EXCLUDED.name, feeder_id=EXCLUDED.feeder_id,
           -- the latest build is the truth: a re-run must be able to clear a stale value (as importCimNetwork.js)
           geog=EXCLUDED.geog, path_geog=EXCLUDED.path_geog, raw_attrs=EXCLUDED.raw_attrs`,
        [JSON.stringify(rows.map((e) => ({
          mrid: e.mrid, cls: e.cim_class, name: e.name, feeder: feederMrid(e.feeder),
          lon: hasPos(e) ? e.lon : null, lat: hasPos(e) ? e.lat : null, wkt: e.path ? wkt(e.path) : null, attrs: e.raw_attrs,
        })))]
      );
    }
    for (const rows of chunks(g.nodes)) {
      await t.none(
        `INSERT INTO network.connectivity_nodes (cim_mrid, feeder_id)
         SELECT r.mrid, f.id FROM jsonb_to_recordset($1::jsonb) AS r(mrid text, feeder text)
         LEFT JOIN network.feeders f ON f.cim_mrid = r.feeder
         ON CONFLICT (cim_mrid) DO UPDATE SET feeder_id=EXCLUDED.feeder_id`,
        [JSON.stringify(rows.map((n) => ({ mrid: n.mrid, feeder: feederMrid(n.feeder) })))]
      );
    }
    for (const rows of chunks(g.terminals)) {
      await t.none(
        `INSERT INTO network.terminals (cim_mrid, equipment_id, connectivity_node_id, sequence_number)
         SELECT r.mrid, ce.id, cn.id, r.seq FROM jsonb_to_recordset($1::jsonb) AS r(mrid text, eq text, node text, seq int)
         JOIN network.conducting_equipment ce ON ce.cim_mrid = r.eq
         JOIN network.connectivity_nodes cn ON cn.cim_mrid = r.node
         ON CONFLICT (cim_mrid) DO UPDATE SET equipment_id=EXCLUDED.equipment_id,
           connectivity_node_id=EXCLUDED.connectivity_node_id, sequence_number=EXCLUDED.sequence_number`,
        [JSON.stringify(rows.map((x) => ({ mrid: x.mrid, eq: x.eq, node: x.node, seq: x.seq })))]
      );
    }

    // Read back what this run owns; any mismatch with the build -- a row
    // missing, or one of ours left over -- aborts the whole transaction
    // rather than leaving a half-written graph.
    const out = {};
    for (const [table, mrids] of Object.entries(built)) {
      const r = await t.one(
        `SELECT count(*) FILTER (WHERE cim_mrid = ANY($2))::int AS written,
                count(*) FILTER (WHERE NOT (cim_mrid = ANY($2)))::int AS leftover
         FROM network.${table} WHERE cim_mrid LIKE ANY($1)`,
        [OWNED[table], mrids]
      );
      if (r.written !== mrids.length) throw new Error(`${table}: built ${mrids.length}, found ${r.written} after write -- rolled back`);
      const allowed = table === 'connectivity_nodes' ? nodesLeftAlone : 0;
      if (r.leftover !== allowed) throw new Error(`${table}: ${r.leftover} row(s) of this importer left over after the stale delete (expected ${allowed}) -- rolled back`);
      out[table] = r.written;
    }
    const noGeog = await t.one(`SELECT count(*)::int n FROM network.conducting_equipment WHERE cim_mrid LIKE ANY($1) AND geog IS NULL`, [OWNED.conducting_equipment]);
    return { written: out, deleted, nodesLeftAlone, referencesChecked: checked, referenceChecksSkipped: skipped, equipmentWithNoGeog: noGeog.n };
  });
  } finally {
    if (endPool) await db.$pool.end();
  }
}

// ---- Summary ----

function summarize(g) {
  const { report } = g;
  const byClass = {};
  for (const e of g.equipment) byClass[e.cim_class] = (byClass[e.cim_class] || 0) + 1;
  const noGeog = g.equipment.filter((e) => !hasPos(e)).length;
  const connectedEq = new Set(g.terminals.map((t) => t.eq));
  const anchored = g.components.filter((c) => c.substations.length);
  const orphaned = g.components.filter((c) => !c.substations.length);
  const BINS = [[1, 1], [2, 2], [3, 5], [6, 10], [11, 50], [51, 200], [201, 1000], [1001, Infinity]];
  const hist = (cs) => Object.fromEntries(BINS.map(([lo, hi]) => [hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`, cs.filter((c) => c.equipment >= lo && c.equipment <= hi).length]));
  const sum = (cs) => cs.reduce((s, c) => s + c.equipment, 0);
  return {
    countsOut: { substations: g.substations.length, feeders: g.feeders.length, equipment: g.equipment.length, connectivityNodes: g.nodes.length, terminals: g.terminals.length },
    equipmentByClass: byClass,
    equipmentWithNoGeog: noGeog,
    equipmentWithNoTerminals: g.equipment.length - connectedEq.size,
    components: {
      total: g.components.length,
      substationAnchored: { components: anchored.length, equipment: sum(anchored) },
      orphanedFragments: { components: orphaned.length, equipment: sum(orphaned) },
    },
    sizeHistogram: { substationAnchored: hist(anchored), orphanedFragments: hist(orphaned) },
    largest: g.components.slice(0, 10).map((c) => ({ equipment: c.equipment, kind: c.substations.length ? 'substation-anchored' : 'orphaned fragment', substations: c.substations.join(' ') || '-', byClass: JSON.stringify(c.byClass) })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const write = process.argv.includes('--write');
  const dryRun = process.argv.includes('--dry-run');
  if (write && dryRun) { console.error('--write and --dry-run together: pick one'); process.exit(2); }
  const joinArg = process.argv.find((a) => a.startsWith('--join='));
  const lineJoinM = joinArg ? Number(joinArg.slice(7)) : LINE_JOIN_M;
  const net = JSON.parse(readFileSync(NET_PATH, 'utf8'));
  const t0 = Date.now();
  const g = buildGraph(net, { lineJoinM });
  const s = summarize(g);
  const r = g.report;

  console.log(write ? '[importHaridwarInferred] build, then WRITE to DATABASE_URL' : dryRun ? '[importHaridwarInferred] build, then DRY RUN against DATABASE_URL (read-only)' : '[importHaridwarInferred] IN-MEMORY BUILD ONLY -- nothing written to any database');
  console.log('source:', NET_PATH, `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('counts in:', Object.fromEntries(['substations', 'htLines', 'feederLines', 'switches', 'fuses', 'distTx', 'rmus', 'powerTx'].map((k) => [k, (net[k] || []).length])));
  console.log('not imported here: rmus (backfillRmusToProtectionAssets.js), top-level feeders list (feeders come from the lines)');
  console.log('lines skipped for a missing/invalid path (not guessed):', r.linesWithBadPath);
  console.log('duplicates:', r.dedup);
  console.log('counts out:', s.countsOut);
  console.log('equipment by class:', s.equipmentByClass);
  console.log(`equipment with no geog: ${s.equipmentWithNoGeog}; equipment with no terminals (unconnected): ${s.equipmentWithNoTerminals}`);
  console.log('line joins:', r.lineJoins);
  console.log('feederLines -> own substation bus:', { attached: r.feederLineToBus.attached, unresolved: r.feederLineToBus.unresolved, tooFar: r.feederLineToBus.tooFar.length });
  if (r.feederLineToBus.tooFar.length) console.table(r.feederLineToBus.tooFar);
  const jc = r.joinCandidates;
  const bare = jc.filter((x) => x.reason).length;
  console.log(`line-join candidates for human review (NOT joined), stored in raw_attrs.join_candidates: ${jc.length}`
    + ` -- ${jc.length - bare} line ends with no join <=${lineJoinM} m but another line ${lineJoinM}-${FLAG_M} m away (same feeder: ${jc.filter((x) => !x.reason && x.sameFeeder).length}, different: ${jc.filter((x) => !x.reason && !x.sameFeeder).length});`
    + ` ${bare} bare joins between different feeders over ${CROSS_FEEDER_BARE_JOIN_M} m (no device within ${BARE_JOIN_DEVICE_M} m)`);
  if (jc.length) console.table(jc.slice(0, 10));
  console.log(`powerTx -> own substation bus (id prefix and name code agree, <=${SUB_NEAR_M} m): attached ${r.powerTx.attached}, rejected ${r.powerTx.rejected.length}`);
  if (r.powerTx.rejected.length) console.table(r.powerTx.rejected);
  console.log('device placement modes:'); console.table(r.deviceModes);
  const oneTerminal = ['switches', 'fuses'].reduce((n, c) => n + (r.deviceModes[c]?.at_line_end || 0), 0);
  const inlineN = ['switches', 'fuses'].reduce((n, c) => n + (r.deviceModes[c]?.inline || 0), 0);
  console.log(`KNOWN GAP (accepted): ${oneTerminal} switches/fuses sit on a line end and have ONE terminal, so they are NOT section boundaries for sectionalize.js; only ${inlineN} in-line ones are.`);
  console.log(`snapped but flagged (${SNAP_M}-${FLAG_M} m): ${r.flagged.length}; cut points with several devices in parallel: ${r.parallelCuts}`);
  console.log(`distTx whose own feeder differs from the line it snapped to: ${r.feederMismatchDt.length}`);
  if (r.feederMismatchDt.length) console.table(r.feederMismatchDt.slice(0, 10));
  console.log('feeders with no substation resolved:', r.feedersWithoutSubstation);
  if (r.warnings.length) console.log('WARNINGS:', r.warnings);

  console.log('\n== Connected components ==');
  console.log(s.components);
  console.log('size histogram (equipment per component):');
  console.table(s.sizeHistogram);
  console.log('largest 10:');
  console.table(s.largest);

  // Sensitivity of the one tolerance not fixed by the audit.
  console.log('\nline-join tolerance sensitivity (components: total / substation-anchored / orphaned):');
  for (const m of [1, 10, 30]) {
    const gg = m === lineJoinM ? g : buildGraph(net, { lineJoinM: m });
    const a = gg.components.filter((c) => c.substations.length).length;
    console.log(`  LINE_JOIN_M=${m}${m === lineJoinM ? ' (used)' : ''}: ${gg.components.length} / ${a} / ${gg.components.length - a}; largest ${gg.components[0]?.equipment}`);
  }

  if (dryRun) {
    const plan = await writeGraph(g, { dryRun: true });
    console.log('\n[importHaridwarInferred] DRY RUN against DATABASE_URL (read-only transaction, nothing written):');
    console.log('would write (upsert):'); console.table(plan.wouldWrite);
    console.log('would delete (this importer\'s stale rows only):', plan.wouldDelete);
    console.log('examples:', plan.wouldDeleteExamples);
    console.log(`'CN:' nodes not produced by this build but used by another source's terminals (left alone): ${plan.nodesLeftAlone}`);
    console.log('reference checks run:', plan.referencesChecked);
    if (plan.referenceChecksSkipped.length) console.log('reference checks SKIPPED:', plan.referenceChecksSkipped);
    if (plan.wouldRefuse) { console.log(`--write WOULD BE REFUSED: ${plan.references.length} reference(s) to rows it would delete:`); console.table(plan.references); }
    else console.log('--write would proceed: no row it would delete is referenced.');
  }
  if (write) {
    try {
      const stats = await writeGraph(g);
      console.log('\n[importHaridwarInferred] written (one transaction):', stats);
    } catch (e) {
      if (!(e instanceof ImportRefused)) throw e;
      console.error(`\n[importHaridwarInferred] ${e.message}`);
      console.table(e.references);
      process.exit(1);
    }
  }
  process.exit(0);
}
