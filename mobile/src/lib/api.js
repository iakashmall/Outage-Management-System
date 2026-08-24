import { authHeader, myCrewId } from "./auth.js";

const BASE = "/api";

async function req(path, method = "GET", body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getMyJobs() {
  const jobs = await req("/mobile/crews/" + myCrewId() + "/jobs");
  return jobs.map((j) => ({
    id: j.id,
    title: j.incident?.type || "Outage",
    address: j.address || j.incident?.zone || "Location unavailable",
    feeder: j.incident?.feeder || "-",
    severity: j.incident?.severity || "Medium",
    priority: j.priority || "Normal",
    customers: j.incident?.customers ?? 0,
    status: j.status,
    distance: "-",
    eta: "-",
    assignedCrewId: j.crew_id,
    assignedDistance: "Assigned",
    incidentId: j.incident_id,
  }));
}

export async function updateJobStatus(jobId, status, extra = {}) {
  return req("/mobile/jobs/" + jobId + "/status", "PATCH", { status, ...extra });
}
