// Upstream trace and what-if (OMS-05, Phase B), on the same graph walk as
// the section trace (networkGraph.js).
//
// What this can and cannot say, given the data we have (see
// docs/OMS05_topology_limits.md):
//  * Switch open/closed state is unknown (SECTION_CAVEAT). The upstream path
//    lists every switch on it with state 'unknown'; the what-if baseline
//    ASSUMES every switch closed and says so in its response.
//  * A source is a substation bus connectivity node (mRID prefix BUS_PREFIX,
//    written by the inferred importer). A CIM export without such nodes has
//    no source here: upstream reports "no path", what-if needs sourceMrid.
//  * The default what-if source is ONE node: the nearest by hops from the
//    first assumed-open device, reported as chosen by inference. Several
//    sources only when the caller names them -- in an inferred graph, other
//    substations joined through incomers (or a false join) would otherwise
//    hide real losses.
//  * Equipment imported from the GIS extract is inferred, and every response
//    built on it says so (inferred: true).
import { db } from '../infra/db.js';
import { equipmentByMrid, walk, devicesOnNodes, devicesOnNode, terminalCounts } from './networkGraph.js';
import { SECTION_CAVEAT, SWITCH_CLASSES } from './sectionalize.js';

export const BUS_PREFIX = 'CN:SS:';
const INFERRED_NOTE = 'Connectivity here is INFERRED from GIS geometry, not a vendor network model: treat paths and losses as indicative.';
const SWITCH_STATE_NOTE = 'The open/closed state of every switch on this path is unknown in this data.';
const BASELINE_NOTE = 'Baseline: everything reachable from the source with EVERY switch treated as closed (real switch states are unknown).';

const brief = (r) => ({ cim_mrid: r.cim_mrid, cim_class: r.cim_class, name: r.name });

// true when any of these devices came from the inferred GIS import.
async function inferred(ids) {
  const r = await db.one(`SELECT coalesce(bool_or(raw_attrs->>'source' LIKE 'network.json#%'), false) AS v
    FROM network.conducting_equipment WHERE id = ANY($1::bigint[])`, [ids]);
  return r.v;
}
const honesty = async (ids) => {
  const inf = await inferred(ids);
  return { inferred: inf, ...(inf ? { inferredNote: INFERRED_NOTE } : {}), caveat: SECTION_CAVEAT };
};

/**
 * The path from a device to the nearest substation bus node (by hops),
 * walking through every device: switch states are unknown, so none blocks.
 * { found: false, reason } for an unknown mRID; pathFound: false (not an
 * error) when the device's component has no substation bus node.
 */
export async function traceUpstream(cimMrid, { maxHops = 1000, maxNodes = 20000 } = {}) {
  const origin = await equipmentByMrid(cimMrid);
  if (!origin) return { found: false, reason: `no equipment with cim_mrid '${cimMrid}'` };
  const buses = await devicesOnNodes(BUS_PREFIX);
  const { rows, truncated } = await walk(origin, { withPath: true, maxHops, maxNodes });
  const onBus = rows.filter((r) => buses.has(String(r.equipment_id))); // visit order: nearest first
  const base = { found: true, origin: brief(origin), truncated, ...(await honesty([origin.id])) };

  if (!onBus.length) {
    return { ...base, pathFound: false, componentSize: rows.length,
      reason: truncated
        ? `No substation found before the walk's safety limit (${rows.length} devices visited); the result is incomplete.`
        : `No path to a substation in this data: the ${rows.length} device(s) connected to this one reach no substation bus node.` };
  }

  // Back from the nearest bus device to the origin, then forwards as
  // equipment, node, equipment, ..., bus node.
  const byId = new Map(rows.map((r) => [String(r.equipment_id), r]));
  const chain = [];
  for (let r = onBus[0]; r; r = r.from_id != null ? byId.get(String(r.from_id)) : null) chain.unshift(r);
  const sourceNode = buses.get(String(onBus[0].equipment_id))[0];
  const path = [];
  chain.forEach((r, i) => {
    if (i > 0) path.push({ type: 'node', cim_mrid: r.via_node });
    path.push({ type: 'equipment', ...brief(r), hops: r.depth });
  });
  path.push({ type: 'node', cim_mrid: sourceNode, substationBus: true });

  const sourceNodes = new Set(onBus.flatMap((r) => buses.get(String(r.equipment_id))));
  return {
    ...base,
    pathFound: true,
    source: { node: sourceNode, hops: onBus[0].depth },
    path,
    switchesOnPath: chain.filter((r) => SWITCH_CLASSES.includes(r.cim_class)).map((r) => ({ ...brief(r), state: 'unknown' })),
    switchStateNote: SWITCH_STATE_NOTE,
    alternateSourcesInComponent: sourceNodes.size - 1,
  };
}

const fail = (status, code, message, extra = {}) => ({ error: { status, code, message, ...extra } });

/**
 * What-if: which devices lose supply from the source(s) when `assumedOpen`
 * devices are opened, compared with the baseline (every switch closed).
 * Returns { error: { status, code, message } } for bad input, unknown
 * devices, or (422) no source in this data and none given.
 */
export async function simulateOpen({ assumedOpen, sourceMrid } = {}, { maxHops = 1000, maxNodes = 20000 } = {}) {
  if (!Array.isArray(assumedOpen) || !assumedOpen.length || !assumedOpen.every((m) => typeof m === 'string' && m)) {
    return fail(400, 'BAD_INPUT', 'assumedOpen must be a non-empty list of device mRIDs');
  }
  const devices = await Promise.all(assumedOpen.map(equipmentByMrid));
  const missing = assumedOpen.filter((_, i) => !devices[i]);
  if (missing.length) return fail(404, 'EQUIPMENT_NOT_FOUND', `no equipment with cim_mrid ${missing.map((m) => `'${m}'`).join(', ')}`);

  // Sources: the caller's (a connectivity node or a device mRID each), or
  // the single nearest substation bus node of the first device.
  let sources = [];
  let source;
  const given = sourceMrid == null ? [] : [].concat(sourceMrid);
  if (given.length) {
    for (const m of given) {
      const onNode = await devicesOnNode(m);
      const eq = onNode.length ? null : await equipmentByMrid(m);
      if (!onNode.length && !eq) return fail(404, 'SOURCE_NOT_FOUND', `no connectivity node or equipment with mRID '${m}'`);
      sources.push(...(onNode.length ? onNode : [eq]));
    }
    source = { mrids: given, chosenBy: 'caller' };
  } else {
    const up = await traceUpstream(assumedOpen[0], { maxHops, maxNodes });
    if (!up.pathFound) {
      return fail(422, 'NO_SOURCE', `No substation bus node is connected to ${assumedOpen[0]} in this data, so there is no default source; pass sourceMrid.`, { reason: up.reason });
    }
    sources = await devicesOnNode(up.source.node);
    source = {
      mrids: [up.source.node], chosenBy: 'inference',
      note: `Chosen by inference: the substation bus node nearest to ${assumedOpen[0]} (${up.source.hops} hops). Pass sourceMrid to choose another.`,
      alternateSourcesInComponent: up.alternateSourcesInComponent,
    };
  }

  const opts = { maxHops, maxNodes };
  const baseline = await walk(sources, opts);
  const reached = new Set(baseline.rows.map((r) => String(r.equipment_id)));
  const openAll = new Set(devices.map((d) => String(d.id)));
  const cut = (open) => walk(sources, { ...opts, expandOrigins: false, expand: (r) => !open.has(String(r.equipment_id)) });
  const scenario = await cut(openAll);
  const live = new Set(scenario.rows.map((r) => String(r.equipment_id)));
  const lost = baseline.rows.filter((r) => !live.has(String(r.equipment_id)));
  let truncated = baseline.truncated || scenario.truncated;

  // Per device: does opening it, on its own, separate anything here?
  const terms = await terminalCounts(devices.map((d) => d.id));
  const perDevice = [];
  for (const d of devices) {
    const k = String(d.id);
    let effective = true, reason = null;
    if ((terms.get(k) || 0) < 2) {
      effective = false;
      reason = `It has ${terms.get(k) || 0} terminal(s) in this data (it sits at a line end), so opening it separates nothing.`;
    } else if (!reached.has(k)) {
      effective = false;
      reason = 'It is not supplied from the chosen source in this data, so opening it changes nothing there.';
    } else {
      const alone = devices.length === 1 ? scenario : await cut(new Set([k]));
      truncated = truncated || alone.truncated;
      if (alone.rows.length === baseline.rows.length) {
        effective = false;
        reason = 'Another path around it exists in this data, so opening it alone cuts no device off.';
      }
    }
    perDevice.push({ ...brief(d), effective, ...(reason ? { reason } : {}) });
  }

  // Distribution transformers among the lost devices: PowerTransformers not
  // on a substation bus. kVA from the original GIS record's kva attribute.
  const buses = await devicesOnNodes(BUS_PREFIX);
  const lostDt = lost.filter((r) => r.cim_class === 'PowerTransformer' && !buses.has(String(r.equipment_id)));
  const kvaRows = lostDt.length ? await db.any(`SELECT id, raw_attrs->'original'->>'kva' AS kva FROM network.conducting_equipment WHERE id = ANY($1::bigint[])`, [lostDt.map((r) => r.equipment_id)]) : [];
  const kvas = kvaRows.map((r) => Number(r.kva)).filter((v) => Number.isFinite(v) && v > 0);
  const withoutKva = lostDt.length - kvas.length;
  const kvaTotal = kvas.reduce((a, b) => a + b, 0);

  return {
    simulation: 'Simulation - not live state',
    assumptions: { baseline: BASELINE_NOTE, switchState: 'The open/closed state of every switch in this network is unknown in this data.' },
    source,
    assumedOpen: perDevice,
    lostSupply: lost.map((r) => ({ ...brief(r), hops: r.depth })),
    counts: { baselineDevices: baseline.rows.length, lostDevices: lost.length },
    distributionTransformers: {
      count: lostDt.length, kvaTotal, withoutKva, kvaIsLowerBound: withoutKva > 0,
      label: withoutKva > 0
        ? `${kvaTotal} kVA is a lower bound: ${withoutKva} of ${lostDt.length} transformer(s) have no kVA in the data.`
        : `${kvaTotal} kVA from ${lostDt.length} transformer(s).`,
    },
    truncated,
    ...(truncated ? { truncatedNote: "A walk hit its safety limit; the result is incomplete." } : {}),
    ...(await honesty([...devices.map((d) => d.id), ...sources.map((s) => s.id)])),
  };
}
