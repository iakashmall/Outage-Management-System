// F4 (load-test findings, 3 Nov 2026): a Redis that stops answering, or is
// stopped, costs milliseconds per cache call, never seconds, and no call
// throws. node:test, part of `npm test`. The client reaches the real Redis
// (REDIS_URL) through a TCP proxy this test controls; skipped without a Redis.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

const target = new URL(process.env.REDIS_URL || 'redis://localhost:16379');
// forward: relay both ways. stall: keep every connection open but relay
// nothing (Redis hung: the client stays "connected", commands get no reply).
// refuse: nothing listens (Redis stopped).
let mode = 'forward';
const socks = new Set();
const pairs = new Set();
const proxy = net.createServer((c) => {
  socks.add(c); c.on('close', () => socks.delete(c)); c.on('error', () => {});
  if (mode !== 'forward') return; // accept, never answer
  const up = net.connect(Number(target.port || 6379), target.hostname);
  socks.add(up); up.on('close', () => socks.delete(up)); up.on('error', () => c.destroy());
  const pair = { c, up }; pairs.add(pair);
  c.on('data', (d) => { if (mode === 'forward') up.write(d); });
  up.on('data', (d) => { if (mode === 'forward') c.write(d); });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const via = new URL(target.href); via.host = `127.0.0.1:${proxy.address().port}`;
process.env.REDIS_URL = via.href;
process.env.REDIS_COMMAND_TIMEOUT_MS = '250';

const { connectRedis, isRedisConnected, setTag, getTag, cacheGet, cacheSet, cacheDel, getTagsByPrefix, disconnectRedis, redis } = await import('./redis.js');
await connectRedis();
const skip = isRedisConnected() ? false : `no Redis at ${target.host}`;

const timed = async (fn) => { const t0 = performance.now(); let threw = null, value; try { value = await fn(); } catch (e) { threw = e; } return { ms: performance.now() - t0, threw, value }; };
const calls = {
  setTag: () => setTag('F4.TEST.CB1', 'TRIP'),
  getTag: () => getTag('F4.TEST.CB1'),
  cacheSet: () => cacheSet('f4', { a: 1 }),
  cacheGet: () => cacheGet('f4'),
  cacheDel: () => cacheDel('f4'),
  getTagsByPrefix: () => getTagsByPrefix('F4.'),
};

test.after(async () => {
  try { redis.destroy(); } catch { /* already closed */ }
  for (const s of [...socks]) s.destroy();
  if (proxy.listening) proxy.close();
});

test('F4: with Redis up, the calls work', { skip }, async () => {
  await setTag('F4.TEST.CB1', 'TRIP');
  assert.equal((await getTag('F4.TEST.CB1'))?.value, 'TRIP');
});

test('F4: Redis hangs (connection open, no replies): every cache call returns null/undefined in under 400 ms and none throws', { skip }, async () => {
  mode = 'stall';
  assert.ok(isRedisConnected(), 'still connected while Redis hangs');
  const seen = {};
  for (let round = 0; round < 3; round++) {
    for (const [name, fn] of Object.entries(calls)) {
      const r = await timed(fn);
      seen[name] = Math.max(seen[name] || 0, Math.round(r.ms));
      assert.equal(r.threw, null, `${name} threw ${r.threw?.message}`);
      assert.ok(r.ms < 400, `${name} took ${Math.round(r.ms)} ms`);
    }
  }
  console.log('  hung Redis, max ms per call:', JSON.stringify(seen));
});

test('F4: Redis refuses connections (stopped): every cache call returns in under 600 ms and none throws', { skip }, async () => {
  mode = 'refuse';
  const closed = new Promise((r) => proxy.close(r)); // nothing listens: connection refused
  for (const s of [...socks]) s.destroy();
  await closed;
  await new Promise((r) => setTimeout(r, 50));
  const seen = {};
  for (const [name, fn] of Object.entries(calls)) {
    const r = await timed(fn);
    seen[name] = Math.round(r.ms);
    assert.equal(r.threw, null, `${name} threw ${r.threw?.message}`);
    assert.ok(r.ms < 600, `${name} took ${Math.round(r.ms)} ms`);
  }
  console.log('  refused, ms per call:', JSON.stringify(seen));
});
