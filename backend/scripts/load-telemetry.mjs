// Load your own feeder readings (CSV or JSON) into feeder_telemetry, with the
// same checks the SCADA ingest applies, then recalculate the stored KPI days
// they touch so the Feeder PQ KPIs dashboard shows them.
//
//   node scripts/load-telemetry.mjs my-data.csv            load (source TEST)
//   node scripts/load-telemetry.mjs my-data.csv --dry-run  check only, write nothing
//   node scripts/load-telemetry.mjs my-data.json --source=FIELD
//   node scripts/load-telemetry.mjs --remove               delete source TEST, recalc its days
//   node scripts/load-telemetry.mjs --sample out.csv [--feeder=UPCL-AN-A] [--date=2026-10-14]
//                                                          write a 24 h test file with known events
//
// CSV: a header row, then one reading per row. Columns (any order):
//   feeder, ts, v_r, v_y, v_b, i_r, i_y, i_b, quality (optional)
// Volts phase-to-neutral, amps; an empty cell = phase not measured.
// ts: ISO with zone (2026-10-14T10:00:00+05:30); without a zone
// ("2026-10-14 10:00", as Excel saves it) it is read as IST.
// JSON: an array of readings, or { "samples": [...] }, same field names.
//
// Turn the simulator off first (FEEDER_TELEMETRY_SIM=off) and delete its rows:
// a reading for a feeder and minute that already exists is skipped as a duplicate.
// Needs DATABASE_URL like the backend (read from backend/.env).
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { db } from '../src/infra/db.js';
import { repo } from '../src/infra/repo.js';
import { validateSample, rollupDay, feederCatalog } from '../src/realtime/feederKpi.js';
import { istDay } from '../src/domain/feederKpi.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;
const file = args.find((a) => !a.startsWith('--'));
const source = opt('source', 'TEST').toUpperCase();
const NUM = ['v_r', 'v_y', 'v_b', 'i_r', 'i_y', 'i_b'];

// ---- CSV ----
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (q) { if (c === '"' && line[k + 1] === '"') { cur += '"'; k++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const head = splitCsvLine(lines[0] || '').map((h) => h.toLowerCase());
  for (const need of ['feeder', 'ts']) if (!head.includes(need)) throw new Error(`CSV header must include "${need}" (found: ${head.join(', ')})`);
  const rows = [];
  for (let n = 1; n < lines.length; n++) {
    if (!lines[n].trim()) continue;
    const cells = splitCsvLine(lines[n]);
    const r = { line: n + 1 };
    head.forEach((h, k) => { r[h] = cells[k] ?? ''; });
    rows.push(r);
  }
  return rows;
}

// A timestamp without a zone is IST; "2026-10-14 10:00" -> 2026-10-14T10:00:00+05:30.
function normTs(ts) {
  const s = String(ts ?? '').trim().replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return s;
  const full = /T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
  return `${full}+05:30`;
}

function toSample(r) {
  const s = { feeder: String(r.feeder ?? '').trim(), ts: normTs(r.ts), source };
  for (const f of NUM) {
    const v = r[f];
    s[f] = v === '' || v == null ? null : Number(v);
  }
  if (r.quality) s.quality = String(r.quality).trim().toUpperCase();
  return s;
}

// ---- load ----
async function load() {
  const text = readFileSync(file, 'utf8');
  const raw = file.toLowerCase().endsWith('.json')
    ? (() => { const j = JSON.parse(text); return (Array.isArray(j) ? j : j.samples || []).map((r, k) => ({ ...r, line: k + 1 })); })()
    : parseCsv(text);
  const known = new Set(feederCatalog().map((c) => c.feeder));
  const good = [], errors = [], unknown = new Map();
  for (const r of raw) {
    const s = toSample(r);
    const bad = validateSample(s) || (NUM.some((f) => Number.isNaN(s[f])) ? 'a value is not a number' : null);
    if (bad) { errors.push(`line ${r.line}: ${bad}`); continue; }
    if (!known.has(s.feeder)) unknown.set(s.feeder, (unknown.get(s.feeder) || 0) + 1);
    good.push({
      feeder: s.feeder, ts: new Date(s.ts).toISOString(),
      ...Object.fromEntries(NUM.map((f) => [f, s[f]])),
      quality: s.quality || 'GOOD', source,
    });
  }

  console.log(`${raw.length} row(s) read, ${good.length} valid, ${errors.length} rejected`);
  for (const e of errors.slice(0, 20)) console.log(`  ✗ ${e}`);
  if (errors.length > 20) console.log(`  … and ${errors.length - 20} more`);
  for (const [f, n] of unknown) console.log(`  ! ${f}: not a feeder in the GIS model (${n} rows); it will load but show without a substation`);
  if (!good.length) return;

  const days = [...new Set(good.map((g) => istDay(g.ts)))].sort();
  const feeders = [...new Set(good.map((g) => g.feeder))];
  console.log(`Feeders: ${feeders.join(', ')}`);
  console.log(`Days (IST): ${days[0]}${days.length > 1 ? ` to ${days.at(-1)} (${days.length})` : ''}`);
  if (flag('dry-run')) { console.log('Dry run: nothing written.'); return; }

  const inserted = await repo.insertFeederTelemetry(good);
  const dup = good.length - inserted;
  console.log(`Inserted ${inserted}${dup ? `, skipped ${dup} duplicate(s) (same feeder and time already stored${await simNote(feeders)})` : ''}`);
  await recalc(days);
}

async function simNote(feeders) {
  const r = await db.oneOrNone("SELECT 1 FROM feeder_telemetry WHERE source='SIM' AND feeder IN ($1:csv) LIMIT 1", [feeders]);
  return r ? '; simulator rows exist for these feeders - delete them first' : '';
}

// Past days are stored by the nightly job; recalc them now. Today is live.
async function recalc(days) {
  const today = istDay(Date.now());
  const past = days.filter((d) => d < today);
  for (const d of past) { await rollupDay(d); process.stdout.write(`  recalculated ${d}\n`); }
  if (days.includes(today)) console.log('  today is calculated live: it shows on the dashboard within a minute');
}

async function remove() {
  const rows = await db.any('SELECT DISTINCT (ts AT TIME ZONE \'Asia/Kolkata\')::date::text AS day FROM feeder_telemetry WHERE source=$1 ORDER BY 1', [source]);
  const r = await db.result('DELETE FROM feeder_telemetry WHERE source=$1', [source]);
  console.log(`Deleted ${r.rowCount} reading(s) with source ${source}`);
  await recalc(rows.map((x) => x.day));
}

// ---- sample dataset: one feeder, one day, 1-minute readings, known events ----
// Defaults (no custom rating): 6350.85 V and 200 A nominal; V band 90-110 %,
// I high 100 %. Expected results are printed so the dashboard can be checked.
function sample(out) {
  const feeder = opt('feeder', 'UPCL-AN-A');
  const day = opt('date', istDay(Date.now() - 86_400_000)); // yesterday, IST
  const VN = 6350.85;
  const v = (pct) => Math.round(VN * pct) / 100;
  const at = (h, m) => h * 60 + m;
  const inRange = (t, a, b) => t >= a && t <= b;
  const lines = ['feeder,ts,v_r,v_y,v_b,i_r,i_y,i_b'];
  for (let t = 0; t < 1440; t++) {
    let vr = v(100), vy = v(100), vb = v(100), ir = 120, iy = 120, ib = 120;
    if (inRange(t, at(10, 0), at(10, 14))) vr = v(112);                    // R high voltage, 15 min
    if (inRange(t, at(14, 0), at(14, 9))) { vr = v(88); vy = v(88); vb = v(88); } // all phases low, 10 min
    if (inRange(t, at(18, 0), at(18, 29))) iy = 230;                       // Y overload, 30 min
    if (t === at(21, 0)) vb = v(80);                                       // B sag to 80 %, 1 min
    if (inRange(t, at(23, 0), at(23, 4))) { vr = 0; vy = 0; vb = 0; ir = 0; iy = 0; ib = 0; } // outage, 5 min
    const hh = String(Math.floor(t / 60)).padStart(2, '0'), mm = String(t % 60).padStart(2, '0');
    lines.push(`${feeder},${day}T${hh}:${mm}:00+05:30,${vr},${vy},${vb},${ir},${iy},${ib}`);
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`Wrote ${out}: ${feeder}, ${day}, 1440 readings (1 per minute)`);
  console.log(`
Expected on the dashboard (Daily, ${day}, feeder ${feeder}, default rating):
  FVHI_R 1   FVHD_R 15 min   FMXV_R 112 %   FVSV_R ${Math.round((v(112) - VN * 1.1) * 15 * 100) / 100} V·min
  FVLI_T 2   FVLD_T 11 min   (14:00-14:09 all phases, 21:00 phase B)
  FVSM_B 80 %   FVSM_T 80 %   (14:00 dip is 88 % on R/Y/B; deepest is B at 80 %)
  FCHI_Y 1   FCHD_Y 30 min   FMXC_Y 115 %   FCSV_Y 900 A·min   ((230-200) x 30)
  FCSM_Y 60 %   (18:30 load falls 230 -> 120 A, a drop of more than 30 %)
  FLIF ${Math.round(230 / 120 * 10000) / 100} %   (Y 230 A vs 120 A on the others)
  23:00-23:04 no supply: excluded from every index (counts for SAIDI/SAIFI only)
  Coverage: 1435 live minutes, 5 without supply`);
}

try {
  if (opt('sample') !== undefined || flag('sample')) sample(file || 'feeder-telemetry-sample.csv');
  else if (flag('remove')) await remove();
  else if (file) await load();
  else { console.log('Usage: node scripts/load-telemetry.mjs <file.csv|file.json> [--dry-run] [--source=TEST]\n       node scripts/load-telemetry.mjs --remove [--source=TEST]\n       node scripts/load-telemetry.mjs --sample out.csv [--feeder=UPCL-AN-A] [--date=YYYY-MM-DD]'); process.exitCode = 1; }
} catch (e) {
  console.error(`Failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.$pool.end();
}
