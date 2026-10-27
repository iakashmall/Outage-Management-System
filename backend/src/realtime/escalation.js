// SLA escalation (FR-OMS-008 / FR-OMS-021). An active incident past its
// sla_due_at is escalated one officer level per hour of breach:
//   breached          -> AE
//   >= 60 min over    -> SE
//   >= 120 min over   -> CE
// Each level's SMS goes out once per incident: the notifications row is
// claimed first through the (incident_id, contact_ref) unique index with
// contact_ref 'ESC-<level>', so a restart or a second backend never resends.
//
// Officer numbers come from ESCALATION_SMS_TO, e.g.
//   ESCALATION_SMS_TO=AE=+919800000001,SE=+919800000002,CE=+919800000003
// A level with no number is still recorded (status 'skipped-no-contact') so
// the tracker shows the escalation happened.
import { nanoid } from 'nanoid';
import { bus, TOPICS } from '../domain/bus.js';
import { db } from '../infra/db.js';
import { repo } from '../infra/repo.js';
import { sendSmsVia, maskPhone } from './sms.js';

export const LEVELS = [
  { key: 'AE', overMin: 0, from: 'Lineman' },
  { key: 'SE', overMin: 60, from: 'AE' },
  { key: 'CE', overMin: 120, from: 'SE' },
];
const INACTIVE = ['closed', 'resolved', 'cancelled', 'restored', 'scheduled'];
const SCAN_MS = 60_000;

export function escalationContacts(raw = process.env.ESCALATION_SMS_TO) {
  const out = {};
  for (const part of String(raw || '').split(',')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out;
}

// Highest level an incident `overMin` minutes past its SLA has reached, or null.
export function levelFor(overMin) {
  if (!(overMin > 0)) return null;
  return [...LEVELS].reverse().find((l) => overMin >= l.overMin) || null;
}

// Live tracker rows: every active incident with an SLA clock, worst first.
export async function listEscalations(now = Date.now()) {
  const rows = await db.any(
    `SELECT i.id, i.feeder, i.zone, i.customers, i.severity, i.status, i.opened_at, i.sla_due_at,
            COALESCE(json_agg(json_build_object('level', substr(n.contact_ref, 5), 'ts', n.ts, 'status', n.status))
                     FILTER (WHERE n.id IS NOT NULL), '[]') AS sent
     FROM incidents i
     LEFT JOIN notifications n ON n.incident_id = i.id AND n.contact_ref LIKE 'ESC-%'
     WHERE i.sla_due_at IS NOT NULL AND i.status <> ALL($1)
     GROUP BY i.id`, [INACTIVE]);
  return rows.map((r) => {
    const opened = new Date(r.opened_at).getTime();
    const due = new Date(r.sla_due_at).getTime();
    const openedMin = Math.max(0, Math.round((now - opened) / 60000));
    const slaMin = Math.round((due - opened) / 60000);
    const overMin = Math.round((now - due) / 60000);
    const level = levelFor(overMin);
    return {
      incidentId: r.id, feeder: r.feeder || r.zone || '—', customers: r.customers || 0, severity: r.severity,
      openedMin, slaMin, overMin,
      level: level ? `${level.from} → ${level.key}` : 'Lineman',
      status: r.sent.length ? 'escalated' : (level ? 'due' : 'pending'),
      sent: r.sent,
    };
  }).sort((a, b) => b.overMin - a.overMin);
}

async function escalate(inc, level, contacts) {
  const ref = `ESC-${level.key}`;
  const to = contacts[level.key];
  const over = Math.round((Date.now() - new Date(inc.sla_due_at).getTime()) / 60000);
  const body = `ESCALATION ${level.key}: ${inc.id} on ${inc.feeder || inc.zone || 'network'} unresolved, ` +
    `SLA breached by ${over} min, ${inc.customers || 0} customers affected.`;
  const recipient = `${level.key}${to ? ` (${maskPhone(to)})` : ''}`;
  const claimed = await db.oneOrNone(
    `INSERT INTO notifications (id, incident_id, channel, recipient, subject, body, status, error, ts, contact_ref, feeder, kind, sent_by)
     VALUES ($/id/, $/incident_id/, 'sms', $/recipient/, 'SLA escalation', $/body/, 'sending', NULL, $/ts/, $/ref/, $/feeder/, 'escalation', 'system')
     ON CONFLICT (incident_id, contact_ref) WHERE contact_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    { id: 'NOT' + nanoid(8), incident_id: inc.id, recipient, body, ts: new Date().toISOString(), ref, feeder: inc.feeder || null });
  if (!claimed) return false;
  const res = to ? await sendSmsVia({ to, body, label: recipient }) : { status: 'skipped-no-contact', error: null };
  await db.none('UPDATE notifications SET status=$2, error=$3 WHERE id=$1', [claimed.id, res.status, res.error || null]);
  await repo.addIncidentEvent(inc.id, 'SYSTEM', 'escalation',
    `SLA breached by ${over} min - escalated to ${level.key}${to ? '' : ' (no number configured)'}`);
  bus.publish(TOPICS.SMS_LOGGED, { id: claimed.id, incidentId: inc.id, kind: 'escalation' });
  return true;
}

export async function scanEscalations() {
  const contacts = escalationContacts();
  const due = await db.any(
    `SELECT id, feeder, zone, customers, sla_due_at FROM incidents
     WHERE sla_due_at < now() AND status <> ALL($1)`, [INACTIVE]);
  let sent = 0;
  for (const inc of due) {
    const level = levelFor((Date.now() - new Date(inc.sla_due_at).getTime()) / 60000);
    if (level && (await escalate(inc, level, contacts))) sent++;
  }
  return sent;
}

export function startEscalations() {
  const run = () => scanEscalations().catch((e) => console.error('[escalation] scan failed:', e.message));
  const n = Object.keys(escalationContacts()).length;
  console.log(`  [escalation] SLA scan every ${SCAN_MS / 1000}s · ${n} officer number(s) configured (ESCALATION_SMS_TO)`);
  run();
  setInterval(run, SCAN_MS).unref();
}
