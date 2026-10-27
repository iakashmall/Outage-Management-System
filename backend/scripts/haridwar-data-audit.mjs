// OMS-05 step 1: diagnostic audit of the flat GIS extract
// (backend/src/infra/network.json) before any connectivity graph is inferred
// from it. Reads the file only -- writes NOTHING to the database.
//
// Reports what a human must sanity-check before the importer
// (src/infra/importHaridwarInferred.js) builds on it:
//
//   1. Status normalization. The source spells the same two states many ways
//      ('Connected'/'CONNECTED'/'Operational', 'Disconnted' [sic], '1'/'0',
//      ...). Every raw value is mapped explicitly in STATUS_MAP below; a value
//      NOT in the map is never defaulted -- it is counted as 'UNMAPPED' and
//      listed, so a new spelling in a later extract shows up instead of being
//      silently absorbed.
//   2. Feeder codes: htLines vs distTx, both directions, after the two agreed
//      merges (FEEDER_MERGES). A feeder with lines but no distTx is reported
//      as a visible gap, not accepted silently.
//   3. Identity: synthetic cim_mrid per class (SW:/FUSE:/DT:/RMU:, matching
//      backfillRmusToProtectionAssets.js), and in-class duplicate ids sorted
//      into "same record repeated" (dedup) vs "different devices sharing an
//      id" (suffixed).
//   4. Placement: distance from every switch/fuse/rmu/distTx to the nearest
//      point on any line SEGMENT (not just its endpoints -- decision
//      2026-10-26), over both line layers: htLines and feederLines. Bucketed
//      <=10 m snap, 10-30 m snap + flag, >30 m not snapped. A switch >30 m
//      from any line is then tried against its OWN substation (id prefix),
//      and only reported unconnected if that fails too.
//   5. Unconnected devices grouped by site.
//   6. What the rule changes bought: devices connected now that the old rule
//      (htLines endpoints only) left unconnected, by reason.
//
// Run (from backend/): node scripts/haridwar-data-audit.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hav } from '../src/infra/geo.js';

const _dir = dirname(fileURLToPath(import.meta.url));
const NET_PATH = join(_dir, '..', 'src', 'infra', 'network.json');

// Rules live in the importer so the audit and the import can never disagree.
import {
  STATUS_MAP, normalizeStatus, FEEDER_MERGES, feederCode, feederLineCode, MRID_PREFIX,
  DUP_SAME_M, SNAP_M, FLAG_M, SUB_NEAR_M, bucketOf, dedupe,
} from '../src/infra/importHaridwarInferred.js';

const hasPos = (r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon);
const metres = (a, b) => hav(a.lat, a.lon, b.lat, b.lon) * 1000;
// Device ids start with their substation id: '07H0115CSS00201' -> '07H01'.
const substationIdOf = (deviceId) => String(deviceId).slice(0, 5);

function audit(net) {
  // ---- 1. Status normalization ----
  const statusReport = {};
  for (const cls of Object.keys(STATUS_MAP)) {
    const rawCounts = new Map();
    const stateCounts = {};
    for (const r of net[cls] || []) {
      const n = normalizeStatus(cls, r.status);
      rawCounts.set(n.raw, (rawCounts.get(n.raw) || 0) + 1);
      const k = `${n.state}/${n.confidence}`;
      stateCounts[k] = (stateCounts[k] || 0) + 1;
    }
    statusReport[cls] = {
      mapping: [...rawCounts].sort((a, b) => b[1] - a[1]).map(([raw, count]) => {
        const n = normalizeStatus(cls, raw);
        return { raw: JSON.stringify(raw), count, state: n.state, confidence: n.confidence };
      }),
      result: stateCounts,
    };
  }

  const subIdByName = new Map((net.substations || []).map((s) => [s.name, s.id]));

  // ---- 2. Feeder codes, htLines vs distTx, after merges ----
  const group = (list, key) => {
    const m = new Map();
    for (const r of list) { const k = key(r); (m.get(k) || m.set(k, []).get(k)).push(r); }
    return m;
  };
  const lineFeeders = group(net.htLines || [], (r) => feederCode(r.feeder ?? ''));
  const dtFeeders = group(net.distTx || [], (r) => feederCode(r.feeder ?? ''));
  const listed = new Set(net.feeders || []);
  const merges = Object.entries(FEEDER_MERGES).map(([from, to]) => ({
    from, to,
    linesMerged: (net.htLines || []).filter((l) => l.feeder === from).length,
    targetExistsOnHtLines: (net.htLines || []).some((l) => l.feeder === to),
  }));
  const onlyOn = (a, b) => [...a.keys()].filter((k) => !b.has(k)).sort();
  const lineSample = (r) => ({ kv: r.kv, status: r.status, from: r.path?.[0], to: r.path?.at(-1) });
  const dtSample = (r) => ({ id: r.id, name: r.name, ss: r.ss, kva: r.kva, lat: r.lat, lon: r.lon });
  const feederReport = {
    merges,
    distinctOnHtLines: lineFeeders.size,
    distinctOnDistTx: dtFeeders.size,
    inBoth: [...lineFeeders.keys()].filter((k) => dtFeeders.has(k)).length,
    // Kept as real feeders (decision 2026-10-26), flagged as a visible gap.
    feederExistsNoDistTx: onlyOn(lineFeeders, dtFeeders).map((c) => ({
      feeder: c, htLines: lineFeeders.get(c).length, inFeedersList: listed.has(c),
      samples: lineFeeders.get(c).slice(0, 2).map(lineSample),
    })),
    distTxFeederNotOnHtLines: onlyOn(dtFeeders, lineFeeders).map((c) => ({
      feeder: c, distTx: dtFeeders.get(c).length, samples: dtFeeders.get(c).slice(0, 3).map(dtSample),
    })),
  };
  // feederLines: their FDR: codes; names folded together by the slug (must
  // be spelling variants only -- a human reads this list); ss names that do
  // not resolve to a substation (must be zero).
  const fdr = new Map();
  for (const l of net.feederLines || []) {
    const code = feederLineCode(l, subIdByName);
    const e = fdr.get(code) || fdr.set(code, { code, names: new Set(), ss: l.ss, lines: 0 }).get(code);
    e.names.add(l.feeder); e.lines++;
  }
  feederReport.feederLines = {
    lines: (net.feederLines || []).length,
    distinctFdrCodes: fdr.size,
    unresolvedSubstation: (net.feederLines || []).filter((l) => !subIdByName.has(l.ss)).map((l) => l.ss),
    spellingVariantsFolded: [...fdr.values()].filter((e) => e.names.size > 1).map((e) => ({ code: e.code, names: [...e.names] })),
    sample: [...fdr.values()].slice(0, 5).map((e) => ({ code: e.code, name: [...e.names][0], ss: e.ss, lines: e.lines })),
  };

  // ---- 3. Identity: per-class mRID prefix + duplicate ids ----
  const devices = {};
  const identityReport = {};
  for (const cls of Object.keys(MRID_PREFIX)) {
    const d = dedupe(cls, net[cls] || []);
    devices[cls] = d.out;
    identityReport[cls] = { in: (net[cls] || []).length, out: d.out.length, sameRecordRepeated: d.repeats, differentDevicesSharingId: d.shared };
  }
  const rawIds = (cls) => new Set((net[cls] || []).map((r) => r.id));
  const crossClassCollisions = [['switches', 'rmus'], ['switches', 'fuses'], ['switches', 'distTx'], ['fuses', 'distTx'], ['fuses', 'rmus'], ['distTx', 'rmus']]
    .map(([a, b]) => { const sb = rawIds(b); return { classes: `${a}/${b}`, sharedRawIds: [...rawIds(a)].filter((x) => sb.has(x)).length }; })
    .filter((x) => x.sharedRawIds);

  // ---- 4. Placement ----
  // Both line layers, every segment of every path; path points are [lat, lon].
  // A path with a non-finite point is skipped and counted, never repaired.
  const lines = [];
  const linesWithBadPath = { htLines: 0, feederLines: 0 };
  for (const [source, code] of [['htLines', (l) => feederCode(l.feeder)], ['feederLines', (l) => feederLineCode(l, subIdByName)]]) {
    for (const l of net[source] || []) {
      const p = l.path || [];
      if (p.length < 2 || p.some((e) => !Number.isFinite(e?.[0]) || !Number.isFinite(e?.[1]))) { linesWithBadPath[source]++; continue; }
      lines.push({ source, feeder: code(l), path: p });
    }
  }
  const K = 111320; // metres per degree of latitude
  const segM = (p, a, b) => { // point to segment, local equirectangular metres (fine below ~1 km)
    const c = Math.cos(p.lat * Math.PI / 180);
    const ax = (a[1] - p.lon) * K * c, ay = (a[0] - p.lat) * K, bx = (b[1] - p.lon) * K * c, by = (b[0] - p.lat) * K;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  };
  // Brute force: ~4.4k devices x ~5k segments, a couple of seconds.
  const nearestLine = (p, only) => {
    let best = { m: Infinity, line: null };
    for (const l of lines) {
      if (only && l.source !== only) continue;
      for (let i = 1; i < l.path.length; i++) {
        const m = segM(p, l.path[i - 1], l.path[i]);
        if (m < best.m) best = { m, line: l };
      }
    }
    return best;
  };
  const nearestM = (r) => nearestLine(r).m;
  // The previous rule (htLines endpoints only), kept solely to report in
  // section 6 what the segment rule and feederLines changed.
  const htEndpoints = lines.filter((l) => l.source === 'htLines').flatMap((l) => [l.path[0], l.path.at(-1)]);
  const oldRuleM = (r) => { let b = Infinity; for (const [la, lo] of htEndpoints) { const d = hav(r.lat, r.lon, la, lo); if (d < b) b = d; } return b * 1000; };
  const subById = new Map((net.substations || []).map((s) => [s.id, s]));
  const quantiles = (ds) => {
    ds = [...ds].sort((x, y) => x - y);
    const q = (f) => (ds.length ? +ds[Math.min(ds.length - 1, Math.floor(f * ds.length))].toFixed(2) : null);
    return { n: ds.length, medianM: q(0.5), p90M: q(0.9), maxM: ds.length ? +ds.at(-1).toFixed(1) : null };
  };

  const placementReport = {};
  const unconnected = [];
  const substationAttached = [];
  const gained = []; // connected now, unconnected under the old rule
  const nearestById = new Map();
  let lineAttachedSwitchDistances = [];
  for (const cls of Object.keys(MRID_PREFIX)) {
    const b = { snap: 0, snapFlagged: 0, toSubstation: 0, unconnected: 0, noPosition: 0, viaFeederLines: 0 };
    const ds = [];
    for (const r of devices[cls]) {
      const near = hasPos(r) ? nearestLine(r) : null;
      if (near) nearestById.set(r.mrid, near);
      const m = near ? near.m : null;
      let bucket = bucketOf(m);
      if (m != null) ds.push(m);
      if (m != null && m <= FLAG_M) {
        if (near.line.source === 'feederLines') b.viaFeederLines++;
        const oldM = oldRuleM(r);
        if (oldM > FLAG_M) {
          gained.push({
            mrid: r.mrid, oldEndpointM: Math.round(oldM), nowM: +m.toFixed(1), via: near.line.source, feeder: near.line.feeder,
            reason: near.line.source === 'feederLines' ? 'on a feederLine' : 'mid-span of an htLine',
          });
        }
      }
      // Switches only (decision 2026-10-26): >30 m from any line -> try the
      // substation named by the id prefix, confirmed by distance.
      if (cls === 'switches' && bucket === 'unconnected') {
        const sub = subById.get(substationIdOf(r.id));
        const subM = sub && hasPos(sub) ? metres(r, sub) : null;
        if (subM != null && subM <= SUB_NEAR_M) {
          bucket = 'toSubstation';
          substationAttached.push({ mrid: r.mrid, substation: sub.id, subM: Math.round(subM), lineM: Math.round(m) });
        } else {
          unconnected.push({ cls, mrid: r.mrid, type: r.type, feeder: r.feeder, lineM: Math.round(m), prefixSub: sub ? sub.id : `${substationIdOf(r.id)} (no such substation)`, subM: subM == null ? null : Math.round(subM) });
        }
      } else if (bucket === 'unconnected') {
        unconnected.push({ cls, mrid: r.mrid, type: r.type, feeder: r.feeder, lineM: Math.round(m), prefixSub: null, subM: null });
      }
      if (cls === 'switches' && bucket !== 'toSubstation' && m != null) lineAttachedSwitchDistances.push(m);
      b[bucket]++;
    }
    placementReport[cls] = { total: devices[cls].length, ...b, ...quantiles(ds) };
  }
  unconnected.sort((a, b) => b.lineM - a.lineM);

  // ---- 5. Unconnected devices grouped by site ----
  // Site id = the device id before its '.' suffix ('07H0115CSS00201.SW050' ->
  // '07H0115CSS00201'), which is also the id of that site's distTx/RMU. Every
  // member of a site is listed (connected ones too), so a site that is
  // wholly offset reads differently from one stray device.
  const siteOf = (mrid) => mrid.replace(/^[A-Z]+:/, '').replace(/#\d+$/, '').split('.')[0];
  const unconnectedMrids = new Set(unconnected.map((u) => u.mrid));
  const sites = new Map();
  for (const cls of Object.keys(MRID_PREFIX)) {
    for (const d of devices[cls]) {
      const site = siteOf(d.mrid);
      const s = sites.get(site) || sites.set(site, { site, members: [] }).get(site);
      s.members.push({ mrid: d.mrid, lat: d.lat, lon: d.lon, lineM: hasPos(d) ? Math.round(nearestM(d)) : null, unconnected: unconnectedMrids.has(d.mrid) });
    }
  }
  const unconnectedSites = [...sites.values()]
    .map((s) => ({ ...s, unconnected: s.members.filter((m) => m.unconnected).length }))
    .filter((s) => s.unconnected)
    .sort((a, b) => b.unconnected - a.unconnected || b.members.length - a.members.length);

  // ---- 6. What the rule changes bought (collected in the placement loop) ----
  gained.sort((a, b) => a.reason.localeCompare(b.reason) || a.mrid.localeCompare(b.mrid));
  const gainedByReason = {};
  for (const g of gained) gainedByReason[g.reason] = (gainedByReason[g.reason] || 0) + 1;

  const switchesByType = {};
  for (const s of devices.switches) switchesByType[s.type] = (switchesByType[s.type] || 0) + 1;
  const switchesNamed = {};
  for (const s of devices.switches) switchesNamed[s.name] = (switchesNamed[s.name] || 0) + 1;

  return {
    countsIn: Object.fromEntries(['substations', 'powerTx', 'distTx', 'switches', 'rmus', 'fuses', 'feederLines', 'htLines', 'feeders'].map((k) => [k, (net[k] || []).length])),
    linesWithBadPath,
    linesUsed: { htLines: lines.filter((l) => l.source === 'htLines').length, feederLines: lines.filter((l) => l.source === 'feederLines').length },
    statusReport, feederReport, identityReport, crossClassCollisions,
    switchesByType, switchesNamed,
    placementReport, substationAttached, unconnected, unconnectedSites, gained, gainedByReason,
    switchesAllQ: quantiles(devices.switches.filter(hasPos).map(nearestM)),
    switchesNotSubstationQ: quantiles(lineAttachedSwitchDistances),
  };
}

const net = JSON.parse(readFileSync(NET_PATH, 'utf8'));
const r = audit(net);

console.log('[haridwar-data-audit] source:', NET_PATH);
console.log('counts in:', r.countsIn);
console.log('lines used for snapping:', r.linesUsed, '; skipped for a missing/invalid path (not guessed):', r.linesWithBadPath);

console.log('\n== 1. Status normalization (state + confidence) ==');
for (const [cls, s] of Object.entries(r.statusReport)) {
  console.log(`\n${cls}:`);
  console.table(s.mapping);
  console.log('  result:', s.result);
}
console.log('\nrmus: not normalized -- status is', JSON.stringify([...new Set((net.rmus || []).map((x) => x.status))]), '(no signal; see backfillRmusToProtectionAssets.js)');

console.log('\n== 2. Feeder codes (htLines vs distTx) ==');
const f = r.feederReport;
console.log('merges applied (original string kept in raw_attrs by the importer):');
console.table(f.merges);
console.log(`distinct on htLines: ${f.distinctOnHtLines}, on distTx: ${f.distinctOnDistTx}, in both: ${f.inBoth}`);
console.log(`\nfeeder exists, no distTx records found (${f.feederExistsNoDistTx.length}):`);
for (const x of f.feederExistsNoDistTx) console.log(JSON.stringify(x));
console.log(`\ndistTx feeder not on any htLine (${f.distTxFeederNotOnHtLines.length}):`);
for (const x of f.distTxFeederNotOnHtLines) console.log(JSON.stringify(x));
console.log(`\nfeederLines: ${f.feederLines.lines} lines -> ${f.feederLines.distinctFdrCodes} FDR:<substation>:<name> codes (own id space, never merged with UPCL-*)`);
console.log(`  ss name not resolved to a substation (must be 0): ${f.feederLines.unresolvedSubstation.length}`, f.feederLines.unresolvedSubstation);
console.log(`  spelling variants folded into one code (check these are the same feeder): ${f.feederLines.spellingVariantsFolded.length}`);
for (const x of f.feederLines.spellingVariantsFolded) console.log('   ', JSON.stringify(x));
console.log('  sample:');
console.table(f.feederLines.sample);

console.log('\n== 3. Identity (mRID prefixes', JSON.stringify(MRID_PREFIX), ') ==');
console.log('raw ids shared across classes (resolved by the prefixes):', r.crossClassCollisions);
for (const [cls, x] of Object.entries(r.identityReport)) {
  console.log(`\n${cls}: ${x.in} in -> ${x.out} unique devices`);
  if (x.sameRecordRepeated.length) { console.log(`  same record repeated (all other fields identical, <=${DUP_SAME_M} m apart) -> deduplicated: ${x.sameRecordRepeated.length}`); console.table(x.sameRecordRepeated); }
  if (x.differentDevicesSharingId.length) { console.log(`  different devices sharing an id (identical attributes but far apart) -> suffixed: ${x.differentDevicesSharingId.length}`); console.table(x.differentDevicesSharingId); }
}

console.log('\n== 4. Placement ==');
console.log('switch `type` values:', r.switchesByType, '\nswitch `name` values:', r.switchesNamed);
console.log(`\nline: snap <=${SNAP_M} m, flag ${SNAP_M}-${FLAG_M} m; switches >${FLAG_M} m -> own substation (id prefix) if within ${SUB_NEAR_M} m; else unconnected`);
console.table(r.placementReport);
console.log('\nswitch -> nearest line (segment, both layers) distance:');
console.table({ allSwitches: r.switchesAllQ, excludingSubstationAttached: r.switchesNotSubstationQ });
console.log(`\nattached to own substation: ${r.substationAttached.length}`);
console.table(r.substationAttached);
const byCls = {};
for (const u of r.unconnected) byCls[u.cls] = (byCls[u.cls] || 0) + 1;
console.log(`\ngenuinely unconnected: ${r.unconnected.length}`, byCls, '-- farthest 15:');
console.table(r.unconnected.slice(0, 15));

console.log(`\n== 5. Unconnected devices grouped by site (${r.unconnectedSites.length} sites) ==`);
console.table(r.unconnectedSites.map((s) => {
  const ms = s.members.map((m) => m.lineM).filter((x) => x != null);
  const lat = s.members.reduce((a, m) => a + m.lat, 0) / s.members.length;
  const lon = s.members.reduce((a, m) => a + m.lon, 0) / s.members.length;
  return { site: s.site, members: s.members.length, unconnected: s.unconnected, lineMmin: Math.min(...ms), lineMmax: Math.max(...ms), at: `${lat.toFixed(6)},${lon.toFixed(6)}` };
}));
console.log('\nlargest 5 sites, every member:');
for (const s of r.unconnectedSites.slice(0, 5)) {
  console.log(`\n${s.site}`);
  console.table(s.members.map(({ mrid, lineM, unconnected }) => ({ mrid, lineM, unconnected })));
}

console.log(`\n== 6. Connected now, unconnected under the old rule (htLines endpoints only) ==`);
console.log(`${r.gained.length} devices`, r.gainedByReason);
console.table(r.gained);
