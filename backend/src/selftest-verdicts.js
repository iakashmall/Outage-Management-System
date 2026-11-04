// D2 / G12 self-test (4 Nov 2026; load test results section 8.4): the intake
// queue never deletes a complaint item without storing it, recording a
// duplicate verdict, or dead-lettering it. Scratch database only:
//   DATABASE_URL=<scratch db> node src/selftest-verdicts.js
//   G12-1  a reused qid with a different external id -> dead letter, with the reason; the stored complaint is untouched
//   G12-2  a reused qid with no external id (key = queue item id) -> dead letter
//   G12-3  the same queue item processed twice (a redelivery) -> stored once + a duplicate verdict
//   G12-4  the same external id resent -> a duplicate verdict, nothing new stored (G3 unchanged)
//   G12-5  through the API: a counter that is behind an existing row hands out a used qid -> 409 rejected
//          with the reason, never the other complaint's answer
//   G12-6  every queue item of this test is accounted for: stored, duplicate verdict or dead letter
if (!process.env.DATABASE_URL || (!/scratch/i.test(process.env.DATABASE_URL) && process.env.CI !== 'true')) {
  console.error('selftest-verdicts: set DATABASE_URL to a scratch database (its name must contain "scratch")');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
process.env.INTAKE_RETRY_BASE_MS = process.env.INTAKE_RETRY_BASE_MS || '20';

const { db, migrate } = await import('./infra/db.js');
const { seed } = await import('./infra/seed.js');
const { initBus } = await import('./domain/bus.js');
const { repo } = await import('./infra/repo.js');
const { distTx } = await import('./infra/geo.js');
const { enqueue, queueStats, closeListener } = await import('./infra/intakeQueue.js');
const { startIntakeWorker, intakeHandlers, submitComplaint } = await import('./realtime/intakeWorker.js');

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(everyMs); }
  return null;
}
const drained = () => waitUntil(async () => (await queueStats()).depth === 0, 20000);
const who = { username: 'verdicts-test', roles: ['call_centre_attendant'] };

await migrate();
await seed({ force: true });
await initBus();
await db.none('DELETE FROM intake_queue; DELETE FROM intake_dead_letter; DELETE FROM intake_duplicates;');
const d = distTx.find((x) => typeof x.lat === 'number');
const body = (externalId, extra = {}) => ({ ...(externalId ? { externalId } : {}), customer: 'G12', phone: '9800000012', category: 'No Supply', lat: d.lat, lon: d.lon, ...extra });
const items = []; // every queue item this test creates
const worker = startIntakeWorker({ pollMs: 20 });
try {
  // A stored complaint whose qid the next cases reuse.
  const a = await submitComplaint(body('G12-A'), who);
  const qa = a.body.queryId;
  const aRow = await repo.complaintIdentity(qa);
  items.push(aRow?.intake_item_id);
  check('setup: complaint G12-A stored through the queue, with its queue item id', a.status === 201 && aRow?.external_id === 'G12-A' && aRow.intake_item_id != null,
    `(${a.status}, ${qa}, item ${aRow?.intake_item_id})`);

  // ---------------------------------------------------------------- G12-1
  {
    const id = await enqueue('complaint', { qid: qa, ts: new Date().toISOString(), body: body('G12-B'), who });
    items.push(id);
    await drained();
    const dl = await db.oneOrNone('SELECT kind, last_error FROM intake_dead_letter WHERE id = $1', [id]);
    const b = await repo.complaintByExternalId('G12-B');
    const still = await repo.complaintIdentity(qa);
    check('G12-1: a reused qid with a different external id goes to dead letter with a clear reason',
      !!dl && /already used by another complaint/.test(dl.last_error) && /external id G12-A/.test(dl.last_error) && /external id G12-B/.test(dl.last_error),
      `(${dl ? dl.last_error.slice(0, 150) : 'not in dead letter'})`);
    check('G12-1: ... nothing stored for it, and the complaint that owns the qid is unchanged',
      !b && still?.external_id === 'G12-A' && String(still.intake_item_id) === String(aRow.intake_item_id));
  }

  // ---------------------------------------------------------------- G12-2
  {
    const id = await enqueue('complaint', { qid: qa, ts: new Date().toISOString(), body: body(null, { customer: 'G12 no external id' }), who });
    items.push(id);
    await drained();
    const dl = await db.oneOrNone('SELECT last_error FROM intake_dead_letter WHERE id = $1', [id]);
    check('G12-2: a reused qid with no external id (key = queue item id) goes to dead letter',
      !!dl && new RegExp(`queue item ${id}\\)`).test(dl.last_error), `(${dl ? dl.last_error.slice(0, 150) : 'not in dead letter'})`);
  }

  // ---------------------------------------------------------------- G12-3
  {
    await worker.stop(); // run the handler by hand, twice, as a redelivery would
    const qid = await repo.nextQueryId();
    const fakeItem = { id: 990000 + Math.floor(Math.random() * 9000), kind: 'complaint' };
    const p = { qid, ts: new Date().toISOString(), body: body(null, { customer: 'G12 redelivered' }), who };
    const r1 = await db.tx((t) => intakeHandlers.complaint(p, t, fakeItem));
    const r2 = await db.tx((t) => intakeHandlers.complaint(p, t, fakeItem));
    const rows = await db.one('SELECT count(*)::int n FROM complaints WHERE intake_item_id = $1', [fakeItem.id]);
    const dup = await db.oneOrNone('SELECT dup_key, existing_ref FROM intake_duplicates WHERE item_id = $1', [fakeItem.id]);
    check('G12-3: the same queue item processed twice: stored once, the second run is a recorded duplicate verdict',
      r1.result.duplicate === false && r2.result.duplicate === true && rows.n === 1 && dup?.dup_key === `intake_item:${fakeItem.id}` && dup.existing_ref === qid,
      `(rows ${rows.n}, verdict ${JSON.stringify(dup)})`);
  }
  const worker2 = startIntakeWorker({ pollMs: 20 });
  try {
    // ---------------------------------------------------------------- G12-4
    {
      const qid = await repo.nextQueryId();
      const id = await enqueue('complaint', { qid, ts: new Date().toISOString(), body: body('G12-A'), who });
      items.push(id);
      await drained();
      const dup = await db.oneOrNone('SELECT dup_key, existing_ref FROM intake_duplicates WHERE item_id = $1', [id]);
      const n = await db.one("SELECT count(*)::int n FROM complaints WHERE external_id = 'G12-A'");
      check('G12-4: the same external id resent: nothing new stored, a duplicate verdict recorded against the stored one',
        n.n === 1 && dup?.dup_key === 'external_id:G12-A' && dup.existing_ref === qa && !(await repo.complaint(qid)), `(rows ${n.n}, verdict ${JSON.stringify(dup)})`);
    }

    // ---------------------------------------------------------------- G12-5
    {
      // A row written by hand at the counter's NEXT value (a restored dump whose counter was not moved):
      const s = await db.one('SELECT last_value::bigint AS v, is_called FROM complaint_qid_seq');
      const next = s.is_called ? Number(s.v) + 1 : Number(s.v);
      const used = `QRY-2026-${String(next).padStart(6, '0')}`;
      await db.none(`INSERT INTO complaints (qid, external_id, customer, category, ts) VALUES ($1, 'G12-HOLDER', 'holder', 'Other', now())`, [used]);
      const r = await submitComplaint(body('G12-C'), who);
      const dl = await db.oneOrNone("SELECT id, last_error FROM intake_dead_letter WHERE payload->'body'->>'externalId' = 'G12-C'");
      if (dl) items.push(dl.id);
      const holder = await repo.complaintIdentity(used);
      check('G12-5: through the API, a used qid is answered 409 rejected with the reason (not with the other complaint)',
        r.status === 409 && r.body.status === 'rejected' && r.body.queryId === used && /already used by another complaint/.test(r.body.reason || ''),
        `(${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
      check('G12-5: ... G12-C is in dead letter, not stored, and G12-HOLDER is unchanged',
        !!dl && !(await repo.complaintByExternalId('G12-C')) && holder?.external_id === 'G12-HOLDER');
    }
  } finally { await worker2.stop(); }

  // ---------------------------------------------------------------- G12-6
  {
    const ids = items.filter((x) => x != null).map(String);
    const acc = await db.one(`SELECT
        (SELECT count(*) FROM complaints WHERE intake_item_id::text = ANY($1))::int AS stored,
        (SELECT count(*) FROM intake_duplicates WHERE item_id::text = ANY($1))::int AS duplicates,
        (SELECT count(*) FROM intake_dead_letter WHERE id::text = ANY($1))::int AS dead,
        (SELECT count(*) FROM intake_queue)::int AS queued`, [ids]);
    check('G12-6: every queue item of this test is stored, a recorded duplicate, or in dead letter; none just vanished',
      acc.stored + acc.duplicates + acc.dead === ids.length && acc.queued === 0, `(${ids.length} items: stored ${acc.stored}, duplicate verdicts ${acc.duplicates}, dead letter ${acc.dead}, still queued ${acc.queued})`);
  }
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
} finally {
  await worker.stop().catch(() => {});
}
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
await closeListener();
await db.$pool.end().catch(() => {});
process.exit(fails ? 1 : 0);
