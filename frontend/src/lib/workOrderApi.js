// OMS-03 daily work orders: the control room's read-only view. Like
// dispatchApi, errors keep the server's message and code, plus the HTTP
// status so the screen can tell 401 / 403 from no network (no status).
import { req } from './api.js';

export const workOrderApi = {
  // { date, crews: [{ crew: { id, name, lead }, workOrder, jobs: { open, done }, summary }] }
  // Without a date the server answers for its own today.
  day: async (date) => {
    try {
      return await req('GET', `/work-orders${date ? `?date=${encodeURIComponent(date)}` : ''}`);
    } catch (e) {
      throw Object.assign(new Error(e.data?.message || e.message), { code: e.data?.code, status: e.status });
    }
  },
};
