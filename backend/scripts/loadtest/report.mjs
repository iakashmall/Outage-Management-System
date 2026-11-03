// Renders the harness JSON (run.mjs) for one label as markdown: a gate table,
// then the exact numbers per scenario. Prints to stdout.
//   node scripts/loadtest/report.mjs --in <out dir> --label wp2
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const IN = args.in, LABEL = args.label;
const ORDER = ['scada', 'complaints', 'dashboard', 'soak', 'chaos-kill', 'chaos-pg', 'chaos-redis'];
const runs = ORDER.map((s) => path.join(IN, `${LABEL}-${s}.json`)).filter(fs.existsSync).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));

const n = (v) => (v == null ? 'n/a' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
const pf = (ok) => (ok == null ? 'n/a' : ok ? 'PASS' : '**FAIL**');
const lat = (g) => (g ? `p50 ${n(g.p50)} / p95 ${n(g.p95)} / p99 ${n(g.p99)} / max ${n(g.max)} ms (n=${n(g.n)})` : 'n/a');
const lines = [];
const out = (s = '') => lines.push(s);

function lossDup(v) {
  if (!v) return { ok: null, text: 'n/a' };
  const unproc = v.unprocessed ?? v.unlinked ?? 0;
  const cc = v.customerCountMismatches ?? 0;
  const ok = v.lost === 0 && v.duplicateRows === 0 && unproc === 0 && v.rejectedAfterRetries === 0 && cc === 0;
  return { ok, text: `acked ${n(v.acked ?? v.ackedUniqueExternalIds)}, lost ${n(v.lost)}, duplicate rows ${n(v.duplicateRows)}, never processed ${n(unproc)}, rejected after retries ${n(v.rejectedAfterRetries)}${v.customerCountMismatches != null ? `, incidents whose customer count != distinct complaints ${n(cc)}` : ''}` };
}
function incDup(v) {
  if (!v?.incidents) return { ok: null, text: 'n/a' };
  const f = v.incidents.perFeeder;
  return { ok: f.extra === 0, text: `${n(v.incidents.activeCreatedInRun)} active incidents created on ${n(f.groups)} feeders; ${n(f.withMoreThanOne)} feeders have more than one (${n(f.extra)} extra)` };
}

const gates = [];
for (const r of runs) {
  if (r.harnessError) { gates.push([r.scenario, 'harness', '**DID NOT RUN**', r.harnessError]); continue; }
  const g = r.latency?.groups || {};
  const p95gate = (name, grp) => grp && gates.push([r.scenario, `${name} p95 < 3 s`, pf(grp.p95 < 3000), `${n(grp.p95)} ms`]);
  if (r.scenario.startsWith('chaos')) {
    for (const k of ['scada', 'complaints']) {
      const ld = lossDup(r.verify[k]); gates.push([r.scenario, `${k}: no loss, no duplicates`, pf(ld.ok), ld.text]);
    }
    // incidents are counted once per run (SCADA and complaints share the feeders)
    const id = incDup(r.verify.scada); gates.push([r.scenario, 'one active incident per feeder (SCADA + complaints)', pf(id.ok), id.text]);
    const hText = `${r.health.availabilityPct}% of ${r.health.samples} one-second samples, longest gap ${r.health.longestGapS} s`;
    const killedOnly = r.scenario === 'chaos-kill' && r.processesAliveAtEnd.length <= 1 && !(r.processesAliveAtEnd[0]?.label || '').match(/api|worker/);
    gates.push([r.scenario, 'kept serving /api/health', killedOnly ? 'n/a (single process: the killed one is the server)' : pf(r.health.longestGapS === 0), hText]);
    gates.push([r.scenario, 'no [fatal] log lines', pf(r.logScan.fatal.count === 0), `${r.logScan.fatal.count}`]);
    p95gate('writes', g.writes);
    continue;
  }
  if (r.verify) {
    const ld = lossDup(r.verify); gates.push([r.scenario, 'no loss, no duplicates', pf(ld.ok), ld.text]);
    const id = incDup(r.verify); gates.push([r.scenario, 'one active incident per feeder', pf(id.ok), id.text]);
  }
  p95gate('writes', g.writes);
  for (const k of Object.keys(g).filter((k) => k.endsWith('reads'))) p95gate(k, g[k]);
  if (r.memoryGrowth) gates.push([r.scenario, 'memory growth < 10%', pf(r.memoryGrowth.growthPct < 10), `${r.memoryGrowth.baselineMB} MB -> ${r.memoryGrowth.endMB} MB (${r.memoryGrowth.growthPct}%), ${r.memoryGrowth.rule}`]);
}

out(`### Gate summary: ${LABEL}`);
out();
out('| Scenario | Gate | Result | Numbers |');
out('|---|---|---|---|');
for (const [s, g, res, num] of gates) out(`| ${s} | ${g} | ${res} | ${num} |`);
out();

for (const r of runs) {
  out(`### ${r.scenario} (${LABEL})`);
  out();
  if (r.harnessError) { out(`Harness error: \`${r.harnessError}\``); out(); continue; }
  out(`- Spec: ${r.spec}. Scale ${r.scale}.`);
  out(`- Fresh database \`${r.db}\` (dropped afterwards: ${r.dbDropped}); backend healthy ${n(r.startupMs)} ms after start.`);
  if (r.load?.targetRate) out(`- Load: target ${n(r.load.targetRate)}/s for ${n(r.load.durationS)} s; issued ${n(r.load.issued)} in ${r.load.sendWindowS} s (${r.load.achievedRate}/s achieved), not sent because ${n(4000)} were already in flight: ${n(r.load.clientSkipped)}; last response ${r.load.drainS} s after the send window.`);
  if (r.load?.scadaIssued != null) out(`- Load: SCADA issued ${n(r.load.scadaIssued)} (skipped ${n(r.load.scadaSkipped)}), complaints issued ${n(r.load.complaintsIssued)} (skipped ${n(r.load.complaintsSkipped)}).`);
  if (r.background) out(`- Background complaints during the burst window: issued ${n(r.background.issued)}, acked ${n(r.background.acked)}.`);
  for (const [k, v] of Object.entries(r.latency?.groups || {})) out(`- Latency, ${k}: ${lat(v)}`);
  const st = Object.entries(r.latency?.byKind || {}).map(([k, v]) => `${k} ${JSON.stringify(v.status)}`);
  if (st.length) out(`- HTTP status per request kind (every attempt, retries included): ${st.join('; ')}`);
  if (r.sessions) out(`- Sessions: ${n(r.sessions.sessions)}, connected at the end ${n(r.sessions.connectedNow)}, connect errors ${n(r.sessions.connectErrors)}, disconnects ${n(r.sessions.disconnects)}, Socket.IO events received ${n(r.sessions.socketEventsReceived)}.`);
  if (r.memory) out(`- Backend memory (RSS / working set): start ${r.memory.startMB} MB, end ${r.memory.endMB} MB, max ${r.memory.maxMB} MB.`);
  if (r.memoryGrowth) out(`- Memory growth: ${JSON.stringify(r.memoryGrowth)}.`);
  if (r.settle) out(`- Backlog worked off ${n(r.settle.settleMs)} ms after the load (settled: ${r.settle.settled}); queue depth on /api/health at the end: ${n(r.settle.queueDepthAtEnd)}.`);
  if (r.marks) out(`- Chaos timeline: ${r.marks.map((m) => `${m.s}s ${m.ev}${m.v !== undefined ? ` (${m.v})` : ''}`).join(', ')}. Processes alive at the end: ${r.processesAliveAtEnd.map((p) => p.label).join(', ') || 'none'}.`);
  if (r.health) out(`- /api/health during the run: ${r.health.availabilityPct}% of ${r.health.samples} samples answered 200, longest gap ${r.health.longestGapS} s.`);
  const vs = r.verify?.scada ? r.verify : { '': r.verify };
  for (const [k, v] of Object.entries(vs)) if (v) out(`- Verification${k ? ' ' + k : ''}: \`${JSON.stringify({ ...v, incidents: undefined, customerCountMismatchExamples: undefined })}\`; incidents \`${JSON.stringify(v.incidents)}\``);
  if (r.schema) out(`- Schema seen: alarm event-id column ${r.schema.alarmEventIdColumn ?? 'none (tag used)'}; queue/dead-letter tables ${JSON.stringify(r.schema.queueTables)}.`);
  const tl = r.latency?.timeline || [];
  if (r.scenario.startsWith('chaos') && tl.length) out(`- 10 s windows (ok/fail/p95 ms): ${tl.map((w) => `${w.t} ${w.ok}/${w.fail}/${w.p95 ?? '-'}`).join('; ')}`);
  const ls = r.logScan;
  if (ls) out(`- Backend log: ${n(ls.lines)} lines; [fatal] ${ls.fatal.count}; errors ${ls.errors.count}${ls.errors.examples.length ? ' e.g. ' + ls.errors.examples.slice(0, 3).map((e) => '`' + e.replace(/`/g, "'") + '`').join(', ') : ''}; redis lines ${ls.redis.count}; db lines ${ls.db.count}; e-mail failures (no SMTP in test) ${ls.notifier?.count ?? 'n/a'}; exits ${ls.exits.count}.`);
  out();
}
process.stdout.write(lines.join('\n') + '\n');
