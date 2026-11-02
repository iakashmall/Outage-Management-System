import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, timeAgo, useConnection, useLiveRefresh } from '../lib/ui.jsx';
import { useT, tOr } from '../lib/i18n.js';
import FeederRatingsCard from '../components/FeederRatingsCard.jsx';
import FeederManagersCard from '../components/FeederManagersCard.jsx';
import UptimeCard from '../components/UptimeCard.jsx';

// Sample data for the demo: NOT read from Keycloak. Labelled as sample in the card below.
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
  const { t } = useT();
  const [audit, setAudit] = useState([]);
  const online = useConnection();

  const load = () => api.audit().then(setAudit);
  useEffect(() => { load(); }, []);
  useLiveRefresh(['oms.incident.created', 'oms.incident.updated', 'scada.alarm.acked', 'crew.job.updated'], load);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('adm.eyebrow')}</div>
          <h2>{t('adm.title')}</h2>
          <p>{t('adm.intro')}</p>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.3fr 1fr' }}>
        <div className="card">
          <div className="card-h">
            <h3>{t('adm.users')} <span className="chip chip-minor" title={t('adm.usersSampleNote')}>{t('adm.usersSample')}</span></h3>
            <span className="eyebrow">{t('adm.nActive', { n: USERS.filter((u) => u.active).length })}</span>
          </div>
          <div className="card-b" style={{ padding: 0 }}>
            <p className="muted" style={{ margin: 0, padding: '8px 14px', fontSize: 12 }}>{t('adm.usersSampleNote')}</p>
            <table className="tbl">
              <thead><tr><th>{t('adm.user')}</th><th>{t('adm.role')}</th><th>{t('col.zone')}</th><th>{t('adm.perms')}</th><th></th></tr></thead>
              <tbody>
                {USERS.map((u) => (
                  <tr key={u.name}>
                    <td><span className="avatar">{u.name[0].toUpperCase()}</span> {u.name}</td>
                    <td>{tOr(`adm.role.${u.role}`, u.role)}</td>
                    <td className="muted">{tOr(`adm.zone.${u.zone}`, u.zone)}</td>
                    <td>{(ROLE_PERMS[u.role] || []).map((p) => <span key={p} className="chip chip-soft">{tOr(`adm.perm.${p}`, p)}</span>)}</td>
                    <td>{u.active
                      ? <span className="chip chip-ok">{t('adm.active')}</span>
                      : <span className="chip chip-muted">{t('adm.locked')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>{t('adm.health')}</h3><span className={`lamp ${online ? 'on' : 'off'}`} /></div>
          <div className="card-b" style={{ display: 'grid', gap: 10 }}>
            {SERVICES.map((s) => (
              <div key={s.key} className="svc-row">
                <span className={`dot-prio ${online ? 'ok' : 'minor'}`} />
                <span style={{ flex: 1 }}>{tOr(`adm.svc.${s.key}`, s.name)}</span>
                <span className="mono muted">{online ? t('adm.healthy') : t('adm.degraded')}</span>
              </div>
            ))}
            <div className="svc-row" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <span className={`dot-prio ${online ? 'ok' : 'minor'}`} />
              <span style={{ flex: 1 }}>{t('adm.socket')}</span>
              <span className="mono muted">{online ? t('adm.connected') : t('adm.reconnecting')}</span>
            </div>
          </div>
        </div>
      </div>

      <UptimeCard />
      <FeederManagersCard />
      <FeederRatingsCard />

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>{t('adm.audit')}</h3><span className="eyebrow">{t('adm.nEntries', { n: audit.length })}</span></div>
        <div className="card-b" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr><th>{t('adm.time')}</th><th>{t('adm.actor')}</th><th>{t('adm.action')}</th><th>{t('adm.target')}</th></tr></thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="muted">{timeAgo(a.ts)}</td>
                  <td><Icon name="user" size={13} /> {a.actor}</td>
                  <td><span className="chip chip-soft">{a.action}</span></td>
                  <td className="mono">{a.target}</td>
                </tr>
              ))}
              {!audit.length && <tr><td colSpan={4} className="empty">{t('adm.noAudit')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
