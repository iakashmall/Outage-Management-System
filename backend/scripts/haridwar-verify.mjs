// OMS-05 step 3: verifies the Haridwar inferred graph AS WRITTEN to the
// database (src/infra/importHaridwarInferred.js --write), independently of
// the in-memory build: everything below is read back from network.* through
// DATABASE_URL. Read-only.
//
// Reports: row counts per table (this importer's mRID prefixes only),
// equipment with no position, and connected components recomputed from
// terminals/connectivity_nodes -- size distribution, and substation-anchored
// (contains a CN:SS:* bus node) vs orphaned fragment. Expected result for
// this extract is many small components, not one dominant one.
//
// Run (from backend/): DATABASE_URL=... node scripts/haridwar-verify.mjs
import 'dotenv/config';
import { db } from '../src/infra/db.js';

const EQ = ['LINE:%', 'SW:%', 'FUSE:%', 'DT:%', 'PT:%'];

const counts = await db.one(
  `SELECT
     (SELECT count(*) FROM network.substations WHERE cim_mrid LIKE 'SS:%')::int AS substations,
     (SELECT count(*) FROM network.feeders WHERE cim_mrid LIKE 'FEEDER:%' OR cim_mrid LIKE 'FDR:%')::int AS feeders,
     (SELECT count(*) FROM network.conducting_equipment WHERE cim_mrid LIKE ANY($1))::int AS equipment,
     (SELECT count(*) FROM network.connectivity_nodes WHERE cim_mrid LIKE 'CN:%')::int AS connectivity_nodes,
     (SELECT count(*) FROM network.terminals WHERE cim_mrid LIKE ANY($1))::int AS terminals`,
  [EQ]
);
const byClass = await db.any(
  `SELECT cim_class, count(*)::int n FROM network.conducting_equipment WHERE cim_mrid LIKE ANY($1) GROUP BY 1 ORDER BY 2 DESC`, [EQ]
);
const noPos = await db.one(
  `SELECT count(*) FILTER (WHERE geog IS NULL)::int AS no_geog,
          count(*) FILTER (WHERE cim_class = 'ACLineSegment' AND path_geog IS NULL)::int AS line_without_path,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM network.terminals t WHERE t.equipment_id = ce.id))::int AS no_terminals
   FROM network.conducting_equipment ce WHERE cim_mrid LIKE ANY($1)`, [EQ]
);
const modes = await db.any(
  `SELECT cim_class, raw_attrs->'placement'->>'mode' AS mode, count(*)::int n
   FROM network.conducting_equipment WHERE cim_mrid LIKE ANY($1) AND cim_class <> 'ACLineSegment'
   GROUP BY 1, 2 ORDER BY 1, 2`, [EQ]
);

// Components: union-find over connectivity nodes, joined through equipment.
const terms = await db.any(
  `SELECT ce.cim_mrid AS eq, ce.cim_class AS cls, cn.cim_mrid AS node
   FROM network.terminals t
   JOIN network.conducting_equipment ce ON ce.id = t.equipment_id
   JOIN network.connectivity_nodes cn ON cn.id = t.connectivity_node_id
   WHERE ce.cim_mrid LIKE ANY($1)`, [EQ]
);
const parent = new Map();
const find = (k) => { if (!parent.has(k)) parent.set(k, k); let r = k; while (parent.get(r) !== r) r = parent.get(r); parent.set(k, r); return r; };
const nodesOf = new Map();
for (const t of terms) (nodesOf.get(t.eq) || nodesOf.set(t.eq, { cls: t.cls, nodes: [] }).get(t.eq)).nodes.push(t.node);
for (const { nodes } of nodesOf.values()) for (let i = 1; i < nodes.length; i++) parent.set(find(nodes[i]), find(nodes[0]));
const comps = new Map();
for (const [, { cls, nodes }] of nodesOf) {
  const c = comps.get(find(nodes[0])) || comps.set(find(nodes[0]), { equipment: 0, byClass: {}, subs: new Set() }).get(find(nodes[0]));
  c.equipment++;
  c.byClass[cls] = (c.byClass[cls] || 0) + 1;
}
for (const node of new Set(terms.map((t) => t.node))) if (node.startsWith('CN:SS:')) comps.get(find(node))?.subs.add(node.slice(6));
const all = [...comps.values()].sort((a, b) => b.equipment - a.equipment);
const anchored = all.filter((c) => c.subs.size);
const orphaned = all.filter((c) => !c.subs.size);
const BINS = [[1, 1], [2, 2], [3, 5], [6, 10], [11, 50], [51, 200], [201, 1000], [1001, Infinity]];
const hist = (cs) => Object.fromEntries(BINS.map(([lo, hi]) => [hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`, cs.filter((c) => c.equipment >= lo && c.equipment <= hi).length]));
const sum = (cs) => cs.reduce((s, c) => s + c.equipment, 0);

console.log('[haridwar-verify] read back from the database');
console.log('counts:', counts);
console.log('equipment by class:'); console.table(byClass);
console.log('position / connectivity:', noPos);
console.log('placement modes:'); console.table(modes);
console.log('\ncomponents:', {
  total: all.length,
  substationAnchored: { components: anchored.length, equipment: sum(anchored) },
  orphanedFragments: { components: orphaned.length, equipment: sum(orphaned) },
});
console.log('size histogram (equipment per component):');
console.table({ substationAnchored: hist(anchored), orphanedFragments: hist(orphaned) });
console.log('largest 10:');
console.table(all.slice(0, 10).map((c) => ({ equipment: c.equipment, kind: c.subs.size ? 'substation-anchored' : 'orphaned fragment', substations: [...c.subs].join(' ') || '-', byClass: JSON.stringify(c.byClass) })));
await db.$pool.end();
