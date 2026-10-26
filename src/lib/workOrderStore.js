// src/lib/workOrderStore.js
// What the phone keeps about the crew's daily work order (OMS-03), so the
// Today screen works without signal:
//   - the server's last answer for the day
//   - a start / end of day made offline, until pending sync has sent it
//   - the crew members named last time, to pre-fill the next start of day
import AsyncStorage from "@react-native-async-storage/async-storage";

const SERVER_KEY = "oms-work-order-server";
const PENDING_KEY = "oms-work-order-pending";
const MEMBERS_KEY = "oms-work-order-members";

async function read(key, fallback) {
  try {
    const stored = await AsyncStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}
const write = (key, value) => AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});

export const getCachedWorkOrder = () => read(SERVER_KEY, null);
export const cacheWorkOrder = (workOrder) => write(SERVER_KEY, workOrder);

// { crewId, date, start?, close? } (the payloads), or null.
export const getPendingWorkOrder = () => read(PENDING_KEY, null);

export async function setPendingWorkOrder(crewId, date, kind, payload) {
  const current = await getPendingWorkOrder();
  const same = current && current.crewId === crewId && current.date === date;
  await write(PENDING_KEY, { ...(same ? current : {}), crewId, date, [kind]: payload });
}

// Called once pending sync has dealt with the item (sent, refused or not applied).
export async function clearPendingWorkOrder(date, kind) {
  const current = await getPendingWorkOrder();
  if (!current || current.date !== date || !current[kind]) return;
  const next = { ...current };
  delete next[kind];
  if (next.start || next.close) await write(PENDING_KEY, next);
  else await AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
}

export const getLastMembers = () => read(MEMBERS_KEY, []);
export const saveLastMembers = (members) => write(MEMBERS_KEY, members);

// Signing out: the next crew on this phone starts clean. A start or end of
// day still in pending sync is kept until it is sent, like other queued items.
export async function clearWorkOrderCache() {
  await AsyncStorage.multiRemove([SERVER_KEY, MEMBERS_KEY]).catch(() => {});
}
