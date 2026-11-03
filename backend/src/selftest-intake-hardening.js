// Intake hardening self-test (runbook WP3 gates): oversized body 413, bad
// fields 400, no token 401, wrong role 403, simulator routes 404 by default,
// plus the generous rate limit (429). The app is wired the way index.js wires
// it (intake parsers, app-wide 12 MB parser, the REAL requireAuth, api,
// errorHandler). Tokens are RS256, signed with a key made here and served from
// a local JWKS endpoint, so requireAuth verifies them exactly as it verifies
// Keycloak's.
// Run: DATABASE_URL=<scratch db> node src/selftest-intake-hardening.js
// Destructive: it runs seed --force. It does not read .env.
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) {
  console.error('selftest-intake-hardening: set DATABASE_URL to a scratch database (this test reseeds it)');
  process.exit(2);
}
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'selftest-only-key';
delete process.env.ENABLE_SIMULATORS;
delete process.env.INTAKE_RATE_LIMIT_PER_MIN;
delete process.env.SCADA_RATE_LIMIT_PER_MIN;

// Local JWKS: started before auth.js is imported, because auth.js reads KEYCLOAK_JWKS_URI at load.
const KID = 'selftest-intake';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; // not in the JWKS
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const jwks = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
process.env.KEYCLOAK_JWKS_URI = `http://127.0.0.1:${jwks.address().port}/certs`;

const { default: express } = await import('express');
const { default: jwt } = await import('jsonwebtoken');
await import('express-async-errors');
const { migrate, db } = await import('./infra/db.js');
const { seed } = await import('./infra/seed.js');
const { api } = await import('./routes/api.js');
const { requireAuth } = await import('./routes/auth.js');
const { errorHandler } = await import('./routes/errors.js');
const { mountIntakeParsers } = await import('./routes/intake.js');
const { initBus } = await import('./domain/bus.js');
const { substations } = await import('./infra/geo.js');

await migrate();
// The complaint insert encrypts the phone (repo.addComplaint, pgp_sym_encrypt):
// do what db/migrations/encrypt_phone_at_rest.sql does, so the 201 paths run
// on a bare scratch database too (plus safe_decrypt_phone.sql). Idempotent.
await db.none('CREATE EXTENSION IF NOT EXISTS pgcrypto');
if ((await db.oneOrNone(`SELECT data_type FROM information_schema.columns WHERE table_name = 'complaints' AND column_name = 'phone'`))?.data_type === 'text') {
  await db.none(`ALTER TABLE complaints ADD COLUMN phone_encrypted bytea;
    UPDATE complaints SET phone_encrypted = pgp_sym_encrypt(phone, $1) WHERE phone IS NOT NULL;
    ALTER TABLE complaints DROP COLUMN phone;
    ALTER TABLE complaints RENAME COLUMN phone_encrypted TO phone;`, [process.env.ENCRYPTION_KEY]);
}
await db.none(readFileSync(new URL('../../db/migrations/safe_decrypt_phone.sql', import.meta.url), 'utf8')); // CREATE OR REPLACE
await seed({ force: true });
await initBus();

let fails = 0, passes = 0;
const check = (name, ok, extra = '') => {
  ok ? passes++ : fails++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${extra}`);
};

const token = (username, roles, key = privateKey) =>
  jwt.sign({ preferred_username: username, realm_access: { roles } }, key, { algorithm: 'RS256', keyid: KID, expiresIn: '10m' });
const T = {
  cc: token('cc.negi', ['call_centre_attendant']),
  op: token('op.sharma', ['oms_operator']),
  admin: token('admin.joshi', ['system_admin']),
  scada: token('scada.rtu', ['scada_operator']),
  crew: token('crew03', ['field_crew']),
  coord: token('coord.rawat', ['field_crew_coordinator']),
  forged: token('mallory', ['system_admin'], otherKey),
  rl: token('rl.tester', ['call_centre_attendant']),
};

// Same order as index.js.
const app = express();
mountIntakeParsers(app);
app.use(express.json({ limit: '12mb' }));
app.use('/api', requireAuth, api);
app.use(errorHandler);

// index.js must mount the intake parsers before its app-wide 12 MB parser, or the 64 KB limit never applies.
const indexSrc = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const iIntake = indexSrc.indexOf('mountIntakeParsers(app)'), iWide = indexSrc.indexOf("express.json({ limit: '12mb' })");
check('index.js mounts the 64 KB intake parsers before the app-wide 12 MB parser', iIntake > 0 && iWide > iIntake, `${iIntake} < ${iWide}`);

const sub = substations.find((s) => typeof s.lat === 'number') || { lat: 29.95, lon: 78.13 };
const good = (n) => ({ externalId: `EXT-WP3-${n}`, customer: 'WP3 test', phone: '9000000003', category: 'No Supply', address: 'Near test', lat: sub.lat, lon: sub.lon });

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (as, method, path, body, raw) => {
    const headers = { 'content-type': 'application/json' };
    if (as) headers.authorization = `Bearer ${T[as] || as}`;
    const r = await fetch(base + path, { method, headers, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
    return { status: r.status, retryAfter: r.headers.get('retry-after'), type: r.headers.get('content-type') || '', body: await r.json().catch(() => ({})) };
  };

  try {
    // ---- 413: oversized body on the intake routes, large limit kept on photos ----
    const big = JSON.stringify({ ...good('big'), notes: 'x'.repeat(70 * 1024) });
    for (const p of ['/complaints', '/scada/fault', '/calls', '/complaints/simulate']) {
      const r = await call('admin', 'POST', p, null, big);
      check(`413 for a 70 KB body on POST ${p}`, r.status === 413 && r.type.includes('json') && /too large/.test(r.body.error), `${r.status} ${JSON.stringify(r.body)}`);
    }
    const under = await call('cc', 'POST', '/complaints', { ...good('under'), notes: 'x'.repeat(60 * 1024) });
    check('a 60 KB complaint is still accepted (limit is 64 KB, not lower)', under.status === 201, `${under.status} ${JSON.stringify(under.body).slice(0, 120)}`);
    const photo = await call('crew', 'POST', '/mobile/jobs/NO-SUCH-JOB/photos', null, JSON.stringify({ dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(200 * 1024) }));
    check('a 200 KB photo body is not 413 (photo routes keep the large limit)', photo.status !== 413, `status ${photo.status}`);

    // ---- 400: bad fields, each named in the message ----
    const bad400 = [
      ['/complaints', { ...good(1), category: 'Ghosts' }, /category must be one of/],
      ['/complaints', { ...good(2), lat: '29.9' }, /lat must be a number/],
      ['/complaints', { ...good(3), lat: 95 }, /lat must be a number between -90 and 90/],
      ['/complaints', { ...good(4), lon: undefined }, /lat and lon must be sent together/],
      ['/complaints', { ...good(5), phone: 'call me maybe' }, /phone must be/],
      ['/complaints', { ...good(6), externalId: { $ne: 1 } }, /externalId must be a string/],
      ['/complaints', { ...good(7), customer: 'x'.repeat(201) }, /customer must be at most 200/],
      ['/complaints', { category: 'No Supply', customer: 'nowhere' }, /lat\/lon or address is required/],
      ['/complaints', [good(8)], /body must be a JSON object/],
      ['/scada/fault', { event: 'trip' }, /tag is required/],
      ['/scada/fault', { tag: 'X.Y.CB1.TRIP', event: 'blink' }, /event must be/],
      ['/scada/fault', { tag: 'X.Y.CB1.TRIP', customers: -5 }, /customers must be a whole number/],
      ['/scada/fault', { tag: 'X'.repeat(129) }, /tag must be at most 128/],
      ['/calls', { customer: 'A', phone: '12', address: 'B', category: 'No Supply' }, /phone must be/],
      ['/calls', { customer: 'A', phone: '9000000000', address: 'x'.repeat(501), category: 'No Supply' }, /address must be at most 500/],
    ];
    for (const [p, body, re] of bad400) {
      const r = await call('admin', 'POST', p, body);
      check(`400 on POST ${p}: ${re.source}`, r.status === 400 && re.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
    }
    const malformed = await call('admin', 'POST', '/complaints', null, '{"category": "No Supply",');
    check('400 for malformed JSON, as JSON', malformed.status === 400 && /not valid JSON/.test(malformed.body.error || ''), `${malformed.status} ${JSON.stringify(malformed.body)}`);

    // ---- 401: no token, or a token not signed by the realm key ----
    for (const p of ['/complaints', '/scada/fault', '/calls']) {
      const r = await call(null, 'POST', p, good('anon'));
      check(`401 without a token on POST ${p}`, r.status === 401, `${r.status}`);
    }
    const forged = await call('forged', 'POST', '/complaints', good('forged'));
    check('401 for a token signed by a key outside the JWKS', forged.status === 401, `${forged.status}`);

    // ---- 403: signed in, wrong role ----
    const r403 = [
      ['crew', '/complaints', good('crew')],
      ['coord', '/complaints', good('coord')],
      ['crew', '/scada/fault', { tag: 'X.Y.CB1.TRIP' }],
      ['cc', '/scada/fault', { tag: 'X.Y.CB1.TRIP' }],
      ['crew', '/calls', { customer: 'A', phone: '9000000000', address: 'B', category: 'No Supply' }],
    ];
    for (const [as, p, body] of r403) {
      const r = await call(as, 'POST', p, body);
      check(`403 for ${as} on POST ${p}`, r.status === 403, `${r.status}`);
    }

    // ---- allowed roles still get through ----
    const ccOk = await call('cc', 'POST', '/complaints', good('cc'));
    check('201 for a valid complaint from call_centre_attendant', ccOk.status === 201 && ccOk.body.queryId, `${ccOk.status}`);
    const opOk = await call('op', 'POST', '/complaints', { ...good('op'), category: 'Meter' });
    check('201 for a valid complaint from oms_operator', opOk.status === 201, `${opOk.status}`);
    const addrOnly = await call('cc', 'POST', '/complaints', { customer: 'Addr only', address: 'Jwalapur', category: 'Other' });
    check('201 for a complaint with an address and no coordinates', addrOnly.status === 201, `${addrOnly.status} ${JSON.stringify(addrOnly.body).slice(0, 100)}`);
    const scadaOk = await call('scada', 'POST', '/scada/fault', { tag: 'WP3.FDR1.CB1.MINOR', condition: 'MINOR', customers: 10 });
    check('202 for a valid SCADA event from scada_operator', scadaOk.status === 202, `${scadaOk.status}`);

    // ---- 404: simulator routes unless ENABLE_SIMULATORS=true ----
    for (const p of ['/complaints/simulate', '/scada/simulate']) {
      const r = await call('admin', 'POST', p, { tag: 'WP3.SIM.CB1.TRIP', event: 'trip' });
      check(`404 for POST ${p} by default, even for system_admin`, r.status === 404, `${r.status}`);
    }
    process.env.ENABLE_SIMULATORS = 'false';
    check('404 for POST /complaints/simulate with ENABLE_SIMULATORS=false', (await call('admin', 'POST', '/complaints/simulate')).status === 404);
    process.env.ENABLE_SIMULATORS = 'true';
    const simC = await call('op', 'POST', '/complaints/simulate');
    check('201 for POST /complaints/simulate with ENABLE_SIMULATORS=true', simC.status === 201, `${simC.status}`);
    const simS = await call('admin', 'POST', '/scada/simulate', { tag: 'WP3.SIM.CB1.MINOR', condition: 'MINOR', event: 'trip' });
    check('202 for POST /scada/simulate with ENABLE_SIMULATORS=true (admin)', simS.status === 202, `${simS.status}`);
    const simS403 = await call('op', 'POST', '/scada/simulate', { tag: 'WP3.SIM.CB1.MINOR', event: 'trip' });
    check('403 for POST /scada/simulate by a non-admin with the flag on', simS403.status === 403, `${simS403.status}`);
    delete process.env.ENABLE_SIMULATORS;

    // ---- 429: rate limit per client, generous by default ----
    process.env.INTAKE_RATE_LIMIT_PER_MIN = '3';
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await call('rl', 'POST', '/complaints', good(`rl${i}`)));
    check('429 with Retry-After once a client passes its limit', codes.slice(0, 3).every((r) => r.status === 201) && codes[3].status === 429 && Number(codes[3].retryAfter) >= 1,
      codes.map((r) => r.status).join(','));
    const other = await call('op', 'POST', '/complaints', { ...good('rl-other'), category: 'Meter' });
    check('another client is not limited by that one', other.status === 201, `${other.status}`);
    process.env.INTAKE_RATE_LIMIT_PER_MIN = '0';
    check('INTAKE_RATE_LIMIT_PER_MIN=0 turns the limit off', (await call('rl', 'POST', '/complaints', good('rl-off'))).status === 201);
    delete process.env.INTAKE_RATE_LIMIT_PER_MIN;
  } catch (err) {
    fails++;
    console.log('  [FAIL] threw:', err.stack || err.message);
  } finally {
    console.log(`\n${passes} passed, ${fails} failed`);
    server.close();
    jwks.close();
    await db.$pool.end();
    process.exit(fails ? 1 : 0);
  }
});
