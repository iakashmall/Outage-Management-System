// SMS to feeder managers. Each feeder can have one manager (Admin -> Feeder
// managers, table feeder_managers). They get:
//   - an automatic SMS when an outage opens on their feeder, and one when it is
//     restored (once each per incident; FEEDER_MANAGER_ALERTS=off disables both)
//   - an SMS an operator sends from the incident drawer
//   - report-builder summaries for their feeder
// Every SMS goes through the sms.js gateway seam and is recorded in notifications
// (kind 'feeder_manager', number masked), so it shows in Analytics -> SMS log.
import { nanoid } from 'nanoid';
import { bus, TOPICS } from '../domain/bus.js';
import { db } from '../infra/db.js';
import { repo } from '../infra/repo.js';
import { sendSmsVia, maskPhone } from './sms.js';

export const managerFor = (feeder) =>
  (feeder ? db.oneOrNone('SELECT * FROM feeder_managers WHERE feeder = $1 AND active', [feeder]) : null);

// Sends one SMS to the manager of `feeder`. Returns null when the feeder has no
// active manager, else { id, status, recipient }.
export async function smsFeederManager({ feeder, body, incidentId = null, subject = null, by = 'system' }) {
  const m = await managerFor(feeder);
  if (!m) return null;
  const label = `${m.name} (${maskPhone(m.phone)})`;
  const r = await sendSmsVia({ to: m.phone, body, label });
  const row = await db.one(
    `INSERT INTO notifications (id, incident_id, channel, recipient, subject, body, status, error, ts, feeder, kind, sent_by)
     VALUES ($/id/, $/incidentId/, 'sms', $/label/, $/subject/, $/body/, $/status/, $/error/, now(), $/feeder/, 'feeder_manager', $/by/)
     RETURNING id, status`,
    { id: 'NOT' + nanoid(8), incidentId, label, subject, body, status: r.status, error: r.error || null, feeder, by });
  if (incidentId) await repo.addIncidentEvent(incidentId, by, 'sms', `SMS to feeder manager ${label}: ${body}`);
  bus.publish(TOPICS.SMS_LOGGED, { id: row.id, incidentId, kind: 'feeder_manager' });
  return { ...row, recipient: label };
}

const alreadySent = async (incidentId, subject) =>
  !!(await db.oneOrNone(
    "SELECT 1 FROM notifications WHERE incident_id = $1 AND kind = 'feeder_manager' AND subject = $2 LIMIT 1", [incidentId, subject]));

const RESTORED = new Set(['resolved', 'restored', 'closed']);

export function startFeederManagerAlerts() {
  if ((process.env.FEEDER_MANAGER_ALERTS || '').toLowerCase() === 'off') {
    console.log('  [feeder-managers] automatic outage SMS off (FEEDER_MANAGER_ALERTS=off)');
    return;
  }
  const safe = (fn) => async (inc) => { try { await fn(inc); } catch (e) { console.error('[feeder-managers]', e.message); } };

  bus.subscribe(TOPICS.INCIDENT_CREATED, safe(async (inc) => {
    if (!inc?.feeder || inc.momentary) return;
    const subject = 'Outage alert';
    if (await alreadySent(inc.id, subject)) return;
    const body = `GridQ: ${inc.type === 'Scheduled' ? 'planned outage' : 'outage'} on feeder ${inc.feeder}` +
      `${inc.zone ? ` (${inc.zone})` : ''}, ${inc.severity || 'unknown'} severity, ~${inc.customers || 0} customers. Ref ${inc.id}.`;
    await smsFeederManager({ feeder: inc.feeder, body, incidentId: inc.id, subject });
  }));

  bus.subscribe(TOPICS.INCIDENT_UPDATED, safe(async (inc) => {
    if (!inc?.feeder || !RESTORED.has(String(inc.status || '').toLowerCase())) return;
    const subject = 'Restoration alert';
    if (await alreadySent(inc.id, subject)) return; // resolved -> closed must not send twice
    const mins = inc.resolved_at && inc.opened_at ? Math.round((new Date(inc.resolved_at) - new Date(inc.opened_at)) / 60000) : null;
    const body = `GridQ: supply restored on feeder ${inc.feeder}${inc.zone ? ` (${inc.zone})` : ''}` +
      `${mins !== null ? ` after ${mins} min` : ''}. Ref ${inc.id}.`;
    await smsFeederManager({ feeder: inc.feeder, body, incidentId: inc.id, subject });
  }));
}
