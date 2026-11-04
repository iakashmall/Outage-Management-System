// Ids for rows written at storm rates (load-test findings F1, F2, 3 Nov 2026).
//
// F1: alarm ids used to be 'ALM-' + 5 random base-36 characters (36^5 = 60.5
// million values). By the birthday bound, n inserts collide about
// n^2 / (2 * 36^5) times: ~25 in a 55,000-event storm, each one a 500 on
// alarms_pkey. A random UUID has 122 random bits; collisions are not a
// practical event at any volume this system will see.
import { randomUUID, createHash } from 'node:crypto';

export const newAlarmId = (prefix = 'ALM-') => prefix + randomUUID();

// F2: the idempotency key of one SCADA event.
//   1. the sender's own event id (eventId, else external_id), as sent;
//   2. otherwise a hash of tag + source timestamp + state, when the event
//      carries its source timestamp (sourceTs or ts);
//   3. otherwise null: nothing identifies a resend, so none is detected.
// Never a hash of tag + state alone: two genuine trips of one breaker would
// then be thrown away as duplicates.
export function scadaEventKey(body = {}) {
  const sent = body.eventId ?? body.external_id;
  if (sent !== undefined && sent !== null && String(sent).trim()) return `id:${String(sent).trim()}`;
  const ts = body.sourceTs ?? body.ts;
  if (!body.tag || ts === undefined || ts === null || !String(ts).trim()) return null;
  const state = `${body.event === 'reclose' ? 'reclose' : 'trip'}:${String(body.condition || '').toUpperCase()}`;
  return 'h:' + createHash('sha256').update(`${body.tag}|${String(ts).trim()}|${state}`).digest('hex').slice(0, 40);
}
