// OMS-01 planned outages: control-room calls. The API answers rule
// rejections as { code, message }; surface the message (and keep the code).
import { req } from './api.js';

const call = async (method, path, body) => {
  try {
    return await req(method, path, body);
  } catch (e) {
    throw Object.assign(new Error(e.data?.message || e.message), { code: e.data?.code, status: e.status });
  }
};

// Each confirmation attempt gets its own id; the server treats a repeat of the
// same id as the same confirmation.
export const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const plannedApi = {
  list: () => call('GET', '/planned-outages'),
  areas: () => call('GET', '/planned-outages/areas'), // [{ value, label, feeders: [code] }]
  get: (id) => call('GET', `/planned-outages/${id}`),
  safetyLog: (id) => call('GET', `/planned-outages/${id}/safety-log`),
  create: (body) => call('POST', '/planned-outages', body),
  reschedule: (id, body) => call('PATCH', `/planned-outages/${id}`, body),
  draftFromTrace: (id, body) => call('POST', `/planned-outages/${id}/switching-plan/draft`, body),
  saveSteps: (id, steps) => call('PUT', `/planned-outages/${id}/switching-plan/steps`, { steps }),
  approve: (id) => call('POST', `/planned-outages/${id}/switching-plan/approve`),
  unapprove: (id) => call('POST', `/planned-outages/${id}/switching-plan/unapprove`),
  notify: (id) => call('POST', `/planned-outages/${id}/notify`),
  skipNotice: (id, reason) => call('POST', `/planned-outages/${id}/notify`, { skip: true, reason }),
  cancel: (id, reason) => call('POST', `/planned-outages/${id}/cancel`, { reason }),
  // { newWindowEnd, reason, reportId? }: extend the window and notify customers
  delay: (id, body) => call('POST', `/planned-outages/${id}/delay`, body),
  dismissReport: (id, reportId, reason) => call('POST', `/planned-outages/${id}/delay-reports/${reportId}/dismiss`, { reason }),
  close: (id, body) => call('POST', `/planned-outages/${id}/close`, body), // body { force: true, reason } closes with open jobs
  confirmStep: (stepId, body) => call('POST', `/switching-steps/${stepId}/confirm`, { clientConfirmationId: newClientId(), ...body }),
  issuePermit: (permitId, body) => call('POST', `/permits/${permitId}/issue`, body),
  refusePermit: (permitId, reason) => call('POST', `/permits/${permitId}/refuse`, { reason }),
  returnOnBehalf: (permitId, body) => call('POST', `/permits/${permitId}/return-on-behalf`, { clientRequestId: newClientId(), ...body }),
};

// OMS-05: a fault incident's own switching plan. Same rules and safety log;
// steps are confirmed with plannedApi.confirmStep (one route for every owner).
export const incidentPlanApi = {
  get: (incidentId) => call('GET', `/incidents/${incidentId}/switching-plan`), // { incident, plan (null until drafted), steps }
  safetyLog: (incidentId) => call('GET', `/incidents/${incidentId}/safety-log`),
  draftFromTrace: (incidentId, body) => call('POST', `/incidents/${incidentId}/switching-plan/draft`, body),
  saveSteps: (incidentId, steps) => call('PUT', `/incidents/${incidentId}/switching-plan/steps`, { steps }),
  approve: (incidentId) => call('POST', `/incidents/${incidentId}/switching-plan/approve`),
  unapprove: (incidentId) => call('POST', `/incidents/${incidentId}/switching-plan/unapprove`),
};
