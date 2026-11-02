// Error middleware unit tests (node:test; part of `npm test`): async route errors reach errorHandler
// through express-async-errors and come back as JSON, 503 for an exhausted pool, 500 for anything else.
import 'express-async-errors';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler, isPoolTimeout } from './errors.js';

const app = express();
app.get('/boom', async () => { throw new Error('something broke'); });
app.get('/busy', async () => { await Promise.resolve(); throw new Error('timeout exceeded when trying to connect'); });
app.get('/slow-connect', async () => { throw new Error('Connection terminated due to connection timeout'); });
app.get('/sync', () => { throw new Error('sync throw'); });
app.use(errorHandler);

let base;
const server = app.listen(0);
test.before(async () => {
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// Count console.error calls made while one request is handled.
async function call(path) {
  const orig = console.error; let logs = 0;
  console.error = () => { logs += 1; };
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(3000) });
    return { status: r.status, type: r.headers.get('content-type'), body: await r.json(), logs };
  } finally { console.error = orig; }
}

test('isPoolTimeout recognises pg-pool and pg connect timeouts only', () => {
  assert.equal(isPoolTimeout(new Error('timeout exceeded when trying to connect')), true);
  assert.equal(isPoolTimeout(new Error('Connection terminated due to connection timeout')), true);
  assert.equal(isPoolTimeout(new Error('canceling statement due to statement timeout')), false);
  assert.equal(isPoolTimeout(undefined), false);
});

test('a rejected async route returns JSON 500, logged once', async () => {
  const r = await call('/boom');
  assert.equal(r.status, 500);
  assert.match(r.type, /application\/json/);
  assert.deepEqual(r.body, { error: 'internal server error' });
  assert.equal(r.logs, 1);
});

test('an exhausted pool returns JSON 503, logged once', async () => {
  for (const path of ['/busy', '/slow-connect']) {
    const r = await call(path);
    assert.equal(r.status, 503, path);
    assert.deepEqual(r.body, { error: 'database busy, try again' });
    assert.equal(r.logs, 1);
  }
});

test('a synchronous throw still returns JSON 500', async () => {
  const r = await call('/sync');
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'internal server error' });
});
