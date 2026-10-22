import { EventEmitter } from 'node:events';
import { Kafka, logLevel } from 'kafkajs';

// Event bus with a Kafka-shaped interface (SDP §3; INT-001). Topics mirror
// the CIM tree, e.g. oms.incident.created, scada.alarm.raised, crew.job.updated.
//
// Two drivers behind the same publish/subscribe/onAny/init API, chosen by
// EVENT_BUS_DRIVER:
//   - "memory" (default): in-process EventEmitter — zero external deps, what
//     the whole app has been running on since the prototype. Good for a
//     laptop that isn't running the Kafka container.
//   - "kafka": real KafkaJS producer/consumer against the brokers in
//     KAFKA_BROKERS. This is the actual Phase-1-tail swap-in — same topic
//     names, same call sites, nothing else in the app needs to change.
export const TOPICS = {
  INCIDENT_CREATED: 'oms.incident.created',
  INCIDENT_UPDATED: 'oms.incident.updated',
  ALARM_RAISED: 'scada.alarm.raised',
  ALARM_ACKED: 'scada.alarm.acked',
  CALL_RECEIVED: 'tcs.call.received',
  CALL_UPDATED: 'tcs.call.updated',
  // OMS-01 planned outages
  PLANNED_OUTAGE_UPDATED: 'oms.planned.updated',
  PLANNED_NOTICE: 'oms.planned.notice',
  PERMIT_CHANGED: 'oms.permit.changed',
  STEP_CONFIRMED: 'oms.switching.confirmed',
  STEP_REJECTED: 'oms.switching.rejected',
  CREW_REPORT: 'oms.planned.crew_report',
  CREW_UPDATED: 'crew.updated',
  JOB_UPDATED: 'crew.job.updated',
  INDICES_UPDATED: 'oms.indices.updated',
  MESSAGE_POSTED: 'oms.message.posted',
    ERT_CHANGED: 'oms.incident.ert_changed',
  CREW_TRACKING_CHANGED: 'crew.tracking.changed',
  FEEDER_ANALOG: 'scada.analog.feeder',
  // OMS-03 workload balancing: { event: proposed|applied|rejected|stale, proposalId, trigger }
  DISPATCH_REBALANCE: 'oms.dispatch.rebalance',
  CREW_LOCATION_STALE: 'crew.location.stale',
  // FR-OMS-021: an SMS (officer, escalation) was recorded: { id, incidentId, kind }
  SMS_LOGGED: 'oms.sms.logged',
};
const ALL_TOPICS = Object.values(TOPICS);

// Topics that are never bridged to WebSocket clients: high-rate machine data
// that no screen renders message by message (the browser would drown in it).
export const NOT_BROADCAST = new Set([TOPICS.FEEDER_ANALOG]);

// Messages that cannot be processed go to <topic>.dlq (Kafka driver only).
const DLQ_SUFFIX = '.dlq';
const MAX_ATTEMPTS = Number(process.env.KAFKA_MAX_ATTEMPTS) || 5;

class MemoryBus {
  constructor() { this._e = new EventEmitter(); this._e.setMaxListeners(0); }
  async init() { /* nothing to connect */ }
  publish(topic, payload) {
    this._e.emit(topic, payload);
    this._e.emit('*', { topic, payload });
  }
  subscribe(topic, handler) {
    // Handlers may be async; in-process there is nothing to retry, so log.
    const h = (p) => Promise.resolve().then(() => handler(p))
      .catch((err) => console.error(`[bus] handler failed (${topic}):`, err.message));
    this._e.on(topic, h);
    return () => this._e.off(topic, h);
  }
  onAny(handler) { this._e.on('*', handler); }
  async close() {}
}

class KafkaBus {
  constructor(brokers) {
    this._kafka = new Kafka({ clientId: 'oms-backend', brokers, logLevel: logLevel.NOTHING });
    this._producer = this._kafka.producer();
    // Every process in one group shares the topics' partitions, so a second
    // process (self-test, load-test probe) needs its own KAFKA_GROUP_ID or it
    // steals messages from the running backend.
    this._consumer = this._kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID || 'oms-backend' });
    this._handlers = new Map(); // topic -> Set(handler); awaited, so Kafka waits for them
    this._any = new EventEmitter(); // WebSocket bridge etc.; fire-and-forget
    this._any.setMaxListeners(0);
    this._attempts = new Map(); // "topic/partition/offset" -> failed attempts
  }

  // Run every subscriber of `topic` and wait for all of them.
  async _dispatch(topic, payload) {
    const hs = [...(this._handlers.get(topic) || [])];
    await Promise.all(hs.map((h) => h(payload)));
    this._any.emit('*', { topic, payload });
  }

  async _deadLetter(topic, messages, reason) {
    console.error(`[bus] ${messages.length} message(s) on ${topic} -> ${topic}${DLQ_SUFFIX}: ${reason}`);
    await this._producer.send({
      topic: topic + DLQ_SUFFIX,
      messages: messages.map((m) => ({ key: m.key, value: m.value, headers: { ...(m.headers || {}), 'x-dlq-reason': String(reason).slice(0, 500) } })),
    }).catch((err) => console.error(`[bus] dead-letter publish failed (${topic}):`, err.message));
  }

  // A batch that keeps failing (e.g. the database rejects it) is retried a few
  // times - a database blip heals - then parked in the DLQ so one bad batch
  // cannot stop the topic forever.
  _giveUp(key) {
    const n = (this._attempts.get(key) || 0) + 1;
    this._attempts.set(key, n);
    if (n < MAX_ATTEMPTS) return false;
    this._attempts.delete(key);
    return true;
  }

  async init() {
    await this._producer.connect();
    await this._consumer.connect();
    const admin = this._kafka.admin();
    await admin.connect();
    const existing = await admin.listTopics();
    const want = [...ALL_TOPICS, ...ALL_TOPICS.map((t) => t + DLQ_SUFFIX)];
    const missing = want.filter((t) => !existing.includes(t));
    if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions: 1 })) });
    await admin.disconnect();

    await this._consumer.subscribe({ topics: ALL_TOPICS, fromBeginning: false });
    // eachBatch, not eachMessage: an offset is committed only after its
    // handlers have finished, so a slow database slows consumption (Kafka
    // holds the backlog) instead of piling work up in memory, and a crash
    // re-delivers instead of losing data.
    await this._consumer.run({
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: Number(process.env.KAFKA_PARTITIONS_CONCURRENT) || 4,
      eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
        const { topic, partition } = batch;
        // 1) Parse. Unparseable messages go to the DLQ and are skipped.
        const good = [];
        const bad = [];
        for (const m of batch.messages) {
          // A leading byte-order mark (Windows tools add one) is not part of the JSON.
          try { good.push({ m, payload: m.value ? JSON.parse(m.value.toString().replace(/^﻿/, '')) : null }); }
          catch { bad.push(m); }
        }
        if (bad.length) await this._deadLetter(topic, bad, 'invalid JSON');

        // 2) Feeder analog samples: one database insert for the whole batch.
        if (topic === TOPICS.FEEDER_ANALOG) {
          if (good.length) {
            const samples = good.flatMap(({ payload }) => (Array.isArray(payload?.samples) ? payload.samples : [payload]));
            const key = `${topic}/${partition}/${batch.firstOffset()}`;
            try { await this._dispatch(topic, { samples }); this._attempts.delete(key); }
            catch (err) {
              if (!this._giveUp(key)) throw err; // kafkajs retries from the last committed offset
              await this._deadLetter(topic, good.map((g) => g.m), err.message);
            }
          }
          resolveOffset(batch.lastOffset());
          await heartbeat();
          return;
        }

        // 3) Everything else: in order, one message at a time.
        for (const { m, payload } of good) {
          if (!isRunning() || isStale()) break;
          const key = `${topic}/${partition}/${m.offset}`;
          try { await this._dispatch(topic, payload); this._attempts.delete(key); }
          catch (err) {
            if (!this._giveUp(key)) throw err;
            await this._deadLetter(topic, [m], err.message);
          }
          resolveOffset(m.offset);
          await heartbeat();
        }
        if (!good.length) resolveOffset(batch.lastOffset());
      },
    });
    console.log('[bus] Kafka driver connected');
  }

  publish(topic, payload) {
    // Fire-and-forget from the caller's point of view, matching the memory
    // bus's synchronous-looking API; errors are logged, not thrown, so a
    // blip on the broker doesn't take down the request that triggered it.
    this._producer.send({ topic, messages: [{ value: JSON.stringify(payload) }] })
      .catch((err) => console.error(`[bus] publish failed (${topic}):`, err.message));
  }
  subscribe(topic, handler) {
    if (!this._handlers.has(topic)) this._handlers.set(topic, new Set());
    this._handlers.get(topic).add(handler);
    return () => this._handlers.get(topic)?.delete(handler);
  }
  onAny(handler) { this._any.on('*', handler); }
  async close() { await this._producer.disconnect(); await this._consumer.disconnect(); }
}

const driver = (process.env.EVENT_BUS_DRIVER || 'memory').toLowerCase();
let impl;
if (driver === 'kafka') {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:19092').split(',').map((s) => s.trim());
  impl = new KafkaBus(brokers);
} else {
  impl = new MemoryBus();
}

export const bus = impl;

// Call once at boot (see index.js). Kept separate from module load because
// connecting to Kafka is async and index.js already awaits migrate()/seed()
// in the same style before starting the HTTP server.
export async function initBus() {
  try {
    await bus.init();
  } catch (err) {
    console.error(`[bus] failed to initialize "${driver}" driver:`, err.message);
    if (driver === 'kafka') {
      console.warn('[bus] falling back to in-memory driver for this run — fix KAFKA_BROKERS or set EVENT_BUS_DRIVER=memory to silence this warning');
      // Swap the exported bus's behaviour onto a fresh memory bus so every
      // module that already imported { bus } gets working behaviour without
      // needing to re-import anything.
      const fallback = new MemoryBus();
      await fallback.init();
      Object.setPrototypeOf(bus, Object.getPrototypeOf(fallback));
      Object.assign(bus, fallback);
    }
  }
}