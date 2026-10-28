// Inferred Haridwar importer, database side (infra/importHaridwarInferred.js
// writeGraph): stale rows of this importer are deleted in the same
// transaction, rows of other sources are never touched, --dry-run writes
// nothing, and a stale row that something still references refuses the
// whole run. Uses a tiny synthetic GIS extract (SELFTEST ids), not network.json.
// Runs against a scratch database (it refuses one that holds a real Haridwar import):
//   DATABASE_URL=<scratch db> node src/selftest-haridwar-import.js
process.env.PORT = process.env.PORT || '4100';
import { readFileSync } from 'node:fs';
import { migrate, db } from './infra/db.js';
import { buildGraph, writeGraph, ImportRefused } from './infra/importHaridwarInferred.js';

if (!process.env.DATABASE_URL) {
  console.error('selftest-haridwar-import: set DATABASE_URL to a scratch database');
  process.exit(2);
}

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

await migrate();
if (!(await db.oneOrNone("SELECT 1 FROM pg_extension WHERE extname = 'postgis'"))) {
  console.log('  [FAIL] selftest-haridwar-import needs PostGIS on this database');
  process.exit(1);
}
if (!(await db.one("SELECT to_regclass('network.conducting_equipment') IS NOT NULL AS ok")).ok) {
  await db.none(readFileSync(new URL('../../db/migrations/network_topology_schema.sql', import.meta.url), 'utf8'));
}
await migrate(); // incidents.tripped_equipment_id gets its foreign key once network.* exists

const OWNED_EQ = ['LINE:%', 'SW:%', 'FUSE:%', 'DT:%', 'PT:%'];
const real = await db.one(`SELECT count(*)::int n FROM network.conducting_equipment WHERE cim_mrid LIKE ANY($1) AND coalesce(raw_attrs->'original'->>'selftest', '') <> 'true'`, [OWNED_EQ]);
if (real.n) {
  console.error(`selftest-haridwar-import: this database holds ${real.n} rows of a real Haridwar import, which the test would delete -- use a fresh scratch database`);
  process.exit(2);
}

// ---- synthetic extract: metres east of a fixed origin ----
const O = [29.9, 78.1];
const at = (east, north = 0) => [O[0] + north / 111320, O[1] + east / (111320 * Math.cos(O[0] * Math.PI / 180))];
const pos = (e, n) => { const [lat, lon] = at(e, n); return { lat, lon }; };
const L = (from, to) => ({ feeder: 'SELFTEST-A', status: '', selftest: true, path: [at(from), at(to)] });
const NET1 = {
  substations: [{ id: 'SELFTESTSS', name: 'SELFTEST S/s', code: 'SELFTEST-A', selftest: true, ...pos(-50, 0) }],
  htLines: [L(0, 100), L(100, 200), L(200, 300)],
  feederLines: [],
  switches: [{ id: 'SELFTESTSW1', type: 'ABS', status: 'CLOSED', selftest: true, ...pos(50, 0) }],
  fuses: [],
  distTx: [{ id: 'SELFTESTDT1', name: 'SELFTEST DT', kva: '100', feeder: 'SELFTEST-A', selftest: true, ...pos(150, 0) }],
  rmus: [], powerTx: [],
};
// the next run's extract: the last line, the transformer and the substation are gone
// (our feeder still points at that substation: it must be unhooked, then rewritten)
const NET2 = { ...NET1, substations: [], htLines: NET1.htLines.slice(0, 2), distTx: [] };
const g1 = buildGraph(structuredClone(NET1));
const g2 = buildGraph(structuredClone(NET2));
const L3 = g1.equipment.find((e) => e.cim_class === 'ACLineSegment' && !g2.equipment.some((x) => x.mrid === e.mrid) && e.lat > at(150)[0] - 1 && e.lon >= at(199)[1]);

const TABLES = ['terminals', 'conducting_equipment', 'connectivity_nodes', 'feeders', 'substations'];
const OWNED = { terminals: OWNED_EQ, conducting_equipment: OWNED_EQ, connectivity_nodes: ['CN:%'], feeders: ['FEEDER:%', 'FDR:%'], substations: ['SS:%'] };
// (selftest-topology.js's own 'CN:SELFTEST-' nodes, if that test ran here first, are not ours and not counted)
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await db.one(
  `SELECT count(*)::int n FROM network.${t} WHERE cim_mrid LIKE ANY($1) AND cim_mrid NOT LIKE 'CN:SELFTEST-%' AND cim_mrid NOT LIKE 'CN:SS:SELFTEST-%'`, [OWNED[t]])).n])));
const exists = async (table, mrid) => !!(await db.oneOrNone(`SELECT 1 FROM network.${table} WHERE cim_mrid = $1`, [mrid]));
const idOf = async (mrid) => (await db.one('SELECT id FROM network.conducting_equipment WHERE cim_mrid = $1', [mrid])).id;

// leftovers of an earlier run of this test
await db.none(`UPDATE incidents SET tripped_equipment_id = NULL WHERE id = 'SELFTEST-IMPORT-INC'`).catch(() => {});
await db.none(`DELETE FROM incidents WHERE id = 'SELFTEST-IMPORT-INC'`);
await db.none(`DELETE FROM network.protection_assets WHERE cim_mrid LIKE 'RMU:SELFTEST-%'`);
await db.none(`DELETE FROM network.terminals WHERE cim_mrid LIKE 'SELFTEST-DDN-%'`);
await db.none(`DELETE FROM network.conducting_equipment WHERE cim_mrid LIKE 'SELFTEST-DDN-%'`);
await db.none(`DELETE FROM network.connectivity_nodes WHERE cim_mrid LIKE 'SELFTEST-DDN-%'`);
await db.none(`DELETE FROM network.feeders WHERE cim_mrid LIKE 'SELFTEST-DDN-%'`);

try {
  console.log('-- first write');
  let r = await writeGraph(g1, { endPool: false });
  const c1 = await counts();
  check('first write: every built row written and read back',
    c1.conducting_equipment === g1.equipment.length && c1.terminals === g1.terminals.length && c1.connectivity_nodes === g1.nodes.length && c1.substations === 1,
    JSON.stringify(r.written));
  check('... the test removes a line and a transformer next run', !!L3 && g1.equipment.some((e) => e.mrid === 'DT:SELFTESTDT1') && !g2.equipment.some((e) => e.mrid === 'DT:SELFTESTDT1'), L3?.mrid);

  // Rows of another source: a Dehradun-like line (no importer prefix) on its
  // own feeder and node, with a second terminal on one of OUR nodes that the
  // next run drops; and an RMU protection asset.
  const farNode = g1.terminals.find((t) => t.eq === L3.mrid && t.seq === 2).node;
  await db.none(`INSERT INTO network.feeders (cim_mrid, name, code) VALUES ('SELFTEST-DDN-F', 'x', 'x')`);
  await db.none(`INSERT INTO network.connectivity_nodes (cim_mrid) VALUES ('SELFTEST-DDN-N1')`);
  const ddn = await db.one(`INSERT INTO network.conducting_equipment (cim_mrid, cim_class, feeder_id) VALUES ('SELFTEST-DDN-1', 'ACLineSegment', (SELECT id FROM network.feeders WHERE cim_mrid = 'SELFTEST-DDN-F')) RETURNING id`);
  await db.none(`INSERT INTO network.terminals (cim_mrid, equipment_id, connectivity_node_id, sequence_number) VALUES
    ('SELFTEST-DDN-1#T1', $1, (SELECT id FROM network.connectivity_nodes WHERE cim_mrid = 'SELFTEST-DDN-N1'), 1),
    ('SELFTEST-DDN-1#T2', $1, (SELECT id FROM network.connectivity_nodes WHERE cim_mrid = $2), 2)`, [ddn.id, farNode]);
  await db.none(`INSERT INTO network.protection_assets (cim_mrid, kind, name, geog) VALUES ('RMU:SELFTEST-1', 'RTU', 'x', public.ST_SetSRID(public.ST_MakePoint($2, $1), 4326)::public.geography)`, at(10));

  console.log('-- dry run');
  const before = await counts();
  const plan = await writeGraph(g2, { dryRun: true, endPool: false });
  const after = await counts();
  check('dry run writes nothing', JSON.stringify(before) === JSON.stringify(after) && await exists('conducting_equipment', L3.mrid));
  check('dry run reports the stale rows it would delete',
    plan.wouldDelete.conducting_equipment >= 2 && plan.wouldDeleteExamples.conducting_equipment.includes('DT:SELFTESTDT1') && plan.wouldDeleteExamples.conducting_equipment.includes(L3.mrid)
    && plan.wouldDelete.terminals >= 3 && plan.wouldDelete.substations === 1 && plan.wouldRefuse === false, JSON.stringify(plan.wouldDelete));
  // our far node, plus selftest-topology.js's 'CN:SELFTEST-' nodes if that test ran here first
  const otherCn = (await db.one(`SELECT count(*)::int n FROM network.connectivity_nodes WHERE cim_mrid LIKE 'CN:SELFTEST-%' OR cim_mrid LIKE 'CN:SS:SELFTEST-%'`)).n;
  check('... and leaves alone our node that another source\'s terminal uses', plan.nodesLeftAlone === 1 + otherCn, `${plan.nodesLeftAlone} (other sources' CN: nodes here: ${otherCn})`);
  check('... every reference check ran here (no column missing)', plan.referenceChecksSkipped.length === 0 && plan.referencesChecked.length >= 7, plan.referenceChecksSkipped.join('; '));

  console.log('-- write with stale rows');
  r = await writeGraph(g2, { endPool: false });
  check('stale rows deleted in the same transaction, counts read back',
    !(await exists('conducting_equipment', L3.mrid)) && !(await exists('conducting_equipment', 'DT:SELFTESTDT1')) && !(await exists('substations', 'SS:SELFTESTSS'))
    && r.deleted.conducting_equipment === plan.wouldDelete.conducting_equipment && r.deleted.terminals === plan.wouldDelete.terminals, JSON.stringify(r.deleted));
  const c2 = await counts();
  check('only the build remains (plus the one node another source uses)',
    c2.conducting_equipment === g2.equipment.length && c2.terminals === g2.terminals.length && c2.connectivity_nodes === g2.nodes.length + 1 && c2.substations === 0, JSON.stringify(c2));
  check('rows of other sources untouched: their line, feeder, nodes, terminals, and the RMU',
    await exists('conducting_equipment', 'SELFTEST-DDN-1') && await exists('feeders', 'SELFTEST-DDN-F') && await exists('connectivity_nodes', 'SELFTEST-DDN-N1')
    && await exists('connectivity_nodes', farNode) && await exists('terminals', 'SELFTEST-DDN-1#T2') && !!(await db.oneOrNone(`SELECT 1 FROM network.protection_assets WHERE cim_mrid = 'RMU:SELFTEST-1'`)));
  r = await writeGraph(g2, { endPool: false });
  check('re-running the same build deletes nothing more', Object.values(r.deleted).every((n) => n === 0), JSON.stringify(r.deleted));

  console.log('-- refusal when a stale row is referenced');
  await writeGraph(g1, { endPool: false }); // the line and the transformer are back
  await db.none(`INSERT INTO incidents (id, type, severity, status, opened_at, tripped_equipment_id) VALUES ('SELFTEST-IMPORT-INC', 'Power Outage', 'low', 'closed', now(), $1)`, [await idOf('DT:SELFTESTDT1')]);
  await db.none(`INSERT INTO network.protection_assets (cim_mrid, kind, name, equipment_id) VALUES ('RMU:SELFTEST-2', 'FaultIndicator', 'x', $1)`, [await idOf(L3.mrid)]);
  const held = await counts();
  let refused = null;
  try { await writeGraph(g2, { endPool: false }); } catch (e) { refused = e; }
  check('a referenced stale row refuses the whole run', refused instanceof ImportRefused, refused?.message);
  const refs = refused?.references || [];
  check('... naming each reference: the incident and the protection asset',
    refs.some((x) => x.check === 'incident tripped equipment' && x.row === 'incidents SELFTEST-IMPORT-INC' && x.references === 'DT:SELFTESTDT1')
    && refs.some((x) => x.check === 'protection asset equipment' && x.row === 'protection_assets RMU:SELFTEST-2' && x.references === L3.mrid), JSON.stringify(refs));
  check('... and rolls back: nothing deleted or written',
    JSON.stringify(await counts()) === JSON.stringify(held) && await exists('conducting_equipment', 'DT:SELFTESTDT1') && await exists('conducting_equipment', L3.mrid));
  const dry = await writeGraph(g2, { dryRun: true, endPool: false });
  check('the dry run says it would be refused, with the same references', dry.wouldRefuse === true && dry.references.length === refs.length);

  // tidy up: drop the references, and the run goes through
  await db.none(`UPDATE incidents SET tripped_equipment_id = NULL WHERE id = 'SELFTEST-IMPORT-INC'`);
  await db.none(`DELETE FROM network.protection_assets WHERE cim_mrid = 'RMU:SELFTEST-2'`);
  r = await writeGraph(g2, { endPool: false });
  check('with the references gone, the same run succeeds', r.deleted.conducting_equipment >= 2 && !(await exists('conducting_equipment', 'DT:SELFTESTDT1')));
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
}
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
await db.$pool.end().catch(() => {});
process.exit(fails ? 1 : 0);
