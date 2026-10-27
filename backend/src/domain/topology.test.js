import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawLinesImported } from './topology.js';
import { lineMrid } from '../infra/importHaridwarInferred.js';

// Two substations' areas whose extents overlap: area A's line and area B's
// line run through the same box (B's even shares A's path exactly). Only A's
// line was imported, so only A's is hidden -- position plays no part.
const shared = [[29.95, 78.16], [29.96, 78.17]];
const net = {
  htLines: [
    { feeder: 'AREA-A-F1', path: shared },                     // imported
    { feeder: 'AREA-B-F1', path: shared },                     // same path, other area: not imported
    { feeder: 'AREA-B-F2', path: [[29.951, 78.161], [29.959, 78.169]] }, // inside A's extent: not imported
  ],
  feederLines: [
    { feeder: 'AREA-A-F1', path: shared },                     // same record as htLines[0] but another source
  ],
};

test('only the raw line whose own mRID was imported is hidden, even with overlapping areas', () => {
  const imported = new Set([lineMrid('htLines', net.htLines[0])]);
  assert.deepEqual(rawLinesImported(net, imported), { htLines: [0], feederLines: [] });
});

test('the source is part of the identity: an imported feeder line does not hide the HT line on the same path', () => {
  const imported = new Set([lineMrid('feederLines', net.feederLines[0])]);
  assert.deepEqual(rawLinesImported(net, imported), { htLines: [], feederLines: [0] });
});

test('nothing imported, or no raw lines at all: nothing hidden', () => {
  assert.deepEqual(rawLinesImported(net, new Set()), { htLines: [], feederLines: [] });
  assert.deepEqual(rawLinesImported({}, new Set(['LINE:x'])), { htLines: [], feederLines: [] });
});
