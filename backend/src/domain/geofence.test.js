import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteCheck, distanceM } from './geofence.js';

const site = { lat: 30.3165, lon: 78.0322 }; // Dehradun
// ~0.0009 deg of latitude is ~100 m
const at = (dLatM) => ({ lat: site.lat + dLatM / 111195, lon: site.lon });

test('distance is about right at street scale', () => {
  assert.ok(Math.abs(distanceM(site, at(100)) - 100) < 1);
});

test('only On Site and Work Started are checked', () => {
  for (const status of ['Acknowledged', 'En Route', 'Work Complete']) {
    assert.equal(siteCheck({ status, site, ...at(5000), radius: 100 }), null);
  }
});

test('within the radius is allowed, outside is refused with the distance', () => {
  assert.equal(siteCheck({ status: 'On Site', site, ...at(80), radius: 100 }), null);
  const r = siteCheck({ status: 'Work Started', site, ...at(450), radius: 100 });
  assert.equal(r.code, 'NOT_ON_SITE');
  assert.ok(r.distance >= 449 && r.distance <= 451);
});

test('no phone position is refused; no site position is never blocked', () => {
  assert.equal(siteCheck({ status: 'On Site', site, lat: null, lon: null, radius: 100 }).code, 'NO_LOCATION');
  assert.equal(siteCheck({ status: 'On Site', site: { lat: null, lon: null }, ...at(5000), radius: 100 }), null);
  assert.equal(siteCheck({ status: 'On Site', site: null, ...at(5000), radius: 100 }), null);
});

test('SITE_RADIUS_M sets the default radius', () => {
  process.env.SITE_RADIUS_M = '500';
  try {
    assert.equal(siteCheck({ status: 'On Site', site, ...at(450) }), null);
  } finally {
    delete process.env.SITE_RADIUS_M;
  }
  assert.equal(siteCheck({ status: 'On Site', site, ...at(450) }).code, 'NOT_ON_SITE');
});
