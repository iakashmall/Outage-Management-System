import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, timeAgo, useLiveRefresh, toast } from '../lib/ui.jsx';
import { useT, t as tt } from '../lib/i18n.js';

const PRIO = { 1: { label: 'Critical', cls: 'crit' }, 2: { label: 'Major', cls: 'major' }, 3: { label: 'Minor', cls: 'minor' } };

export default function Alarms({ openIncident } = {}) {
  const [alarms, setAlarms] = useState([]);
  const { t } = useT();
  const [show, setShow] = useState('active'); // active | all

  const load = () => api.alarms().then(setAlarms);
  useEffect(() => { load(); }, []);
  useLiveRefresh(['scada.alarm.raised', 'scada.alarm.acked', 'oms.incident.created'], load);

  const rows = useMemo(
    () => alarms.filter((a) => (show === 'active' ? !a.ack : true))
      .sort((a, b) => (a.priority - b.priority) || (b.ts || '').localeCompare(a.ts || '')),
    [alarms, show]
  );
  const unacked = alarms.filter((a) => !a.ack).length;
  const counts = [1, 2, 3].map((p) => alarms.filter((a) => a.priority === p && !a.ack).length);

  const ack = async (id) => { try { await api.ackAlarm(id); toast(tt('al.ackedToast')); load(); } catch (e) { toast(e.message, 'err'); } };
  const ackAll = async () => { try { await api.ackAll(); toast(tt('al.allAckedToast')); load(); } catch (e) { toast(e.message, 'err'); } };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">SCADA / DMS</div>
          <h2>{t('al.title')}</h2>
          <p>{t('al.intro')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="seg">
            <button className={show === 'active' ? 'on' : ''} onClick={() => setShow('active')}>{t('al.active')}</button>
            <button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>{t('al.all')}</button>
          </div>
          <button className="btn btn-primary" disabled={!unacked} onClick={ackAll}>
            <Icon name="check" size={16} /> {t('al.ackAll', { n: unacked })}
          </button>
        </div>
      </div>

      <div className="grid stat-row" style={{ marginBottom: 16 }}>
        {[[t('al.critical'), counts[0], 'crit'], [t('al.major'), counts[1], 'major'], [t('al.minor'), counts[2], 'minor'], [t('al.unackedTotal'), unacked, 'neutral']].map(([l, n, c]) => (
          <div key={l} className={`stat prio-${c}`}>
            <div className="stat-n">{n}</div>
            <div className="stat-l">{l}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-h"><h3>{t('al.list')}</h3><span className="eyebrow">{t('al.shown', { n: rows.length })}</span></div>
        <div className="card-b" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr><th>{t('al.colPrio')}</th><th>{t('al.colTag')}</th><th>{t('al.colCondition')}</th><th>{t('al.colLimit')}</th><th>{t('al.colMessage')}</th><th>{t('al.colIncident')}</th><th>{t('al.colRaised')}</th><th></th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const p = PRIO[a.priority] || PRIO[3];
                return (
                  <tr key={a.id} className={a.ack ? 'row-ack' : ''}>
                    <td><span className={`dot-prio ${p.cls}`} /> {t(`al.${{ crit: 'critical', major: 'major', minor: 'minor' }[p.cls]}`)}</td>
                    <td className="mono">{a.tag}</td>
                    <td><span className={`chip chip-${p.cls}`}>{a.condition}</span></td>
                    <td className="mono">{a.limit_val || '—'}</td>
                    <td style={{ maxWidth: 340 }}>{a.message}</td>
                    <td>
                      {a.incident_id
                        ? <button className="btn btn-sm" onClick={() => openIncident && openIncident(a.incident_id)} title={t('al.openIncTitle')}>
                            <Icon name="bolt" size={13} /> {a.incident_id}
                          </button>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="muted">{timeAgo(a.ts)}</td>
                    <td>{a.ack
                      ? <span className="muted" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="check" size={14} /> {t('al.acked')}</span>
                      : <button className="btn btn-sm" onClick={() => ack(a.id)}>{t('al.ack')}</button>}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={8} className="empty">{show === 'active' ? t('al.noActive') : t('al.none')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}