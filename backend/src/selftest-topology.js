// Upstream trace and what-if (OMS-05, domain/supplyTrace.js) on a tiny
// synthetic graph of SELFTEST- mRIDs built here -- independent of any import.
// Needs PostGIS (network.* is applied here when missing).
// Runs against a scratch database:
//   DATABASE_URL=<scratch db> node src/selftest-topology.js
//
//  Component A (anchored), inferred (raw_attrs.source network.json#...):
//
//   [CN:SS:SELFTEST-A] -L1- N1 -SW1- N2 -L2- N3 -L3- N4
//          |                                |        |
//         PT1 (on the bus)            DT1 100 kVA   DT3 250 kVA
//                                     DT2 (no kVA)  FUSE1 (one terminal)
//
//  Component B (orphaned fragment, not inferred): N9 -L9- N10 -DT9
process.env.PORT = process.env.PORT || '4100';
import express from 'express';
import { readFileSync } from 'node:fs';
import { migrate, db } from './infra/db.js';
import { api } from './routes/api.js';

if (!process.env.DATABASE_URL) {
  console.error('selftest-topology: set DATABASE_URL to a scratch database');
  process.exit(2);
}

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

await migrate();
if (!(await db.oneOrNone("SELECT 1 FROM pg_extension WHERE extname = 'postgis'"))) {
  console.log('  [FAIL] selftest-topology needs PostGIS on this database');
  process.exit(1);
}
if (!(await db.one("SELECT to_regclass('network.conducting_equipment') IS NOT NULL AS ok")).ok) {
  await db.none(readFileSync(new URL('../../db/migrations/network_topology_schema.sql', import.meta.url), 'utf8'));
}

// ---- the synthetic graph (re-runs start clean) ----
await db.none(`DELETE FROM network.terminals WHERE cim_mrid LIKE 'SELFTEST-T:%'`);
await db.none(`DELETE FROM network.connectivity_nodes WHERE cim_mrid LIKE 'CN:SS:SELFTEST-%' OR cim_mrid LIKE 'CN:SELFTEST-%'`);
await db.none(`DELETE FROM network.conducting_equipment WHERE cim_mrid LIKE 'SELFTEST-%'`);
const INF = (kva) => ({ source: 'network.json#selftest', original: kva === undefined ? {} : { kva } });
const EQ = {
  'SELFTEST-L1': ['ACLineSegment', ['CN:SS:SELFTEST-A', 'CN:SELFTEST-N1'], INF()],
  'SELFTEST-PT1': ['PowerTransformer', ['CN:SS:SELFTEST-A'], INF('5000')],
  'SELFTEST-SW1': ['Disconnector', ['CN:SELFTEST-N1', 'CN:SELFTEST-N2'], INF()],
  'SELFTEST-L2': ['ACLineSegment', ['CN:SELFTEST-N2', 'CN:SELFTEST-N3'], INF()],
  'SELFTEST-DT1': ['PowerTransformer', ['CN:SELFTEST-N3'], INF('100')],
  'SELFTEST-DT2': ['PowerTransformer', ['CN:SELFTEST-N3'], INF()],
  'SELFTEST-L3': ['ACLineSegment', ['CN:SELFTEST-N3', 'CN:SELFTEST-N4'], INF()],
  'SELFTEST-DT3': ['PowerTransformer', ['CN:SELFTEST-N4'], INF('250')],
  'SELFTEST-FUSE1': ['Fuse', ['CN:SELFTEST-N4'], INF()],
  'SELFTEST-L9': ['ACLineSegment', ['CN:SELFTEST-N9', 'CN:SELFTEST-N10'], {}],
  'SELFTEST-DT9': ['PowerTransformer', ['CN:SELFTEST-N10'], {}],
};
for (const [mrid, [cls, nodes, attrs]] of Object.entries(EQ)) {
  const { id } = await db.one(`INSERT INTO network.conducting_equipment (cim_mrid, cim_class, name, raw_attrs) VALUES ($1, $2, $1, $3::jsonb) RETURNING id`, [mrid, cls, JSON.stringify(attrs)]);
  for (const [i, n] of nodes.entries()) {
    const cn = await db.one(`INSERT INTO network.connectivity_nodes (cim_mrid) VALUES ($1) ON CONFLICT (cim_mrid) DO UPDATE SET cim_mrid = EXCLUDED.cim_mrid RETURNING id`, [n]);
    await db.none(`INSERT INTO network.terminals (cim_mrid, equipment_id, connectivity_node_id, sequence_number) VALUES ($1, $2, $3, $4)`, [`SELFTEST-T:${mrid}:${i + 1}`, id, cn.id, i + 1]);
  }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { username: 'op.sharma', roles: ['oms_operator'], crewId: null }; next(); });
app.use('/api', api);

const server = app.listen(0, async () => {
  const { port } = server.address();
  const call = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const set = (xs) => xs.map((x) => x.cim_mrid).sort().join(',');
  let r;
  try {
    console.log('-- section trace on the synthetic graph (the shared walk)');
    r = await call('GET', '/network/section/SELFTEST-DT3');
    check('section trace: switch-class devices bound the section',
      r.status === 200 && set(r.body.sectionEquipment) === 'SELFTEST-DT1,SELFTEST-DT2,SELFTEST-DT3,SELFTEST-L2,SELFTEST-L3'
      && set(r.body.boundarySwitches) === 'SELFTEST-FUSE1,SELFTEST-SW1', `${set(r.body.sectionEquipment || [])} | ${set(r.body.boundarySwitches || [])}`);

    console.log('-- upstream trace');
    r = await call('GET', '/network/upstream/SELFTEST-DT3');
    const path = r.body.path || [];
    check('path found to the substation bus node, in order, nodes between devices',
      r.status === 200 && r.body.pathFound === true && r.body.source.node === 'CN:SS:SELFTEST-A' && r.body.source.hops === 4
      && path.map((p) => p.cim_mrid).join(' > ') === 'SELFTEST-DT3 > CN:SELFTEST-N4 > SELFTEST-L3 > CN:SELFTEST-N3 > SELFTEST-L2 > CN:SELFTEST-N2 > SELFTEST-SW1 > CN:SELFTEST-N1 > SELFTEST-L1 > CN:SS:SELFTEST-A'
      && path.at(-1).substationBus === true, path.map((p) => p.cim_mrid).join(' > '));
    check('every switch on the path is listed with state unknown, and said plainly',
      r.body.switchesOnPath?.length === 1 && r.body.switchesOnPath[0].cim_mrid === 'SELFTEST-SW1' && r.body.switchesOnPath[0].state === 'unknown'
      && /unknown/.test(r.body.switchStateNote) && /not known/.test(r.body.caveat));
    check('inferred data says it is inferred; one source in the component', r.body.inferred === true && /INFERRED/.test(r.body.inferredNote) && r.body.alternateSourcesInComponent === 0);
    r = await call('GET', '/network/upstream/SELFTEST-DT9');
    check('no substation node in the component -> "no path" result (200, not an error)',
      r.status === 200 && r.body.pathFound === false && /No path to a substation in this data/.test(r.body.reason) && r.body.componentSize === 2 && !r.body.path);
    check('... and data not from the inferred import is not labelled inferred', r.body.inferred === false && !r.body.inferredNote);
    r = await call('GET', '/network/upstream/SELFTEST-NOPE');
    check('unknown device -> 404', r.status === 404 && r.body.found === false);

    console.log('-- what-if');
    r = await call('POST', '/network/whatif', { assumedOpen: ['SELFTEST-SW1'] });
    const w = r.body;
    check('in-line two-terminal switch cuts off everything downstream of it',
      r.status === 200 && set(w.lostSupply) === 'SELFTEST-DT1,SELFTEST-DT2,SELFTEST-DT3,SELFTEST-FUSE1,SELFTEST-L2,SELFTEST-L3'
      && w.counts.baselineDevices === 9 && w.counts.lostDevices === 6 && w.assumedOpen[0].effective === true, set(w.lostSupply || []));
    check('default source: the nearest substation bus node, chosen by inference, alternates counted',
      w.source?.mrids.join() === 'CN:SS:SELFTEST-A' && w.source.chosenBy === 'inference' && /inference/.test(w.source.note) && w.source.alternateSourcesInComponent === 0);
    check('the baseline assumption and simulation label are in the response',
      /EVERY switch treated as closed/.test(w.assumptions?.baseline) && w.simulation === 'Simulation - not live state' && w.inferred === true);
    check('DT count and kVA: bus transformer excluded, missing kVA makes the total a lower bound',
      w.distributionTransformers?.count === 3 && w.distributionTransformers.kvaTotal === 350 && w.distributionTransformers.withoutKva === 1
      && w.distributionTransformers.kvaIsLowerBound === true && /lower bound: 1 of 3/.test(w.distributionTransformers.label), JSON.stringify(w.distributionTransformers));
    r = await call('POST', '/network/whatif', { assumedOpen: ['SELFTEST-FUSE1'] });
    check('one-terminal device: effective false with the reason, not an empty "finding"',
      r.status === 200 && r.body.assumedOpen[0].effective === false && /1 terminal\(s\).*separates nothing/.test(r.body.assumedOpen[0].reason) && r.body.counts.lostDevices === 0);
    r = await call('POST', '/network/whatif', { assumedOpen: ['SELFTEST-L9'] });
    check('no source in the component and none given -> 422 NO_SOURCE', r.status === 422 && r.body.code === 'NO_SOURCE' && /pass sourceMrid/.test(r.body.message));
    r = await call('POST', '/network/whatif', { assumedOpen: ['SELFTEST-L9'], sourceMrid: 'CN:SELFTEST-N9' });
    check('... with sourceMrid given: that source is used, chosen by the caller',
      r.status === 200 && r.body.source.chosenBy === 'caller' && set(r.body.lostSupply) === 'SELFTEST-DT9' && r.body.distributionTransformers.count === 1
      && r.body.distributionTransformers.kvaIsLowerBound === true && r.body.inferred === false);
    r = await call('POST', '/network/whatif', { assumedOpen: [] });
    check('empty assumedOpen -> 400', r.status === 400 && r.body.code === 'BAD_INPUT');
    r = await call('POST', '/network/whatif', { assumedOpen: ['SELFTEST-NOPE'] });
    check('unknown device -> 404', r.status === 404 && r.body.code === 'EQUIPMENT_NOT_FOUND');
  } catch (e) {
    fails++;
    console.log('  [FAIL] unexpected error', e.stack);
  }
  console.log('  ----------------------------------------');
  console.log(`  ${passes}/${passes + fails} passed`);
  server.close();
  await db.$pool.end().catch(() => {});
  process.exit(fails ? 1 : 0);
});
