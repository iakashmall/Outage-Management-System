// Forwards /api/map/* to the in-house map server, which only the OMS backend talks to.
// It is mounted inside the authenticated /api router, so only logged-in OMS users and crews can reach the
// map (same protection as /api/tiles), and the map server's own API key never leaves the backend.
//
// Only these requests are forwarded (anything else: 404). Paths are relative to /api/map:
//   GET|HEAD  style.json, tiles.json, sprite[@2x].json|png                     map drawing
//   GET|HEAD  tiles/{z}/{x}/{y}.pbf  (z 0-22)
//   GET|HEAD  fonts/{fontstack}/{start}-{end}.pbf
//   GET|HEAD  info, export/{id}, export/{id}/file                              "give me this area" (status, download)
//   POST      export   operators/admins: any area within the export limits; crew devices: only the map server's
//                      service area (the crew app's fallback when no region is configured)
// The region routes (regions, my-region, regions/:id/export) are handled before this, in mapRegions.js.
//
// Env:  MAP_SERVER_URL (default http://127.0.0.1:8095)   MAP_API_KEY (optional, must match the map server's API_KEY)
import http from 'node:http';
import { exportLimitError } from '../infra/mapRegions.js';

const mapUrl = () => new URL(process.env.MAP_SERVER_URL || 'http://127.0.0.1:8095');
const CONTROL_ROOM_ROLES = ['oms_operator', 'system_admin'];
const MAX_EXPORT_BODY = 4096; // bytes; a real export request is well under 200

const EXPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FONTSTACK = /^[A-Za-z0-9 ,_-]{1,200}$/;
const FONT_RANGE = /^(\d{1,5})-(\d{1,5})\.pbf$/;
const SPRITE = /^sprite(@2x)?\.(json|png)$/;
const INT = /^\d{1,7}$/;

// One path segment, decoded exactly once. null if it is unsafe: encoded dots/slashes/backslashes, NUL, anything
// still percent-encoded after one decode (double encoding), or a decoded value containing / \ or "..".
export function safeSegment(raw) {
  if (/%(2e|2f|5c|00)/i.test(raw)) return null;
  let s;
  try { s = decodeURIComponent(raw); } catch { return null; }
  if (/[%/\\\0]/.test(s) || s.includes('..')) return null;
  return s;
}

// Maps a request to the map server path it may reach, or null (not allowed). `url` is req.url below the mount
// point, e.g. "/tiles/12/2958/1689.pbf?x=1". The query string is never forwarded.
export function allowedMapPath(method, url) {
  const raw = String(url).split('?')[0];
  if (!raw.startsWith('/') || raw.includes('..') || raw.includes('\\') || raw.includes('\0') || raw.includes('//')) return null;
  const parts = raw.slice(1).split('/').map(safeSegment);
  if (parts.some((p) => p === null || p === '')) return null;
  const read = method === 'GET' || method === 'HEAD';
  const [a, b, c, d] = parts;

  if (method === 'POST') return parts.length === 1 && a === 'export' ? '/api/map/export' : null;
  if (!read) return null;

  if (parts.length === 1) {
    if (a === 'style.json' || a === 'tiles.json' || SPRITE.test(a)) return `/${a}`;
    if (a === 'info') return '/api/map/info';
    return null;
  }
  if (a === 'tiles' && parts.length === 4) {
    const y = /^(\d{1,7})\.pbf$/.exec(d);
    if (!INT.test(b) || !INT.test(c) || !y) return null;
    const z = Number(b), x = Number(c), yy = Number(y[1]);
    if (z > 22 || x >= 2 ** z || yy >= 2 ** z) return null;
    return `/tiles/${z}/${x}/${yy}.pbf`;
  }
  if (a === 'fonts' && parts.length === 3) {
    const r = FONT_RANGE.exec(c);
    if (!FONTSTACK.test(b) || !r || Number(r[1]) > Number(r[2]) || Number(r[2]) > 65535) return null;
    return `/fonts/${encodeURIComponent(b)}/${c}`;
  }
  if (a === 'export' && EXPORT_ID.test(b ?? '')) {
    if (parts.length === 2) return `/api/map/export/${b}`;
    if (parts.length === 3 && c === 'file') return `/api/map/export/${b}/file`;
  }
  return null;
}

// Request headers the client may not set for the map server, and hop-by-hop headers that must not be forwarded.
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization'];
function cleanHeaders(incoming) {
  const named = String(incoming.connection || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.includes(key) || named.includes(key) || key.startsWith('proxy-')) continue;
    if (key.startsWith('x-forwarded-') || key === 'forwarded' || key === 'x-real-ip') continue;
    if (key === 'x-api-key' || key === 'authorization' || key === 'cookie' || key === 'host' || key === 'content-length') continue;
    out[key] = v;
  }
  return out;
}

// Four finite numbers from an array or a "a,b,c,d" string, else null.
const fourNumbers = (v) => {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (typeof p === 'string' && p.trim() === '' ? NaN : typeof p === 'number' || typeof p === 'string' ? Number(p) : NaN));
  return n.every(Number.isFinite) ? n : null;
};
const parseBbox = (v) => {
  const n = fourNumbers(v);
  if (!n) return null;
  const [x0, y0, x1, y1] = n;
  if (x0 < -180 || x1 > 180 || y0 < -85.06 || y1 > 85.06 || x0 >= x1 || y0 >= y1) return null;
  return n;
};
// Same area within 1e-6 degrees (about 10 cm) per coordinate; either side may be an array or a "a,b,c,d" string.
export const BBOX_TOLERANCE = 1e-6;
export function sameBbox(a, b) {
  const x = fourNumbers(a), y = fourNumbers(b);
  return Boolean(x && y && x.every((v, i) => Math.abs(v - y[i]) <= BBOX_TOLERANCE));
}

// The map server's /api/map/info answer, kept ~60 s so crew exports don't each ask for it. Only a good answer is
// kept, per map server address and key; any failure talking to the map server drops it.
const INFO_TTL_MS = 60000;
let infoCache = null; // { key, at, info }
const infoKey = () => `${mapUrl().href}|${process.env.MAP_API_KEY || ''}`;
export const clearMapInfoCache = () => { infoCache = null; };
async function mapInfo() {
  const key = infoKey();
  if (infoCache && infoCache.key === key && Date.now() - infoCache.at < INFO_TTL_MS) return { info: infoCache.info };
  infoCache = null;
  let r;
  try {
    r = await fetch(new URL('/api/map/info', mapUrl()), {
      headers: process.env.MAP_API_KEY ? { 'x-api-key': process.env.MAP_API_KEY } : {},
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { status: 502, error: 'map server unavailable' };
  }
  if (r.status === 401) return { status: 502, error: "The map server refused the OMS's key. An administrator should check MAP_API_KEY in backend/.env." };
  const info = r.ok ? await r.json().catch(() => null) : null;
  if (!info || typeof info !== 'object') return { status: 502, error: 'map server unavailable' };
  infoCache = { key, at: Date.now(), info };
  return { info };
}

// x-forwarded-host/proto/prefix for the map server. With OMS_PUBLIC_URL set (e.g. https://oms.example.org) they come
// from it; otherwise from this connection's Host header and protocol (fine when nothing in front rewrites Host).
function forwardedFor(req) {
  const pub = process.env.OMS_PUBLIC_URL;
  if (pub) {
    try {
      const u = new URL(pub);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return { host: u.host, proto: u.protocol.slice(0, -1), prefix: u.pathname.replace(/\/+$/, '') + req.baseUrl };
      }
    } catch { /* ignored: fall back to the connection */ }
    if (!forwardedFor.warned) { forwardedFor.warned = true; console.error('[map] OMS_PUBLIC_URL is not an http(s) URL; using the request Host instead'); }
  }
  return { host: String(req.headers.host || ''), proto: req.protocol || 'http', prefix: req.baseUrl };
}

// Checks a raw POST /export and returns { status, error } or { body } (the only fields sent on to the map server).
async function checkExport(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_EXPORT_BODY || Buffer.byteLength(JSON.stringify(req.body ?? {})) > MAX_EXPORT_BODY) {
    return { status: 413, error: 'Request body too large.' };
  }
  const roles = req.user?.roles || [];
  const controlRoom = CONTROL_ROOM_ROLES.some((r) => roles.includes(r));
  const crew = !controlRoom && (Boolean(req.user?.crewId) || roles.includes('field_crew'));
  if (!controlRoom && !crew) return { status: 403, error: 'Only the control room can export a map area.' };

  const b = req.body || {};
  const bbox = parseBbox(b.bbox);
  if (!bbox) return { status: 400, error: 'bbox must be "minLon,minLat,maxLon,maxLat": four numbers inside the world, min < max.' };
  const minZoom = b.minZoom ?? 8, maxZoom = b.maxZoom ?? 14;
  if (![minZoom, maxZoom].every(Number.isInteger) || minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) {
    return { status: 400, error: 'minZoom and maxZoom must be whole numbers with 0 <= minZoom <= maxZoom <= 22.' };
  }
  if (b.label !== undefined && (typeof b.label !== 'string' || !/^[A-Za-z0-9 ._-]{1,64}$/.test(b.label))) {
    return { status: 400, error: 'label must be up to 64 letters, digits, spaces, dots, dashes or underscores.' };
  }

  if (crew) { // a crew device may only take the service area the map server itself offers phones
    const { info, status, error } = await mapInfo();
    if (error) return { status, error };
    if (!sameBbox(bbox, info.serviceArea)) return { status: 403, error: 'Crew devices may only download their region or the service area.' };
  }
  const tooBig = exportLimitError(bbox, minZoom, maxZoom);
  if (tooBig) return { status: 400, error: tooBig };

  const body = { bbox: bbox.join(','), minZoom, maxZoom };
  if (b.label !== undefined) body.label = b.label;
  return { body };
}

export function mapProxy(req, res) {
  forward(req, res).catch(() => { if (!res.headersSent) res.status(500).json({ error: 'map request failed' }); });
}

async function forward(req, res) {
  const path = allowedMapPath(req.method, req.url);
  if (!path) return res.status(404).json({ error: 'not found' });

  let body = null;
  if (req.method === 'POST') {
    const checked = await checkExport(req);
    if (checked.error) return res.status(checked.status).json({ error: checked.error });
    body = JSON.stringify(checked.body);
  }

  const target = mapUrl();
  // Tell the map server which address the client used (so links in its answers are right wherever the OMS is
  // deployed): OMS_PUBLIC_URL if set, else this connection; never client-supplied x-forwarded-* headers.
  const fwd = forwardedFor(req);
  const headers = {
    ...cleanHeaders(req.headers),
    host: target.host,
    'x-forwarded-host': fwd.host,
    'x-forwarded-proto': fwd.proto,
    'x-forwarded-prefix': fwd.prefix,
  };
  if (process.env.MAP_API_KEY) headers['x-api-key'] = process.env.MAP_API_KEY;
  if (body !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }

  const upstream = http.request(
    { hostname: target.hostname, port: target.port || 80, path, method: req.method, headers },
    (r) => {
      if (r.statusCode === 401 || r.statusCode >= 500) clearMapInfoCache();
      if (r.statusCode === 401) { // the map server refused the OMS's OWN key: a setup problem, not the user's login
        r.resume();
        return res.status(502).json({ error: "The map server refused the OMS's key. An administrator should check MAP_API_KEY in backend/.env." });
      }
      const out = { ...r.headers };
      delete out['access-control-allow-origin'];   // CORS is the backend's job
      for (const h of HOP_BY_HOP) delete out[h];
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    },
  );
  upstream.setTimeout(30000, () => upstream.destroy(new Error('map server timeout')));
  upstream.on('error', () => {
    clearMapInfoCache(); // the map server may be down or restarted: ask it again next time
    if (!res.headersSent) res.status(502).json({ error: 'map server unavailable' });
    else res.end();
  });
  upstream.end(body);
}
