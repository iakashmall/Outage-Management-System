import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useT, tOr, locale } from '../lib/i18n.js';

// Admin -> System uptime (P8.6g): live status of every dependency, uptime against the
// 99.9% target for 24 h / 7 d / 30 d, per-component uptime and the outage log.
// Backend: realtime/uptime.js records a health sample every 30 s; domain/uptime.js does the maths.
const COMPONENTS = ['api', 'database', 'keycloak', 'kafka', 'redis', 'map'];
const STATUS_COLOR = { up: 'var(--live)', degraded: 'var(--high)', down: 'var(--crit)' };

export default function UptimeCard() {
  const { t } = useT();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.uptime().then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []);

  const pct = (v) => (v == null ? '—' : `${v.toFixed(3)}%`);
  const when = (ts) => new Date(ts).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const cur = d?.current;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <h3>{t('up.title')}</h3>
        {cur && (
          <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: STATUS_COLOR[cur.status] }}>
            <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: STATUS_COLOR[cur.status] }} />
            {t(`up.st.${cur.status}`)}
          </span>
        )}
      </div>
      <div className="card-b">
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
          {t('up.intro', { target: d?.target ?? 99.9, s: d?.intervalS ?? 30 })}
        </p>
        {err && <p className="fr-err">{err}</p>}
        {d && (
          <>
            <div className="sr-stats">
              {d.windows.map((w) => (
                <div key={w.key} className="sr-stat">
                  <span>{t(`up.win.${w.key}`)}</span>
                  <b style={{ color: w.meetsTarget === false ? 'var(--crit)' : undefined }}>{pct(w.pct)}</b>
                  <span>{w.pct == null ? t('up.noData') : t('up.allowed', { m: w.allowedDownMin })}{w.meetsTarget === false ? ` · ${t('up.below')}` : ''}</span>
                </div>
              ))}
            </div>
            {d.firstSample && <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>{t('up.since', { when: when(d.firstSample) })}</p>}

            <table className="tbl" aria-label={t('up.compTable')}>
              <thead><tr><th>{t('up.col.component')}</th><th>{t('up.col.now')}</th><th>{t('up.col.response')}</th><th>{t('up.col.uptime30')}</th><th>{t('up.col.critical')}</th></tr></thead>
              <tbody>
                {COMPONENTS.filter((n) => cur?.components?.[n]).map((n) => {
                  const c = cur.components[n];
                  return (
                    <tr key={n}>
                      <td>{tOr(`up.c.${n}`, n)}</td>
                      <td title={c.error || c.note || ''}>
                        <span style={{ color: c.ok ? 'var(--live)' : c.critical ? 'var(--crit)' : 'var(--high)', fontWeight: 600 }}>{c.ok ? t('up.ok') : t('up.fail')}</span>
                        {!c.ok && c.error && <span className="muted"> · {c.error}</span>}
                        {c.note && <span className="muted"> · {tOr(`up.note.${c.note}`, c.note)}</span>}
                      </td>
                      <td className="mono">{c.ms} ms</td>
                      <td className="mono">{pct(d.windows[2].perComponent[n])}</td>
                      <td>{c.critical ? t('up.yes') : t('up.no')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>{t('up.outages')}</h4>
            {!d.outages.length ? <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{t('up.noOutages')}</p> : (
              <table className="tbl" aria-label={t('up.outages')}>
                <thead><tr><th>{t('up.col.start')}</th><th>{t('up.col.end')}</th><th>{t('up.col.duration')}</th><th>{t('up.col.cause')}</th></tr></thead>
                <tbody>
                  {d.outages.map((o) => (
                    <tr key={o.start}><td>{when(o.start)}</td><td>{when(o.end)}</td><td className="mono">{o.minutes} {t('up.min')}</td>
                      <td>{o.cause.startsWith('no data') ? t('up.causeNoData') : o.cause.split(', ').map((c) => tOr(`up.c.${c}`, c)).join(', ')}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted" style={{ fontSize: 11.5, margin: '12px 0 0' }}>{t('up.footnote')}</p>
          </>
        )}
      </div>
    </div>
  );
}
