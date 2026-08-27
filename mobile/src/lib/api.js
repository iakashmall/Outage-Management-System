import { authHeader, myCrewId, logout as kcLogout } from "./auth.js";

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

const CREWS = {
  C001: { id: "C001", name: "Crew Alpha-3", lead: "Rajesh Kumar", role: "Field Technician", shift: "06:00-18:00", skills: ["HV","Underground"] },
  C002: { id: "C002", name: "Crew Beta-1", lead: "Amit Sharma", role: "Field Technician", shift: "06:00-18:00", skills: ["MV","Recloser"] },
  C003: { id: "C003", name: "Crew Gamma-2", lead: "Priya Singh", role: "Field Technician", shift: "06:00-18:00", skills: ["HV","Transformer"] },
};

export async function getCurrentCrew() {
  const id = myCrewId();
  try {
    return await req("/mobile/crews/" + id);
  } catch {
    return CREWS[id] || CREWS.C003;
  }
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
    assignedCrewId: j.crew_id,
    incidentId: j.incident_id,
  }));
}

export async function updateJobStatus(id, status, location = {}) {
  return req("/mobile/jobs/" + id + "/status", "PATCH", {
    status,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
  });
}

export async function updateMyJob(id, job) {
  return updateJobStatus(id, job.status, job.location || {});
}

export function logout() {
  kcLogout();
}

export async function uploadJobPhoto(jobId, dataUrl, location = {}, note) {
  return req('/mobile/jobs/' + jobId + '/photos', 'POST', {
    dataUrl,
    lat: location.lat ?? null,
    lon: location.lon ?? null,
    note: note ?? null,
  });
}

export async function getMessages(incidentId) {
  return req('/incidents/' + incidentId + '/messages');
}

export async function postMessage(incidentId, body) {
  return req('/incidents/' + incidentId + '/messages', 'POST', { body });
}
