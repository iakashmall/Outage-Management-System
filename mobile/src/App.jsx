import { useEffect, useState, useCallback, useRef } from 'react';

/* ============================== data + helpers ============================== */
const CREWS = [
  { id: 'C001', name: 'Crew Alpha-3', lead: 'Rajesh Kumar', role: 'Crew Lead', shift: '06:00–18:00', skills: ['HV', 'Underground'] },
  { id: 'C002', name: 'Crew Beta-1', lead: 'Amit Sharma', role: 'Field Technician', shift: '06:00–18:00', skills: ['MV', 'Recloser'] },
  { id: 'C003', name: 'Crew Gamma-2', lead: 'Priya Singh', role: 'Field Technician', shift: '06:00–18:00', skills: ['HV', 'Transformer'] },
  { id: 'C004', name: 'Crew Delta-4', lead: 'Suresh Patel', role: 'Crew Lead', shift: '18:00–06:00', skills: ['MV', 'Fuse'] },
  { id: 'C005', name: 'Crew Echo-1', lead: 'Meena Rao', role: 'Field Technician', shift: '18:00–06:00', skills: ['MV', 'LV'] },
];

const FLOW = ['Acknowledged', 'En Route', 'On Site', 'Work Started', 'Work Complete'];
const nextStatus = (s) => { const i = FLOW.indexOf(s); return i >= 0 && i < FLOW.length - 1 ? FLOW[i + 1] : null; };
const SEV = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };
const QKEY = 'oms.crew.queue.v2';
const PKEY = 'oms.crew.photos.v2';

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const loadQ = () => { try { return JSON.parse(localStorage.getItem(QKEY)) || []; } catch { return []; } };
const saveQ = (q) => localStorage.setItem(QKEY, JSON.stringify(q));

const toRad = (d) => (d * Math.PI) / 180;
const haversine = (a, b, c, d) => {
  if ([a, b, c, d].some((x) => x == null)) return null;
  const R = 6371, dLat = toRad(c - a), dLon = toRad(d - b);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
};
const etaMin = (km) => (km == null ? null : Math.max(1, Math.round((km / 32) * 60)));
const fmtKm = (km) => (km == null ? '—' : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
const timeAgo = (iso) => {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const hhmm = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '—');

const getGps = () => new Promise((res) => {
  if (!navigator.geolocation) return res({ lat: null, lon: null });
  navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5) }),
    () => res({ lat: 30.316, lon: 78.032 }),
    { timeout: 4000 }
  );
});

/* corridor bounds for the mini-map */
const BOX = { minLat: 29.86, maxLat: 30.36, minLon: 77.95, maxLon: 78.34 };
const project = (lat, lon, w, h) => ({
  x: ((lon - BOX.minLon) / (BOX.maxLon - BOX.minLon)) * w,
  y: (1 - (lat - BOX.minLat) / (BOX.maxLat - BOX.minLat)) * h,
});

/* ============================== root ============================== */
export default function App() {
  const [crew, setCrew] = useState(null);
  const [crewLoc, setCrewLoc] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [tab, setTab] = useState('jobs');
  const [openId, setOpenId] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState(loadQ());
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef();

  const toast = (m) => { setFlash(m); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(null), 2400); };

  const fetchJobs = useCallback(async (id) => {
    try {
      const [jr, cr] = await Promise.all([fetch(`/api/mobile/crews/${id}/jobs`), fetch(`/api/mobile/crews/${id}`)]);
      setJobs(await jr.json());
      const c = await cr.json();
      if (c && c.lat != null) setCrewLoc({ lat: c.lat, lon: c.lon });
      setOnline(true);
    } catch { setOnline(false); }
  }, []);

  useEffect(() => { if (crew) fetchJobs(crew.id); }, [crew, fetchJobs]);

  const drain = useCallback(async () => {
    const q = loadQ();
    if (!q.length) return;
    const still = [];
    for (const item of q) {
      try {
        const r = await fetch(`/api/mobile/jobs/${item.jobId}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body),
        });
        if (!r.ok) throw new Error();
      } catch { still.push(item); }
    }
    saveQ(still); setQueue(still);
    if (q.length && !still.length) { toast(`Synced ${q.length} update${q.length > 1 ? 's' : ''}`); if (crew) fetchJobs(crew.id); }
  }, [crew, fetchJobs]);

  useEffect(() => {
    const on = () => { setOnline(true); drain(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const t = setInterval(() => { if (navigator.onLine && loadQ().length) drain(); }, 6000);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(t); };
  }, [drain]);

  // send a status/note update; queue if offline
  const sendUpdate = useCallback(async (jobId, patch, optimistic) => {
    const gps = await getGps();
    const body = { lat: gps.lat, lon: gps.lon, ...patch };
    if (optimistic && patch.status) {
      setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, status: patch.status } : j)));
    }
    try {
      const r = await fetch(`/api/mobile/jobs/${jobId}/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error();
      if (crew) fetchJobs(crew.id);
      return true;
    } catch {
      const q = [...loadQ(), { jobId, body, at: Date.now() }];
      saveQ(q); setQueue(q); setOnline(false);
      return false;
    }
  }, [crew, fetchJobs]);

  if (!crew) return <Login onPick={setCrew} />;

  const openJob = jobs.find((j) => j.id === openId) || null;
  const withDist = jobs.map((j) => {
    const inc = j.incident || {};
    const km = crewLoc ? haversine(crewLoc.lat, crewLoc.lon, inc.lat, inc.lon) : null;
    return { ...j, _km: km, _eta: etaMin(km) };
  });

  return (
    <div className="phone">
      <Header crew={crew} online={online} pending={queue.length} />
      {!online && (
        <div className="offline-banner">
          <span className="wifi-off" /> Offline{queue.length ? ` · ${queue.length} update${queue.length > 1 ? 's' : ''} queued` : ''}
        </div>
      )}

      <div className="scroll">
        {tab === 'jobs' && <JobsTab jobs={withDist} onOpen={setOpenId} />}
        {tab === 'map' && <MapTab jobs={withDist} crewLoc={crewLoc} onOpen={setOpenId} />}
        {tab === 'team' && <TeamTab crew={crew} />}
        {tab === 'me' && <MeTab crew={crew} crewLoc={crewLoc} online={online} queue={queue} onSignOut={() => { setCrew(null); setJobs([]); setTab('jobs'); }} />}
      </div>

      <BottomNav tab={tab} setTab={setTab} isLead={crew.role === 'Crew Lead'} jobCount={jobs.length} />

      {openJob && (
        <JobDetail
          job={withDist.find((j) => j.id === openId)}
          crewLoc={crewLoc}
          online={online}
          onClose={() => setOpenId(null)}
          onSend={sendUpdate}
          toast={toast}
        />
      )}
      {flash && <div className="flash">{flash}</div>}
    </div>
  );
}

/* ============================== login ============================== */
function Login({ onPick }) {
  return (
    <div className="phone">
      <div className="login">
        <div className="login-top">
          <div className="brand"><span className="spark" /> OMS <b>Crew</b></div>
          <p className="sub">Ganga Corridor · UPCL Field Operations</p>
        </div>
        <div className="pick">
          <div className="pick-h">Sign in to your unit</div>
          {CREWS.map((c) => (
            <button key={c.id} className="crew-btn" onClick={() => onPick(c)}>
              <span className="ava">{c.name.split(' ')[1]?.[0] || c.name[0]}</span>
              <span className="cb-txt">
                <b>{c.name}</b>
                <small>{c.lead} · {c.role}</small>
              </span>
              <span className="bio" title="Biometric sign-in">⊚</span>
            </button>
          ))}
        </div>
        <div className="login-foot">
          <span className="lock">🔒</span> Biometric &amp; offline session · encrypted token storage
        </div>
      </div>
    </div>
  );
}

/* ============================== header + nav ============================== */
function Header({ crew, online, pending }) {
  return (
    <div className="hdr">
      <div className="hdr-l">
        <span className="ava sm">{crew.name.split(' ')[1]?.[0]}</span>
        <div className="hdr-id">
          <b>{crew.name}</b>
          <small>{crew.role} · shift {crew.shift}</small>
        </div>
      </div>
      <div className={`net-pill ${online ? 'up' : 'down'}`}>
        <span className="net-dot" />{online ? 'Online' : 'Offline'}{pending ? ` · ${pending}` : ''}
      </div>
    </div>
  );
}

function BottomNav({ tab, setTab, isLead, jobCount }) {
  const items = [
    ['jobs', 'Jobs', 'M4 6h16M4 12h16M4 18h10'],
    ['map', 'Map', 'M9 3 4 5v16l5-2 6 2 5-2V3l-5 2-6-2Z'],
    ...(isLead ? [['team', 'Team', 'M17 20v-2a4 4 0 0 0-3-3.87M9 20v-2a4 4 0 0 1 3-3.87M12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z']] : []),
    ['me', 'Me', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0'],
  ];
  return (
    <nav className="botnav">
      {items.map(([id, label, d]) => (
        <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
          <svg viewBox="0 0 24 24" width="22" height="22"><path d={d} /></svg>
          <span>{label}</span>
          {id === 'jobs' && jobCount > 0 && <em>{jobCount}</em>}
        </button>
      ))}
    </nav>
  );
}

/* ============================== jobs tab ============================== */
function JobsTab({ jobs, onOpen }) {
  const sorted = [...jobs].sort((a, b) => {
    const p = { Urgent: 0, Normal: 1, Planned: 2 };
    return (p[a.priority] ?? 1) - (p[b.priority] ?? 1) || (a._km ?? 99) - (b._km ?? 99);
  });
  const urgent = jobs.filter((j) => j.priority === 'Urgent').length;
  const done = jobs.filter((j) => j.status === 'Work Complete').length;

  return (
    <>
      <div className="tab-head">
        <h1>My jobs</h1>
        <p>{jobs.length} assigned · {urgent} urgent · {done} complete</p>
      </div>
      {sorted.length === 0 && <div className="none"><span className="none-ico">✓</span>No jobs assigned. You’re all clear.</div>}
      <div className="job-list">
        {sorted.map((j) => {
          const inc = j.incident || {};
          const done = j.status === 'Work Complete';
          return (
            <button key={j.id} className={`job-card ${done ? 'is-done' : ''}`} onClick={() => onOpen(j.id)}>
              <span className={`sev-bar sev-${SEV[inc.severity] || 'med'}`} />
              <div className="jc-body">
                <div className="jc-row1">
                  <span className={`chip sev-${SEV[inc.severity] || 'med'}`}>{inc.severity || '—'}</span>
                  {j.priority === 'Urgent' && <span className="chip urgent">Urgent</span>}
                  <span className="jc-status">{j.status}</span>
                </div>
                <div className="jc-addr">{j.address}</div>
                <div className="jc-sub"><span className="mono">{inc.feeder || ''}</span>{inc.cause ? ` · ${inc.cause}` : ''}</div>
                <div className="jc-foot">
                  <span>📍 {fmtKm(j._km)}</span>
                  <span>⏱ {j._eta != null ? `${j._eta} min` : '—'}</span>
                  <span>👥 {(inc.customers || 0).toLocaleString()}</span>
                </div>
              </div>
              <span className="chev">›</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/* ============================== map tab ============================== */
function MapTab({ jobs, crewLoc, onOpen }) {
  const W = 360, H = 300;
  return (
    <>
      <div className="tab-head"><h1>Job map</h1><p>Your position and assigned sites across the corridor</p></div>
      <div className="map-card">
        <svg viewBox={`0 0 ${W} ${H}`} className="mini-map">
          <rect x="0" y="0" width={W} height={H} className="map-bg" rx="14" />
          {/* river line for context */}
          <path d="M20 40 C120 90, 90 160, 200 200 S320 250, 340 280" className="map-river" />
          {jobs.map((j) => {
            const inc = j.incident || {};
            if (inc.lat == null) return null;
            const { x, y } = project(inc.lat, inc.lon, W, H);
            return (
              <g key={j.id} className="map-job" onClick={() => onOpen(j.id)} style={{ cursor: 'pointer' }}>
                <circle cx={x} cy={y} r="10" className={`mj sev-${SEV[inc.severity] || 'med'}`} />
                <circle cx={x} cy={y} r="4" className="mj-core" />
              </g>
            );
          })}
          {crewLoc && (() => { const { x, y } = project(crewLoc.lat, crewLoc.lon, W, H); return (
            <g className="map-me"><circle cx={x} cy={y} r="14" className="me-halo" /><circle cx={x} cy={y} r="6" className="me-dot" /></g>
          ); })()}
        </svg>
        <div className="map-legend">
          <span><i className="lg me" /> You</span>
          <span><i className="lg sev-crit" /> Critical</span>
          <span><i className="lg sev-high" /> High</span>
          <span><i className="lg sev-med" /> Medium</span>
        </div>
      </div>
      <div className="map-hint">Tap a site marker to open the job.</div>
    </>
  );
}

/* ============================== team tab (crew lead) ============================== */
function TeamTab({ crew }) {
  const [crews, setCrews] = useState([]);
  const [inc, setInc] = useState([]);
  useEffect(() => {
    fetch('/api/crews').then((r) => r.json()).then(setCrews).catch(() => {});
    fetch('/api/incidents').then((r) => r.json()).then(setInc).catch(() => {});
  }, []);
  const statusLabel = { available: 'Available', in_transit: 'En route', in_service: 'On site', off_shift: 'Off shift' };
  return (
    <>
      <div className="tab-head"><h1>Team overview</h1><p>Live status across field units — {crew.lead}, lead</p></div>
      <div className="team-list">
        {crews.map((c) => {
          const active = inc.find((i) => i.crew_id === c.id && !['resolved', 'closed'].includes(i.status));
          return (
            <div key={c.id} className="team-card">
              <span className={`ava sm st-${c.status}`}>{c.name.split(' ')[1]?.[0] || c.name[0]}</span>
              <div className="tc-body">
                <b>{c.name}</b>
                <small>{c.lead} · {(c.skills || []).join(', ')}</small>
                {active && <div className="tc-job">▸ {active.zone} · {active.severity}</div>}
              </div>
              <span className={`tc-status s-${c.status}`}>{statusLabel[c.status] || c.status}</span>
            </div>
          );
        })}
        {!crews.length && <div className="none">Loading team…</div>}
      </div>
    </>
  );
}

/* ============================== me tab ============================== */
function MeTab({ crew, crewLoc, online, queue, onSignOut }) {
  return (
    <>
      <div className="tab-head"><h1>Profile</h1><p>Session, sync and account</p></div>
      <div className="profile-card">
        <span className="ava lg">{crew.name.split(' ')[1]?.[0]}</span>
        <div><b>{crew.name}</b><small>{crew.lead}</small></div>
      </div>
      <div className="info-grid">
        <div><small>Role</small>{crew.role}</div>
        <div><small>Shift</small>{crew.shift}</div>
        <div><small>Skills</small>{(crew.skills || []).join(', ')}</div>
        <div><small>Position</small>{crewLoc ? `${crewLoc.lat}, ${crewLoc.lon}` : '—'}</div>
      </div>
      <div className="sync-card">
        <div className="sync-h">Sync status</div>
        <div className="sync-row"><span className={`net-dot ${online ? 'up' : 'down'}`} /> {online ? 'Connected' : 'Offline'}</div>
        <div className="sync-row">{queue.length ? `${queue.length} update(s) waiting to sync` : 'All updates synced'}</div>
      </div>
      <div className="settings">
        {['Push notifications', 'Biometric unlock', 'Offline maps'].map((s, i) => (
          <label key={s} className="set-row"><span>{s}</span><span className={`toggle ${i < 2 ? 'on' : ''}`}><span /></span></label>
        ))}
      </div>
      <button className="signout" onClick={onSignOut}>Sign out</button>
      <div className="ver">OMS Crew · v1.0 · UPCL Ganga Corridor</div>
    </>
  );
}

/* ============================== job detail ============================== */
function JobDetail({ job, crewLoc, online, onClose, onSend, toast }) {
  const inc = job.incident || {};
  const [status, setStatus] = useState(job.status);
  const [history, setHistory] = useState([]);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState((load(PKEY)[job.id]) || []);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    fetch(`/api/mobile/jobs/${job.id}/history`).then((r) => r.json()).then(setHistory).catch(() => {});
  }, [job.id, status]);

  const km = job._km, eta = job._eta;
  const accepted = status !== 'Acknowledged' || history.some((h) => h.status === 'Acknowledged');
  const ns = nextStatus(status);

  const advance = async (target) => {
    setBusy(true);
    const t = target || ns;
    const ok = await onSend(job.id, { status: t, note: note || null }, true);
    setStatus(t); setNote('');
    toast(ok ? `${t} · GPS logged` : `Offline — “${t}” queued`);
    setBusy(false);
  };
  const doReject = async (reason) => {
    setRejecting(false); setBusy(true);
    const ok = await onSend(job.id, { status: 'Rejected', note: reason }, true);
    setStatus('Rejected');
    toast(ok ? 'Job rejected — dispatcher notified' : 'Offline — rejection queued');
    setBusy(false);
  };
  const saveNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    const ok = await onSend(job.id, { status, note: note.trim() }, false);
    toast(ok ? 'Note saved' : 'Offline — note queued'); setNote(''); setBusy(false);
  };
  const addPhoto = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const next = [...photos, rd.result];
      setPhotos(next);
      const all = load(PKEY); all[job.id] = next; save(PKEY, all);
      toast('Photo attached (stored on device)');
    };
    rd.readAsDataURL(f);
  };
  const mapsUrl = inc.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${inc.lat},${inc.lon}` : null;

  return (
    <div className="sheet-wrap" role="dialog" aria-label={`Job ${job.id}`}>
      <div className="sheet-mask" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-bar">
          <button className="back" onClick={onClose}>‹ Back</button>
          <span className="sheet-id">{job.id}</span>
          <span className={`net-dot ${online ? 'up' : 'down'}`} />
        </div>
        <div className="sheet-scroll">
          <div className="jd-hero">
            <span className={`chip sev-${SEV[inc.severity] || 'med'}`}>{inc.severity || '—'}</span>
            <span className={`chip ${job.priority === 'Urgent' ? 'urgent' : 'soft'}`}>{job.priority}</span>
            <span className="chip soft">{status}</span>
          </div>
          <h2 className="jd-addr">{job.address}</h2>

          <div className="jd-actions">
            {mapsUrl && <a className="act-btn" href={mapsUrl} target="_blank" rel="noreferrer"><b>🧭</b>Navigate</a>}
            <a className="act-btn" href="tel:112"><b>📞</b>Call in</a>
          </div>

          <div className="jd-meta">
            <div><small>Zone</small>{inc.zone || '—'}</div>
            <div><small>Feeder</small><span className="mono">{inc.feeder || '—'}</span></div>
            <div><small>Distance</small>{fmtKm(km)}</div>
            <div><small>ETA</small>{eta != null ? `${eta} min` : '—'}</div>
            <div><small>Cause</small>{inc.cause || '—'}</div>
            <div><small>Affected</small>{(inc.customers || 0).toLocaleString()}</div>
          </div>

          {status === 'Acknowledged' && !accepted && (
            <div className="accept-row">
              <button className="cta" disabled={busy} onClick={() => advance('En Route')}>Accept &amp; start</button>
              <button className="cta danger-ghost" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
            </div>
          )}

          <div className="stepper">
            {FLOW.map((s) => {
              const done = FLOW.indexOf(s) <= FLOW.indexOf(status);
              const at = history.find((h) => h.status === s);
              return (
                <div key={s} className={`step ${done ? 'done' : ''} ${s === status ? 'cur' : ''}`}>
                  <span className="node" />
                  <div className="step-txt"><b>{s}</b>{at && <small>{hhmm(at.ts)}</small>}</div>
                </div>
              );
            })}
          </div>

          {ns && status !== 'Rejected' && (accepted || status !== 'Acknowledged') && (
            <button className="cta" disabled={busy} onClick={() => advance()}>Mark “{ns}”</button>
          )}
          {status === 'Work Complete' && (
            <button className="cta ghost" disabled={busy} onClick={() => advance('Requires Review')}>Flag for review</button>
          )}
          {(status === 'Work Complete' || status === 'Requires Review') && (
            <div className="done-note">✓ {status === 'Requires Review' ? 'Flagged for control-room review' : 'Work complete — awaiting verification'}</div>
          )}

          <div className="jd-sec">Notes</div>
          <textarea className="note-in" rows="3" placeholder="Add a field note (syncs when online)…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn-slim" disabled={busy || !note.trim()} onClick={saveNote}>Save note</button>

          <div className="jd-sec">Photos <small>{photos.length}</small></div>
          <div className="photo-grid">
            {photos.map((p, i) => <img key={i} src={p} alt={`site ${i + 1}`} />)}
            <button className="photo-add" onClick={() => fileRef.current?.click()}>＋</button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={addPhoto} />
          </div>

          {history.length > 0 && (
            <>
              <div className="jd-sec">Activity</div>
              <ul className="hist">
                {history.map((h) => (
                  <li key={h.id}><span className="hist-dot" /><div><b>{h.status}</b>{h.note ? ` — ${h.note}` : ''}<small>{hhmm(h.ts)}{h.lat ? ` · ${h.lat}, ${h.lon}` : ''}</small></div></li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {rejecting && <RejectModal onCancel={() => setRejecting(false)} onConfirm={doReject} />}
    </div>
  );
}

function RejectModal({ onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  const reasons = ['Wrong skill set', 'Already on urgent job', 'Access blocked', 'Equipment unavailable'];
  return (
    <div className="modal-wrap">
      <div className="modal-mask" onClick={onCancel} />
      <div className="modal">
        <div className="modal-h">Reject job</div>
        <p className="modal-p">A reason is required (FR-APP-006). Your dispatcher is notified.</p>
        <div className="reason-chips">
          {reasons.map((r) => <button key={r} className={reason === r ? 'on' : ''} onClick={() => setReason(r)}>{r}</button>)}
        </div>
        <textarea className="note-in" rows="2" placeholder="Add detail (optional)…" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="modal-actions">
          <button className="btn-slim ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-slim danger" disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}>Confirm reject</button>
        </div>
      </div>
    </div>
  );
}
