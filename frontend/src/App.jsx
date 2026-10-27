import { useEffect, useState, useRef, Component } from 'react';
import { useTableGates } from './lib/tableGate.js';
import { motion, AnimatePresence } from 'motion/react';
import { socket } from './lib/api.js';
import { Icon, useConnection, useToasts, toast, hhmm } from './lib/ui.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Incidents from './screens/Incidents.jsx';
import NetworkMap from './screens/NetworkMap.jsx';
import Dispatch from './screens/Dispatch.jsx';
import Alarms from './screens/Alarms.jsx';
import TCS from './screens/TCS.jsx';
import Complaints from './screens/Complaints.jsx';
import Analytics from './screens/Analytics.jsx';
import Admin from './screens/Admin.jsx';
import PlannedOutages from './screens/PlannedOutages.jsx';
import WorkOrders from './screens/WorkOrders.jsx';
import { currentUser } from './lib/auth.js';
import { useT, t, setLang, LANGS } from './lib/i18n.js';
import IncidentSearch from './components/IncidentSearch.jsx';
import ProfileMenu from './components/ProfileMenu.jsx';
import AboutOverlay from './components/AboutOverlay.jsx';

// Isolates a screen crash so it shows an inline message instead of blanking the
// whole app. Resets when you navigate to another screen (keyed by `tab`).
class ScreenBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div className="screen-error">
          <h2>{t('app.errTitle')}</h2>
          <p>{t('app.errBody')}</p>
          <pre>{String(this.state.err.message || this.state.err)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// [id, label, icon, Screen, roles?]: with roles, only logins holding one of
// them see the entry (match the roles its API requires).
const NAV = [
  ['dashboard', 'Dashboard', 'dashboard', Dashboard],
  ['map', 'Network Map', 'map', NetworkMap],
  ['incidents', 'Incidents', 'bolt', Incidents],
  ['dispatch', 'Dispatch', 'users', Dispatch],
  ['planned', 'Planned outages', 'clock', PlannedOutages],
  ['workorders', 'Work orders', 'clipboard', WorkOrders, ['oms_operator', 'system_admin', 'field_crew_coordinator']],
  ['alarms', 'Alarms', 'bell', Alarms],
  ['tcs', 'TCS / IVR', 'phone', TCS],
  ['complaints', 'Complaints', 'inbox', Complaints],
  ['analytics', 'Analytics', 'chart', Analytics],
  ['admin', 'Admin', 'gear', Admin],
];

const TAPE_LABEL = {
  'oms.incident.created': ['NEW INCIDENT', 'crit'],
  'oms.incident.updated': ['INCIDENT', ''],
  'oms.permit.changed': ['PERMIT', ''],
  'oms.switching.confirmed': ['SWITCHING', 'ok'],
  'oms.switching.rejected': ['SWITCHING REJECTED', 'crit'],
  'oms.planned.crew_report': ['CREW REPORT', ''],
  'scada.alarm.raised': ['SCADA ALARM', 'crit'],
  'scada.alarm.acked': ['ALARM ACK', 'ok'],
  'tcs.call.received': ['TROUBLE CALL', ''],
  'crew.updated': ['CREW', ''],
  'crew.job.updated': ['JOB', 'ok'],
  'crew.tracking.changed': ['TRACKING', ''],
  'crew.location.stale': ['NO GPS', 'crit'],
  'oms.message.posted': ['MESSAGE', ''],
};

function LiveTape() {
  const { t } = useT();
  const [events, setEvents] = useState([]);
  useEffect(() => {
    const topics = Object.keys(TAPE_LABEL);
    const mk = (topic) => (p) => {
      const [, cls] = TAPE_LABEL[topic];
      let detail = '';
      if (topic.startsWith('oms.incident')) detail = `${p.id} . ${p.zone} . ${p.status}`;
      else if (topic === 'oms.permit.changed') detail = `${p.permit_no} . ${p.crew_id} . ${p.state}`;
      else if (topic === 'oms.switching.confirmed') detail = `${p.phase} ${p.seq} . ${p.device_label} . ${p.confirmed_by}`;
      else if (topic === 'oms.switching.rejected') detail = `${p.code}`;
      else if (topic === 'oms.planned.crew_report') detail = `${p.incidentId} . ${p.report?.crew_id} . ${p.report?.kind === 'delay' ? t('tape.delay') : t('tape.siteReport')}`;
      else if (topic.startsWith('scada')) detail = `${p.tag} . ${p.condition}`;
      else if (topic === 'tcs.call.received') detail = `${p.customer} . ${p.category}`;
      else if (topic === 'crew.updated') detail = `${p.name} . ${p.status}`;
      else if (topic === 'crew.job.updated') detail = `${p.id} . ${p.reassignRequest ? t('tape.reassign') : p.status}`;
      else if (topic === 'oms.message.posted') detail = `${p.sender_role === 'field_crew' ? t('tape.crewPrefix') : ''}${p.sender} . ${String(p.body || '').slice(0, 60)}`;
      else if (topic === 'crew.tracking.changed') detail = `${p.crewName} . ${p.state === 'on' ? t('tape.trackOn') : t('tape.trackOff')}`;
      else if (topic === 'crew.location.stale') detail = `${p.crewName} . ${p.stale ? t('tape.noPos', { n: p.minutes }) : t('tape.posResumed')}`;
      setEvents((e) => [{ id: Math.random(), topic, cls, detail, t: hhmm(new Date().toISOString()) }, ...e].slice(0, 14));
    };
    const hs = topics.map((t) => { const h = mk(t); socket.on(t, h); return [t, h]; });
    return () => hs.forEach(([t, h]) => socket.off(t, h));
  }, []);

  const feed = events.length ? events : [{ id: 0, topic: 'system', cls: 'ok', detail: t('app.feedIdle'), t: hhmm(new Date().toISOString()) }];
  const doubled = [...feed, ...feed];
  return (
    // Not a live region: the tape updates on every crew GPS ping, and announcing each one
    // drowns out everything else for screen-reader users (WCAG 2.2.2). It stays readable in
    // browse mode; the second copy only exists for the scrolling animation, so it is hidden.
    <section className="tape" aria-label={t('app.liveFeed')}>
      <div className="badge"><i />{t('app.live')}</div>
      <div className="track">
        {doubled.map((e, idx) => (
          <span className={`ev ${e.cls}`} key={e.id + '-' + idx} aria-hidden={idx >= feed.length || undefined}>
            <span className="t">{e.t}</span><b>{t(`tape.${e.topic}`)}</b> {e.detail}
          </span>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const { t, lang } = useT();
  const [tab, setTab] = useState('dashboard');
  // Choosing a screen in the rail moves focus to that screen, so the next Tab
  // reaches its first control instead of the header controls again (WCAG 2.4.1, 2.4.3).
  const mainRef = useRef(null);
  useTableGates(mainRef);
  const goTab = (id) => { setTab(id); requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true })); };
  // Esc inside a screen returns focus to that screen's button in the rail - unless Esc already
  // has a job there: closing a dialog/drawer, or leaving a field the user is typing in.
  const escToRail = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], [data-vaul-drawer]')) return;
    document.querySelector('nav.rail button[aria-current="true"]')?.focus();
  };
  const [focusIncidentId, setFocusIncidentId] = useState(null);
  const [showAbout, setShowAbout] = useState(false);
  const up = useConnection();
  const { items } = useToasts();
  // A crew on duty who can't be tracked is an operational risk: say so on
  // every screen, and keep it up long enough to be noticed.
  useEffect(() => {
    const onTracking = (p) => {
      if (p.alert) toast(t('tape.tToastOff', { name: p.crewName, id: p.crewId, reason: p.reasonText }), 'err', 20000);
      else if (p.state === 'on') toast(t('tape.tToastOn', { name: p.crewName, id: p.crewId }));
    };
    const onStale = (p) => {
      if (p.stale) toast(t('tape.tStale', { name: p.crewName, id: p.crewId, n: p.minutes }), 'err', 20000);
      else toast(t('tape.tResumed', { name: p.crewName, id: p.crewId }));
    };
    socket.on('crew.tracking.changed', onTracking);
    socket.on('crew.location.stale', onStale);
    return () => { socket.off('crew.tracking.changed', onTracking); socket.off('crew.location.stale', onStale); };
  }, []);
  const [clock, setClock] = useState('');
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, []);

  // Jump to the Incidents screen with a specific incident pre-selected -
  // used by the Alarms table so an operator can go straight from "this alarm
  // fired" to "here's the incident it created" in one click.
  const openIncident = (id) => { setFocusIncidentId(id); setTab('incidents'); };
  // Jump to the Network Map on a point (e.g. a crew's QR asset scan).
  const [mapFocus, setMapFocus] = useState(null);
  const showOnMap = (point) => { setMapFocus({ ...point, at: Date.now() }); setTab('map'); };

  // Crew messages and reassignment requests must be seen on every screen.
  useEffect(() => {
    const onMessage = (m) => { if (m?.sender_role === 'field_crew') toast(t('tape.tMsg', { crew: m.crew_id || m.sender, job: m.job_id ? ` (${m.job_id})` : '', body: m.body }), 'err', 15000); };
    const onJob = (j) => { if (j?.reassignRequest) toast(t('tape.tReassign', { crew: j.reassignRequest.crew_id, id: j.id, reason: j.reassignRequest.reason }), 'err', 20000); };
    socket.on('oms.message.posted', onMessage);
    socket.on('crew.job.updated', onJob);
    return () => { socket.off('oms.message.posted', onMessage); socket.off('crew.job.updated', onJob); };
  }, []);

  // OMS-01: switching attempted out of order, or a permit waiting for the
  // control room, must be seen on every screen.
  useEffect(() => {
    const onRejected = (p) => toast(t('tape.tRejected', { code: p.code, msg: p.message }), 'err', 20000);
    const onPermit = (p) => { if (p.state === 'requested') toast(t('tape.tPermit', { no: p.permit_no, crew: p.crew_id }), 'err', 20000); };
    // A crew delay report waits for the control room to apply or dismiss it.
    const onCrewReport = (p) => (p.report?.kind === 'delay'
      ? toast(t('tape.tDelay', { crew: p.report.crew_id, id: p.incidentId, zone: p.zone }), 'err', 20000)
      : toast(t('tape.tSite', { crew: p.report?.crew_id, id: p.incidentId, note: p.report?.note || '' })));
    socket.on('oms.switching.rejected', onRejected);
    socket.on('oms.permit.changed', onPermit);
    socket.on('oms.planned.crew_report', onCrewReport);
    return () => { socket.off('oms.switching.rejected', onRejected); socket.off('oms.permit.changed', onPermit); socket.off('oms.planned.crew_report', onCrewReport); };
  }, []);

  const roles = currentUser().roles;
  const nav = NAV.filter((n) => !n[4] || n[4].some((r) => roles.includes(r)));
  const active = nav.find((n) => n[0] === tab) || nav[0];
  const Screen = active[3];
  const navLabel = (id) => t(`nav.${id}`);

  const header = (
        <header className="cmd">
          <div>
            <h1>{navLabel(active[0])}</h1>
            <div className="sub">{t('app.subtitle')}</div>
          </div>
          <div className="grow" />
          <div className="conn" title={up ? t('app.connTitleUp') : t('app.connTitleDown')}>
            <span className={`dot ${up ? 'up' : 'down'}`} />
            {up ? t('app.connLive') : t('app.reconnecting')}
          </div>
          <div className="clock mono">{clock}</div>
             <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 12 }}>
               <div style={{ marginLeft: 12, width: 260, position: 'relative', display: 'flex', alignItems: 'center' }}>
                 <IncidentSearch onOpen={(inc) => openIncident(inc.id)} />
               </div>
               {/* P8.7c: UI language; also sets <html lang> for screen readers. */}
               <select className="lang-select" value={lang} onChange={(e) => setLang(e.target.value)} aria-label={`${t('app.language')} / Language`}>
                 {LANGS.map(([k, l]) => <option key={k} value={k} lang={k}>{l}</option>)}
               </select>
               <ProfileMenu />
             </div>
           </header>
  );
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>{t('app.skip')}</a>
      <nav className="rail" aria-label={t('app.primaryNav')}>
        <div className="brand" title="GridQ"><img src="/gridq-mark.png" alt="GridQ" className="brand-img" /></div>
        {nav.map(([id, , icon]) => (
          <button key={id} className={`navbtn ${tab === id ? 'on' : ''}`}
            onClick={() => goTab(id)} aria-current={tab === id} aria-label={navLabel(id)}>
            <Icon name={icon} />
            <span className="tip">{navLabel(id)}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="brand brand-btn" title={t('app.about')} aria-label={t('app.about')} onClick={() => setShowAbout(true)}>
          <img src="/spintech-logo.png" alt="Sharika SpinTech" className="brand-img" />
        </button>
      </nav>

      <div className="main">
        <div className="masthead">
          <div className="masthead-brand">
            <div className="masthead-text">
              <div className="masthead-word">GridQ</div>
              {/* Real tagline - update here if it changes */}
              <div className="masthead-tag">Predict. Prevent. Power.</div>
            </div>
          </div>
          <div className="grow" />
          <div className="masthead-brand masthead-brand-right">
            <div className="masthead-text masthead-text-right">
              <div className="masthead-tag">{t('app.upcl')}</div>
            </div>
            <img src="/upcl-logo.png" alt="UPCL" className="masthead-logo" />
          </div>
        </div>

        {/* Header controls (search, clock, link status, profile) come right after the rail only on the
            Dashboard. On other screens they are rendered after <main> - CSS order keeps them on top -
            so Tab goes rail -> screen content, and the header is still reachable at the end (WCAG 2.4.3). */}
        {tab === 'dashboard' && header}

        <LiveTape />

        {/* onKeyDown handles Esc bubbling up from the screen's own controls (see escToRail). */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <main className="content" id="main-content" ref={mainRef} tabIndex={-1} aria-label={navLabel(active[0])} onKeyDown={escToRail}>
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
            >
              <ScreenBoundary key={tab}>
                <Screen go={setTab} openIncident={openIncident} focusIncidentId={tab === 'incidents' ? focusIncidentId : null} clearFocus={() => setFocusIncidentId(null)}
                  showOnMap={showOnMap} mapFocus={tab === 'map' ? mapFocus : null} clearMapFocus={() => setMapFocus(null)} />
              </ScreenBoundary>
            </motion.div>
          </AnimatePresence>
        </main>
        {tab !== 'dashboard' && header}

        <div className="powered-by">
          <img src="/spintech-logo.png" alt="" />
          {t('app.poweredBy')}
        </div>
      </div>

      <div className="toast-wrap" role="status" aria-live="polite" aria-atomic="true">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`} role={t.kind === 'err' ? 'alert' : undefined}>
            <Icon name={t.kind === 'err' ? 'x' : 'check'} size={16} />{t.msg}
          </div>
        ))}
      </div>

      {showAbout && <AboutOverlay onClose={() => setShowAbout(false)} />}
    </div>
  );
}