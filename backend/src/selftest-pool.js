// Database pool self-test (infra/db.js + routes/errors.js): pool settings come from the environment,
// the defaults keep pg's old behaviour (no timeouts), and when the pool is full a request gets a JSON
// 503 after PG_CONNECT_TIMEOUT_MS instead of hanging. Needs a database, only runs SELECT/SHOW:
//   DATABASE_URL=<scratch db> node src/selftest-pool.js
import 'express-async-errors';
import { spawnSync } from 'node:child_process';
import express from 'express';

if (!process.env.DATABASE_URL) {
  console.error('selftest-pool: set DATABASE_URL to a scratch database');
  process.exit(2);
}

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

// Pool options as db.js builds them for a given environment, in a fresh process.
function poolOptions(env) {
  const clean = { ...process.env };
  for (const k of ['PG_POOL_MAX', 'PG_IDLE_TIMEOUT_MS', 'PG_CONNECT_TIMEOUT_MS', 'PG_STATEMENT_TIMEOUT_MS', 'PG_IDLE_TX_TIMEOUT_MS']) delete clean[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(new URL('./infra/db.js', import.meta.url).href)});
    const o = db.$pool.options;
    console.log(JSON.stringify({ max: o.max, idleTimeoutMillis: o.idleTimeoutMillis, connectionTimeoutMillis: o.connectionTimeoutMillis,
      statement_timeout: o.statement_timeout, idle_in_transaction_session_timeout: o.idle_in_transaction_session_timeout }));
    await db.$pool.end();`], { env: { ...clean, ...env }, encoding: 'utf8' });
  return r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').pop()) : { error: (r.stderr.match(/^Error: .*$/m) || [r.stderr.trim()])[0] };
}

const defaults = poolOptions({});
check('defaults: max 10, idleTimeoutMillis 30000', defaults.max === 10 && defaults.idleTimeoutMillis === 30000, JSON.stringify(defaults));
check('defaults: no connection, statement or idle-in-transaction timeout',
  defaults.connectionTimeoutMillis === undefined && defaults.statement_timeout === undefined && defaults.idle_in_transaction_session_timeout === undefined);
const fromEnv = poolOptions({ PG_POOL_MAX: '4', PG_IDLE_TIMEOUT_MS: '1000', PG_CONNECT_TIMEOUT_MS: '5000', PG_STATEMENT_TIMEOUT_MS: '60000', PG_IDLE_TX_TIMEOUT_MS: '60000' });
check('every setting is read from the environment',
  fromEnv.max === 4 && fromEnv.idleTimeoutMillis === 1000 && fromEnv.connectionTimeoutMillis === 5000
  && fromEnv.statement_timeout === 60000 && fromEnv.idle_in_transaction_session_timeout === 60000, JSON.stringify(fromEnv));
const bad = poolOptions({ PG_CONNECT_TIMEOUT_MS: '5s' });
check('a malformed value stops startup with a clear message', /PG_CONNECT_TIMEOUT_MS must be a whole number/.test(bad.error || ''), bad.error || '');

// From here on: a one-connection pool that gives up waiting after 500 ms.
process.env.PG_POOL_MAX = '1';
process.env.PG_CONNECT_TIMEOUT_MS = '500';
process.env.PG_STATEMENT_TIMEOUT_MS = '60000';
process.env.PG_IDLE_TX_TIMEOUT_MS = '60000';
const { db } = await import('./infra/db.js');
const { errorHandler } = await import('./routes/errors.js');

const app = express();
app.get('/one', async (req, res) => res.json(await db.one('SELECT 1 AS one')));
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/one`;

try {
  const s = await db.one("SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS itx");
  check('statement and idle-in-transaction timeouts reach the session', s.st === '1min' && s.itx === '1min', JSON.stringify(s));

  check('a free pool answers 200', (await fetch(url)).status === 200);

  const held = await db.connect(); // the pool's only connection
  const t0 = Date.now();
  let r, body;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(5000) }); // would throw TimeoutError if it hung
    body = await r.json();
  } catch (e) { r = { status: e.name }; }
  const ms = Date.now() - t0;
  check('pool full: the request gets a JSON 503', r.status === 503 && body?.error === 'database busy, try again', `${r.status} ${JSON.stringify(body)}`);
  check('... after the connect timeout, not hanging', ms >= 400 && ms < 3000, `${ms} ms`);
  held.done();

  check('once the connection is released the same request answers 200', (await fetch(url)).status === 200);
} catch (e) {
  fails++;
  console.log('  [FAIL] unexpected error', e.stack);
}
console.log('  ----------------------------------------');
console.log(`  ${passes}/${passes + fails} passed`);
// Close everything and let the process end by itself: process.exit() with fetch's keep-alive sockets still
// closing trips a libuv assertion on Windows.
server.closeAllConnections();
await new Promise((r) => server.close(r));
await db.$pool.end().catch(() => {});
process.exitCode = fails ? 1 : 0;
