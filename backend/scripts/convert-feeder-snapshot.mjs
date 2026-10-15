// Turn an ADMS "Feeder Summary" export (one row per feeder, a single moment)
// into a day of test readings for load-telemetry.mjs.
//
//   node scripts/convert-feeder-snapshot.mjs "<Feeder Summary.csv>" [out.csv] [--date=2026-10-14] [--step=1] [--keep-unbalanced]
//
// FOR TESTING ONLY. The export has no time series, so the day is MADE UP around
// each feeder's snapshot: a daily load curve (low at night, peak in the evening)
// scaled so the curve passes through the snapshot current at the export time,
// voltage sagging slightly as load rises, plus a little noise. The source feeders
// are also mapped one-to-one onto this app's GIS feeder codes (the app knows only
// those), so the results say nothing about the real feeders.
//
// Kept: 11 kV feeders ("Close", all three currents >= 1 A, voltages 10-12 kV), in
// feeder-code order, one per GIS feeder. A phase under 1 A is a dead phase or a
// single-phase feeder; FLIF for it runs to 100,000 % and swamps the chart, so
// those are skipped unless --keep-unbalanced. Voltage: line-to-line kV -> phase-to-
// neutral volts (x 1000 / sqrt 3). Also writes <out>-mapping.csv: which source
// feeder became which GIS code, with its CT rating (a candidate I nominal).
import { readFileSync, writeFileSync } from 'node:fs';
import { distTx } from '../src/infra/geo.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;
const [src, outArg] = args.filter((a) => !a.startsWith('--'));
if (!src) {
  console.log('Usage: node scripts/convert-feeder-snapshot.mjs "<Feeder Summary.csv>" [out.csv] [--date=YYYY-MM-DD] [--step=minutes]');
  process.exit(1);
}
const out = outArg || 'feeder-snapshot-test.csv';
const IST_MS = 330 * 60_000;
const day = opt('date', new Date(Date.now() + IST_MS - 86_400_000).toISOString().slice(0, 10)); // yesterday, IST
const step = Math.max(1, Number(opt('step', 1)) || 1);
const minPhaseA = args.includes('--keep-unbalanced') ? 0 : 1;

// ---- CSV (quoted fields, BOM) ----
function splitCsvLine(line) {
  const cells = []; let cur = '', q = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (q) { if (c === '"' && line[k + 1] === '"') { cur += '"'; k++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells.map((s) => s.trim());
}
const lines = readFileSync(src, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
const head = splitCsvLine(lines[0]);
const col = (...names) => {
  const k = head.findIndex((h) => names.some((n) => h.toLowerCase() === n.toLowerCase()));
  if (k < 0) throw new Error(`column not found: ${names[0]}`);
  return k;
};
// The export spells two of the voltage headers "Volatge".
const C = {
  code: col('Feeder Code'), name: col('Feeder Name'), sub: col('Substation'), status: col('Current Status'),
  ir: col('Current IR (A)'), iy: col('Current IY (A)'), ib: col('Current IB (A)'),
  vr: col('Volatge VR (KV)', 'Voltage VR (KV)'), vy: col('Voltage VY (KV)', 'Volatge VY (KV)'), vb: col('Volatge VB (KV)', 'Voltage VB (KV)'),
  ct: col('Feeder CT'),
};

const rows = lines.slice(1).map(splitCsvLine).map((c) => ({
  code: c[C.code], name: c[C.name], sub: c[C.sub], status: c[C.status], ct: c[C.ct],
  i: [c[C.ir], c[C.iy], c[C.ib]].map(Number), kv: [c[C.vr], c[C.vy], c[C.vb]].map(Number),
}));
const usable = rows
  .filter((r) => r.status === 'Close' && r.i.every((x) => x > minPhaseA && x > 0) && r.kv.every((x) => x >= 10 && x <= 12))
  .sort((a, b) => a.code.localeCompare(b.code));

const gis = [...new Set(distTx.map((d) => d.feeder).filter(Boolean))].sort();
const n = Math.min(gis.length, usable.length);
if (!n) throw new Error('no usable 11 kV feeder rows in the file');

// ---- the made-up day ----
// Deterministic noise per feeder, so the same input gives the same file.
function rng(seed) {
  let a = 0;
  for (const ch of seed) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Relative load: night low ~0.55, morning bump, evening peak ~1.3 at 19:30.
const shape = (min) => {
  const h = min / 60;
  return 0.55 + 0.25 * Math.exp(-((h - 9.5) ** 2) / 6) + 0.75 * Math.exp(-((h - 19.5) ** 2) / 5);
};
const SNAP = 13 * 60 + 24; // the export's time: the curve passes through the snapshot there
const r1 = (x) => Math.round(x * 10) / 10;

const outLines = ['feeder,ts,v_r,v_y,v_b,i_r,i_y,i_b'];
const mapLines = ['gis_feeder,source_feeder_code,source_feeder_name,source_substation,snapshot_i_r,snapshot_i_y,snapshot_i_b,snapshot_v_ll_kv,feeder_ct_a'];
for (let k = 0; k < n; k++) {
  const f = gis[k], s = usable[k], rand = rng(s.code);
  const vln = s.kv.map((x) => (x * 1000) / Math.sqrt(3));
  for (let t = 0; t < 1440; t += step) {
    const load = shape(t) / shape(SNAP);
    const i = s.i.map((x) => r1(x * load * (1 + (rand() - 0.5) * 0.06)));
    const v = vln.map((x) => r1(x * (1 - 0.03 * (load - 1)) * (1 + (rand() - 0.5) * 0.01)));
    const hh = String(Math.floor(t / 60)).padStart(2, '0'), mm = String(t % 60).padStart(2, '0');
    outLines.push(`${f},${day}T${hh}:${mm}:00+05:30,${v.join(',')},${i.join(',')}`);
  }
  mapLines.push([f, s.code, `"${s.name}"`, `"${s.sub}"`, ...s.i, s.kv.join('/'), s.ct].join(','));
}
writeFileSync(out, outLines.join('\n') + '\n');
const mapOut = out.replace(/\.csv$/i, '') + '-mapping.csv';
writeFileSync(mapOut, mapLines.join('\n') + '\n');

console.log(`${rows.length} rows read; ${usable.length} usable 11 kV feeders; ${n} mapped onto GIS feeders`);
console.log(`Wrote ${out}: ${outLines.length - 1} readings, ${day}, every ${step} min`);
console.log(`Wrote ${mapOut}: source feeder -> GIS code`);
console.log(`Next: npm --workspace backend run telemetry:load -- "${out}" --dry-run`);
