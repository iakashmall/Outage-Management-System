import { repo } from '../infra/repo.js';
import { feederCatalog } from './feederKpi.js';
import { DEFAULT_RATING } from '../domain/feederKpi.js';

// Synthetic per-phase V/I for every feeder, so the PFC KPI dashboard has
// something to show before the real SCADA analog feed is connected.
// Same switch as the other simulators: SIMULATOR=off (or
// FEEDER_TELEMETRY_SIM=off) disables it. Samples are tagged source='SIM'.
//
// Stateless: a sample is a pure function of (feeder, minute), so the backfill
// and the live loop agree and a restart does not change history.

const MIN = 60_000;
const VN = DEFAULT_RATING.v_nominal_v;
const IN = DEFAULT_RATING.i_nominal_a;

function hash(str) {
  let h = 2166136261;
  for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const rnd = (...parts) => (hash(parts.join('|')) % 1_000_000) / 1_000_000; // [0,1)

function profile(feeder) {
  return {
    load: 0.35 + rnd(feeder, 'load') * 0.75,        // 35%..110% of nominal at peak
    imbalance: 0.02 + rnd(feeder, 'imb') * 0.16,    // phase spread
    vBias: (rnd(feeder, 'vb') - 0.5) * 0.1,         // feeder sits a bit high/low
    weakPhase: ['r', 'y', 'b'][Math.floor(rnd(feeder, 'wp') * 3)],
  };
}

export function simSample(feeder, t) {
  const p = profile(feeder);
  const ist = new Date(t + 330 * MIN);
  const h = ist.getUTCHours() + ist.getUTCMinutes() / 60;
  const dh = (c) => ((h - c + 36) % 24) - 12; // circular hour distance, no jump at midnight
  const curve = 0.35 + 0.65 * Math.exp(-((dh(20) / 3) ** 2)) + 0.35 * Math.exp(-((dh(9) / 2.5) ** 2));
  const block = Math.floor(t / (30 * MIN));
  const minute = Math.floor(t / MIN);
  const ts = new Date(minute * MIN).toISOString();

  // Feeder outage: ~0.4% of half-hour blocks.
  if (rnd(feeder, 'out', block) < 0.004) {
    return { feeder, ts, v_r: 0, v_y: 0, v_b: 0, i_r: 0, i_y: 0, i_b: 0, source: 'SIM' };
  }
  let loadPu = p.load * curve * (0.95 + rnd(feeder, 'n', minute) * 0.1);
  if (rnd(feeder, 'shed', minute) < 0.001) loadPu *= 0.4 + rnd(feeder, 'shedd', minute) * 0.25; // a large load trips off
  const share = { r: 1 + p.imbalance, y: 1, b: 1 - p.imbalance * 0.8 };
  const out = { feeder, ts, source: 'SIM' };
  for (const ph of ['r', 'y', 'b']) {
    const i = IN * loadPu * share[ph] * (0.97 + rnd(feeder, ph, 'i', minute) * 0.06);
    // Voltage falls with load; the weak phase falls further.
    let v = VN * (1.09 + p.vBias - 0.13 * loadPu * share[ph] * (ph === p.weakPhase ? 1.4 : 1) + (rnd(feeder, ph, 'v', minute) - 0.5) * 0.01);
    if (rnd(feeder, ph, 'sag', minute) < 0.0002) v = VN * (0.55 + rnd(feeder, ph, 'depth', minute) * 0.33); // short sag
    out[`i_${ph}`] = Math.round(i * 10) / 10;
    out[`v_${ph}`] = Math.round(v);
  }
  return out;
}

async function backfill(days, stepMin) {
  const latest = await repo.latestFeederTelemetryTs();
  const now = Date.now();
  let start = now - days * 86_400_000;
  if (latest && new Date(latest).getTime() > start) start = new Date(latest).getTime() + stepMin * MIN;
  start = Math.ceil(start / (stepMin * MIN)) * stepMin * MIN;
  if (start >= now) return 0;
  const feeders = feederCatalog().map((c) => c.feeder);
  let n = 0, rows = [];
  for (let t = start; t < now; t += stepMin * MIN) {
    for (const f of feeders) rows.push(simSample(f, t));
    if (rows.length >= 10_000) { n += await repo.insertFeederTelemetry(rows); rows = []; }
  }
  n += await repo.insertFeederTelemetry(rows);
  return n;
}

export async function startFeederTelemetrySim() {
  if (/^(off|false|0|no)$/i.test(process.env.FEEDER_TELEMETRY_SIM || '')) return;
  const days = Number(process.env.FEEDER_SIM_BACKFILL_DAYS ?? 7);
  try {
    // 5-minute history keeps the backfill small; live samples are 1-minute.
    const n = await backfill(days, 5);
    if (n) console.log(`  [simulator] backfilled ${n} feeder telemetry samples (${days} days, 5-min)`);
  } catch (e) { console.error('[simulator] feeder telemetry backfill failed:', e.message); }
  const feeders = feederCatalog().map((c) => c.feeder);
  setInterval(async () => {
    try { await repo.insertFeederTelemetry(feeders.map((f) => simSample(f, Date.now()))); }
    catch (e) { console.error('[simulator] feeder telemetry error:', e.message); }
  }, 60_000);
}
