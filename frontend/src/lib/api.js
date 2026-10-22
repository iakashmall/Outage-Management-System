import { io } from 'socket.io-client';
import { freshAuthHeader, refreshToken } from './auth.js';

const BASE = '/api';
export async function req(method, path, body, retried = false) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(await freshAuthHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // The server can still reject a token we thought was valid (clock skew, session revoked): renew it once and
  // retry. A 401 is answered before anything is processed, so the retry is safe.
  if (r.status === 401 && !retried) {
    try { await refreshToken(true); return req(method, path, body, true); } catch { /* sign-in redirect triggered */ }
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { data, status: r.status });
  return data;
}
async function exportReliabilityReport(format, filters = {}) {
  const params = new URLSearchParams({ format, ...filters });
  const r = await fetch(`${BASE}/reports/reliability?${params}`, {
    method: 'GET',
    headers: { ...(await freshAuthHeader()) },
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || r.statusText), { data, status: r.status });
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reliability-report.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
// Downloads a file from the API (with the login token) under the name the server gives it.
async function download(path, fallbackName) {
  const r = await fetch(`${BASE}${path}`, { headers: { ...(await freshAuthHeader()) } });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || r.statusText), { data, status: r.status });
  }
  const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const exportFeederKpi = (params = {}) => download(`/analytics/feeder-kpi/export?${new URLSearchParams(params)}`, 'feeder-kpi.csv');
const exportFeederKpiPdf = (params = {}, feeders = []) => {
  const { feeder, ...rest } = params; // the PDF names its own feeders
  return download(`/analytics/feeder-kpi/export.pdf?${new URLSearchParams({ ...rest, feeders: feeders.join(',') })}`, 'feeder-kpi.pdf');
};
export const api = {
  incidents: () => req('GET', '/incidents'),
  smsLog: () => req('GET', '/sms'),
  sendSms: (b) => req('POST', '/sms', b),
  escalations: () => req('GET', '/escalations'),
  incident: (id) => req('GET', `/incidents/${id}`),
  createIncident: (b) => req('POST', '/incidents', b),
  setStatus: (id, status, note) => req('PATCH', `/incidents/${id}/status`, { status, note }),
  // extra (OMS-03, optional): { requiredSkill, estimatedDurationMin }
  assign: (id, crewId, priority, extra = {}) => req('POST', `/incidents/${id}/assign`, { crewId, priority, ...extra }),
  messages: (id) => req('GET', `/incidents/${id}/messages`),
  photos: (id) => req('GET', `/incidents/${id}/photos`),
  assetScans: (id) => req('GET', `/incidents/${id}/asset-scans`),
  // OMS-03 crew job workflow: each crew job's lock state, completion form and
  // the photos/scans that reached it after it was locked.
  fieldReport: (id) => req('GET', `/incidents/${id}/field-report`),
  returnForCorrection: (id, reason) => req('POST', `/incidents/${id}/return-for-correction`, { reason }),
  photoDetail: (photoId) => req('GET', `/mobile/photos/${photoId}`),
  postMessage: (id, body) => req('POST', `/incidents/${id}/messages`, { body }),
  setErt: (id, ert) => req('PATCH', `/incidents/${id}/ert`, { ert }),
  crews: () => req('GET', '/crews'),
  // GPS trail of one crew between two instants (newest `limit` fixes, oldest -> newest).
  crewTrack: (id, from, to, limit = 5000) => req('GET', `/mobile/crews/${encodeURIComponent(id)}/track?${new URLSearchParams({ from, to, limit })}`),
  nearestCrews: (incidentId) => req('GET', `/incidents/${incidentId}/nearest-crews`),
  alarms: () => req('GET', '/alarms'),
  ackAlarm: (id) => req('POST', `/alarms/${id}/ack`),
  ackAll: () => req('POST', '/alarms/ack-all'),
  calls: () => req('GET', '/calls'),
  callToIncident: (id) => req('POST', `/calls/${id}/to-incident`),
  callAreas: () => req('GET', '/calls/areas'),
  createCall: (b) => req('POST', '/calls', b),
  rejectCall: (id, reason) => req('POST', `/calls/${id}/reject`, { reason }),
  indicators: () => req('GET', '/indicators'),
  monthly: () => req('GET', '/analytics/monthly'),
  exportReliabilityReport,
  mttr: () => req('GET', '/analytics/mttr'),
  slaCompliance: () => req('GET', '/analytics/sla'),
  crewProductivity: () => req('GET', '/analytics/crew-productivity'),
  outageFrequency: () => req('GET', '/analytics/outage-frequency'),
  feederKpiDefs: () => req('GET', '/analytics/feeder-kpi/defs'),
  feederKpi: (params) => req('GET', `/analytics/feeder-kpi?${new URLSearchParams(params)}`),
  feederKpiRatings: () => req('GET', '/analytics/feeder-kpi/ratings'),
  feederKpiChildSeries: (params) => req('GET', `/analytics/feeder-kpi/child-series?${new URLSearchParams(params)}`),
  feederKpiSeries: (params) => req('GET', `/analytics/feeder-kpi/series?${new URLSearchParams(params)}`),
  updateFeederKpiRating: (feeder, patch) => req('PUT', `/analytics/feeder-kpi/ratings/${encodeURIComponent(feeder)}`, patch),
  feederKpiRollup: (range) => req('POST', '/analytics/feeder-kpi/rollup', range),
  exportFeederKpi,
  exportFeederKpiPdf,
  audit: () => req('GET', '/audit'),
  network: () => req('GET', '/network'),
  networkTopology: () => req('GET', '/network/topology'),
  mapRegions: () => req('GET', '/map/regions'),   // regions the OMS can cut out of the in-house map
  networkSection: (mrid) => req('GET', `/network/section/${encodeURIComponent(mrid)}`),
  
  network: () => req('GET', '/network'),
  complaints: () => req('GET', '/complaints'),
  complaintTrace: (qid) => req('GET', `/complaints/${qid}/trace`),
  simulateComplaint: () => req('POST', '/complaints/simulate'),
  
};

// singleton socket
export const socket = io('/', { transports: ['websocket', 'polling'], autoConnect: true });