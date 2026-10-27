// The equipment / terminal / connectivity-node graph (network.* schema),
// loaded and walked one hop at a time. Shared by the section trace
// (sectionalize.js) and anything else that walks the same graph, so the
// loading and the truncation reporting exist once.
//
// Breadth-first, one query per hop, with an in-memory visited set: each
// device is visited exactly once, loops terminate, and depth is the true
// shortest hop count. If a safety limit stops the walk, the result says so
// (truncated: true) instead of quietly returning a partial set. (Why BFS and
// not a recursive SQL query: see sectionalize.js.)
import { db } from '../infra/db.js';

// One device by mRID: { id, cim_mrid, cim_class, name } or null.
export const equipmentByMrid = (cimMrid) =>
  db.oneOrNone('SELECT id, cim_mrid, cim_class, name FROM network.conducting_equipment WHERE cim_mrid = $1', [cimMrid]);

// Every device sharing a connectivity node with any device in `ids`.
export const neighbours = (ids) => db.any(
  `SELECT DISTINCT ce2.id, ce2.cim_mrid, ce2.cim_class, ce2.name
   FROM network.terminals t1
   JOIN network.terminals t2 ON t2.connectivity_node_id = t1.connectivity_node_id AND t2.id <> t1.id
   JOIN network.conducting_equipment ce2 ON ce2.id = t2.equipment_id
   WHERE t1.equipment_id = ANY($1::bigint[])`,
  [ids]
);

// The same hop, also saying through which connectivity node each device was
// reached and from which device -- for walks that must report a path.
export const neighboursVia = (ids) => db.any(
  `SELECT DISTINCT ON (ce2.id) ce2.id, ce2.cim_mrid, ce2.cim_class, ce2.name, t1.equipment_id AS from_id, cn.cim_mrid AS via_node
   FROM network.terminals t1
   JOIN network.terminals t2 ON t2.connectivity_node_id = t1.connectivity_node_id AND t2.id <> t1.id
   JOIN network.conducting_equipment ce2 ON ce2.id = t2.equipment_id
   JOIN network.connectivity_nodes cn ON cn.id = t1.connectivity_node_id
   WHERE t1.equipment_id = ANY($1::bigint[])
   ORDER BY ce2.id, t1.equipment_id, cn.cim_mrid`,
  [ids]
);

// How many terminals each device has (a device with one terminal sits at a
// line end and cannot separate anything).
export async function terminalCounts(ids) {
  const rows = await db.any('SELECT equipment_id, count(*)::int AS n FROM network.terminals WHERE equipment_id = ANY($1::bigint[]) GROUP BY equipment_id', [ids]);
  return new Map(rows.map((r) => [String(r.equipment_id), r.n]));
}

// The devices attached to each connectivity node whose mRID starts with
// `prefix`: Map equipment id -> [node mRID, ...].
export async function devicesOnNodes(prefix) {
  const rows = await db.any(
    `SELECT t.equipment_id, cn.cim_mrid FROM network.terminals t
     JOIN network.connectivity_nodes cn ON cn.id = t.connectivity_node_id
     WHERE cn.cim_mrid LIKE $1 ORDER BY cn.cim_mrid`, [prefix + '%']);
  const m = new Map();
  for (const r of rows) { const k = String(r.equipment_id); m.set(k, [...(m.get(k) || []), r.cim_mrid]); }
  return m;
}

// The devices attached to one connectivity node, as walk origins.
export const devicesOnNode = (nodeMrid) => db.any(
  `SELECT ce.id, ce.cim_mrid, ce.cim_class, ce.name FROM network.terminals t
   JOIN network.connectivity_nodes cn ON cn.id = t.connectivity_node_id
   JOIN network.conducting_equipment ce ON ce.id = t.equipment_id
   WHERE cn.cim_mrid = $1 ORDER BY ce.id`, [nodeMrid]);

/**
 * Walk outward from `origin` (a row from equipmentByMrid).
 * @param {object} opts
 * @param {(row) => boolean} [opts.expand] whether to walk on past a device
 *   reached after the origin (the origin itself is always expanded: the walk
 *   goes away from it, not through it). Default: every device.
 * @param {number} [opts.maxHops=1000]  safety limit on graph depth
 * @param {number} [opts.maxNodes=20000] safety limit on devices visited
 * @param {boolean} [opts.withPath=false] also record, per device, the device
 *   it was reached from (from_id) and the connectivity node between them (via_node)
 * `origin` may also be an array of devices, all at depth 0 (several sources);
 * opts.expandOrigins=false applies `expand` to them as well.
 * @returns {{ rows: object[], truncated: boolean }} rows in visit order:
 *   { equipment_id, cim_mrid, cim_class, name, depth } (+ from_id, via_node)
 */
export async function walk(origin, { expand = () => true, maxHops = 1000, maxNodes = 20000, withPath = false, expandOrigins = true } = {}) {
  const seen = new Map(); // equipment id -> row
  const origins = Array.isArray(origin) ? origin : [origin];
  for (const o of origins) seen.set(String(o.id), { equipment_id: o.id, cim_mrid: o.cim_mrid, cim_class: o.cim_class, name: o.name, depth: 0 });

  let frontier = [...seen.values()].filter((r) => expandOrigins || expand(r)).map((r) => r.equipment_id);
  let depth = 0;
  let truncated = false;
  while (frontier.length) {
    if (depth >= maxHops || seen.size >= maxNodes) { truncated = true; break; }
    const next = [];
    for (const r of await (withPath ? neighboursVia : neighbours)(frontier)) {
      const key = String(r.id);
      if (seen.has(key)) continue;
      const row = { equipment_id: r.id, cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name, depth: depth + 1 };
      if (withPath) Object.assign(row, { from_id: r.from_id, via_node: r.via_node });
      seen.set(key, row);
      if (expand(row)) next.push(r.id);
    }
    frontier = next;
    depth++;
  }
  return { rows: [...seen.values()], truncated };
}
