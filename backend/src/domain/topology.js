// Serves the network.* topology as GeoJSON for the Network Map's "Topology
// (CIM)" layers. Reads the PostGIS schema directly -- the Haridwar layers on
// the same map still come from network.json; this is the first map layer
// backed by real connectivity data.
//
// Lines come from path_geog (full ordered path, recovered from UTM by the
// importer); everything else is a Point from geog. Equipment with no
// geometry at all is left out rather than drawn at a made-up location.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../infra/db.js';
import { lineMrid } from '../infra/importHaridwarInferred.js';

const NET_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'network.json');
let rawNet = null;
const loadRawNet = () => {
  if (!rawNet) { try { rawNet = JSON.parse(readFileSync(NET_PATH, 'utf8')); } catch { rawNet = {}; } }
  return rawNet;
};

// Which raw network.json lines (by array index, as served by GET /network)
// have their own line in the imported topology. Exact, by id: a raw line's
// topology mRID is derived from its own record (lineMrid), so a raw line
// counts as imported only if THAT mRID -- or a piece of it, '<mrid>/<n>' --
// exists. Position plays no part, so a neighbouring area cannot hide it.
export function rawLinesImported(net, importedLineMrids) {
  const out = {};
  for (const source of ['htLines', 'feederLines']) {
    out[source] = [];
    (net[source] || []).forEach((l, i) => { if (importedLineMrids.has(lineMrid(source, l))) out[source].push(i); });
  }
  return out;
}

export async function topologyGeoJSON() {
  const rows = await db.any(`
    SELECT ce.cim_mrid, ce.cim_class, ce.name,
           f.name AS feeder, f.cim_mrid AS feeder_mrid,
           ST_AsGeoJSON(COALESCE(ce.path_geog, ce.geog)::geometry, 7)::json AS geometry,
           ce.raw_attrs->>'sedms:ConductingEquipment.ratedVoltage' AS rated_voltage
    FROM network.conducting_equipment ce
    LEFT JOIN network.feeders f ON f.id = ce.feeder_id
    WHERE COALESCE(ce.path_geog, ce.geog) IS NOT NULL
    ORDER BY ce.cim_class, ce.cim_mrid`);

  const subs = await db.any(`
    SELECT cim_mrid, name, code, ST_AsGeoJSON(geog::geometry, 7)::json AS geometry
    FROM network.substations`);

  // Substations that actually have imported topology (equipment on one of
  // their feeders), with the extent of that equipment -- the map labels its
  // topology layer and builds its jump targets from these, so a newly
  // imported area appears without a code change. Equipment on no feeder
  // (e.g. an unconnected device) belongs to no area and is not counted.
  const areas = await db.any(`
    SELECT cim_mrid, name, code, equipment,
           ST_XMin(box) AS w, ST_YMin(box) AS s, ST_XMax(box) AS e, ST_YMax(box) AS n
    FROM (
      SELECT s.cim_mrid, s.name, s.code, count(*)::int AS equipment,
             ST_Extent(COALESCE(ce.path_geog, ce.geog)::geometry) AS box
      FROM network.substations s
      JOIN network.feeders f ON f.substation_id = s.id
      JOIN network.conducting_equipment ce ON ce.feeder_id = f.id
      WHERE COALESCE(ce.path_geog, ce.geog) IS NOT NULL
      GROUP BY s.id, s.cim_mrid, s.name, s.code
    ) a
    ORDER BY name`);

  const imported = new Set(rows.filter((r) => r.cim_mrid.startsWith('LINE:')).map((r) => r.cim_mrid.split('/')[0]));

  const features = rows.map((r) => ({
    type: 'Feature',
    geometry: r.geometry,
    // feederId: the equipment's assigned feeder (network.feeders.cim_mrid) --
    // the cleaned identity the map colours lines by, stable across databases.
    properties: { mrid: r.cim_mrid, cls: r.cim_class, name: r.name, feeder: r.feeder, feederId: r.feeder_mrid, ratedVoltage: r.rated_voltage },
  }));
  return {
    type: 'FeatureCollection',
    features,
    meta: {
      equipment: rows.length,
      lines: rows.filter((r) => r.geometry.type === 'LineString').length,
      substations: subs.map((s) => ({ mrid: s.cim_mrid, name: s.name, code: s.code, hasLocation: !!s.geometry })),
      // [{ mrid, name, code, equipment, bbox: [w, s, e, n] }] -- see the areas query above
      areas: areas.map((a) => ({ mrid: a.cim_mrid, name: a.name, code: a.code, equipment: a.equipment, bbox: [a.w, a.s, a.e, a.n] })),
      // { htLines: [index...], feederLines: [index...] } -- see rawLinesImported
      rawImported: rawLinesImported(loadRawNet(), imported),
    },
  };
}
