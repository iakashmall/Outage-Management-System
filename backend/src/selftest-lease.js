// D3 / G13 self-test (4 Nov 2026; load test results section 8.3): the intake
// queue's lease heartbeat. Scratch database only:
//   DATABASE_URL=<scratch db> node src/selftest-lease.js
//   G13    a worker process holding claimed items is killed (default lease,
//          10 s); a new worker takes them over: all processed within ~15 s of
//          the kill, each exactly once
//   D3-2   a slow item on a LIVE worker (2 s lease, the item takes 7 s): the
//          heartbeat keeps its claim, no other worker takes any of its items
//   D3-3   a STALLED worker (its event loop blocked 6 s, so no heartbeat): its
//          leases run out and another worker processes the items; when the
//          stalled one wakes up it skips them (lease lost) -- every item
//          processed exactly once
import { spawn } from 'node:child_process';

if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-lease: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
delete process.env.QUEUE_LEASE_MS; // G13 measures the shipped default

const { db, migrate } = await import('./infra/db.js');
const { enqueue, startIntakeConsumer, closeListener } = await import('./infra/intakeQueue.js');

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, everyMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(everyMs); }
  return null;
}

// The handler both workers run: optional event-loop block (stall), optional
// wait, then one row in d3_runs inside the item's transaction -- a row exists
// only for a processing that COMMITTED, so duplicates show up as extra rows.
const handlerSource = (who) => `async (p, t, item) => {
  if (p.stall) { const end = Date.now() + p.stall; while (Date.now() < end) { /* blocked event loop */ } }
  if (p.sleep) await new Promise((r) => setTimeout(r, p.sleep));
  if (p.sleepB && ${JSON.stringify(who)} === 'B') await new Promise((r) => setTimeout(r, p.sleepB));
  if (p.stallB && ${JSON.stringify(who)} === 'B') { const end = Date.now() + 30000; while (Date.now() < end) { /* holds its claim until killed */ } }
  await t.none('INSERT INTO d3_runs (item_id, who, attempts) VALUES ($1, $2, $3)', [item.id, ${JSON.stringify(who)}, item.attempts]);
  return { effects: [] };
}`;
const handlerFor = (who) => (0, eval)(`(${handlerSource(who)})`);

function startChild(who, env = {}) {
  const code = `
    const { startIntakeConsumer } = await import(${JSON.stringify(new URL('./infra/intakeQueue.js', import.meta.url).href)});
    startIntakeConsumer({ d3: ${handlerSource(who)} }, { pollMs: 20 });
    console.log('child ${who} ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return child;
}
const heldCount = async () => (await db.one('SELECT count(*)::int n FROM intake_queue WHERE claimed_by IS NOT NULL AND available_at > now()')).n;
const runs = () => db.one(`SELECT count(*)::int AS rows, count(DISTINCT item_id)::int AS items, max(attempts)::int AS max_attempts FROM d3_runs`);
async function reset() {
  await db.none('DELETE FROM intake_queue; DELETE FROM intake_dead_letter; DELETE FROM d3_runs;');
}

await migrate();
await db.none('CREATE TABLE IF NOT EXISTS d3_runs (item_id BIGINT NOT NULL, who TEXT NOT NULL, attempts INT, at TIMESTAMPTZ NOT NULL DEFAULT now())');
const children = [];
try {
  // ---------------------------------------------------------------- G13
  {
    await reset();
    // 5 ms of work per item (a real SCADA item costs about 1 ms); a claim of up
    // to 200 items is worked through one by one, so items stay claimed a while.
    const N = 600;
    for (let i = 0; i < N; i++) await enqueue('d3', { sleep: 5 });
    const a = startChild('A'); children.push(a);
    const held = await waitUntil(async () => { const n = await heldCount(); return n >= 50 ? n : null; }, 30000, 20);
    a.kill('SIGKILL'); await a.exited;
    const killedAt = Date.now();
    const snap = await db.any(`SELECT id, EXTRACT(EPOCH FROM available_at - now())::float AS left_s
      FROM intake_queue WHERE claimed_by IS NOT NULL AND available_at > now()`);
    const ids = snap.map((r) => r.id);
    const b = startIntakeConsumer({ d3: handlerFor('B') }, { pollMs: 20 });
    const gone = await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue WHERE id = ANY($1::bigint[])', [ids])).n === 0, 60000, 100);
    const tookS = (Date.now() - killedAt) / 1000;
    await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue')).n === 0, 60000, 100);
    await b.stop();
    const r = await runs();
    const leaseLeft = snap.length ? Math.max(...snap.map((s) => s.left_s)) : null;
    check('G13: a killed worker\'s claimed items are processed by the next worker within 15 s (default lease)',
      !!held && ids.length > 0 && !!gone && tookS <= 15,
      `(held ${ids.length} at the kill, their lease had at most ${leaseLeft?.toFixed(1)} s left; all processed ${tookS.toFixed(1)} s after the kill)`);
    check('G13: ... every item processed exactly once', r.rows === N && r.items === N, `(${r.rows} committed runs for ${r.items} of ${N} items)`);
  }

  // ---------------------------------------------------------------- D3-2
  {
    await reset();
    const slow = await enqueue('d3', { sleep: 7000 });
    for (let i = 0; i < 20; i++) await enqueue('d3', {});
    const a = startIntakeConsumer({ d3: handlerFor('A') }, { pollMs: 20, leaseMs: 2000, concurrency: 1 });
    await waitUntil(async () => (await heldCount()) >= 21, 10000, 20);
    const b = startIntakeConsumer({ d3: handlerFor('B') }, { pollMs: 20, leaseMs: 2000 });
    await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue')).n === 0, 30000, 100);
    await a.stop(); await b.stop();
    const r = await runs();
    const byB = (await db.one("SELECT count(*)::int n FROM d3_runs WHERE who = 'B'")).n;
    const slowRun = await db.oneOrNone('SELECT who, attempts FROM d3_runs WHERE item_id = $1', [slow]);
    check('D3-2: a live worker on a 7 s item with a 2 s lease keeps its claim (heartbeat): no other worker takes its items',
      r.rows === 21 && r.items === 21 && r.max_attempts === 1 && byB === 0 && slowRun?.who === 'A',
      `(${r.rows} runs for ${r.items} items, highest attempt ${r.max_attempts}, items run by the other worker ${byB})`);
  }

  // ---------------------------------------------------------------- D3-3
  {
    await reset();
    const first = await enqueue('d3', { stall: 6000 });
    for (let i = 0; i < 20; i++) await enqueue('d3', { sleepB: 300 });
    const a = startChild('A', { QUEUE_LEASE_MS: '2000', QUEUE_CONCURRENCY: '1' }); children.push(a);
    await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue WHERE claimed_by IS NOT NULL')).n >= 21, 15000, 20);
    const b = startIntakeConsumer({ d3: handlerFor('B') }, { pollMs: 20, leaseMs: 2000, concurrency: 1 });
    await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue')).n === 0, 60000, 100);
    await sleep(1500); // let the stalled worker finish waking up and skipping
    await b.stop();
    const r = await runs();
    const firstRun = await db.oneOrNone('SELECT who FROM d3_runs WHERE item_id = $1', [first]);
    const byB = (await db.one("SELECT count(*)::int n FROM d3_runs WHERE who = 'B'")).n;
    check('D3-3: a stalled worker (event loop blocked 6 s, 2 s lease): every item processed exactly once',
      r.rows === 21 && r.items === 21, `(${r.rows} committed runs for ${r.items} of 21 items)`);
    check('D3-3: ... the other worker took over the stalled worker\'s 20 waiting items; the stalled one finished only its own',
      firstRun?.who === 'A' && byB === 20, `(stalled item run by ${firstRun?.who}; ${byB} items run by the other worker)`);
    a.kill('SIGKILL'); await a.exited;
  }

  // ---------------------------------------------------------------- D3-4
  // The claim check itself, made deterministic: while A is stalled, B claims
  // A's waiting items and is killed holding them (claimed, not locked). When A
  // wakes, those rows carry B's claim: A must skip them, not process them; it
  // processes them only after claiming them again itself.
  {
    await reset();
    await enqueue('d3', { stall: 6000 });
    for (let i = 0; i < 20; i++) await enqueue('d3', { stallB: 1 });
    const a = startChild('A', { QUEUE_LEASE_MS: '2000', QUEUE_CONCURRENCY: '1' }); children.push(a);
    await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue WHERE claimed_by IS NOT NULL')).n >= 21, 15000, 20);
    const b = startChild('B', { QUEUE_LEASE_MS: '2000', QUEUE_CONCURRENCY: '1' }); children.push(b);
    const bClaimed = await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue WHERE claimed_by LIKE $1', [`%:${b.pid}:%`])).n >= 20, 15000, 10);
    b.kill('SIGKILL'); await b.exited;
    await waitUntil(async () => (await db.one('SELECT count(*)::int n FROM intake_queue')).n === 0, 60000, 100);
    const r = await runs();
    const byB = (await db.one("SELECT count(*)::int n FROM d3_runs WHERE who = 'B'")).n;
    const lost = (a.output.match(/lease lost/g) || []).length;
    check('D3-4: a stalled worker that wakes to items re-claimed by another worker skips them ("lease lost"), then processes each once',
      !!bClaimed && lost >= 1 && r.rows === 21 && r.items === 21 && byB === 0,
      `(other worker held ${bClaimed ? 20 : 0} when killed; ${lost} "lease lost" skip(s); ${r.rows} committed runs for ${r.items} of 21 items, ${byB} by the killed worker)`);
    a.kill('SIGKILL'); await a.exited;
  }
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
} finally {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
}
await db.none('DROP TABLE IF EXISTS d3_runs').catch(() => {});
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
await closeListener();
await db.$pool.end().catch(() => {});
process.exit(fails ? 1 : 0);
