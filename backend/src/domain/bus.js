import { EventEmitter } from 'node:events';

// Event bus with a Kafka-shaped interface. In this runnable build it is an
// in-process emitter; in production (SDP §3) swap the body of publish/subscribe
// for a KafkaJS producer/consumer. Topics mirror the CIM tree, e.g.
//   oms.incident.created  scada.alarm.raised  crew.job.updated
class Bus {
  constructor() { this._e = new EventEmitter(); this._e.setMaxListeners(0); }
  publish(topic, payload) {
    this._e.emit(topic, payload);
    this._e.emit('*', { topic, payload });
  }
  subscribe(topic, handler) { this._e.on(topic, handler); return () => this._e.off(topic, handler); }
  onAny(handler) { this._e.on('*', handler); }
}

export const bus = new Bus();

export const TOPICS = {
  INCIDENT_CREATED: 'oms.incident.created',
  INCIDENT_UPDATED: 'oms.incident.updated',
  ALARM_RAISED: 'scada.alarm.raised',
  ALARM_ACKED: 'scada.alarm.acked',
  CALL_RECEIVED: 'tcs.call.received',
  CREW_UPDATED: 'crew.updated',
  JOB_UPDATED: 'crew.job.updated',
  INDICES_UPDATED: 'oms.indices.updated',
  MESSAGE_POSTED: 'oms.message.posted',
    ERT_CHANGED: 'oms.incident.ert_changed',
};
