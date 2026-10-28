// setTag, cacheSet and cacheDel must never throw (node:test; part of `npm test`): a Redis that rejects
// writes, e.g. full under maxmemory with volatile-lru (tag:* keys have no TTL, so they are never evicted),
// must not make handleScadaEvent drop the event or a route fail. Needs a reachable Redis (REDIS_URL);
// skipped without one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redis, connectRedis, isRedisConnected, setTag, getTag, cacheGet, cacheSet, cacheDel, disconnectRedis } from './redis.js';

await connectRedis();
const skip = isRedisConnected() ? false : 'no Redis at REDIS_URL';
test.after(() => disconnectRedis());

test('setTag writes the tag when Redis accepts it', { skip }, async () => {
  const rec = await setTag('SELFTEST.REDIS.OK', 42);
  assert.equal(rec.value, 42);
  assert.equal((await getTag('SELFTEST.REDIS.OK')).value, 42);
  await redis.del('tag:SELFTEST.REDIS.OK');
});

test('setTag resolves null, logged once, when Redis rejects the write', { skip }, async () => {
  const warn = console.warn; let logs = 0;
  redis.set = async () => { throw new Error("OOM command not allowed when used memory > 'maxmemory'."); };
  console.warn = () => { logs += 1; };
  try {
    assert.equal(await setTag('SELFTEST.REDIS.FULL', 1), null);
    assert.equal(await setTag('SELFTEST.REDIS.FULL', 2), null);
    assert.equal(logs, 1);
  } finally {
    delete redis.set; // back to the client's own method
    console.warn = warn;
  }
  assert.equal((await setTag('SELFTEST.REDIS.FULL', 3)).value, 3); // recovers
  await redis.del('tag:SELFTEST.REDIS.FULL');
});

test('cacheSet and cacheDel resolve null, each warning once, when Redis rejects them', { skip }, async () => {
  const warn = console.warn; const logs = [];
  const oom = async () => { throw new Error("OOM command not allowed when used memory > 'maxmemory'."); };
  redis.set = oom; redis.del = oom;
  console.warn = (msg) => { logs.push(msg); };
  try {
    assert.equal(await cacheSet('selftest-full', { a: 1 }), null);
    assert.equal(await cacheSet('selftest-full', { a: 2 }), null);
    assert.equal(await cacheDel('selftest-full'), null);
    assert.equal(await cacheDel('selftest-full'), null);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /cache write failed/);
    assert.match(logs[1], /cache delete failed/);
  } finally {
    delete redis.set; delete redis.del; // back to the client's own methods
    console.warn = warn;
  }
  await cacheSet('selftest-full', { a: 3 }); // recovers
  assert.deepEqual(await cacheGet('selftest-full'), { a: 3 });
  await cacheDel('selftest-full');
  assert.equal(await cacheGet('selftest-full'), null);
});
