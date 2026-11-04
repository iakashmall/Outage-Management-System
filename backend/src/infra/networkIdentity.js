// Canonical feeder and substation identity (runbook v2, G9).
//
// SCADA names a feeder by its tag ("DEHRA.FDR7"), a complaint by the network
// code of its nearest transformer ("UPCL-BW-A"), the CIM model by mRID or
// name. Intake merges by feeder (decision D2), so every name is first
// resolved to ONE canonical id, in the database, the same way for both sides:
//
//   normalise(x)  = upper case, every non-alphanumeric removed
//                   ("33/11 kV Bhoopatwala S/s" -> "3311KVBHOOPATWALASS")
//   feeder key    = the network feeder CODE whose code, name, mRID or alias
//                   normalises to the same string; none -> unknown (NULL)
//   substation key= the substation of the resolved feeder; else the network
//                   substation NAME whose name, core name (without "33/11 kV"
//                   and "S/s"), code, id, mRID or alias matches; else the
//                   raw text ("RAW:<normalised>"), so two events that name the
//                   same unknown substation still meet; none -> NULL
//
// Sources, rebuilt by refreshNetworkIdentity() at every migrate():
//   network.json (in-memory model: 61 feeder codes, 15 substations)
//   network.feeders / network.substations (CIM import), when installed
//   network_aliases (kind 'feeder' | 'substation', alias -> canonical), the
//     hand-kept tag dictionary, e.g. ('feeder', 'DEHRA.FDR7', 'UPCL-BW-A')
// A generated alias that points at two different canonical ids is dropped
// (ambiguous = unknown); a network_aliases row always wins.
import { db } from './db.js';
import { substations as NET_SUBSTATIONS, distTx as NET_DIST_TX } from './geo.js';

export const norm = (t) => {
  const s = String(t ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
};
const coreName = (name) => String(name || '').replace(/^\s*\d+\s*\/\s*\d+\s*kv\s*/i, '').replace(/\s*s\/s\s*$/i, '');

export async function migrateNetworkIdentity(cx = db) {
  await cx.none(`
    CREATE TABLE IF NOT EXISTS network_aliases (
      kind      TEXT NOT NULL CHECK (kind IN ('feeder', 'substation')),
      alias     TEXT NOT NULL,
      canonical TEXT NOT NULL,
      note      TEXT,
      PRIMARY KEY (kind, alias)
    );
    CREATE TABLE IF NOT EXISTS feeder_identity (
      alias_norm  TEXT PRIMARY KEY,
      feeder_code TEXT NOT NULL,
      substation  TEXT,
      source      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS substation_identity (
      alias_norm TEXT PRIMARY KEY,
      substation TEXT NOT NULL,
      source     TEXT NOT NULL
    );
    CREATE OR REPLACE FUNCTION oms_norm(t text) RETURNS text
      LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')), '') $$;
    -- Positional $1/$2, not parameter names: a column of the same name
    -- (substation_identity.substation) would silently win over the parameter.
    CREATE OR REPLACE FUNCTION oms_feeder_key(feeder text) RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT fi.feeder_code FROM feeder_identity fi WHERE fi.alias_norm = oms_norm($1) $$;
    CREATE OR REPLACE FUNCTION oms_substation_key(substation text, feeder text) RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(
          (SELECT fi.substation FROM feeder_identity fi WHERE fi.alias_norm = oms_norm($2)),
          (SELECT si.substation FROM substation_identity si WHERE si.alias_norm = oms_norm($1)),
          'RAW:' || oms_norm($1)) $$;
  `);
  // refreshNetworkIdentity() (data) runs from ensureSchema() on every start.
}

// Rebuilds feeder_identity and substation_identity from every source.
// Call again after a CIM import or a change to network_aliases.
export async function refreshNetworkIdentity(cx = db) {
  const feeders = new Map();     // alias_norm -> Map(code -> { substation, source })
  const subs = new Map();        // alias_norm -> Map(name -> source)
  const subByCode = new Map(NET_SUBSTATIONS.map((s) => [s.code, s.name]));
  const addSub = (alias, name, source) => {
    const k = norm(alias); if (!k || !name) return;
    if (!subs.has(k)) subs.set(k, new Map());
    subs.get(k).set(name, source);
  };
  const addFeeder = (alias, code, substation, source) => {
    const k = norm(alias); if (!k || !code) return;
    if (!feeders.has(k)) feeders.set(k, new Map());
    const m = feeders.get(k);
    if (!m.has(code) || (!m.get(code).substation && substation)) m.set(code, { substation: substation || null, source });
  };

  // 1. network.json
  for (const s of NET_SUBSTATIONS) {
    for (const a of [s.name, coreName(s.name), s.code, s.id]) addSub(a, s.name, 'network.json');
  }
  for (const d of NET_DIST_TX) if (d.feeder) addFeeder(d.feeder, d.feeder, subByCode.get(d.ss) || null, 'network.json');

  // 2. CIM network model, when installed
  const cim = (await cx.one("SELECT to_regclass('network.feeders') IS NOT NULL AND to_regclass('network.substations') IS NOT NULL AS ok")).ok;
  if (cim) {
    for (const s of await cx.any('SELECT cim_mrid, name, code FROM network.substations')) {
      const name = s.name || s.code || s.cim_mrid;
      for (const a of [s.name, coreName(s.name), s.code, s.cim_mrid]) addSub(a, name, 'network.substations');
    }
    const rows = await cx.any(`SELECT f.cim_mrid, f.name, f.code, COALESCE(s.name, s.code, s.cim_mrid) AS substation
      FROM network.feeders f LEFT JOIN network.substations s ON s.id = f.substation_id`);
    for (const f of rows) {
      const code = f.code || f.name || f.cim_mrid;
      for (const a of [f.code, f.name, f.cim_mrid]) addFeeder(a, code, f.substation, 'network.feeders');
    }
  }

  // Generated aliases: keep only the unambiguous ones.
  const feederRows = new Map(), subRows = new Map();
  for (const [k, m] of feeders) if (m.size === 1) { const [[code, v]] = [...m]; feederRows.set(k, { code, substation: v.substation, source: v.source }); }
  for (const [k, m] of subs) if (m.size === 1) { const [[name, source]] = [...m]; subRows.set(k, { name, source }); }
  // A feeder's own substation must be canonical too.
  for (const v of feederRows.values()) {
    if (v.substation) v.substation = subRows.get(norm(v.substation))?.name || v.substation;
  }

  // 3. hand-kept aliases win
  for (const a of await cx.any('SELECT kind, alias, canonical FROM network_aliases')) {
    if (a.kind === 'substation') {
      const name = subRows.get(norm(a.canonical))?.name || a.canonical;
      subRows.set(norm(a.alias), { name, source: 'alias' });
    } else {
      const target = feederRows.get(norm(a.canonical));
      feederRows.set(norm(a.alias), { code: target?.code || a.canonical, substation: target?.substation || null, source: 'alias' });
    }
  }

  await cx.tx('network-identity', async (t) => {
    await t.any('SELECT pg_advisory_xact_lock(41020, 1)'); // one rebuild at a time
    await t.none('DELETE FROM feeder_identity; DELETE FROM substation_identity;');
    const pgp = db.$config.pgp;
    const fr = [...feederRows].map(([alias_norm, v]) => ({ alias_norm, feeder_code: v.code, substation: v.substation, source: v.source }));
    const sr = [...subRows].map(([alias_norm, v]) => ({ alias_norm, substation: v.name, source: v.source }));
    if (fr.length) await t.none(pgp.helpers.insert(fr, ['alias_norm', 'feeder_code', 'substation', 'source'], 'feeder_identity'));
    if (sr.length) await t.none(pgp.helpers.insert(sr, ['alias_norm', 'substation', 'source'], 'substation_identity'));
  });
  return { feederAliases: feederRows.size, substationAliases: subRows.size };
}

// The canonical scope of an event: { feederKey, substationKey, feeder, substation }.
// feeder / substation are what to store on a new incident: the canonical
// code / name when resolved, else the text as reported.
export async function resolveScope({ feeder, substation } = {}, cx = db) {
  const r = await cx.one(`SELECT oms_feeder_key($1) AS fk, oms_substation_key($2, $1) AS sk,
      (SELECT s.substation FROM substation_identity s WHERE s.alias_norm = oms_norm($2)) AS sname`, [feeder || null, substation || null]);
  const subName = r.sk && !r.sk.startsWith('RAW:') ? r.sk : null;
  return {
    feederKey: r.fk || null,
    substationKey: r.sk || null,
    feeder: r.fk || feeder || null,
    substation: subName || r.sname || substation || null,
  };
}
