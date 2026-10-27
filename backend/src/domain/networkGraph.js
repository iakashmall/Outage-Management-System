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

/**
 * Walk outward from `origin` (a row from equipmentByMrid).
 * @param {object} opts
 * @param {(row) => boolean} [opts.expand] whether to walk on past a device
 *   reached after the origin (the origin itself is always expanded: the walk
 *   goes away from it, not through it). Default: every device.
 * @param {number} [opts.maxHops=1000]  safety limit on graph depth
 * @param {number} [opts.maxNodes=20000] safety limit on devices visited
 * @returns {{ rows: object[], truncated: boolean }} rows in visit order:
 *   { equipment_id, cim_mrid, cim_class, name, depth }
 */
export async function walk(origin, { expand = () => true, maxHops = 1000, maxNodes = 20000 } = {}) {
  const seen = new Map(); // equipment id -> row
  seen.set(String(origin.id), { equipment_id: origin.id, cim_mrid: origin.cim_mrid, cim_class: origin.cim_class, name: origin.name, depth: 0 });

  let frontier = [origin.id];
  let depth = 0;
  let truncated = false;
  while (frontier.length) {
    if (depth >= maxHops || seen.size >= maxNodes) { truncated = true; break; }
    const next = [];
    for (const r of await neighbours(frontier)) {
      const key = String(r.id);
      if (seen.has(key)) continue;
      const row = { equipment_id: r.id, cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name, depth: depth + 1 };
      seen.set(key, row);
      if (expand(row)) next.push(r.id);
    }
    frontier = next;
    depth++;
  }
  return { rows: [...seen.values()], truncated };
}
