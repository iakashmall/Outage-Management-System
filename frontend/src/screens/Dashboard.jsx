import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { CrewDot, Icon, SevBadge, StatusBadge, timeAgo, useLiveRefresh, RowButton } from '../lib/ui.jsx';
import ReliabilityRings from '../components/ReliabilityRings.jsx';
import { useT, tOr } from '../lib/i18n.js';

export default function Dashboard({ go }) {
  const { t } = useT();
  const [inc, setInc] = useState([]);
  const [crews, setCrews] = useState([]);
  const [ind, setInd] = useState(null);
  const [feed, setFeed] = useState([]);

  const load = () => {
    api.incidents().then(setInc);
    api.crews().then(setCrews);
    api.indicators().then(setInd);
  };
  useEffect(() => { load(); }, []);
  useLiveRefresh(['oms.incident.created', 'oms.incident.updated', 'crew.updated', 'crew.job.updated'], load);

  const active = inc.filter((i) => !['closed', 'resolved', 'cancelled'].includes(i.status));
  const affected = active.reduce((s, i) => s + (i.customers || 0), 0);
  const deployed = crews.filter((c) => ['in_service', 'in_transit'].includes(c.status)).length;
  const slaRisk = active.filter((i) => i.sla_due_at && new Date(i.sla_due_at).getTime() - Date.now() < 30 * 60000).length;

  const stat = (lab, val, unit, foot, color) => (
    <div className="stat">
      <span className="edge" style={{ background: color }} />
      <div className="lab">{lab}</div>
      <div className="val">{val}<small>{unit}</small></div>
      <div className="foot">{foot}</div>
    </div>
  );

  const pct = (v, t) => Math.min(100, Math.round((v / t) * 100));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('dash.eyebrow')}</div>
          <h2>{t('dash.title')}</h2>
        </div>
        <button className="btn primary" onClick={() => go('incidents')}>
          <Icon name="bolt" size={16} /> {t('dash.viewAll')}
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', marginBottom: 16 }}>
        {stat(t('dash.active'), active.length, '', t('dash.nCritical', { n: inc.filter(i => i.severity === 'critical' && !['closed', 'resolved'].includes(i.status)).length }), 'var(--crit)')}
        {stat(t('dash.affected'), affected.toLocaleString(), '', t('dash.acrossLive'), 'var(--high)')}
        {stat(t('dash.deployed'), deployed, `/${crews.length}`, t('dash.nAvailable', { n: crews.filter(c => c.status === 'available').length }), 'var(--live)')}
        {stat(t('dash.slaRisk'), slaRisk, '', t('dash.within30'), slaRisk ? 'var(--crit)' : 'var(--low)')}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="card">
          <div className="card-h"><h3>{t('dash.active')}</h3><span className="eyebrow">{t('dash.nOpen', { n: active.length })}</span></div>
          {/* Scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1). */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div tabIndex={0} role="region" aria-label={t('dash.tableLabel')} style={{ overflow: 'auto', maxHeight: 380 }}>
            <table>
              <thead><tr>{['id', 'severity', 'zone', 'feeder', 'customers', 'status'].map((c) => <th key={c}>{t(`col.${c}`)}</th>)}</tr></thead>
              <tbody>
                {active.map((i) => (
                  <tr key={i.id} className="click" onClick={() => go('incidents')}>
                    <td className="id-cell"><RowButton label={t('dash.goTo', { id: i.id })} onActivate={() => go('incidents')}>{i.id.slice(-6)}</RowButton></td>
                    <td><SevBadge sev={i.severity} /></td>
                    <td>{i.zone}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{i.feeder || '—'}</td>
                    <td className="mono">{(i.customers || 0).toLocaleString()}</td>
                    <td><StatusBadge status={i.status} /></td>
                  </tr>
                ))}
                {!active.length && <tr><td colSpan={6}><div className="empty"><span className="disp">{t('dash.allClear')}</span>{t('dash.noActive')}</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div className="card">
            <div className="card-h"><h3>{t('dash.reliability')}</h3></div>
            <div className="card-b" style={{ display: 'grid', gap: 14 }}>
              {ind && (
                <ReliabilityRings
                  saidi={{ value: ind.saidi, target: ind.saidiTarget }}
                  saifi={{ value: ind.saifi, target: ind.saifiTarget }}
                  caidi={{ value: ind.caidi, target: ind.saidiTarget && ind.saifiTarget ? +(ind.saidiTarget / ind.saifiTarget).toFixed(1) : ind.caidi * 1.3 }}
                  maifi={{ value: ind.maifi }}
                />
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>{t('dash.crewStatus')}</h3></div>
            <div className="card-b" style={{ display: 'grid', gap: 9 }}>
              {crews.map((c) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CrewDot status={c.status} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.lead} · {c.location}</div>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }} className="mono">{tOr(`crew.lc.${c.status}`, c.status.replace('_', ' '))}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const IndexBar = ({ label, value, target, unit, pct }) => (
  <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5 }}>
      <span style={{ fontFamily: 'var(--disp)', fontWeight: 600 }}>{label}</span>
      <span className="mono">{value}{unit && ' ' + unit} <span style={{ color: 'var(--muted)' }}>/ {target}{unit && ' ' + unit}</span></span>
    </div>
    <div className="bar"><i style={{ width: pct + '%', background: pct > 90 ? 'var(--crit)' : pct > 70 ? 'var(--high)' : 'var(--live)' }} /></div>
  </div>
);
const MiniStat = ({ label, value, unit }) => (
  <div><div className="eyebrow">{label}</div><div style={{ fontFamily: 'var(--disp)', fontSize: 20, fontWeight: 600 }}>{value}<small style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 3 }}>{unit}</small></div></div>
);