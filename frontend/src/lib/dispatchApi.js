// OMS-03 workload balancing: dispatcher calls. Like plannedApi, rule
// rejections come back as { code, message }; surface the message and keep
// the code (and any `problems` list of a stale proposal).
import { req } from './api.js';

const call = async (method, path, body) => {
  try {
    return await req(method, path, body);
  } catch (e) {
    throw Object.assign(new Error(e.data?.message || e.message), { code: e.data?.code, problems: e.data?.problems, status: e.status });
  }
};

export const dispatchApi = {
  // { settings, crews: [{ ...crew, load, weight, over, jobs }], unassigned: [job], openProposal }
  workload: () => call('GET', '/dispatch/workload'),
  saveSettings: (settings) => call('PUT', '/dispatch/settings', settings),
  addCrew: (body) => call('POST', '/crews', body),
  updateCrew: (id, patch) => call('PATCH', `/crews/${encodeURIComponent(id)}`, patch),
  propose: () => call('POST', '/dispatch/rebalance/propose'),
  apply: (id) => call('POST', `/dispatch/rebalance/proposals/${encodeURIComponent(id)}/apply`),
  reject: (id, note) => call('POST', `/dispatch/rebalance/proposals/${encodeURIComponent(id)}/reject`, { note }),
  history: () => call('GET', '/dispatch/rebalance/history'), // { proposals, reassignments }
};
