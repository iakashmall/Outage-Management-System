// Records what offlineQueue sends; globalThis.__apiCalls is reset by tests.
const calls = () => (globalThis.__apiCalls ??= []);
const ok = (kind) => async (...args) => { calls().push({ kind, args }); return { applied: true }; };
export const updateJobStatus = ok("status");
export const uploadJobPhoto = ok("photo");
export const saveAssetScan = ok("scan");
export const postJobCompletion = ok("completion");
export const postJobChecklist = ok("checklist");
export const startWorkOrder = ok("wo-start");
export const closeWorkOrder = ok("wo-close");
export const isSignedIn = async () => true;
export const isNotYourJob = (err) => err?.code === "NOT_YOUR_JOB";
