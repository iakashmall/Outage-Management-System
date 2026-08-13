import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, timeAgo, useConnection, useLiveRefresh } from '../lib/ui.jsx';

const USERS = [
  { name: 'A. Kulkarni', role: 'Control Room Operator', zone: 'Dehradun', active: true },
  { name: 'R. Bhatt', role: 'Dispatcher', zone: 'Ganga Corridor', active: true },
  { name: 'S. Nair', role: 'Supervisor', zone: 'All zones', active: true },
  { name: 'M. Verma', role: 'Crew Lead', zone: 'Haridwar', active: true },
  { name: 'P. Rana', role: 'Field Technician', zone: 'Rishikesh', active: false },
  { name: 'admin', role: 'System Administrator', zone: '—', active: true },
];

const ROLE_PERMS = {
  'Control Room Operator': ['view incidents', 'create incidents', 'ack alarms'],
  Dispatcher: ['assign crews', 'merge duplicates', 'set priority'],
  Supervisor: ['view analytics', 'override SLA', 'approve close'],
  'Crew Lead': ['team jobs', 'reassign field', 'confirm restore'],
  'Field Technician': ['own jobs', 'update status', 'capture notes'],
  'System Administrator': ['manage users', 'system config', 'audit access'],
};

const SERVICES = [
  { name: 'API Gateway (Kong)', key: 'gw' },
  { name: 'Event Bus (Kafka-shaped)', key: 'bus' },
  { name: 'Incident DB (PostgreSQL)', key: 'db' },
  { name: 'Telemetry (TimescaleDB)', key: 'ts' },
  { name: 'Cache (Redis)', key: 'cache' },
  { name: 'Identity (Keycloak)', key: 'idp' },
];

export default function Admin() {
  const [audit, setAudit] = useState([]);
  const online = useConnection();

  const load = () => api.audit().then(setAudit);
  useEffect(() => { load(); }, []);
  useLiveRefresh(['oms.incident.created', 'oms.incident.updated', 'scada.alarm.acked', 'crew.job.updated'], load);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Administration</div>
          <h2>System &amp; access</h2>
          <p>Role-based access control, service health and the immutable audit trail (FR-OMS-007).</p>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.3fr 1fr' }}>
        <div className="card">
          <div className="card-h"><h3>Users &amp; roles</h3><span className="eyebrow">{USERS.filter((u) => u.active).length} active</span></div>
          <div className="card-b" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>User</th><th>Role</th><th>Zone</th><th>Permissions</th><th></th></tr></thead>
              <tbody>
                {USERS.map((u) => (
                  <tr key={u.name}>
                    <td><span className="avatar">{u.name[0].toUpperCase()}</span> {u.name}</td>
                    <td>{u.role}</td>
                    <td className="muted">{u.zone}</td>
                    <td>{(ROLE_PERMS[u.role] || []).map((p) => <span key={p} className="chip chip-soft">{p}</span>)}</td>
                    <td>{u.active
                      ? <span className="chip chip-ok">active</span>
                      : <span className="chip chip-muted">locked</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>System health</h3><span className={`lamp ${online ? 'on' : 'off'}`} /></div>
          <div className="card-b" style={{ display: 'grid', gap: 10 }}>
            {SERVICES.map((s) => (
              <div key={s.key} className="svc-row">
                <span className={`dot-prio ${online ? 'ok' : 'minor'}`} />
                <span style={{ flex: 1 }}>{s.name}</span>
                <span className="mono muted">{online ? 'healthy' : 'degraded'}</span>
              </div>
            ))}
            <div className="svc-row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <span className={`dot-prio ${online ? 'ok' : 'minor'}`} />
              <span style={{ flex: 1 }}>Realtime socket</span>
              <span className="mono muted">{online ? 'connected' : 'reconnecting'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Audit log</h3><span className="eyebrow">{audit.length} entries</span></div>
        <div className="card-b" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="muted">{timeAgo(a.ts)}</td>
                  <td><Icon name="user" size={13} /> {a.actor}</td>
                  <td><span className="chip chip-soft">{a.action}</span></td>
                  <td className="mono">{a.target}</td>
                </tr>
              ))}
              {!audit.length && <tr><td colSpan={4} className="empty">No audit entries yet — take an action to populate the trail.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
