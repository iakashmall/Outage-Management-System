// Bus relay between processes (runbook v2, WP4: ROLE=api / ROLE=worker).
//
// The memory bus only reaches subscribers in its own process. When the API
// and the worker are separate processes, an incident the worker creates must
// still reach the API's Socket.IO clients, and an incident an operator edits
// through the API must still reach the worker's notifier (SMS) and DMS
// publisher. Every local publish is therefore also sent to the other OMS
// processes over Postgres LISTEN/NOTIFY and re-emitted there (locally only,
// never relayed again). Payloads over the NOTIFY size limit go through the
// bus_relay table, cleaned up after an hour.
// Same delivery promise as the memory bus: live and best effort. Durable work
// (SCADA events, complaints) goes through the intake queue, not the bus.
// Not used with ROLE=all (one process: nothing to relay).
import { nanoid } from 'nanoid';
import { db } from './db.js';
import { bus, TOPICS } from '../domain/bus.js';

const CHANNEL = 'oms_bus';
const ORIGIN = nanoid(10);
const MAX_INLINE = 7500; // bytes; NOTIFY payloads must stay under 8000
const LOCAL_ONLY = new Set([TOPICS.FEEDER_ANALOG]); // raw analog samples: per process, high volume

export async function migrateBusRelay() {
  await db.none(`
    CREATE TABLE IF NOT EXISTS bus_relay (
      id         BIGSERIAL PRIMARY KEY,
      topic      TEXT NOT NULL,
      payload    JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bus_relay_created ON bus_relay (created_at);`);
}

let enabled = false;
export const relayStats = { sent: 0, received: 0, viaTable: 0, errors: 0 };

export async function enableBusRelay() {
  if (enabled) return;
  enabled = true;
  if (typeof bus._e === 'undefined') {
    console.warn('[relay] the event bus is not the memory driver; cross-process relay is off (use EVENT_BUS_DRIVER=memory with ROLE=api/worker)');
    return;
  }
  const localPublish = bus.publish.bind(bus);

  bus.publish = (topic, payload) => {
    localPublish(topic, payload);
    if (LOCAL_ONLY.has(topic)) return;
    send(topic, payload).catch((err) => { relayStats.errors++; console.error(`[relay] could not relay ${topic}:`, err.message); });
  };

  async function send(topic, payload) {
    const msg = JSON.stringify({ o: ORIGIN, t: topic, p: payload ?? null });
    if (Buffer.byteLength(msg) <= MAX_INLINE) {
      await db.any('SELECT pg_notify($1, $2)', [CHANNEL, msg]);
    } else {
      const { id } = await db.one('INSERT INTO bus_relay (topic, payload) VALUES ($1, $2) RETURNING id', [topic, JSON.stringify(payload ?? null)]);
      await db.any('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ o: ORIGIN, t: topic, r: Number(id) })]);
      relayStats.viaTable++;
    }
    relayStats.sent++;
  }

  async function onNotice(m) {
    if (m.channel !== CHANNEL) return;
    try {
      const msg = JSON.parse(m.payload);
      if (msg.o === ORIGIN) return; // our own
      let payload = msg.p;
      if (msg.r != null) payload = (await db.oneOrNone('SELECT payload FROM bus_relay WHERE id = $1', [msg.r]))?.payload ?? null;
      relayStats.received++;
      localPublish(msg.t, payload);
    } catch (err) {
      relayStats.errors++;
      console.error('[relay] bad relayed event:', err.message);
    }
  }

  async function listen() {
    for (let i = 0; ; i++) {
      try {
        const c = await db.connect({ direct: true });
        c.client.on('notification', onNotice);
        let gone = false; // 'error' and 'end' can both fire: reconnect once
        const again = () => { if (gone) return; gone = true; c.client.removeAllListeners('notification'); setTimeout(listen, 2000); };
        c.client.once('error', (err) => { console.error('[relay] listener lost:', err.message); again(); });
        c.client.once('end', () => again());
        await c.none('LISTEN $1:name', [CHANNEL]);
        if (i) console.log('[relay] listener reconnected');
        return;
      } catch (err) {
        if (i % 10 === 0) console.error('[relay] cannot listen yet:', err.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  await listen();

  const cleanup = setInterval(() => {
    db.none("DELETE FROM bus_relay WHERE created_at < now() - interval '1 hour'").catch(() => {});
  }, 5 * 60000);
  cleanup.unref?.();
  console.log(`[relay] cross-process bus relay on (origin ${ORIGIN})`);
}
