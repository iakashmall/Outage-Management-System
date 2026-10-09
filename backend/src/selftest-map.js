// Map forwarder self-test: the /api/map allowlist, path traversal, export rules for crews and the control room,
// header hygiene, and the answers when the map server is down. A fake map server records exactly what reaches it.
// Same style as selftest-oms01.js: the real /api router, identities injected the way requireAuth attaches them.
// Run: node src/selftest-map.js (needs DATABASE_URL; use a scratch DB).
import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { migrate, db } from './infra/db.js';
import { api } from './routes/api.js';
import { allowedMapPath, safeSegment, sameBbox, BBOX_TOLERANCE, clearMapInfoCache } from './routes/mapProxy.js';
import { exportTileCount, MAX_EXPORT_TILES } from './infra/mapRegions.js';

const PORT = Number(process.env.PORT || 4100);
const UPSTREAM_PORT = PORT + 2;
const DEAD_PORT = PORT + 3; // nothing listens here
const OMS_KEY = 'oms-test-key';
const SERVICE_AREA = [78.05, 29.85, 78.3, 30.05];
process.env.MAP_SERVER_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
process.env.MAP_API_KEY = OMS_KEY;

const USERS = {
  op: { username: 'op.sharma', roles: ['oms_operator'], crewId: null },
  admin: { username: 'sys.admin', roles: ['system_admin'], crewId: null },
  c3: { username: 'crew03', roles: ['field_crew'], crewId: 'C003' },
  viewer: { username: 'viewer', roles: ['oms_viewer'], crewId: null },
};

let passes = 0, fails = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
};

// ---- fake map server ----
const seen = [];
const fake = { infoStatus: 200, serviceArea: SERVICE_AREA, dropNextExport: false }; // knobs for the cache tests
const infoHits = () => seen.filter((s) => s.url === '/api/map/info').length;
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/map/info') {
      return fake.infoStatus === 200
        ? json(200, { version: 'abcdef12', bounds: [68, 6, 98, 36], serviceArea: fake.serviceArea, maxzoom: 14 })
        : json(fake.infoStatus, { error: 'broken' });
    }
    if (req.method === 'POST' && req.url === '/api/map/export' && fake.dropNextExport) { fake.dropNextExport = false; return req.socket.destroy(); }
    if (req.method === 'POST' && req.url === '/api/map/export') return json(202, { jobId: 'job_1', status: 'working' });
    if (req.url === '/style.json' && req.headers['x-api-key'] !== OMS_KEY) return json(401, { error: 'bad key' });
    return json(200, { ok: true, path: req.url });
  });
});

// ---- OMS under test ----
const app = express();
app.use(express.json({ limit: '12mb' })); // as in index.js
app.use((req, res, next) => { req.user = USERS[req.header('x-test-as') || 'op']; next(); });
app.use('/api', api);

// Raw HTTP so paths like /../ reach the server exactly as typed (fetch would normalise them).
function call(method, path, { as = 'op', body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: `/api/map${path}`,
      headers: { 'x-test-as': as, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on('error', (e) => resolve({ status: 0, json: { error: e.message } }));
    req.end(data);
  });
}
// Runs a request and returns its response plus what reached the fake map server meanwhile.
async function through(method, path, opts) {
  const before = seen.length;
  const r = await call(method, path, opts);
  return { ...r, upstream: seen.slice(before) };
}

await migrate();
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));
const server = app.listen(PORT, async () => {
  try {
    console.log('\n  map forwarder self-test');
    console.log('  ----------------------------------------');

    // 1. every allowlisted read reaches the right map server path
    const reads = [
      ['/style.json', '/style.json'],
      ['/tiles.json', '/tiles.json'],
      ['/sprite.json', '/sprite.json'],
      ['/sprite@2x.png', '/sprite@2x.png'],
      ['/tiles/12/2958/1689.pbf', '/tiles/12/2958/1689.pbf'],
      ['/tiles/0/0/0.pbf?cache=1', '/tiles/0/0/0.pbf'],
      ['/fonts/Noto%20Sans%20Regular/0-255.pbf', '/fonts/Noto%20Sans%20Regular/0-255.pbf'],
      ['/fonts/Noto Sans Regular,Noto Sans Bold/256-511.pbf'.replace(/ /g, '%20'), '/fonts/Noto%20Sans%20Regular%2CNoto%20Sans%20Bold/256-511.pbf'],
      ['/info', '/api/map/info'],
      ['/export/abc_123', '/api/map/export/abc_123'],
      ['/export/abc_123/file', '/api/map/export/abc_123/file'],
    ];
    for (const [path, expected] of reads) {
      const r = await through('GET', path);
      check(`GET ${path} -> map server ${expected}`, r.status === 200 && r.upstream.length === 1 && r.upstream[0].url === expected,
        `status ${r.status}, upstream ${JSON.stringify(r.upstream.map((u) => u.url))}`);
    }
    const head = await through('HEAD', '/style.json');
    check('HEAD /style.json is forwarded', head.status === 200 && head.upstream[0]?.method === 'HEAD');
    const crewTile = await through('GET', '/tiles/14/11700/6700.pbf', { as: 'c3' });
    check('a crew device may read tiles', crewTile.status === 200 && crewTile.upstream.length === 1);
    check('CORS header from the map server is dropped', !('access-control-allow-origin' in crewTile.headers));

    // 2. anything not listed: 404, and nothing reaches the map server
    const blocked = [
      ['GET', '/admin/keys'], ['POST', '/some/other/endpoint'], ['GET', '/health'], ['GET', '/export'],
      ['PUT', '/export'], ['DELETE', '/style.json'], ['POST', '/style.json'], ['POST', '/export/abc'],
      ['GET', '/tiles/23/0/0.pbf'], ['GET', '/tiles/12/4096/1.pbf'], ['GET', '/tiles/1/a/0.pbf'], ['GET', '/tiles/1/0/0.png'],
      ['GET', '/fonts/Noto/0-255.png'], ['GET', '/fonts/Noto/300-255.pbf'], ['GET', '/export/abc/file/extra'],
      ['GET', '/export/' + 'x'.repeat(65)], ['GET', '/sprite.svg'], ['GET', '/style.json/'],
    ];
    for (const [method, path] of blocked) {
      const r = await through(method, path);
      check(`${method} ${path} -> 404, not forwarded`, r.status === 404 && r.json?.error === 'not found' && r.upstream.length === 0,
        `status ${r.status}, upstream ${r.upstream.length}`);
    }

    // 3. traversal and encoding tricks
    const tricks = [
      '/export/../../admin/keys', '/export/..%2f..%2fadmin', '/export/%2e%2e/file', '/fonts/%2e%2e/0-255.pbf',
      '/tiles%2f1%2f0%2f0.pbf', '/export/%252e%252e/file', '/fonts/Noto%252fSans/0-255.pbf', '/style.json%00',
      '/..%5cadmin', '/fonts/..%5c..%5cetc/0-255.pbf', '/tiles//1/0/0.pbf', '/export/abc%2ffile', '/fonts/%zz/0-255.pbf',
    ];
    for (const path of tricks) {
      const r = await through('GET', path);
      check(`traversal ${path} -> refused, not forwarded`, r.status === 404 && r.upstream.length === 0, `status ${r.status}, upstream ${r.upstream.length}`);
    }
    check('allowedMapPath: unit check of a NUL byte', allowedMapPath('GET', '/style.json\0') === null);
    // The per-route patterns already refuse ".." in every slot, so the ".." rule itself is checked directly here.
    check('safeSegment: ".." and its encodings refused, ordinary names kept',
      ['..', 'a..b', '%2e%2e', '%2E.', '.%2e', '%252e%252e', 'a%2fb', 'a%5cb', '%00', '%zz'].every((s) => safeSegment(s) === null)
      && safeSegment('Noto%20Sans%20Regular') === 'Noto Sans Regular' && safeSegment('abc_123') === 'abc_123',
      JSON.stringify(['..', 'a..b'].map(safeSegment)));
    check('allowedMapPath: unit check of // in a path', allowedMapPath('GET', '//style.json') === null && allowedMapPath('GET', '/tiles//1/0/0.pbf') === null);
    // Express mounts /map with a non-strict, non-end match, so it consumes "/map/" INCLUDING one following slash and
    // re-adds a single "/": /api/map//style.json reaches the forwarder as req.url "/style.json" (allowed), while
    // /api/map///style.json reaches it as "//style.json" (refused). Only the rebuilt path is ever sent upstream.
    const leading = await through('GET', '//style.json');
    check('//style.json reaches the map server only as /style.json', leading.upstream.length === 1 && leading.upstream[0].url === '/style.json');
    const leading3 = await through('GET', '///style.json');
    check('///style.json (req.url "//style.json") -> 404, not forwarded', leading3.status === 404 && leading3.upstream.length === 0);

    // 4. raw POST /export
    const corridor = { bbox: '77.93,29.85,78.37,30.41', minZoom: 8, maxZoom: 14, label: 'corridor test', extra: 'dropped' };
    const opExp = await through('POST', '/export', { body: corridor });
    const sent = opExp.upstream[0] ? JSON.parse(opExp.upstream[0].body) : null;
    check('operator POST /export -> forwarded (202)', opExp.status === 202 && opExp.upstream.length === 1 && opExp.upstream[0].url === '/api/map/export');
    check('only bbox/minZoom/maxZoom/label reach the map server', JSON.stringify(sent) === JSON.stringify({ bbox: '77.93,29.85,78.37,30.41', minZoom: 8, maxZoom: 14, label: 'corridor test' }), JSON.stringify(sent));
    const adminExp = await through('POST', '/export', { as: 'admin', body: { bbox: [77.93, 29.85, 78.37, 30.41] } });
    check('system_admin POST /export (bbox as array, default zooms) -> forwarded', adminExp.status === 202 && JSON.parse(adminExp.upstream[0]?.body || '{}').minZoom === 8);

    const world = { bbox: '-180,-85,180,85', minZoom: 0, maxZoom: 20 };
    const crewWorld = await through('POST', '/export', { as: 'c3', body: world });
    check('crew POST /export of the whole world -> 403', crewWorld.status === 403 && !crewWorld.upstream.some((u) => u.method === 'POST'), `status ${crewWorld.status}`);
    const crewOther = await through('POST', '/export', { as: 'c3', body: { bbox: '78.05,29.85,78.3,30.06', minZoom: 8, maxZoom: 14 } });
    check('crew POST /export of an area other than the service area -> 403', crewOther.status === 403 && !crewOther.upstream.some((u) => u.method === 'POST'));
    const crewArea = await through('POST', '/export', { as: 'c3', body: { bbox: SERVICE_AREA.join(','), minZoom: 8, maxZoom: 14, label: 'crew' } });
    check('crew POST /export of exactly the service area -> forwarded (crew app fallback)', crewArea.status === 202 && crewArea.upstream.some((u) => u.method === 'POST' && u.url === '/api/map/export'));
    // service-area comparison: 1e-6 degrees per coordinate, array or string on either side
    const SA = SERVICE_AREA;
    const rounded = [SA[0] + 4e-7, SA[1] - 6e-7, SA[2] + 9e-7, SA[3] - 1e-7];
    const crewRounded = await through('POST', '/export', { as: 'c3', body: { bbox: rounded.join(','), minZoom: 8, maxZoom: 14 } });
    check('crew POST /export of the service area rounded within 1e-6 (string) -> forwarded', crewRounded.status === 202, `status ${crewRounded.status}`);
    const crewRoundedArr = await through('POST', '/export', { as: 'c3', body: { bbox: rounded, minZoom: 8, maxZoom: 14 } });
    check('crew POST /export of the service area rounded within 1e-6 (array) -> forwarded', crewRoundedArr.status === 202, `status ${crewRoundedArr.status}`);
    const crewJustOut = await through('POST', '/export', { as: 'c3', body: { bbox: [SA[0] + 2e-6, SA[1], SA[2], SA[3]], minZoom: 8, maxZoom: 14 } });
    check('crew POST /export 2e-6 off the service area -> 403', crewJustOut.status === 403 && !crewJustOut.upstream.some((u) => u.method === 'POST'));
    const crewShifted = await through('POST', '/export', { as: 'c3', body: { bbox: [SA[0] + 0.1, SA[1] + 0.1, SA[2] + 0.1, SA[3] + 0.1], minZoom: 8, maxZoom: 14 } });
    check('crew POST /export of a genuinely different area (same size, shifted) -> 403', crewShifted.status === 403 && !crewShifted.upstream.some((u) => u.method === 'POST'));
    fake.serviceArea = SA.join(','); clearMapInfoCache();
    const crewStrSA = await through('POST', '/export', { as: 'c3', body: { bbox: SA, minZoom: 8, maxZoom: 14 } });
    check('map server giving serviceArea as a string still matches', crewStrSA.status === 202, `status ${crewStrSA.status}`);
    fake.serviceArea = SERVICE_AREA; clearMapInfoCache();
    check('sameBbox unit checks', sameBbox('1,2,3,4', [1, 2, 3, 4]) && sameBbox([1, 2, 3, 4], '1.0000009,2,3,4') && !sameBbox([1, 2, 3, 4], [1.0000011, 2, 3, 4])
      && !sameBbox([1, 2, 3], [1, 2, 3]) && !sameBbox('a,b,c,d', 'a,b,c,d') && !sameBbox([1, 2, 3, 4], null) && BBOX_TOLERANCE === 1e-6);

    // /api/map/info is cached ~60 s; a failure is not cached and an upstream error clears the cache
    clearMapInfoCache();
    let hits = infoHits();
    await call('POST', '/export', { as: 'c3', body: { bbox: SA } });
    await call('POST', '/export', { as: 'c3', body: { bbox: SA } });
    check('two crew exports within 60 s ask the map server for /info once', infoHits() - hits === 1, `info calls ${infoHits() - hits}`);
    fake.dropNextExport = true;
    const dropped = await call('POST', '/export', { as: 'c3', body: { bbox: SA } });
    hits = infoHits();
    const afterDrop = await call('POST', '/export', { as: 'c3', body: { bbox: SA } });
    check('a failed forward clears the cache: the next crew export asks /info again',
      dropped.status === 502 && afterDrop.status === 202 && infoHits() - hits === 1, `drop ${dropped.status}, after ${afterDrop.status}, info calls ${infoHits() - hits}`);
    clearMapInfoCache();
    fake.infoStatus = 500;
    const infoDown = await call('POST', '/export', { as: 'c3', body: { bbox: SA } });
    check('/info answering 500 -> crew export 502 JSON (not 403)', infoDown.status === 502 && infoDown.json?.error === 'map server unavailable', `status ${infoDown.status}`);
    fake.infoStatus = 200;
    hits = infoHits();
    const infoBack = await call('POST', '/export', { as: 'c3', body: { bbox: SA } });
    check('a failed /info is not cached: the next request asks again and succeeds', infoBack.status === 202 && infoHits() - hits === 1);

    const viewerExp = await through('POST', '/export', { as: 'viewer', body: corridor });
    check('other roles POST /export -> 403', viewerExp.status === 403 && viewerExp.upstream.length === 0);

    const bad = [
      ['operator whole world zoom 0-20', world],
      ['maxZoom above 16', { bbox: '78.1,29.9,78.11,29.91', minZoom: 15, maxZoom: 17 }],
      ['more tiles than the cap', { bbox: '68,6,98,36', minZoom: 8, maxZoom: 13 }],
      ['five numbers', { bbox: '1,2,3,4,5' }], ['not numbers', { bbox: 'a,b,c,d' }], ['empty part', { bbox: '78,,79,30' }],
      ['min > max', { bbox: '78.3,29.9,78.1,30' }], ['latitude 90', { bbox: '78,29,79,90' }], ['longitude 200', { bbox: '78,29,200,30' }],
      ['missing bbox', { minZoom: 8 }], ['fractional zoom', { bbox: '78.1,29.9,78.2,30', minZoom: 8.5 }],
      ['minZoom > maxZoom', { bbox: '78.1,29.9,78.2,30', minZoom: 12, maxZoom: 10 }], ['zoom as text', { bbox: '78.1,29.9,78.2,30', maxZoom: '14' }],
      ['bad label', { bbox: '78.1,29.9,78.2,30', label: '../../x' }],
    ];
    for (const [name, body] of bad) {
      const r = await through('POST', '/export', { body });
      check(`operator POST /export ${name} -> 400`, r.status === 400 && r.upstream.length === 0, `status ${r.status} ${JSON.stringify(r.json)}`);
    }
    const huge = await through('POST', '/export', { body: { ...corridor, label: undefined, pad: 'x'.repeat(5000) } });
    check('POST /export body over 4 KB -> 413', huge.status === 413 && huge.upstream.length === 0, `status ${huge.status}`);
    check('tile count: corridor at zoom 8-14 is under the cap', exportTileCount([77.93, 29.85, 78.37, 30.41], 8, 14) < MAX_EXPORT_TILES);

    // 5. region exports keep their rules and now share the cap
    const crewRegion = await through('POST', '/regions/corridor/export', { as: 'c3', body: {} });
    check('crew /regions/:id/export for a non-crew region -> 403', crewRegion.status === 403 && crewRegion.upstream.length === 0);
    const crewOwn = await through('POST', '/regions/haridwar/export', { as: 'c3', body: {} });
    check('crew /regions/:id/export for a crew region -> forwarded', crewOwn.status === 202 && crewOwn.upstream[0]?.url === '/api/map/export');
    const deepRegion = await through('POST', '/regions/haridwar/export', { body: { minZoom: 8, maxZoom: 22 } });
    check('/regions/:id/export above the zoom cap -> 400', deepRegion.status === 400 && deepRegion.upstream.length === 0);

    // 6. header hygiene
    const dirty = await through('GET', '/style.json', {
      headers: {
        'x-api-key': 'stolen-key', authorization: 'Bearer user-token', cookie: 'sid=1', 'proxy-authorization': 'Basic x',
        'x-forwarded-host': 'evil.example', 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'gopher', forwarded: 'for=6.6.6.6',
        'x-real-ip': '6.6.6.6', connection: 'keep-alive, x-secret', 'x-secret': 'hop', 'keep-alive': 'timeout=5', te: 'trailers',
        accept: 'application/json',
      },
    });
    const h = dirty.upstream[0]?.headers || {};
    check('client x-api-key replaced by the OMS key', h['x-api-key'] === OMS_KEY, h['x-api-key']);
    check('Authorization and Cookie never forwarded', !h.authorization && !h.cookie);
    check('client x-forwarded-* / forwarded / x-real-ip replaced or dropped',
      h['x-forwarded-host'] === `127.0.0.1:${PORT}` && h['x-forwarded-proto'] === 'http' && h['x-forwarded-prefix'] === '/api/map' && !h['x-forwarded-for'] && !h.forwarded && !h['x-real-ip'],
      JSON.stringify(h));
    check('hop-by-hop headers (and ones named in Connection) dropped',
      !h['proxy-authorization'] && !h['x-secret'] && !h['keep-alive'] && !h.te && h.connection !== 'keep-alive, x-secret');
    check('ordinary headers still forwarded', h.accept === 'application/json');

    // x-forwarded-host: the connection's Host by default; OMS_PUBLIC_URL when set (the client's Host is then ignored)
    const evilHost = { headers: { host: 'evil.example', 'x-forwarded-host': 'evil2.example' } };
    const byHost = (await through('GET', '/style.json', evilHost)).upstream[0]?.headers || {};
    check('OMS_PUBLIC_URL unset: x-forwarded-host is the request Host (default behaviour)', byHost['x-forwarded-host'] === 'evil.example' && byHost['x-forwarded-proto'] === 'http');
    process.env.OMS_PUBLIC_URL = 'https://oms.example.org/oms/';
    const byPub = (await through('GET', '/style.json', evilHost)).upstream[0]?.headers || {};
    check('OMS_PUBLIC_URL set: x-forwarded-host/proto/prefix come from it, not the client',
      byPub['x-forwarded-host'] === 'oms.example.org' && byPub['x-forwarded-proto'] === 'https' && byPub['x-forwarded-prefix'] === '/oms/api/map', JSON.stringify(byPub));
    process.env.OMS_PUBLIC_URL = 'ftp://not-http';
    const byBad = (await through('GET', '/style.json', evilHost)).upstream[0]?.headers || {};
    check('OMS_PUBLIC_URL not http(s): falls back to the request Host', byBad['x-forwarded-host'] === 'evil.example');
    delete process.env.OMS_PUBLIC_URL;

    delete process.env.MAP_API_KEY;
    const noKey = await through('GET', '/tiles/1/0/0.pbf', { headers: { 'x-api-key': 'stolen-key' } });
    check('without MAP_API_KEY, a client x-api-key still never reaches the map server', noKey.upstream.length === 1 && !noKey.upstream[0].headers['x-api-key']);
    const refused = await through('GET', '/style.json');
    check('map server refusing the OMS key -> 502 with an admin hint', refused.status === 502 && /MAP_API_KEY/.test(refused.json?.error || ''));
    process.env.MAP_API_KEY = OMS_KEY;

    // 7. map server down
    process.env.MAP_SERVER_URL = `http://127.0.0.1:${DEAD_PORT}`;
    const down = await call('GET', '/tiles/1/0/0.pbf');
    check('map server down: tile -> 502 JSON', down.status === 502 && down.json?.error === 'map server unavailable', `status ${down.status}`);
    const downCrew = await call('POST', '/export', { as: 'c3', body: { bbox: SERVICE_AREA.join(',') } });
    check('map server down: crew POST /export -> 502 JSON', downCrew.status === 502 && downCrew.json?.error === 'map server unavailable');
    const downRegion = await call('POST', '/regions/haridwar/export', { body: {} });
    check('map server down: region export -> 502 JSON', downRegion.status === 502 && downRegion.json?.error === 'map server unavailable');
    const regions = await call('GET', '/regions');
    check('map server down: the region list still works', regions.status === 200 && regions.json?.regions?.length > 0);
    process.env.MAP_SERVER_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
  } catch (e) {
    fails++;
    console.log('  [FAIL] unexpected error', e.stack);
  }
  console.log('  ----------------------------------------');
  console.log(`  ${passes}/${passes + fails} passed`);
  server.close();
  upstream.close();
  await db.$pool.end().catch(() => {});
  process.exit(fails ? 1 : 0);
});
