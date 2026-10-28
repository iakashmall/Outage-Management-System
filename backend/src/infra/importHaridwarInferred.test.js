// Line-join rules of the inferred Haridwar importer (buildGraph, in memory,
// no database): the node diameter cap, the cross-feeder bare-join rule, and
// that the result does not depend on the order of the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, lineMrid, NODE_MAX_SPAN_M, CROSS_FEEDER_BARE_JOIN_M } from './importHaridwarInferred.js';

// Synthetic positions: metres east/north of a fixed origin.
const O = [29.9, 78.1];
const at = (east, north) => [O[0] + north / 111320, O[1] + east / (111320 * Math.cos(O[0] * Math.PI / 180))];
const line = (feeder, from, to) => ({ feeder, path: [at(...from), at(...to)] });
const net = (htLines, extra = {}) => ({ substations: [], htLines, feederLines: [], switches: [], fuses: [], distTx: [], rmus: [], powerTx: [], ...extra });

// node mRIDs each line touches
const nodesOfLine = (g, l) => {
  const m = lineMrid('htLines', l);
  return new Set(g.terminals.filter((t) => t.eq === m || t.eq.startsWith(`${m}/`)).map((t) => t.node));
};
const share = (g, a, b) => [...nodesOfLine(g, a)].some((n) => nodesOfLine(g, b).has(n));

test('diameter cap: a chain of joins never puts ends more than NODE_MAX_SPAN_M apart in one node', () => {
  // three line ends 6 m apart in a row: L1-L2 and L2-L3 are each within 10 m,
  // L1-L3 is 12 m -- chained, all three would share one 12 m node
  const L1 = line('F1', [0, 0], [-100, 0]);
  const L2 = line('F1', [6, 0], [6, 100]);
  const L3 = line('F1', [12, 0], [112, 0]);
  const g = buildGraph(net([L1, L2, L3]));
  assert.ok(NODE_MAX_SPAN_M < 12);
  assert.ok(!(share(g, L1, L2) && share(g, L2, L3) && share(g, L1, L3)), 'all three ends ended up in one node');
  assert.ok(share(g, L1, L2) || share(g, L2, L3), 'the 6 m join was not made at all');
  assert.ok(g.report.lineJoins.refusedByNodeSpanCap >= 1);
});

test('diameter cap: the closest candidate wins', () => {
  // L2's end is 3 m from L1 and 7 m from L3; L1-L3 is 10.5 m, so only one can share L2's node
  const L1 = line('F1', [0, 0], [-100, 0]);
  const L2 = line('F1', [3, 0], [3, 100]);
  const L3 = line('F1', [10.5, 0], [110, 0]);
  const g = buildGraph(net([L1, L2, L3]));
  assert.ok(share(g, L1, L2), 'the 3 m join should win');
  assert.ok(!share(g, L2, L3));
});

test('cross-feeder bare join: made at 3 m or less, a join candidate beyond it', () => {
  const near = buildGraph(net([line('FA', [0, 0], [-100, 0]), line('FB', [CROSS_FEEDER_BARE_JOIN_M - 1, 0], [100, 0])]));
  assert.equal(near.report.lineJoins.refusedCrossFeederBare, 0);
  const a = line('FA', [0, 0], [-100, 0]), b = line('FB', [5, 0], [100, 0]);
  const far = buildGraph(net([a, b]));
  assert.ok(!share(far, a, b), 'a bare 5 m join between two feeders must not be made');
  const cands = far.equipment.filter((e) => e.raw_attrs.join_candidates?.some((c) => /different feeders/.test(c.reason)));
  assert.ok(cands.length >= 1, 'the refused join is recorded in raw_attrs.join_candidates');
  assert.equal(cands[0].raw_attrs.join_candidates[0].distanceM, 5);
});

test('cross-feeder join over 3 m is still made when a device is within 10 m, and same-feeder joins are unaffected', () => {
  const a = line('FA', [0, 0], [-100, 0]), b = line('FB', [5, 0], [100, 0]);
  const withFuse = buildGraph(net([a, b], { fuses: [{ id: 'SELFTESTF1', lat: at(2.5, 6)[0], lon: at(2.5, 6)[1], status: '' }] }));
  assert.ok(share(withFuse, a, b), 'a device near the join makes it a plausible tie point');
  const c = line('FA', [0, 0], [-100, 0]), d = line('FA', [5, 0], [100, 0]);
  assert.ok(share(buildGraph(net([c, d])), c, d), 'same feeder: joined as before');
});

test('order independence: shuffled input lines give the same nodes and terminals', () => {
  // a dense cluster of short lines whose ends chain within 10 m of each other
  const lines = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) {
    const x = i * 4 + j * 1.3, y = j * 3.1;
    lines.push(line(i % 3 === 0 ? 'FA' : 'FB', [x, y], [x + (i % 2 ? 40 : -40), y + (j - 1) * 25]));
  }
  const sig = (g) => JSON.stringify({ nodes: g.nodes.map((n) => n.mrid).sort(), terminals: g.terminals.map((t) => `${t.mrid}=${t.node}`).sort(), comps: g.components.length });
  const g0 = buildGraph(net(lines));
  // only meaningful if the cluster actually makes both rules refuse joins
  assert.ok(g0.report.lineJoins.refusedByNodeSpanCap > 0 && g0.report.lineJoins.refusedCrossFeederBare > 0, JSON.stringify(g0.report.lineJoins));
  const base = sig(g0);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 3; k++) {
    const shuffled = [...lines];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    assert.equal(sig(buildGraph(net(shuffled))), base, `shuffle ${k + 1} changed the graph`);
  }
});
