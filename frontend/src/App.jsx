import { useEffect, useState, useRef, Component } from 'react';
import { socket } from './lib/api.js';
import { Icon, useConnection, useToasts, hhmm } from './lib/ui.jsx';
import { currentUser, logout } from './lib/auth.js';
import Dashboard from './screens/Dashboard.jsx';
import Incidents from './screens/Incidents.jsx';
import NetworkMap from './screens/NetworkMap.jsx';
import Dispatch from './screens/Dispatch.jsx';
import Alarms from './screens/Alarms.jsx';
import TCS from './screens/TCS.jsx';
import Complaints from './screens/Complaints.jsx';
import Analytics from './screens/Analytics.jsx';
import Admin from './screens/Admin.jsx';
import LandingPage from './components/LandingPage.jsx';
import ProfileMenu from './components/ProfileMenu.jsx';
import { motion, AnimatePresence } from 'motion/react';
import IncidentSearch from './components/IncidentSearch.jsx';

class ScreenBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div className="screen-error">
          <h2>This screen hit an error</h2>
          <p>The rest of the app is still working - pick another tab, or reload.</p>
          <pre>{String(this.state.err.message || this.state.err)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard', Dashboard],
  ['map', 'Network Map', 'map', NetworkMap],
  ['incidents', 'Incidents', 'bolt', Incidents],
  ['dispatch', 'Dispatch', 'users', Dispatch],
  ['alarms', 'Alarms', 'bell', Alarms],
  ['tcs', 'TCS / IVR', 'phone', TCS],
  ['complaints', 'Complaints', 'inbox', Complaints],
  ['analytics', 'Analytics', 'chart', Analytics],
  ['admin', 'Admin', 'gear', Admin],
];

const TAPE_LABEL = {
  'oms.incident.created': ['NEW INCIDENT', 'crit'],
  'oms.incident.updated': ['INCIDENT', ''],
  'scada.alarm.raised': ['SCADA ALARM', 'crit'],
  'scada.alarm.acked': ['ALARM ACK', 'ok'],
  'tcs.call.received': ['TROUBLE CALL', ''],
  'crew.updated': ['CREW', ''],
  'crew.job.updated': ['JOB', 'ok'],
};

function LiveTape() {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    const topics = Object.keys(TAPE_LABEL);
    const mk = (topic) => (p) => {
      const [label, cls] = TAPE_LABEL[topic];
      let detail = '';
      if (topic.startsWith('oms.incident')) detail = `${p.id} . ${p.zone} . ${p.status}`;
      else if (topic.startsWith('scada')) detail = `${p.tag} . ${p.condition}`;
      else if (topic === 'tcs.call.received') detail = `${p.customer} . ${p.category}`;
      else if (topic === 'crew.updated') detail = `${p.name} . ${p.status}`;
      else if (topic === 'crew.job.updated') detail = `${p.id} . ${p.status}`;
      setEvents((e) => [{ id: Math.random(), label, cls, detail, t: hhmm(new Date().toISOString()) }, ...e].slice(0, 14));
    };
    const hs = topics.map((t) => { const h = mk(t); socket.on(t, h); return [t, h]; });
    return () => hs.forEach(([t, h]) => socket.off(t, h));
  }, []);

  const feed = events.length ? events : [{ id: 0, label: 'SYSTEM', cls: 'ok', detail: 'Field telemetry stream connected - awaiting events', t: hhmm(new Date().toISOString()) }];
  const doubled = [...feed, ...feed];
  return (
    <div className="tape" role="status" aria-label="Live event feed">
      <div className="badge"><i />Live</div>
      <div className="track">
        {doubled.map((e, idx) => (
          <span className={`ev ${e.cls}`} key={e.id + '-' + idx}>
            <span className="t">{e.t}</span><b>{e.label}</b> {e.detail}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [openIncidentId, setOpenIncidentId] = useState(null);
  const [entered, setEntered] = useState(false);
  const [dashFading, setDashFading] = useState(true);
  const [focusIncidentId, setFocusIncidentId] = useState(null);
  useEffect(() => {
    if (entered) {
      const t = setTimeout(() => setDashFading(false), 20);
      return () => clearTimeout(t);
    }
  }, [entered]);
  const up = useConnection();
  const { items } = useToasts();
  const [clock, setClock] = useState('');
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, []);

  // Jump to the Incidents screen with a specific incident pre-selected -
  // used by the Alarms table so an operator can go straight from "this alarm
  // fired" to "here's the incident it created" in one click.
  const openIncident = (id) => {
    setFocusIncidentId(id);
    setOpenIncidentId(id);
    setTab('incidents');
  };
  const goToIncident = openIncident;

  const active = NAV.find((n) => n[0] === tab);
  const Screen = active[3];

  

  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        <div className="brand" title="GridQ">
          <svg width="24" height="24" viewBox="0 0 120 120" fill="none">
            <circle cx="60" cy="60" r="40" fill="none" stroke="#fff" strokeWidth="9" />
            <path d="M64 82 L48 100 L60 100 L52 122 L78 92 L64 92 Z" fill="#fff" />
          </svg>
        </div>
        {NAV.map(([id, label, icon]) => (
          <button key={id} className={`navbtn ${tab === id ? 'on' : ''}`}
            onClick={() => setTab(id)} aria-current={tab === id} aria-label={label}>
            <Icon name={icon} />
            <span className="tip">{label}</span>
          </button>
        ))}
        <div className="spacer" />
      </nav>

      <div className="main">
        <header className="cmd">
          <div>
            <h1>{active[1]}</h1>
            <div className="sub">Uttarakhand Power Corp . Ganga Corridor Control Centre</div>
          </div>
          <div className="grow" />
          <div className="conn" title={up ? 'Live link to control-room backend' : 'Reconnecting...'}>
            <span className={`dot ${up ? 'up' : 'down'}`} />
            {up ? 'SCADA link live' : 'Reconnecting'}
          </div>
          <div className="clock mono">{clock}</div>
          <div style={{ marginLeft: 12, width: 260, position: 'relative', display: 'flex', alignItems: 'center' }}>
            <IncidentSearch onOpen={(inc) => goToIncident(inc.id)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 12 }}>
            <ProfileMenu />
          </div>
        </header>

        <LiveTape />

        <div className="content">
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
            >
              <ScreenBoundary key={tab}>
                <Screen
                  go={setTab}
                  openId={tab === 'incidents' ? openIncidentId : undefined}
                  openIncident={openIncident}
                  focusIncidentId={tab === 'incidents' ? focusIncidentId : null}
                  clearFocus={() => setFocusIncidentId(null)}
                />
              </ScreenBoundary>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`}>
            <Icon name={t.kind === 'err' ? 'x' : 'check'} size={16} />{t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}