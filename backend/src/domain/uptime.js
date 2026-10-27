// P8.6g uptime maths (pure; realtime/uptime.js records the samples).
// The recorder stores one health sample every `intervalS` seconds. Uptime over a
// window is measured against the samples that SHOULD exist: a sample that is
// missing means the server itself was not running, which counts as down. So:
//   uptime % = up samples / expected samples
// where expected = window length / interval, counted from when monitoring began.

export const TARGET_PCT = 99.9;

// Allowed downtime for a window at a target, in minutes (99.9% of 30 days = 43.2 min).
export const allowedDownMin = (windowMs, target = TARGET_PCT) => Math.round((windowMs / 60000) * (1 - target / 100) * 10) / 10;

// rows: [{ ts, status: 'up'|'degraded'|'down', components: { name: { ok } } }], any order.
// Returns { pct, expected, up, missing, perComponent: { name: pct }, outages: [...] }.
export function computeUptime(rows, { from, to, intervalS = 30 }) {
  const fromMs = new Date(from).getTime(), toMs = new Date(to).getTime();
  const step = intervalS * 1000;
  const samples = rows
    .map((r) => ({ ...r, t: new Date(r.ts).getTime() }))
    .filter((r) => r.t >= fromMs && r.t <= toMs)
    .sort((a, b) => a.t - b.t);
  if (!samples.length) return { pct: null, expected: 0, up: 0, missing: 0, perComponent: {}, outages: [], since: null };

  // Monitoring can't speak for time before its first sample in the window.
  const start = Math.max(fromMs, samples[0].t);
  const expected = Math.max(samples.length, Math.floor((toMs - start) / step) + 1);
  const upCount = samples.filter((s) => s.status !== 'down').length;

  const names = [...new Set(samples.flatMap((s) => Object.keys(s.components || {})))];
  const perComponent = Object.fromEntries(names.map((n) => {
    const ok = samples.filter((s) => s.components?.[n]?.ok).length;
    return [n, round(ok / expected * 100)];
  }));

  // Outage periods: runs of 'down' samples, and gaps longer than two intervals
  // (the server, or the recorder, was not running).
  const outages = [];
  let open = null;
  const close = (end) => { if (open) { outages.push({ ...open, end: new Date(end).toISOString(), minutes: round((end - open.t0) / 60000) }); open = null; } };
  let prev = null;
  for (const s of samples) {
    if (prev && s.t - prev.t > 2 * step) {
      close(prev.t);
      outages.push({ start: new Date(prev.t).toISOString(), end: new Date(s.t).toISOString(), minutes: round((s.t - prev.t - step) / 60000), cause: 'no data (server not running)' });
    }
    if (s.status === 'down') {
      const failed = Object.entries(s.components || {}).filter(([, c]) => !c.ok && c.critical).map(([n]) => n);
      if (!open) open = { start: new Date(s.t).toISOString(), t0: s.t, cause: failed.join(', ') || 'unknown' };
    } else close(s.t);
    prev = s;
  }
  if (open) close(Math.min(toMs, prev.t + step));
  for (const o of outages) delete o.t0;

  const missing = expected - samples.length;
  return { pct: round(upCount / expected * 100), expected, up: upCount, missing, perComponent, outages, since: new Date(start).toISOString() };
}

const round = (x) => Math.round(x * 1000) / 1000;

// Overall status from component results: any critical failure = down,
// any non-critical failure = degraded.
export function overallStatus(components) {
  const list = Object.values(components);
  if (list.some((c) => c.critical && !c.ok)) return 'down';
  if (list.some((c) => !c.ok)) return 'degraded';
  return 'up';
}
