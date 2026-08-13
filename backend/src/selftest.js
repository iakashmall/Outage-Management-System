// Boots the real Express app in-process (supertest-free), exercises the API
// against the real SQLite DB, prints results, and exits. Run: node src/selftest.js
import express from 'express';
import { migrate } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';

migrate();
seed({ force: true });

const app = express();
app.use(express.json());
app.use('/api', api);

const server = app.listen(4100, async () => {
  const base = 'http://127.0.0.1:4100/api';
  const j = async (m, p, b) => {
    const r = await fetch(base + p, {
      method: m, headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const results = [];
  const check = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };

  const inc = await j('GET', '/incidents');
  check('GET /incidents returns seeded rows', inc.body.length === 7, `(${inc.body.length})`);

  const ind = await j('GET', '/indicators');
  check('indicators computed', ind.body.saidi > 0 && ind.body.caidi < 100,
    `saidi=${ind.body.saidi} saifi=${ind.body.saifi} caidi=${ind.body.caidi}`);

  const bad = await j('PATCH', '/incidents/INC-2026-000003/status', { status: 'closed' });
  check('state machine rejects open→closed', bad.status === 409, `(${bad.status})`);

  const good = await j('PATCH', '/incidents/INC-2026-000003/status', { status: 'dispatched' });
  check('state machine allows open→dispatched', good.body.status === 'dispatched');

  const created = await j('POST', '/incidents', { zone: 'Test Zone', severity: 'high', cause: 'Test', feeder: 'FDR-X' });
  check('manual incident create (FR-OMS-002)', created.status === 201 && /INC-2026-/.test(created.body.id), created.body.id);

  const asg = await j('POST', '/incidents/INC-2026-000006/assign', { crewId: 'C004', priority: 'Urgent' });
  check('dispatch assigns crew + creates job', asg.body.crew.status === 'in_transit' && !!asg.body.job);

  const jobId = asg.body.job.id;
  const mob = await j('PATCH', `/mobile/jobs/${jobId}/status`, { status: 'On Site', lat: 30.1, lon: 78.2 });
  check('mobile status update accepted', mob.body.status === 'On Site');
  const incAfter = await j('GET', '/incidents/INC-2026-000006');
  check('mobile On Site flips incident → in_progress', incAfter.body.status === 'in_progress', incAfter.body.status);

  const ack = await j('POST', '/alarms/ack-all');
  check('ack-all clears unacked alarms', ack.body.every(a => a.ack === 1));

  const tcs = await j('POST', '/calls/CALL-002/to-incident');
  check('trouble call → incident (FR-OMS-005)', tcs.status === 201);

  console.log('\n  OMS backend self-test\n  ' + '-'.repeat(40));
  results.forEach(([s, n, e]) => console.log(`  [${s}] ${n} ${e}`));
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log('  ' + '-'.repeat(40));
  console.log(`  ${results.length - fails}/${results.length} passed\n`);
  server.close();
  process.exit(fails ? 1 : 0);
});
