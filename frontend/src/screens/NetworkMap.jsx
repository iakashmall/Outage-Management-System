import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, useLiveRefresh } from '../lib/ui.jsx';

const SEVC = { critical: '#e23b2e', high: '#ef9021', medium: '#3b82f6', low: '#22b06b' };
const CREWC = { available: '#0fb39d', in_service: '#3b82f6', in_transit: '#ef9021', on_break: '#9fb0c4', off_shift: '#9fb0c4' };
const PALETTE = ['#3b82f6', '#0fb39d', '#e0742b', '#8b5cf6', '#22b06b', '#e0447a', '#d1a017', '#2fa3a3', '#7a9e2e', '#c2622a', '#5b6ee0', '#c94f9a'];
const feederColor = (name) => { if (!name) return '#9fb0c4'; let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff; return PALETTE[h % PALETTE.length]; };
const hav = (a, b) => { const R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const clean = (n) => (n || '').replace(/33\/11 kV/i, '').replace(/S\/s/i, '').trim();

const LAYER_GROUPS = [
  ['Network', [['htLines', 'HT network', true], ['feeders', 'Feeder lines', true], ['substations', 'Substations', true],
    ['powerTx', 'Power transformers', false], ['distTx', 'Distribution txr', false],
    ['switches', 'Switches', false], ['rmus', 'RMUs', false], ['fuses', 'Drop-out fuses', false]]],
  ['Operations', [['incidents', 'Incidents', true], ['crews', 'Crews', true]]],
];
const ALL = LAYER_GROUPS.flatMap(([, ls]) => ls);

export default function NetworkMap() {
  const [net, setNet] = useState(null);
  const [inc, setInc] = useState([]);
  const [crews, setCrews] = useState([]);
  const [sel, setSel] = useState(null);
  const [selFeeder, setSelFeeder] = useState(null);
  const [layers, setLayers] = useState(Object.fromEntries(ALL.map(([k, , on]) => [k, on])));
  const [ready, setReady] = useState(false);

  const boxRef = useRef();
  const mapRef = useRef(null);
  const groups = useRef({});
  const feederIdx = useRef({});
  const selRef = useRef(null); selRef.current = sel;

  useEffect(() => { api.network().then(setNet).catch(() => setNet({ error: true })); }, []);
  const loadLive = () => { api.incidents().then(setInc); api.crews().then(setCrews); };
  useEffect(() => { loadLive(); }, []);
  useLiveRefresh(['crew.updated', 'oms.incident.updated', 'oms.incident.created'], loadLive);
  useEffect(() => { if (sel && sel.kind === 'incident') setSel((s) => ({ ...s, ...(inc.find((i) => i.id === s.id) || {}) })); }, [inc]); // eslint-disable-line

  const feeders = useMemo(() => {
    if (!net || !net.feederLines) return {};
    const m = {};
    net.feederLines.forEach((l) => { const k = l.feeder || '—'; if (!m[k]) m[k] = { name: k, kv: l.kv, ss: l.ss, segs: 0, km: 0, color: feederColor(k) }; m[k].segs++; for (let i = 0; i < l.path.length - 1; i++) m[k].km += hav(l.path[i], l.path[i + 1]); });
    return m;
  }, [net]);

  // create the Leaflet map once
  useEffect(() => {
    if (!net || net.error || mapRef.current || !boxRef.current) return;
    const b = net.bounds;
    const bounds = L.latLngBounds([b.minLat, b.minLon], [b.maxLat, b.maxLon]);
    const map = L.map(boxRef.current, { preferCanvas: true, zoomControl: false, attributionControl: true, maxZoom: 19, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 });
    map.fitBounds(bounds.pad(0.05));
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap', opacity: 0.92 }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    mapRef.current = map;
    map.__bounds = bounds;
    setReady(true);
    return () => { map.remove(); mapRef.current = null; };
  }, [net]);

  // build static network layers once the map exists
  useEffect(() => {
    if (!ready || !mapRef.current || !net || groups.current.built) return;
    const map = mapRef.current;
    const mk = () => L.layerGroup();
    ['htLines', 'feeders', 'substations', 'powerTx', 'distTx', 'switches', 'rmus', 'fuses'].forEach((k) => (groups.current[k] = mk()));

    net.htLines.forEach((l) => L.polyline(l.path, { color: '#9fb0cb', weight: 1, opacity: 0.55, interactive: false }).addTo(groups.current.htLines));

    feederIdx.current = {};
    net.feederLines.forEach((l) => {
      const pl = L.polyline(l.path, { color: feederColor(l.feeder), weight: 2.5, opacity: 0.9 });
      pl.on('click', () => pickFeeder(l.feeder));
      pl.bindTooltip(`${l.feeder || 'Feeder'} · ${l.kv || 11} kV`, { sticky: true });
      pl.addTo(groups.current.feeders);
      (feederIdx.current[l.feeder] = feederIdx.current[l.feeder] || []).push(pl);
    });

    net.fuses.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 2.5, color: '#b98a5e', weight: 0, fillOpacity: 0.85 }).addTo(groups.current.fuses));
    net.rmus.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 3, color: '#7a9e2e', weight: 0, fillOpacity: 0.9 }).on('click', () => select('rmu', a, 'RMU')).addTo(groups.current.rmus));
    net.switches.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 2.8, color: '#8b5cf6', weight: 0, fillOpacity: 0.85 }).on('click', () => select('switch', a, a.name || 'Switch')).addTo(groups.current.switches));
    net.distTx.forEach((a) => L.circleMarker([a.lat, a.lon], { radius: 3, color: '#3b82f6', weight: 0, fillOpacity: 0.85 }).bindTooltip(a.name || 'DTR').on('click', () => select('dt', a, a.name || 'DTR')).addTo(groups.current.distTx));
    net.powerTx.forEach((a) => L.marker([a.lat, a.lon], { icon: L.divIcon({ className: '', html: '<div class="mk-ptx"></div>', iconSize: [12, 12] }) }).on('click', () => select('ptx', a, a.name || 'Power Txr')).addTo(groups.current.powerTx));
    net.substations.forEach((s) => L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-ss"><span class="mk-ss-d"></span><span class="mk-ss-l">${clean(s.name)}</span></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), zIndexOffset: 500 }).on('click', () => select('ss', s, s.name)).addTo(groups.current.substations));

    groups.current.incidents = mk();
    groups.current.crews = mk();
    groups.current.built = true;
    // add the default-on layers
    ALL.forEach(([k, , on]) => { if (on && groups.current[k]) groups.current[k].addTo(map); });
  }, [ready, net]); // eslint-disable-line

  // rebuild incident markers on live updates
  useEffect(() => {
    const g = groups.current.incidents; if (!g) return;
    g.clearLayers();
    inc.filter((i) => i.lat && i.lon).forEach((i) => {
      const active = !['resolved', 'closed', 'cancelled'].includes(i.status);
      const m = L.marker([i.lat, i.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-inc ${active ? 'live' : ''}" style="--c:${SEVC[i.severity]}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 });
      m.on('click', () => select('incident', i, i.id)); m.addTo(g);
    });
  }, [inc, ready]);

  // rebuild crew markers on live updates
  useEffect(() => {
    const g = groups.current.crews; if (!g) return;
    g.clearLayers();
    crews.filter((c) => c.lat && c.lon).forEach((c) => {
      const m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: `<div class="mk-crew" style="--c:${CREWC[c.status] || '#9fb0c4'}"></div>`, iconSize: [16, 14], iconAnchor: [8, 10] }), zIndexOffset: 900 });
      m.on('click', () => select('crew', c, c.name)); m.addTo(g);
    });
  }, [crews, ready]);

  // toggle layers on/off
  useEffect(() => {
    const map = mapRef.current; if (!map || !groups.current.built) return;
    Object.entries(layers).forEach(([k, on]) => {
      const g = groups.current[k]; if (!g) return;
      if (on && !map.hasLayer(g)) g.addTo(map);
      if (!on && map.hasLayer(g)) map.removeLayer(g);
    });
  }, [layers, ready]);

  // highlight the selected feeder circuit
  useEffect(() => {
    Object.entries(feederIdx.current).forEach(([name, arr]) => {
      const on = !selFeeder || name === selFeeder;
      arr.forEach((pl) => pl.setStyle({ weight: name === selFeeder ? 4.5 : 2.5, opacity: on ? 0.95 : 0.12 }));
    });
  }, [selFeeder]);

  function select(kind, obj, label) { setSel({ kind, label, ...obj }); if (kind !== 'feeder') setSelFeeder(null); }
  function pickFeeder(name) { setSelFeeder(name); setSel({ kind: 'feeder', ...feeders[name] }); }
  const fitAll = () => { const m = mapRef.current; if (m && m.__bounds) m.flyToBounds(m.__bounds.pad(0.05), { duration: 0.5 }); };

  if (!net) return <div className="empty"><span className="disp">Loading network…</span>Reading the Haridwar GIS model.</div>;
  if (net.error) return <div className="screen-error"><h2>Network unavailable</h2><p>Could not load the topology from the backend.</p></div>;
  const c = net.counts || {};
  const plottedInc = inc.filter((i) => i.lat && i.lon);

  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Geospatial · Haridwar</div><h2>Network map</h2>
          <p>{c.substations} substations · {c.distTx ? c.distTx.toLocaleString() : 0} DTRs · {c.feederLines} feeder spans · {Object.keys(feeders).length} circuits</p></div>
      </div>

      <div className="map-wrap">
        <div className="layer-panel">
          {LAYER_GROUPS.map(([group, ls]) => (
            <div key={group} className="lp-group">
              <div className="lp-h">{group}</div>
              {ls.map(([k, label]) => {
                const n = k === 'incidents' ? plottedInc.length : k === 'crews' ? crews.length : (c[k === 'feeders' ? 'feederLines' : k] || 0);
                return (
                  <label key={k} className={`lp-row ${layers[k] ? 'on' : ''}`}>
                    <input type="checkbox" checked={!!layers[k]} onChange={() => setLayers((l) => ({ ...l, [k]: !l[k] }))} />
                    <span className={`lp-swatch sw-${k}`} /><span className="lp-label">{label}</span>
                    <span className="lp-count">{n && n.toLocaleString ? n.toLocaleString() : n}</span>
                  </label>
                );
              })}
            </div>
          ))}
          {selFeeder && <button className="lp-clear" onClick={() => { setSelFeeder(null); setSel(null); }}>Clear feeder highlight</button>}
          <div className="lp-hint">Drag to pan · scroll to zoom · click a feeder to trace its circuit</div>
        </div>

        <div className="card map-stage">
          <div ref={boxRef} className="leaflet-host" />
          <button className="map-fit" onClick={fitAll} title="Fit whole network"><Icon name="map" size={15} /> Fit</button>

          <div className="map-legend2">
            <span><i className="lg2 dia" /> Substation</span><span><i className="lg2 sq" /> Power Txr</span>
            <span><i className="lg2 dt" /> DTR</span><span><i className="lg2 tri" /> Crew</span><span><i className="lg2 inc" /> Incident</span>
          </div>

          {sel && (
            <div className="map-detail card">
              <div className="card-h"><h3>{sel.kind === 'incident' ? sel.id : sel.kind === 'feeder' ? 'Feeder' : sel.label}</h3>
                <button className="iconbtn" onClick={() => { setSel(null); setSelFeeder(null); }}><Icon name="x" size={15} /></button></div>
              <div className="card-b">
                {sel.kind === 'incident' && <><div style={{ display: 'flex', gap: 7, marginBottom: 12 }}><SevBadge sev={sel.severity} /><StatusBadge status={sel.status} /></div>
                  <KV k="Substation" v={sel.substation} /><KV k="Zone" v={sel.zone} /><KV k="Feeder" v={sel.feeder} mono /><KV k="Customers" v={(sel.customers || 0).toLocaleString()} mono /><KV k="Cause" v={sel.cause} /><KV k="Crew" v={sel.crew_id || 'unassigned'} /></>}
                {sel.kind === 'feeder' && <><div className="feeder-tag" style={{ background: sel.color }}>{sel.name}</div>
                  <KV k="Voltage" v={sel.kv ? sel.kv + ' kV' : '11 kV'} /><KV k="Substation" v={sel.ss} /><KV k="Segments" v={sel.segs} mono /><KV k="Route length" v={sel.km ? sel.km.toFixed(2) + ' km' : '—'} mono /></>}
                {sel.kind === 'ss' && <><span className="chip chip-soft">Substation</span><KV k="Voltage" v={sel.ratio} /><KV k="Capacity" v={sel.mva ? sel.mva + ' MVA' : '—'} /><KV k="Status" v={sel.status} /><KV k="Outgoing feeders" v={sel.feeders} /></>}
                {sel.kind === 'ptx' && <><span className="chip chip-soft">Power transformer</span><KV k="HV" v={sel.hv ? sel.hv + ' kV' : '—'} /><KV k="LV" v={sel.lv ? sel.lv + ' kV' : '—'} /><KV k="Capacity" v={sel.mva ? sel.mva + ' MVA' : '—'} /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'dt' && <><span className="chip chip-soft">Distribution transformer</span><KV k="Capacity" v={sel.kva ? sel.kva + ' kVA' : '—'} /><KV k="Feeder" v={sel.feeder} mono /><KV k="Substation code" v={sel.ss} mono /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'switch' && <><span className="chip chip-soft">Switch</span><KV k="Type" v={sel.type} /><KV k="Voltage" v={sel.kv ? sel.kv + ' kV' : '—'} /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'rmu' && <><span className="chip chip-soft">Ring main unit</span><KV k="ID" v={sel.id} mono /><KV k="Status" v={sel.status} /></>}
                {sel.kind === 'crew' && <><span className="chip chip-soft">Field crew</span><KV k="Lead" v={sel.lead} /><KV k="Status" v={sel.status ? sel.status.replace('_', ' ') : ''} /><KV k="Location" v={sel.location} /><KV k="Skills" v={sel.skills} /></>}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function KV({ k, v, mono }) { return <div className="kv-row"><span className="k">{k}</span><span className={`v ${mono ? 'mono' : ''}`}>{v || '—'}</span></div>; }
