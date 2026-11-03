// Intake hardening (runbook WP3): what an external caller may send to the
// intake routes (complaints, SCADA events, trouble calls) before any of it
// reaches the database.
//   - a 64 KB JSON body limit on the intake paths (photo routes keep the large
//     limit set in index.js), answered with a JSON 413 by errors.js
//   - field validation with a clear 400 message naming the field
//   - the simulator routes answer 404 unless ENABLE_SIMULATORS=true
//   - a generous per-client rate limit (429 with Retry-After)
import express from 'express';

export const INTAKE_BODY_LIMIT = '64kb';
// app.use() prefixes: /api/complaints also covers /complaints/simulate, /api/scada covers /scada/fault and /scada/simulate.
export const INTAKE_PATHS = ['/api/complaints', '/api/scada', '/api/calls'];

// Mount BEFORE the app-wide express.json(). The first parser that reads a body
// marks it parsed, so the large app-wide limit never sees these paths.
export function mountIntakeParsers(app) {
  app.use(INTAKE_PATHS, express.json({ limit: INTAKE_BODY_LIMIT }));
}

// ---------- validation (pure: returns an error message, or null) ----------
export const COMPLAINT_CATEGORIES = ['No Supply', 'Partial Supply', 'Voltage', 'Wire Down', 'Meter', 'Other'];
export const SCADA_EVENTS = ['trip', 'reclose'];
const PHONE = /^[0-9+\-\s()]{5,20}$/;

const isObject = (b) => b !== null && typeof b === 'object' && !Array.isArray(b);
const present = (v) => v !== undefined && v !== null;

function optString(b, field, max) {
  const v = b[field];
  if (!present(v)) return null;
  if (typeof v !== 'string') return `${field} must be a string`;
  if (v.length > max) return `${field} must be at most ${max} characters`;
  return null;
}

// lat and lon come together, as numbers inside the valid range.
function optCoords(b) {
  const hasLat = present(b.lat), hasLon = present(b.lon);
  if (!hasLat && !hasLon) return null;
  if (hasLat !== hasLon) return 'lat and lon must be sent together';
  if (typeof b.lat !== 'number' || !Number.isFinite(b.lat) || b.lat < -90 || b.lat > 90) return 'lat must be a number between -90 and 90';
  if (typeof b.lon !== 'number' || !Number.isFinite(b.lon) || b.lon < -180 || b.lon > 180) return 'lon must be a number between -180 and 180';
  return null;
}

function optPhone(b) {
  const e = optString(b, 'phone', 20);
  if (e) return e;
  if (present(b.phone) && !PHONE.test(b.phone)) return 'phone must be 5-20 digits (spaces, +, - and brackets allowed)';
  return null;
}

// POST /complaints: the external complaint service and the call centre.
export function validateComplaint(b) {
  if (!isObject(b)) return 'body must be a JSON object';
  if (present(b.category) && !COMPLAINT_CATEGORIES.includes(b.category)) return `category must be one of ${COMPLAINT_CATEGORIES.join(', ')}`;
  return optString(b, 'externalId', 100) || optString(b, 'customer', 200) || optString(b, 'address', 500)
    || optPhone(b) || optCoords(b)
    || (!present(b.lat) && !(typeof b.address === 'string' && b.address.trim()) ? 'lat/lon or address is required' : null);
}

// POST /scada/fault and /scada/simulate (state changes and alarms only, runbook D3).
export function validateScadaEvent(b) {
  if (!isObject(b)) return 'body must be a JSON object';
  if (typeof b.tag !== 'string' || !b.tag.trim()) return 'tag is required';
  if (b.tag.length > 128) return 'tag must be at most 128 characters';
  if (present(b.event) && !SCADA_EVENTS.includes(b.event)) return "event must be 'trip' or 'reclose'";
  if (present(b.customers) && !(Number.isInteger(b.customers) && b.customers >= 0 && b.customers <= 1_000_000)) return 'customers must be a whole number from 0 to 1000000';
  return optString(b, 'condition', 32) || optString(b, 'limit_val', 32) || optString(b, 'feeder', 128)
    || optString(b, 'substation', 200) || optString(b, 'cim_mrid', 128) || optCoords(b);
}

// POST /calls keeps its own required-field checks in api.js; this caps the sizes and types.
export function validateCall(b) {
  if (!isObject(b)) return 'body must be a JSON object';
  return optString(b, 'customer', 200) || optString(b, 'address', 500) || optString(b, 'category', 64)
    || optString(b, 'area', 200) || optPhone(b);
}

export const validate = (fn) => (req, res, next) => {
  const error = fn(req.body);
  if (error) return res.status(400).json({ error });
  next();
};

// ---------- simulators ----------
export const simulatorsEnabled = () => process.env.ENABLE_SIMULATORS === 'true';

// Off by default: the route answers as if it did not exist.
export function requireSimulators(req, res, next) {
  if (!simulatorsEnabled()) return res.status(404).json({ error: 'not found' });
  next();
}

// ---------- rate limit ----------
// Fixed one-minute window per client (the token's username, else the remote
// address), per route group, in this process's memory. Generous on purpose:
// it stops a runaway client, not a storm. 0 turns a limit off.
//   INTAKE_RATE_LIMIT_PER_MIN  complaints and calls, default 6000 (100 a second)
//   SCADA_RATE_LIMIT_PER_MIN   SCADA events,         default 120000 (2000 a second)
export function rateLimit(group, { envVar, defaultPerMin, windowMs = 60_000 }) {
  const hits = new Map(); // key -> { start, count }
  let sweptAt = Date.now();
  return (req, res, next) => {
    const raw = process.env[envVar];
    const max = raw === undefined || raw === '' ? defaultPerMin : Number(raw);
    if (!Number.isFinite(max) || max <= 0) return next();
    const now = Date.now();
    if (now - sweptAt > windowMs) { // drop finished windows so the map stays small
      for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      sweptAt = now;
    }
    const key = `${group}:${req.user?.username || req.ip}`;
    let h = hits.get(key);
    if (!h || now - h.start >= windowMs) { h = { start: now, count: 0 }; hits.set(key, h); }
    h.count += 1;
    if (h.count > max) {
      const retry = Math.max(1, Math.ceil((h.start + windowMs - now) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `rate limit exceeded (${max} requests a minute); retry in ${retry} s` });
    }
    next();
  };
}

export const intakeRateLimit = rateLimit('intake', { envVar: 'INTAKE_RATE_LIMIT_PER_MIN', defaultPerMin: 6000 });
export const scadaRateLimit = rateLimit('scada', { envVar: 'SCADA_RATE_LIMIT_PER_MIN', defaultPerMin: 120000 });
