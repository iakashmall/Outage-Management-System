import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet'; // adds L.maplibreGL (vector basemap inside the existing Leaflet map)
import { api, socket } from '../lib/api.js';
import { authHeader } from '../lib/auth.js';

import { TRAIL_WINDOWS, DEFAULT_WINDOW, MAX_POINTS, windowMs, normalizeTrack, splitTrail, summarize, thinDots, fmtClock, fmtDur, fmtAgo } from '../lib/trail.js';
import { Icon, SevBadge, StatusBadge, useLiveRefresh } from '../lib/ui.jsx';
import { useT, t as tt, tOr } from '../lib/i18n.js';

// VITE_BASEMAP_FALLBACK=osm: if the in-house basemap cannot load, show OpenStreetMap instead (loaded from the public
// internet). Default: no fallback, just a notice; the OMS layers are drawn either way.
const OSM_FALLBACK = String(import.meta.env.VITE_BASEMAP_FALLBACK || '').toLowerCase() === 'osm';

const SEVC = { critical: '#e23b2e', high: '#ef9021', medium: '#3b82f6', low: '#22b06b' };
// Severity and crew status are also shown by a letter / mark, not by colour alone (WCAG 1.4.1).
const SEVL = { critical: 'C', high: 'H', medium: 'M', low: 'L' };
const crewCls = (status) => `mk-crew s-${status || 'unknown'}`;
const CREWC = { available: '#0fb39d', in_service: '#3b82f6', in_transit: '#ef9021', on_break: '#9fb0c4', off_shift: '#9fb0c4' };
const PALETTE = ['#3b82f6', '#0fb39d', '#e0742b', '#8b5cf6', '#22b06b', '#e0447a', '#d1a017', '#2fa3a3', '#7a9e2e', '#c2622a', '#5b6ee0', '#c94f9a'];
const feederColor = (name) => { if (!name) return '#9fb0c4'; let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff; return PALETTE[h % PALETTE.length]; };
const hav = (a, b) => { const R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
// compass bearing a→b in degrees (0 = north), for pointing the crew arrow
const bearing = (a, b) => { const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r); return (Math.atan2(y, x) / r + 360) % 360; };
const clean = (n) => (n || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim();

const LAYER_GROUPS = [
  ['Network', [['htLines', 'HT network', true], ['feeders', 'Feeder lines', true], ['substations', 'Substations', true],
    ['powerTx', 'Power transformers', false], ['distTx', 'Distribution txr', false],
    ['switches', 'Switches', false], ['rmus', 'RMUs', false], ['fuses', 'Drop-out fuses', false]]],
  ['Operations', [['incidents', 'Incidents', true], ['crews', 'Crews', true], ['trails', 'Crew trails', false], ['scans', 'Asset scans (crew QR, 7 days)', true]]],
];
// CIM topology (network.* PostGIS schema) -- connectivity data imported from a
// CIM export or inferred from GIS. Separate from the Haridwar layers above,
// which still come from network.json. The heading shown names the imported
// substations (topoTitle below); this key only identifies the group.
LAYER_GROUPS.splice(1, 0, ['Topology · CIM', [
  // one control for lines and devices (groups topoLines + topoEquip): they are
  // one layer, never useful apart
  ['topo', 'Lines & devices', true],
  ['topoStruct', 'Poles & junctions', true],
]]);
const ALL = LAYER_GROUPS.flatMap(([, ls]) => ls);
const TOPO_STYLE = {
  PowerTransformer: { color: '#2563eb', r: 6.5 }, Fuse: { color: '#ea8a12', r: 5 },
  Breaker: { color: '#7c3aed', r: 6.5 }, ProtectedSwitch: { color: '#7c3aed', r: 6.5 }, CurrentTransformer: { color: '#0d9488', r: 5 },
  Structure: { color: '#6b7a90', r: 3 }, Junction: { color: '#6b7a90', r: 4.5 }, Meter: { color: '#6b7a90', r: 4.5 },
};
const topoGroupOf = (cls) => (cls === 'ACLineSegment' ? 'topoLines' : ['Structure', 'Junction', 'Meter'].includes(cls) ? 'topoStruct' : 'topoEquip');
const SECTION_COLOR = '#ff6a00';
const SIM_COLOR = '#7c3aed';  // what-if: devices that lose supply (a simulation, never live state)
const TRACE_MAX_ZOOM = 17;     // fly-to-fit cap for any trace
const SMALL_SECTION = 10;      // below this, say the section is likely limited by missing connectivity data
// One stable colour per crew for its trail (a crew keeps its colour as its status changes).
const TRAIL_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#ca8a04', '#16a34a', '#db2777', '#2563eb', '#ea580c'];
const trailColor = (id) => { let h = 0; for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0; return TRAIL_COLORS[h % TRAIL_COLORS.length]; };

// A crew QR asset scan: a small purple diamond.
const SCAN_ICON = () => L.divIcon({ className: '', html: '<div style="width:11px;height:11px;background:#6b3fa0;border:2px solid #fff;transform:rotate(45deg);box-shadow:0 1px 4px rgba(15,27,45,.45)"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });

// mapFocus: { kind: 'scan', id, lat, lon, at } from another screen (Incidents' asset scans).
export default function NetworkMap({ mapFocus, clearMapFocus } = {}) {
  const { t, lang } = useT();
  const [net, setNet] = useState(null);
  const [inc, setInc] = useState([]);
  const [crews, setCrews] = useState([]);
  const [sel, setSel] = useState(null);
  const [selFeeder, setSelFeeder] = useState(null);
  const [layers, setLayers] = useState(Object.fromEntries(ALL.map(([k, , on]) => [k, on])));
  // Raw GIS lines inside an imported-topology area are hidden by default (the
  // topology draws them, cleaned). Once the user toggles "HT network" /
  // "Feeder lines" themselves, that choice covers those segments too.
  const [rawTouched, setRawTouched] = useState({ htLines: false, feeders: false });
  const [rawUnderTopo, setRawUnderTopo] = useState({ htLines: 0, feeders: 0 });
  const [rawNoteDismissed, setRawNoteDismissed] = useState(false);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [openResults, setOpenResults] = useState(false);
  const [topo, setTopo] = useState(null);       // GeoJSON from /api/network/topology (null = loading)
  const [trace, setTrace] = useState(null);     // result of /api/network/section/:mrid
  const [regions, setRegions] = useState([]);   // regions from /api/map/regions (substations, zones, divisions)
  const [regionId, setRegionId] = useState('');
  const [basemapDown, setBasemapDown] = useState(false); // in-house basemap could not load; OMS layers still shown
  const [traceBusy, setTraceBusy] = useState(false);
  const [trailWin, setTrailWin] = useState(DEFAULT_WINDOW); // how far back trails reach
  const [trailCrew, setTrailCrew] = useState(null);         // null = every crew, else one crew id
  const [trails, setTrails] = useState({});                 // crew id -> normalised GPS fixes
  const [trailBusy, setTrailBusy] = useState(false);
  const [trailFailed, setTrailFailed] = useState(false);
  const [scans, setScans] = useState([]);                   // crew QR asset scans (last 7 days)

  const boxRef = useRef();
  const mapRef = useRef(null);
  const groups = useRef({});
  const crewMarkers = useRef(new Map()); // crew id -> { m, crew, at, heading, raf }
  const feederIdx = useRef({});
  const rawSegs = useRef({ htLines: [], feeders: [] }); // raw GIS segments, see the build effect
  const hiRef = useRef(null);
  const topoIdx = useRef({});       // mrid -> { layer, isLine, base, latlng }
  const traceLayer = useRef(null);  // origin / boundary markers for the active trace
  const selRef = useRef(null); selRef.current = sel;
  const trailsOnRef = useRef(false), trailCrewRef = useRef(null), trailWinRef = useRef(DEFAULT_WINDOW);
  const trailTimers = useRef({}), trailFit = useRef(null);

  useEffect(() => { api.network().then(setNet).catch(() => setNet({ error: true })); }, []);
  useEffect(() => { api.networkTopology().then(setTopo).catch(() => setTopo({ error: true })); }, []);
  useEffect(() => { api.mapRegions().then((r) => setRegions(r.regions || [])).catch(() => {}); }, []);
  const loadLive = () => { api.incidents().then(setInc); api.crews().then(setCrews); };
  useEffect(() => { loadLive(); }, []);
  useLiveRefresh(['oms.incident.updated', 'oms.incident.created'], () => api.incidents().then(setInc));
  const loadScans = () => api.recentAssetScans(7).then(setScans).catch(() => {});
  useEffect(() => { loadScans(); }, []);
  useLiveRefresh(['crew.job.updated'], loadScans); // a new scan publishes its job
  // A crew.updated event carries the full crew row; merge it in place rather
  // than refetching everything, so position fixes reach the map immediately.
  useEffect(() => {
    const h = (c) => {
      if (!c || !c.id) return;
      setCrews((list) => (list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? { ...x, ...c } : x)) : [...list, c]));
      setSel((s) => (s && s.kind === 'crew' && s.id === c.id ? { ...s, ...c } : s));
    };
    socket.on('crew.updated', h);
    return () => socket.off('crew.updated', h);
  }, []);
  useEffect(() => { if (sel && sel.kind === 'incident') setSel((s) => ({ ...s, ...(inc.find((i) => i.id === s.id) || {}) })); }, [inc]); // eslint-disable-line

  const topoOk = !!(topo && !topo.error && topo.features && topo.features.length);
  // Substations with imported topology, from the API -- nothing here names a place.
  const topoAreas = topoOk ? topo.meta?.areas || [] : [];
  const topoTitle = topoAreas.length === 1 ? t('map.topoOne', { name: clean(topoAreas[0].name) || topoAreas[0].code })
    : topoAreas.length > 1 ? t('map.topoMany', { n: topoAreas.length }) : t('map.topoNone');
  const topoCounts = useMemo(() => {
    const m = { topoLines: 0, topoStruct: 0, topoEquip: 0 };
    if (topoOk) topo.features.forEach((f) => { m[topoGroupOf(f.properties.cls)]++; });
    return m;
  }, [topo, topoOk]);

  const feeders = useMemo(() => {
    if (!net || !net.feederLines) return {};
    const m = {};
    net.feederLines.forEach((l) => {
      const k = l.feeder || '—';
      if (!m[k]) m[k] = { name: k, kv: l.kv, ss: l.ss, segs: 0, km: 0, color: feederColor(k), minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
      m[k].segs++;
      for (let i = 0; i < l.path.length; i++) {
        const [la, lo] = l.path[i];
        m[k].minLat = Math.min(m[k].minLat, la); m[k].maxLat = Math.max(m[k].maxLat, la);
        m[k].minLon = Math.min(m[k].minLon, lo); m[k].maxLon = Math.max(m[k].maxLon, lo);
        if (i < l.path.length - 1) m[k].km += hav(l.path[i], l.path[i + 1]);
      }
    });
    return m;
  }, [net]);

  // searchable index over every dataset — assets, circuits, plus live incidents & crews
  const searchIndex = useMemo(() => {
    if (!net) return [];
    const out = [];
    const push = (type, kind, label, ref, sub) => label && out.push({ type, kind, label: String(label), sub, lat: ref.lat, lon: ref.lon, ref });
    net.substations.forEach((s) => push('Substation', 'ss', clean(s.name) || s.name, s, s.name));
    net.powerTx.forEach((a) => push('Power Txr', 'ptx', a.name || 'Power transformer', a));
    net.distTx.forEach((a) => push('DTR', 'dt', a.name || a.id, a, a.feeder));
    net.switches.forEach((a) => push('Switch', 'switch', a.name || a.id, a));
    net.rmus.forEach((a) => push('RMU', 'rmu', a.id || a.name, a));
    net.fuses.forEach((a) => push('Fuse', 'fuse', a.id || a.name, a));
    if (topoOk) topo.features.forEach((f) => {
      const p = f.properties; if (!p.name || p.name === p.mrid) return; // numeric-only names are not useful to search
      const [lo, la] = f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0];
      push('CIM', 'topo', p.name, { ...p, lat: la, lon: lo }, p.cls);
    });
    Object.values(feeders).forEach((f) => out.push({ type: 'Feeder', kind: 'feeder', label: f.name, sub: (f.kv || 11) + ' kV', ref: f }));
    return out;
  }, [net, feeders, topo]); // eslint-disable-line

  const liveIndex = useMemo(() => {
    const out = [];
    inc.forEach((i) => i.lat && i.lon && out.push({ type: 'Incident', kind: 'incident', label: i.id, sub: i.zone, lat: i.lat, lon: i.lon, ref: i }));
    crews.forEach((c) => c.lat && c.lon && out.push({ type: 'Crew', kind: 'crew', label: c.name, sub: tOr(`map.cs.${c.status}`, (c.status || '').replace('_', ' ')), lat: c.lat, lon: c.lon, ref: c }));
    return out;
  }, [inc, crews, lang]);

  const RANK = { Substation: 0, Feeder: 1, Incident: 2, Crew: 3, CIM: 3.5, 'Power Txr': 4, DTR: 5, Switch: 6, RMU: 7, Fuse: 8 };
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const it of [...liveIndex, ...searchIndex]) {
      const l = it.label.toLowerCase();
      const i = l.indexOf(q);
      if (i !== -1) hits.push({ ...it, starts: i === 0 });
    }
    hits.sort((a, b) => (b.starts - a.starts) || ((RANK[a.type] ?? 9) - (RANK[b.type] ?? 9)) || a.label.localeCompare(b.label));
    return hits.slice(0, 30);
  }, [query, searchIndex, liveIndex]); // eslint-disable-line
  const [activeIdx, setActiveIdx] = useState(0);
  // Move focus to the details panel when a feature is chosen (search, or Enter on a marker),
  // so keyboard and screen-reader users land on what they opened.
  const detailRef = useRef(null);
  const selKey = sel ? `${sel.kind}:${sel.id || sel.mrid || sel.label || ''}` : '';
  useEffect(() => { if (selKey) detailRef.current?.focus({ preventScroll: true }); }, [selKey]);

  // create the Leaflet map once
  useEffect(() => {
    if (!net || net.error || mapRef.current || !boxRef.current) return;
    const b = net.bounds;
    const bounds = L.latLngBounds([b.minLat, b.minLon], [b.maxLat, b.maxLon]);
    const map = L.map(boxRef.current, { preferCanvas: true, zoomControl: false, attributionControl: true, maxZoom: 19, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 });
    map.fitBounds(bounds.pad(0.05));
    // role=application makes NVDA/JAWS switch to focus mode on the map, so the arrow / + / - keys reach
    // Leaflet's keyboard panning and zoom instead of being used for reading (WCAG 2.1.1).
    const box = map.getContainer();
    box.setAttribute('role', 'application');
    box.setAttribute('aria-roledescription', tt('map.ariaRole'));
    box.setAttribute('aria-label', tt('map.ariaMap'));
    // Basemap: vector map from the in-house map server, reached through the OMS backend (/api/map), so the
    // normal login protects it and nothing is loaded from the public internet. transformRequest attaches the
    // Bearer token to every map request (style, tiles, fonts). Leaflet layers (feeders, crews...) draw on top.
    // A basemap failure (map server down, style 4xx/5xx, WebGL missing) must never take the OMS layers down with it:
    // the map shows a notice instead, and only with VITE_BASEMAP_FALLBACK=osm loads OpenStreetMap from the internet.
    let alive = true, gl = null, glLoaded = false, failed = false;
    const basemapFailed = (why) => {
      if (!alive || failed) return;
      failed = true;
      console.error('[map] basemap unavailable; showing OMS layers without it:', why);
      if (gl) { try { map.removeLayer(gl); } catch { /* already gone */ } }
      if (OSM_FALLBACK) L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap', opacity: 0.92 }).addTo(map);
      setBasemapDown(true);
    };
    try {
      gl = L.maplibreGL({
        style: '/api/map/style.json',
        attributionControl: { customAttribution: 'Spintech' },
        transformRequest: (url) => (new URL(url, location.href).pathname.startsWith('/api/map/') ? { url, headers: authHeader() } : undefined),
      }).addTo(map);
      const glMap = gl.getMaplibreMap();
      let tileErrors = 0; // consecutive tile failures since the last tile that loaded
      glMap.on('load', () => { glLoaded = true; });
      glMap.on('data', (e) => { if (e?.tile) tileErrors = 0; });
      // Before the first load, an error that is not about one tile means the style or its sources failed.
      // After it, 10 tile failures in a row (map server gone mid-session) count as the basemap failing too.
      glMap.on('error', (e) => {
        if (!e?.tile) { if (!glLoaded) basemapFailed(e?.error || e); }
        else if (glLoaded && ++tileErrors >= 10) basemapFailed(e?.error || e);
      });
    } catch (e) { basemapFailed(e); }
    map.attributionControl.setPrefix(false); // drop the "Leaflet" prefix; the corner shows only our own credit
    L.control.zoom({ position: 'topright', zoomInTitle: t('map.zoomIn'), zoomOutTitle: t('map.zoomOut') }).addTo(map);
    mapRef.current = map;
    map.__bounds = bounds;
    setReady(true);
    return () => { alive = false; map.remove(); mapRef.current = null; };
  }, [net]);

  // build static network layers once the map exists
  useEffect(() => {
    if (!ready || !mapRef.current || !net || groups.current.built) return;
    const map = mapRef.current;
    const mk = () => L.layerGroup();
    ['htLines', 'feeders', 'substations', 'powerTx', 'distTx', 'switches', 'rmus', 'fuses', 'htLinesTopo', 'feedersTopo'].forEach((k) => (groups.current[k] = mk()));

    // Raw segments are remembered so the effect below can move the ones that
    // imported topology already draws into htLinesTopo / feedersTopo.
    rawSegs.current = { htLines: [], feeders: [] };
    net.htLines.forEach((l, index) => {
      const pl = L.polyline(l.path, { color: '#3f5a86', weight: 2, opacity: 0.9, interactive: false }).addTo(groups.current.htLines);
      rawSegs.current.htLines.push({ index, layers: [pl] });
    });

    feederIdx.current = {};
    net.feederLines.forEach((l, index) => {
      const col = feederColor(l.feeder);
      // wide, invisible "hit" line so the feeder is easy to hover/click...
      const hit = L.polyline(l.path, { color: col, weight: 14, opacity: 0, interactive: true });
      hit.on('click', () => pickFeeder(l.feeder));
      hit.bindTooltip(`${l.feeder || tt('map.feeder')} · ${l.kv || 11} kV`, { sticky: true });
      hit.addTo(groups.current.feeders);
      // ...and the thin, visible line drawn on top
      const pl = L.polyline(l.path, { color: col, weight: 3, opacity: 0.92, interactive: false });
      pl.addTo(groups.current.feeders);
      (feederIdx.current[l.feeder] = feederIdx.current[l.feeder] || []).push(pl);
      rawSegs.current.feeders.push({ index, layers: [hit, pl] });
    });

    net.fuses.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 2.5, color: '#b98a5e', weight: 0, fillOpacity: 0.85 }).addTo(groups.current.fuses));
    net.rmus.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 3, color: '#7a9e2e', weight: 0, fillOpacity: 0.9 }).on('click', () => select('rmu', a, 'RMU')).addTo(groups.current.rmus));
    net.switches.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 2.8, color: '#8b5cf6', weight: 0, fillOpacity: 0.85 }).on('click', () => select('switch', a, a.name || 'Switch')).addTo(groups.current.switches));
    net.distTx.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 3, color: '#3b82f6', weight: 0, fillOpacity: 0.85 }).bindTooltip(a.name || 'DTR').on('click', () => select('dt', a, a.name || 'DTR')).addTo(groups.current.distTx));
    net.powerTx.forEach((a) => L.marker([a.lat, a.lon], { icon: L.divIcon({ className: '', html: '<div class="mk-ptx"></div>', iconSize: [12, 12] }), title: tt('map.ttPowerTx', { name: a.name || '' }).trim() }).on('click', () => select('ptx', a, a.name || 'Power Txr')).addTo(groups.current.powerTx));
    net.substations.forEach((s) => L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-ss"><span class="mk-ss-d"></span><span class="mk-ss-l">${clean(s.name)}</span></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: 500, title: tt('map.ttSubstation', { name: clean(s.name) }) }).on('click', () => select('ss', s, s.name)).addTo(groups.current.substations));

    groups.current.incidents = mk();
    groups.current.crews = mk();
    groups.current.trails = mk();
    groups.current.scans = mk();
    crewMarkers.current.clear();
    groups.current.built = true;
    // add the default-on layers
    ALL.forEach(([k, , on]) => { if (on && groups.current[k]) groups.current[k].addTo(map); });
  }, [ready, net]); // eslint-disable-line

  // build the CIM topology layers once both the map and the GeoJSON exist
  useEffect(() => {
    if (!ready || !mapRef.current || !topoOk || groups.current.topoBuilt) return;
    const map = mapRef.current;
    ['topoLines', 'topoStruct', 'topoEquip'].forEach((k) => (groups.current[k] = L.layerGroup()));
    topoIdx.current = {};
    const bounds = L.latLngBounds([]);
    topo.features.forEach((f) => {
      const p = f.properties, grp = groups.current[topoGroupOf(p.cls)];
      if (f.geometry.type === 'LineString') {
        const latlngs = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
        latlngs.forEach((ll) => bounds.extend(ll));
        // coloured by the assigned feeder (cleaned, from network.feeders) with the
        // same hash as the raw feeder layer; teal when the line has no feeder
        const base = { color: p.feederId ? feederColor(p.feederId) : '#0e7490', weight: 3, opacity: 0.9 };
        // wide invisible line so a thin cable is easy to click, thin visible line on top
        const hit = L.polyline(latlngs, { color: '#0e7490', weight: 14, opacity: 0, interactive: true });
        hit.on('click', () => selectTopo(p, latlngs[0]));
        hit.bindTooltip(`${p.cls} · ${p.name || p.mrid}`, { sticky: true });
        hit.addTo(grp);
        const pl = L.polyline(latlngs, { ...base, interactive: false }).addTo(grp);
        topoIdx.current[p.mrid] = { layer: pl, isLine: true, base, latlng: latlngs[0] };
      } else {
        const [lo, la] = f.geometry.coordinates;
        bounds.extend([la, lo]);
        const st = TOPO_STYLE[p.cls] || { color: '#6b7a90', r: 3.5 };
        const base = { radius: st.r, color: '#ffffff', weight: 1.4, fillColor: st.color, fillOpacity: 0.95, opacity: 1 };
        const m = L.circleMarker([la, lo], base);
        m.bindTooltip(`${p.cls} · ${p.name || p.mrid}`);
        m.on('click', () => selectTopo(p, [la, lo]));
        m.addTo(grp);
        topoIdx.current[p.mrid] = { layer: m, isLine: false, base, latlng: [la, lo] };
      }
    });
    map.__topoBounds = bounds.isValid() ? bounds : null;
    groups.current.topoBuilt = true;
    // devices drawn above lines: topoEquip is added after topoLines
    groups.current.topo = L.layerGroup([groups.current.topoLines, groups.current.topoEquip]);
    ['topo', 'topoStruct'].forEach((k) => { if (layers[k]) groups.current[k].addTo(map); });
  }, [ready, topo]); // eslint-disable-line

  // Trace highlight, one effect for the three trace kinds (trace.kind):
  //   section  -- the electrical section, origin and boundary switches
  //   upstream -- the path to the nearest substation, switches on it marked
  //   whatif   -- the devices that lose supply (in SIM_COLOR), the opened device
  // Everything else is dimmed.
  const traceView = useMemo(() => {
    if (!trace || trace.found === false || trace.error) return null;
    if (trace.kind === 'upstream') {
      if (!trace.pathFound) return null;
      const eq = trace.path.filter((p) => p.type === 'equipment').map((p) => p.cim_mrid);
      return { hit: new Set(eq), color: SECTION_COLOR, origin: trace.origin.cim_mrid, originTip: tt('map.ttTraced'),
        marks: trace.switchesOnPath.map((s) => [s.cim_mrid, tt('map.ttSwitchOnPath', { cls: s.cim_class, name: s.name || s.cim_mrid })]) };
    }
    if (trace.kind === 'whatif') {
      const opened = trace.assumedOpen[0]?.cim_mrid;
      return { hit: new Set(trace.lostSupply.map((e) => e.cim_mrid)), color: SIM_COLOR, origin: opened, originTip: tt('map.ttSimOpen'), marks: [] };
    }
    return { hit: new Set(trace.sectionEquipment.map((e) => e.cim_mrid)), color: SECTION_COLOR, origin: trace.origin.cim_mrid, originTip: tt('map.ttOrigin'),
      marks: trace.boundarySwitches.map((b) => [b.cim_mrid, tt('map.ttBoundary', { cls: b.cim_class, name: b.name || b.cim_mrid })]) };
  }, [trace, lang]); // lang: the tooltips are translated
  useEffect(() => {
    const map = mapRef.current; if (!map || !groups.current.topoBuilt) return;
    if (traceLayer.current) { map.removeLayer(traceLayer.current); traceLayer.current = null; }
    const idx = topoIdx.current;
    const v = traceView;
    const marked = new Set(v ? v.marks.map(([m]) => m) : []);
    Object.entries(idx).forEach(([mrid, t]) => {
      if (!v) { t.layer.setStyle(t.base); return; }
      const hit = v.hit.has(mrid) || marked.has(mrid) || mrid === v.origin;
      if (t.isLine) t.layer.setStyle(hit ? { color: v.color, weight: 6, opacity: 1 } : { ...t.base, opacity: 0.2 });
      else t.layer.setStyle(hit ? { ...t.base, fillColor: v.color, radius: t.base.radius + 2, fillOpacity: 1 } : { ...t.base, fillOpacity: 0.2, opacity: 0.3 });
      if (hit && t.layer.bringToFront) t.layer.bringToFront();
    });
    if (!v) return;
    const g = L.layerGroup();
    const mkIcon = (cls, size) => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    const o = idx[v.origin];
    if (o) L.marker(o.latlng, { icon: mkIcon('mk-origin', 22), zIndexOffset: 3000 }).bindTooltip(v.originTip).addTo(g);
    v.marks.forEach(([m, tip]) => { const t = idx[m]; if (t) L.marker(t.latlng, { icon: mkIcon('mk-bound', 20), zIndexOffset: 2500 }).bindTooltip(tip).addTo(g); });
    g.addTo(map); traceLayer.current = g;
    const pts = [...v.hit, ...marked, v.origin].map((m) => idx[m]).filter(Boolean).flatMap((t) => (t.isLine ? t.layer.getLatLngs() : [t.latlng]));
    // capped: a tiny section must not zoom in past street level
    if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: TRACE_MAX_ZOOM, duration: 0.6 });
  }, [traceView, ready, topo]); // eslint-disable-line

  // rebuild incident markers on live updates
  useEffect(() => {
    const g = groups.current.incidents; if (!g) return;
    g.clearLayers();
    inc.filter((i) => i.lat && i.lon).forEach((i) => {
      const active = !['resolved', 'closed', 'cancelled'].includes(i.status);
      const m = L.marker([i.lat, i.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-inc ${active ? 'live' : ''}" style="--c:${SEVC[i.severity]}">${SEVL[i.severity] || ''}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, title: tt('map.ttIncident', { id: i.id, sev: tOr(`sev.${i.severity}`, i.severity), status: tOr(`st.${i.status}`, String(i.status).replace('_', ' ')) }) });
      m.on('click', () => select('incident', i, i.id)); m.addTo(g);
    });
  }, [inc, ready, lang]);

  // crew QR asset scans: where each asset was scanned (lat/long from the crew's phone)
  useEffect(() => {
    const g = groups.current.scans; if (!g) return;
    g.clearLayers();
    scans.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)).forEach((s) => {
      L.marker([s.lat, s.lon], { icon: SCAN_ICON(), zIndexOffset: 800 })
        .bindTooltip(tt('map.asset', { id: s.asset_id || s.raw_value }))
        .on('click', () => select('scan', s, tt('map.asset', { id: s.asset_id || s.raw_value })))
        .addTo(g);
    });
  }, [scans, ready, lang]);

  // Opened from another screen on a point: show the scans layer, fly there, mark it.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapFocus || !ready || !map) return;
    setLayers((l) => ({ ...l, scans: true }));
    map.flyTo([mapFocus.lat, mapFocus.lon], 18, { duration: 0.6 });
    highlight(mapFocus.lat, mapFocus.lon);
    const s = scans.find((x) => x.id === mapFocus.id);
    if (s) select('scan', s, tt('map.asset', { id: s.asset_id || s.raw_value }));
    else if (!scans.length) return; // scans still loading: try again when they arrive
    clearMapFocus?.();
  }, [mapFocus, ready, scans]); // eslint-disable-line

  // Crew markers persist per crew id and glide to each new fix (Uber-style)
  // instead of being rebuilt, with the arrow turned to the direction of travel.
  useEffect(() => {
    const g = groups.current.crews; if (!g) return;
    const live = crewMarkers.current;
    const seen = new Set();
    crews.filter((c) => c.lat && c.lon).forEach((c) => {
      seen.add(c.id);
      const color = CREWC[c.status] || '#9fb0c4';
      let e = live.get(c.id);
      if (!e) {
        const m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-crew-wrap"><div class="${crewCls(c.status)}" style="--c:${color}"></div></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 900, title: tt('map.ttCrew', { name: c.name || c.id }) });
        e = { m, crew: c, at: Date.now(), heading: 0, raf: 0 };
        m.on('click', () => select('crew', e.crew, e.crew.name));
        // Leaflet rebuilds the icon element when the layer is toggled back on
        m.on('add', () => {
          const wrap = m.getElement()?.querySelector('.mk-crew-wrap');
          if (wrap) wrap.style.transform = `rotate(${e.heading}deg)`;
          wrap?.firstChild?.style.setProperty('--c', CREWC[e.crew.status] || '#9fb0c4');
          if (wrap?.firstChild) wrap.firstChild.className = crewCls(e.crew.status);
        });
        m.addTo(g);
        live.set(c.id, e);
        return;
      }
      e.crew = c;
      const el = e.m.getElement()?.querySelector('.mk-crew');
      if (el) { el.style.setProperty('--c', color); el.className = crewCls(c.status); }
      const from = e.m.getLatLng(), to = L.latLng(c.lat, c.lon);
      if (from.distanceTo(to) < 1) return;
      if (from.distanceTo(to) > 3) {
        // turn the short way round (350° → 10° is +20°, not -340°)
        e.heading += ((bearing(from, to) - e.heading) % 360 + 540) % 360 - 180;
        const wrap = e.m.getElement()?.querySelector('.mk-crew-wrap');
        if (wrap) wrap.style.transform = `rotate(${e.heading}deg)`;
      }
      // Spread the glide over the gap since the previous fix so movement looks
      // continuous; cap it so a crew that was offline for a while doesn't crawl.
      const now = Date.now();
      const dur = Math.min(Math.max(now - e.at, 800), 8000);
      e.at = now;
      cancelAnimationFrame(e.raf);
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min((t - t0) / dur, 1);
        e.m.setLatLng([from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k]);
        if (k < 1) e.raf = requestAnimationFrame(step);
      };
      e.raf = requestAnimationFrame(step);
    });
    live.forEach((e, id) => { if (!seen.has(id)) { cancelAnimationFrame(e.raf); g.removeLayer(e.m); live.delete(id); } });
  }, [crews, ready]);

  // Sort raw segments: one whose own line was imported into the topology (the
  // API lists them by index, matched by id -- not by position) is already
  // drawn, cleaned, by the topology layer, so it moves to htLinesTopo /
  // feedersTopo. Every other raw line stays exactly as before.
  useEffect(() => {
    if (!ready || !groups.current.built) return;
    const imported = topoOk ? topo.meta?.rawImported || {} : {};
    const sets = { htLines: new Set(imported.htLines || []), feeders: new Set(imported.feederLines || []) };
    const moved = { htLines: 0, feeders: 0 };
    for (const k of ['htLines', 'feeders']) {
      for (const seg of rawSegs.current[k]) {
        const hide = sets[k].has(seg.index);
        const [from, to] = hide ? [groups.current[k], groups.current[`${k}Topo`]] : [groups.current[`${k}Topo`], groups.current[k]];
        seg.layers.forEach((pl) => { if (from.hasLayer(pl)) { from.removeLayer(pl); to.addLayer(pl); } });
        if (hide) moved[k]++;
      }
    }
    setRawUnderTopo(moved);
  }, [ready, topo]); // eslint-disable-line

  // toggle layers on/off
  useEffect(() => {
    const map = mapRef.current; if (!map || !groups.current.built) return;
    Object.entries(layers).forEach(([k, on]) => {
      const g = groups.current[k]; if (!g) return;
      if (on && !map.hasLayer(g)) g.addTo(map);
      if (!on && map.hasLayer(g)) map.removeLayer(g);
    });
    // raw segments under imported topology: only on an explicit user choice
    ['htLines', 'feeders'].forEach((k) => {
      const g = groups.current[`${k}Topo`]; if (!g) return;
      const on = layers[k] && rawTouched[k];
      if (on && !map.hasLayer(g)) g.addTo(map);
      if (!on && map.hasLayer(g)) map.removeLayer(g);
    });
  }, [layers, rawTouched, ready]);

  // ---- crew trails ---------------------------------------------------------------
  // The path each crew's phone has reported (GET /mobile/crews/:id/track), drawn from the
  // server's stored fixes -- including ones the phone recorded offline and uploaded later.
  const trailsOn = !!layers.trails;
  trailsOnRef.current = trailsOn; trailCrewRef.current = trailCrew; trailWinRef.current = trailWin;
  const crewIdsKey = crews.map((c) => c.id).join(',');
  const crewNamesKey = crews.map((c) => c.name).join('|');

  async function fetchTrail(id) {
    const now = Date.now();
    const rows = await api.crewTrack(id, new Date(now - windowMs(trailWinRef.current)).toISOString(), new Date(now + 60000).toISOString(), MAX_POINTS);
    return normalizeTrack(rows);
  }
  const trailIds = () => (trailCrewRef.current ? [trailCrewRef.current] : crewIdsKey.split(',').filter(Boolean));

  // load when the layer is switched on, the window or the chosen crew changes, or crews appear
  useEffect(() => {
    if (!trailsOn) return undefined;
    let dead = false;
    setTrailBusy(true);
    Promise.all(trailIds().map((id) => fetchTrail(id).then((p) => [id, p]).catch(() => [id, null]))).then((entries) => {
      if (dead) return;
      setTrails((t) => ({ ...t, ...Object.fromEntries(entries.filter(([, p]) => p)) }));
      setTrailFailed(entries.some(([, p]) => !p));
      setTrailBusy(false);
      const want = trailFit.current, mine = entries.find(([id, p]) => id === want && p && p.length);
      if (mine && mapRef.current) { trailFit.current = null; mapRef.current.flyToBounds(L.latLngBounds(mine[1].map((p) => [p.lat, p.lon])).pad(0.25), { duration: 0.5, maxZoom: 18 }); }
    });
    return () => { dead = true; };
  }, [trailsOn, trailWin, trailCrew, crewIdsKey]); // eslint-disable-line

  // a crew just reported a position: refresh that crew's trail shortly (batched)
  useEffect(() => {
    const h = (c) => {
      if (!trailsOnRef.current || !c || !c.id) return;
      if (trailCrewRef.current && trailCrewRef.current !== c.id) return;
      clearTimeout(trailTimers.current[c.id]);
      trailTimers.current[c.id] = setTimeout(() => { fetchTrail(c.id).then((p) => setTrails((t) => ({ ...t, [c.id]: p }))).catch(() => {}); }, 1500);
    };
    socket.on('crew.updated', h);
    return () => { socket.off('crew.updated', h); Object.values(trailTimers.current).forEach(clearTimeout); };
  }, []); // eslint-disable-line

  // keep the time window sliding even when nothing new arrives
  useEffect(() => {
    if (!trailsOn) return undefined;
    const iv = setInterval(() => { trailIds().forEach((id) => fetchTrail(id).then((p) => setTrails((t) => ({ ...t, [id]: p }))).catch(() => {})); }, 60000);
    return () => clearInterval(iv);
  }, [trailsOn, crewIdsKey]); // eslint-disable-line

  // draw
  useEffect(() => {
    const g = groups.current.trails; if (!g) return;
    g.clearLayers();
    const names = Object.fromEntries(crews.map((c) => [c.id, c.name]));
    (trailCrew ? [trailCrew] : Object.keys(trails)).forEach((id) => {
      const pts = trails[id]; if (!pts || !pts.length) return;
      const col = trailColor(id), nm = names[id] || id;
      const { legs, gaps } = splitTrail(pts);
      legs.forEach((leg) => { if (leg.length > 1) L.polyline(leg.map((p) => [p.lat, p.lon]), { color: col, weight: 4, opacity: 0.85, lineJoin: 'round', interactive: false }).addTo(g); });
      gaps.forEach(([a, b]) => L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: col, weight: 2.5, opacity: 0.7, dashArray: '2 8' })
        .bindTooltip(tt('map.ttGap', { name: nm, dur: fmtDur(b.t - a.t), from: fmtClock(a.t), to: fmtClock(b.t) }), { sticky: true }).addTo(g));
      thinDots(pts).forEach((p) => L.circleMarker([p.lat, p.lon], { radius: 3.6, color: col, weight: p.late ? 2 : 1, fillColor: p.late ? '#ffffff' : col, fillOpacity: p.late ? 1 : 0.95 })
        .bindTooltip(`${nm} · ${fmtClock(p.t)}${p.accuracy != null ? ` · ±${Math.round(p.accuracy)} m` : ''}${p.late ? tt('map.ttLate') : ''}`).addTo(g));
      const f = pts[0];
      L.circleMarker([f.lat, f.lon], { radius: 7, color: '#ffffff', weight: 2.5, fillColor: col, fillOpacity: 1 }).bindTooltip(tt('map.ttStart', { name: nm, t: fmtClock(f.t) })).addTo(g);
    });
  }, [trails, trailCrew, crewNamesKey, ready, lang]); // eslint-disable-line

  function focusTrail(id) {
    setLayers((l) => ({ ...l, trails: true }));
    setTrailCrew(id);
    const pts = trails[id];
    if (pts && pts.length && mapRef.current) mapRef.current.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.25), { duration: 0.5, maxZoom: 18 });
    else trailFit.current = id;
  }

  // highlight the selected feeder circuit
  useEffect(() => {
    Object.entries(feederIdx.current).forEach(([name, arr]) => {
      const on = !selFeeder || name === selFeeder;
      arr.forEach((pl) => pl.setStyle({ weight: name === selFeeder ? 5.5 : 3, opacity: on ? 0.95 : 0.12 }));
    });
  }, [selFeeder]);

  function select(kind, obj, label) { setTrace(null); setSel({ kind, label, ...obj }); if (kind !== 'feeder') setSelFeeder(null); }
  function selectTopo(p, latlng) { setTrace(null); setSel({ kind: 'topo', label: p.name || p.mrid, ...p, lat: latlng[0], lon: latlng[1] }); setSelFeeder(null); }
  // kind: 'section' (Trace electrical section), 'upstream' (Trace to source),
  // 'whatif' (Simulate opening). The result is kept with its kind and the
  // device it was run for (trace.for), so the card shows it only for that device.
  async function runTrace(mrid, kind = 'section') {
    setTraceBusy(kind);
    try {
      const r = kind === 'upstream' ? await api.networkUpstream(mrid)
        : kind === 'whatif' ? await api.networkWhatIf({ assumedOpen: [mrid] })
        : await api.networkSection(mrid);
      setTrace({ ...r, kind, for: mrid });
    } catch (e) { setTrace({ found: false, kind, for: mrid, reason: e.data?.message || e.data?.reason || e.message || tt('map.traceFailed') }); }
    finally { setTraceBusy(false); }
  }
  // Jump to one imported substation's topology (its bbox from the API), or to
  // all of it when no area is given.
  const fitTopo = (area) => {
    const m = mapRef.current; if (!m) return;
    const b = area?.bbox?.every(Number.isFinite) ? L.latLngBounds([area.bbox[1], area.bbox[0]], [area.bbox[3], area.bbox[2]]) : m.__topoBounds;
    if (b) m.flyToBounds(b.pad(0.15), { duration: 0.6 });
  };
  // Picking a feeder is an explicit ask to see its raw lines, even under topology.
  function pickFeeder(name) { setSelFeeder(name); setSel({ kind: 'feeder', ...feeders[name] }); setRawTouched((t) => ({ ...t, feeders: true })); }
  const fitAll = () => { const m = mapRef.current; if (m && m.__bounds) m.flyToBounds(m.__bounds.pad(0.05), { duration: 0.5 }); };

  function highlight(lat, lon) {
    const map = mapRef.current; if (!map) return;
    if (hiRef.current) { map.removeLayer(hiRef.current); hiRef.current = null; }
    if (lat == null) return;
    hiRef.current = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="mk-find"></div>', iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 2000 }).addTo(map);
  }
  // fly the map to a searched item and reveal / highlight it
  // Fly to a region chosen from the OMS's own GIS data (substation areas, zones, divisions).
  // 'topo:<mrid>' (or 'topo:*' for all) jumps to imported topology instead,
  // switching the topology layers on so there is something to see there.
  function goRegion(id) {
    setRegionId(id);
    if (id.startsWith('topo:')) {
      setLayers((l) => ({ ...l, topo: true, topoStruct: true }));
      fitTopo(topoAreas.find((a) => `topo:${a.mrid}` === id));
      return;
    }
    const r = regions.find((x) => x.id === id);
    const map = mapRef.current;
    if (!r || !map) return;
    map.flyToBounds(L.latLngBounds([r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]), { duration: 0.6 });
  }

  function goTo(item) {
    const map = mapRef.current; if (!map) return;
    const layerKey = { ss: 'substations', ptx: 'powerTx', dt: 'distTx', switch: 'switches', rmu: 'rmus', fuse: 'fuses', feeder: 'feeders', incident: 'incidents', crew: 'crews' }[item.kind];
    if (layerKey && !layers[layerKey]) setLayers((l) => ({ ...l, [layerKey]: true }));
    setQuery(''); setOpenResults(false);
    if (item.kind === 'feeder') {
      const f = feeders[item.label]; pickFeeder(item.label); highlight(null);
      if (f) map.flyToBounds(L.latLngBounds([f.minLat, f.minLon], [f.maxLat, f.maxLon]).pad(0.25), { maxZoom: 16, duration: 0.6 });
      return;
    }
    if (item.lat && item.lon) {
      map.flyTo([item.lat, item.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
      highlight(item.lat, item.lon);
    }
    select(item.kind, item.ref, item.label);
  }

  if (!net) return <div className="empty"><span className="disp">{t('map.loading')}</span>{t('map.loadingSub')}</div>;
  if (net.error) return <div className="screen-error"><h2>{t('map.unavail')}</h2><p>{t('map.unavailSub')}</p></div>;
  const c = net.counts || {};
  // Both raw line layers actually on screen (ticked, and not entirely hidden
  // under imported topology) -- they never visually join, so say why.
  const rawShowing = (k, total) => layers[k] && (rawTouched[k] || rawUnderTopo[k] < (total || 0));
  const rawBothShowing = rawShowing('htLines', c.htLines) && rawShowing('feeders', c.feederLines);
  const plottedInc = inc.filter((i) => i.lat && i.lon);

  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">{t('map.eyebrow')}</div><h2>{t('map.title')}</h2>
          <p>{t('map.summary', { ss: c.substations, dt: c.distTx ? c.distTx.toLocaleString() : 0, spans: c.feederLines, circuits: Object.keys(feeders).length })}</p></div>
      </div>

      <div className="map-wrap">
        <div className="layer-panel">
          {LAYER_GROUPS.filter(([group]) => topoOk || !group.startsWith('Topology')).map(([group, ls]) => (
            <div key={group} className="lp-group">
              <div className="lp-h">{group.startsWith('Topology') ? topoTitle : t(`map.grp.${group}`)}</div>
              {group.startsWith('Topology') && <div className="lp-sub">{t('map.topoSub')}</div>}
              {ls.map(([k, label]) => {
                const n = k === 'topo' ? topoCounts.topoLines + topoCounts.topoEquip : k.startsWith('topo') ? topoCounts[k] : k === 'incidents' ? plottedInc.length : k === 'crews' ? crews.length : k === 'trails' ? Object.values(trails).filter((p) => p && p.length).length : (c[k === 'feeders' ? 'feederLines' : k] || 0);
                return (
                  <label key={k} className={`lp-row ${layers[k] ? 'on' : ''}`}>
                    <input type="checkbox" checked={!!layers[k]} onChange={() => {
                      setLayers((l) => ({ ...l, [k]: !l[k] }));
                      if (k in rawTouched) setRawTouched((t) => ({ ...t, [k]: true }));
                    }} />
                    <span className={`lp-swatch sw-${k}`} /><span className="lp-label">{tOr(`map.ly.${k}`, label)}
                      {k in rawTouched && !rawTouched[k] && rawUnderTopo[k] > 0 && (
                        <span className="lp-hidden" title={t('map.rawHiddenTitle')}>
                          {t('map.rawHidden', { n: rawUnderTopo[k].toLocaleString() })}</span>)}
                      {k === 'topo' && (
                        <span className="lp-hidden">{t('map.topoLinesDevices', { l: topoCounts.topoLines.toLocaleString(), d: topoCounts.topoEquip.toLocaleString() })}</span>)}
                    </span>
                    <span className="lp-count">{n && n.toLocaleString ? n.toLocaleString() : n}</span>
                  </label>
                );
              })}
              {group === 'Network' && rawBothShowing && !rawNoteDismissed && (
                <div className="lp-hint lp-rawnote" role="note">
                  {t('map.rawNote')}
                  <button className="ms-clear" aria-label={t('map.dismissNote')} onClick={() => setRawNoteDismissed(true)}><Icon name="x" size={12} /></button>
                </div>)}
              {group === 'Operations' && trailsOn && (
                <TrailPanel crews={crews} trails={trails} trailCrew={trailCrew} trailWin={trailWin} setTrailWin={setTrailWin}
                  busy={trailBusy} failed={trailFailed} onFocus={focusTrail} onAll={() => setTrailCrew(null)} />)}
            </div>
          ))}
          {selFeeder && <button className="lp-clear" onClick={() => { setSelFeeder(null); setSel(null); }}>{t('map.clearFeeder')}</button>}

          <div className="lp-group lp-key">
            <div className="lp-h">{t('map.key')}</div>
            <div className="lp-kt">{t('map.keySev')}</div>
            <div className="lp-kgrid">
              {['critical', 'high', 'medium', 'low'].map((k) => (
                <span key={k} className="lp-krow"><span className="mk-inc lg-inc" style={{ '--c': SEVC[k] }} aria-hidden="true">{SEVL[k]}</span> {t(`map.sev.${k}`)}</span>
              ))}
            </div>
            <div className="lp-kt">{t('map.keyCrew')}</div>
            <div className="lp-kgrid">
              {['available', 'in_transit', 'in_service', 'on_break'].map((k) => (
                <span key={k} className="lp-krow"><span className="lg-crew" aria-hidden="true"><span className={crewCls(k)} style={{ '--c': CREWC[k] }} /></span> {t(`map.key.${k}`)}</span>
              ))}
            </div>
            <div className="lp-knote">{t('map.keyNote')}</div>
          </div>

          <div className="lp-hint">{t('map.hint')}</div>
        </div>

        <div className="card map-stage">
          {trace?.kind === 'whatif' && trace.simulation && <div className="sim-banner" role="status">{t('map.simBanner')}</div>}
          <div ref={boxRef} className="leaflet-host" />
          {basemapDown && (
            <div className="map-basemap-note" role="status">
              {t('map.basemapDown')}{OSM_FALLBACK ? t('map.osmFallback') : ''}
            </div>
          )}

          <div className="map-search">
            <div className="ms-box">
              <Icon name="pin" size={15} />
              {/* Keyboard route to every map feature (markers on the canvas can't take focus):
                  a combobox - arrows move through results, Enter opens the active one. */}
              <input value={query} placeholder={t('map.searchPh')}
                aria-label={t('map.searchAria')} role="combobox" aria-autocomplete="list"
                aria-expanded={!!(openResults && query)} aria-controls="map-search-results"
                aria-activedescendant={openResults && query && results[activeIdx] ? `map-result-${activeIdx}` : undefined}
                onChange={(e) => { setQuery(e.target.value); setOpenResults(true); setActiveIdx(0); }}
                onFocus={() => setOpenResults(true)}
                onBlur={() => setTimeout(() => setOpenResults(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); setOpenResults(true); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
                  else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === 'Enter' && results[activeIdx]) goTo(results[activeIdx]);
                  else if (e.key === 'Escape') { setQuery(''); setOpenResults(false); }
                }} />
              {query && <button className="ms-clear" aria-label={t('map.clearSearch')} onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery('')}><Icon name="x" size={13} /></button>}
            </div>
            {openResults && query && (
              <div className="ms-results" id="map-search-results" role="listbox" aria-label={t('map.results')}>
                {results.length === 0 && <div className="ms-empty" role="status">{t('map.noMatch', { q: query })}</div>}
                {results.map((r, i) => (
                  <button key={r.kind + r.label + i} id={`map-result-${i}`} role="option" aria-selected={i === activeIdx} tabIndex={-1}
                    className={`ms-item${i === activeIdx ? ' active' : ''}`} onMouseEnter={() => setActiveIdx(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => goTo(r)}>
                    <span className={`ms-tag tag-${r.kind}`}>{tOr(`map.type.${r.type}`, r.type)}</span>
                    <span className="ms-label">{r.label}</span>
                    {r.sub && <span className="ms-sub">{r.sub}</span>}
                  </button>
                ))}
              </div>
            )}
            {(regions.length > 0 || topoAreas.length > 0) && (
              <select className="ms-box" aria-label={t('map.goRegion')} value={regionId} onChange={(e) => goRegion(e.target.value)}
                style={{ marginTop: 6, width: '100%', fontSize: 13, color: 'var(--ink)', cursor: 'pointer' }}>
                <option value="">{t('map.goRegionOpt')}</option>
                {['division', 'zone', 'substation', 'corridor', 'network'].map((kind) => {
                  const list = regions.filter((r) => r.kind === kind);
                  return list.length ? (
                    <optgroup key={kind} label={t(`map.rg.${kind}`)}>
                      {list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </optgroup>
                  ) : null;
                })}
                {topoAreas.length > 0 && (
                  <optgroup label={t('map.importedTopo')}>
                    {topoAreas.length > 1 && <option value="topo:*">{t('map.allImportedTopo')}</option>}
                    {topoAreas.map((a) => <option key={a.mrid} value={`topo:${a.mrid}`}>{clean(a.name) || a.code} · {a.equipment.toLocaleString()}</option>)}
                  </optgroup>)}
              </select>
            )}
          </div>

          <div className="map-tools">
            <button className="map-fit" onClick={fitAll} title={t('map.fitTitle')}><Icon name="map" size={15} /> {t('map.fit')}</button>
          </div>

          {sel && (
            <div className="map-detail card" ref={detailRef} tabIndex={-1} role="region" aria-label={t('map.selected', { x: sel.kind === 'incident' ? sel.id : sel.label || sel.kind })}>
              <div className="card-h"><h3>{sel.kind === 'incident' ? sel.id : sel.kind === 'feeder' ? t('map.feeder') : sel.label}</h3>
                <button className="iconbtn" aria-label={t('map.close')} onClick={() => { setSel(null); setSelFeeder(null); setTrace(null); highlight(null); }}><Icon name="x" size={15} /></button></div>
              <div className="card-b">
                {sel.kind === 'incident' && <><div style={{ display: 'flex', gap: 7, marginBottom: 12 }}><SevBadge sev={sel.severity} /><StatusBadge status={sel.status} /></div>
                  <KV k={t('map.k.substation')} v={sel.substation} /><KV k={t('map.k.zone')} v={sel.zone} /><KV k={t('map.k.feeder')} v={sel.feeder} mono /><KV k={t('map.k.customers')} v={(sel.customers || 0).toLocaleString()} mono /><KV k={t('map.k.cause')} v={sel.cause} /><KV k={t('map.k.crew')} v={sel.crew_id || t('map.unassigned')} /></>}
                {sel.kind === 'feeder' && <><div className="feeder-tag" style={{ background: sel.color }}>{sel.name}</div>
                  <KV k={t('map.k.voltage')} v={sel.kv ? sel.kv + ' kV' : '11 kV'} /><KV k={t('map.k.substation')} v={sel.ss} /><KV k={t('map.k.segments')} v={sel.segs} mono /><KV k={t('map.k.routeLen')} v={sel.km ? sel.km.toFixed(2) + ' km' : '—'} mono /></>}
                {sel.kind === 'ss' && <><span className="chip chip-soft">{t('map.k.substation')}</span><KV k={t('map.k.voltage')} v={sel.ratio} /><KV k={t('map.k.capacity')} v={sel.mva ? sel.mva + ' MVA' : '—'} /><KV k={t('map.k.status')} v={sel.status} /><KV k={t('map.k.outFeeders')} v={sel.feeders} /></>}
                {sel.kind === 'ptx' && <><span className="chip chip-soft">{t('map.powerTx')}</span><KV k="HV" v={sel.hv ? sel.hv + ' kV' : '—'} /><KV k="LV" v={sel.lv ? sel.lv + ' kV' : '—'} /><KV k={t('map.k.capacity')} v={sel.mva ? sel.mva + ' MVA' : '—'} /><KV k={t('map.k.status')} v={sel.status} /></>}
                {sel.kind === 'dt' && <><span className="chip chip-soft">{t('map.distTx')}</span><KV k={t('map.k.capacity')} v={sel.kva ? sel.kva + ' kVA' : '—'} /><KV k={t('map.k.feeder')} v={sel.feeder} mono /><KV k={t('map.k.ssCode')} v={sel.ss} mono /><KV k={t('map.k.status')} v={sel.status} /></>}
                {sel.kind === 'switch' && <><span className="chip chip-soft">{t('map.switch')}</span><KV k={t('map.k.type')} v={sel.type} /><KV k={t('map.k.voltage')} v={sel.kv ? sel.kv + ' kV' : '—'} /><KV k={t('map.k.status')} v={sel.status} /></>}
                {sel.kind === 'rmu' && <><span className="chip chip-soft">{t('map.rmu')}</span><KV k={t('map.k.id')} v={sel.id} mono /><KV k={t('map.k.status')} v={sel.status} /></>}
                {sel.kind === 'topo' && <>
                  <span className="chip chip-soft">{sel.cls} · CIM</span>
                  <KV k="mRID" v={sel.mrid} mono /><KV k={t('map.k.name')} v={sel.name} /><KV k={t('map.k.feeder')} v={sel.feeder} />
                  <KV k={t('map.k.ratedV')} v={sel.ratedVoltage ? (Number(sel.ratedVoltage) / 1000) + ' kV' : null} />
                  <TraceCard trace={trace && trace.for === sel.mrid ? trace : null} busy={traceBusy}
                    onRun={(kind) => runTrace(sel.mrid, kind)} onClear={() => setTrace(null)} />
                </>}
                {sel.kind === 'scan' && <><span className="chip chip-soft">{t('map.scanChip')}</span><KV k={t('map.k.asset')} v={sel.asset_id || sel.raw_value} mono /><KV k={t('map.k.crew')} v={sel.crew_id} mono /><KV k={t('map.k.job')} v={sel.job_id} mono /><KV k={t('map.k.incident')} v={sel.incident_id} mono />
                  <KV k={t('map.k.scanned')} v={sel.scanned_at ? new Date(sel.scanned_at).toLocaleString() : '—'} /><KV k={t('map.k.latlon')} v={`${Number(sel.lat).toFixed(6)}, ${Number(sel.lon).toFixed(6)}`} mono /></>}
                {sel.kind === 'crew' && <><span className="chip chip-soft">{t('map.fieldCrew')}</span><KV k={t('map.k.lead')} v={sel.lead} /><KV k={t('map.k.status')} v={sel.status ? tOr(`map.cs.${sel.status}`, sel.status.replace('_', ' ')) : ''} /><KV k={t('map.k.location')} v={sel.location} /><KV k={t('map.k.skills')} v={sel.skills} />
                  <CrewTrailInfo pts={trails[sel.id]} win={trailWin} lastFix={sel.location_updated_at} onShow={() => focusTrail(sel.id)} /></>}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Side-panel list of crew trails: window picker, one row per crew, and an honest
// "no fixes" line (with the last time the server heard from that crew) when there is nothing to draw.
function TrailPanel({ crews, trails, trailCrew, trailWin, setTrailWin, busy, failed, onFocus, onAll }) {
  const { t } = useT();
  const rows = trailCrew ? crews.filter((c) => c.id === trailCrew) : crews;
  return (
    <div className="trail-ctl">
      <div className="trail-win" role="group" aria-label={t('map.trailWin')}>
        {TRAIL_WINDOWS.map(([k]) => <button key={k} className={`tw ${trailWin === k ? 'on' : ''}`} onClick={() => setTrailWin(k)}>{k}</button>)}
      </div>
      {trailCrew && <button className="lp-clear" onClick={onAll}>{t('map.oneCrew')}</button>}
      {failed && <div className="trail-warn">{t('map.trailFail')}</div>}
      <div className="trail-list">
        {rows.map((c) => {
          const pts = trails[c.id], s = pts ? summarize(pts) : null;
          return (
            <button key={c.id} className="trail-row" onClick={() => onFocus(c.id)}
              title={pts && !s.count ? t('map.noPosTitle', { name: c.name, win: trailWin, ago: c.location_updated_at ? fmtAgo(c.location_updated_at) : t('map.never') }) : t('map.zoomTrail')}>
              <span className="trail-sw" style={{ background: trailColor(c.id) }} />
              <span className="trail-name">{c.name}</span>
              <span className="trail-meta">
                {!pts ? (busy ? t('map.loadingSm') : '—')
                  : s.count ? t('map.fixesKm', { n: s.count, km: (s.distanceM / 1000).toFixed(2) })
                    : c.location_updated_at ? t('map.noFixesAgo', { ago: fmtAgo(c.location_updated_at) }) : t('map.noFixesYet')}
              </span>
            </button>
          );
        })}
      </div>
      <div className="lp-knote" title={t('map.legendTitle')}>{t('map.legend')}</div>
    </div>
  );
}

// Trail summary + button inside the selected crew's detail card.
function CrewTrailInfo({ pts, win, lastFix, onShow }) {
  const { t } = useT();
  const s = pts ? summarize(pts) : null;
  return (
    <>
      <button className="trace-btn trail-btn" onClick={onShow}>{t('map.showTrail', { win })}</button>
      {s && s.count > 0 && <div className="trail-sum">
        <KV k={t('map.k.fixes')} v={String(s.count)} mono /><KV k={t('map.k.distance')} v={`${(s.distanceM / 1000).toFixed(2)} km`} mono />
        <KV k={t('map.k.firstFix')} v={fmtClock(s.firstT)} mono /><KV k={t('map.k.lastFix')} v={`${fmtClock(s.lastT)} (${fmtAgo(s.lastT)})`} mono />
        {s.lateCount > 0 && <KV k={t('map.k.offline')} v={t('map.nFixes', { n: s.lateCount })} mono />}
        {s.gapCount > 0 && <KV k={t('map.k.gaps')} v={String(s.gapCount)} mono />}
      </div>}
      {s && s.count === 0 && <div className="trace-note">{t('map.noFixes', { win, ago: lastFix ? fmtAgo(lastFix) : t('map.never') })}</div>}
    </>
  );
}

function KV({ k, v, mono }) { return <div className="kv-row"><span className="k">{k}</span><span className={`v ${mono ? 'mono' : ''}`}>{v || '—'}</span></div>; }

// The trace card in a topology device's detail panel: section trace, trace to
// source and simulate opening (OMS-05), each with the honesty text its result
// carries -- switch states unknown, inferred connectivity, simulation not live.
function TraceCard({ trace, busy, onRun, onClear }) {
  const { t } = useT();
  const btn = (kind, label, busyLabel) => (
    <button key={kind} className={`trace-btn${kind === 'section' ? '' : ' ghost'}`} disabled={!!busy} onClick={() => onRun(kind)}>{busy === kind ? busyLabel : label}</button>);
  const Notes = ({ r }) => <>
    {r.truncated && <div className="trace-note" style={{ color: '#b91c1c', fontWeight: 600 }}>{r.truncatedNote || t('map.truncated')}</div>}
    {r.inferredNote && <div className="trace-note"><b>{t('map.inferred')}</b> {r.inferredNote}</div>}
    {r.caveat && <div className="trace-note">{r.caveat}</div>}
  </>;
  const clear = <button className="trace-btn ghost" onClick={onClear}>{t('map.clearTrace')}</button>;

  if (!trace) return <>{btn('section', t('map.traceBtn'), t('map.tracing'))}{btn('upstream', t('map.traceUpBtn'), t('map.tracing'))}{btn('whatif', t('map.simBtn'), t('map.simulating'))}</>;
  if (trace.found === false) return <><div className="trace-note">{trace.reason}</div>{clear}</>;

  if (trace.kind === 'upstream') return (
    <div className="trace-box">
      <h4>{t('map.upTitle')}</h4>
      {trace.pathFound ? <>
        <div className="trace-stat">
          <div><b>{trace.source.hops}</b><span>{t('map.hopsToSs')}</span></div>
          <div><b>{trace.switchesOnPath.length}</b><span>{t('map.swOnPath')}</span></div>
        </div>
        <KV k={t('map.k.ssBus')} v={trace.source.node} mono />
        <KV k={t('map.k.otherSs')} v={String(trace.alternateSourcesInComponent)} />
        {trace.switchesOnPath.length > 0 && <div className="trace-note">{trace.switchesOnPath.map((s) => `${s.cim_class} ${s.name || s.cim_mrid}`).join(', ')}</div>}
        <div className="trace-note">{trace.switchStateNote}</div>
      </> : <div className="trace-note" style={{ fontWeight: 600 }}>{trace.reason}</div>}
      <Notes r={trace} />{clear}
    </div>);

  if (trace.kind === 'whatif') {
    const dt = trace.distributionTransformers;
    return (
      <div className="trace-box sim">
        <h4>{t('map.simTitle')}</h4>
        {trace.assumedOpen.filter((d) => !d.effective).map((d) => <div key={d.cim_mrid} className="trace-note" style={{ fontWeight: 600 }}>{d.reason}</div>)}
        <div className="trace-stat">
          <div><b>{trace.counts.lostDevices}</b><span>{t('map.lostDevices')}</span></div>
          <div><b>{dt.count}</b><span>{t('map.distTxs')}</span></div>
        </div>
        <KV k={t('map.k.kvaAffected')} v={dt.kvaIsLowerBound ? `≥ ${dt.kvaTotal}` : String(dt.kvaTotal)} mono />
        <div className="trace-note">{dt.label}</div>
        <KV k={t('map.k.source')} v={trace.source.mrids.join(', ')} mono />
        {trace.source.note && <div className="trace-note">{trace.source.note}{trace.source.alternateSourcesInComponent ? t('map.otherSsUnused', { n: trace.source.alternateSourcesInComponent }) : ''}</div>}
        <div className="trace-note">{trace.assumptions.baseline}</div>
        <Notes r={trace} />{clear}
      </div>);
  }

  return (
    <div className="trace-box">
      <h4>{t('map.sectionTrace')}</h4>
      <div className="trace-stat">
        <div><b>{trace.sectionEquipment.length}</b><span>{t('map.inSection')}</span></div>
        <div><b>{trace.boundarySwitches.length}</b><span>{t('map.boundarySw')}</span></div>
      </div>
      <KV k={t('map.protection')} v={trace.nearbyProtectionAssets.length ? trace.nearbyProtectionAssets.map((a) => `${a.kind} ${a.name}`).join(', ') : t('map.none')} />
      {trace.sectionEquipment.length === 1 && trace.boundarySwitches.length === 0 ? (
        <div className="trace-note">{t('map.selfOnly')}</div>
      ) : trace.sectionEquipment.length < SMALL_SECTION && (
        <div className="trace-note">{t('map.smallSection')}</div>)}
      <Notes r={trace} />{clear}
    </div>);
}

