import { db } from './db.js';
import { nanoid } from 'nanoid';

// The only module that talks SQL. Every function is now async because the
// pg driver is async (unlike node:sqlite/better-sqlite3, which were sync).
// Named params use pg-promise's $/name/ syntax instead of the old bare @name.
const parseSkills = (r) => r ? { ...r, skills: r.skills ? r.skills.split(',') : [] } : r;

// Builds a "col=$/col/" SET clause from a patch object — same dynamic-update
// pattern as before, just async at the call site now.
const setClause = (patch) => Object.keys(patch).map(k => `${k}=$/${k}/`).join(',');

export const repo = {
  // ---- incidents
  incidents: () => db.any('SELECT * FROM incidents ORDER BY opened_at DESC'),
  incident: (id) => db.oneOrNone('SELECT * FROM incidents WHERE id=$1', [id]),
  incidentEvents: (id) => db.any('SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY ts ASC', [id]),
  nextIncidentId: async () => {
    const { c } = await db.one('SELECT COUNT(*) c FROM incidents');
    return 'INC-2026-' + String(Number(c) + 1).padStart(6, '0');
  },
  createIncident: async (i) => {
    const row = { substation: null, ...i };
    await db.none(`INSERT INTO incidents
      (id,type,severity,status,zone,feeder,customers,cause,lat,lon,crew_id,opened_at,ert,sla_due_at,source,substation)
      VALUES ($/id/,$/type/,$/severity/,$/status/,$/zone/,$/feeder/,$/customers/,$/cause/,$/lat/,$/lon/,$/crew_id/,$/opened_at/,$/ert/,$/sla_due_at/,$/source/,$/substation/)`,
      row);
    return repo.incident(i.id);
  },
  updateIncident: async (id, patch) => {
    await db.none(`UPDATE incidents SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return repo.incident(id);
  },
  addIncidentEvent: async (incidentId, actor, kind, note) => {
    const ev = { id: 'EV' + nanoid(8), incident_id: incidentId, ts: new Date().toISOString(), actor, kind, note };
    await db.none(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note)
      VALUES ($/id/,$/incident_id/,$/ts/,$/actor/,$/kind/,$/note/)`, ev);
    return ev;
  },

  // ---- complaints (external REST intake, dedup + merge, traceability)
  complaints: () => db.any('SELECT * FROM complaints ORDER BY ts DESC'),
  complaint: (qid) => db.oneOrNone('SELECT * FROM complaints WHERE qid=$1', [qid]),
  complaintsForIncident: (incidentId) => db.any('SELECT * FROM complaints WHERE incident_id=$1 ORDER BY ts ASC', [incidentId]),
  nextQueryId: async () => {
    const { c } = await db.one('SELECT COUNT(*) c FROM complaints');
    return 'QRY-2026-' + String(Number(c) + 1).padStart(6, '0');
  },
  addComplaint: async (c) => {
    await db.none(`INSERT INTO complaints
      (qid,external_id,customer,phone,address,category,lat,lon,dt_id,feeder,substation,incident_id,action,ts)
      VALUES ($/qid/,$/external_id/,$/customer/,$/phone/,$/address/,$/category/,$/lat/,$/lon/,$/dt_id/,$/feeder/,$/substation/,$/incident_id/,$/action/,$/ts/)`,
      c);
    return repo.complaint(c.qid);
  },
  // Active incidents at a substation within the correlation window (most recent first).
  activeIncidentsAtSubstation: (substation, windowMin = 240) => {
    const cutoff = new Date(Date.now() - windowMin * 60000).toISOString();
    return db.any(
      `SELECT * FROM incidents
       WHERE substation IS NOT DISTINCT FROM $/substation/
         AND status NOT IN ('resolved','closed','cancelled')
         AND opened_at >= $/cutoff/
       ORDER BY opened_at DESC`,
      { substation, cutoff }
    );
  },

  // ---- crews
  crews: async () => (await db.any('SELECT * FROM crews ORDER BY name')).map(parseSkills),
  crew: async (id) => parseSkills(await db.oneOrNone('SELECT * FROM crews WHERE id=$1', [id])),
  updateCrew: async (id, patch) => {
    await db.none(`UPDATE crews SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return repo.crew(id);
  },
  // Available crews nearest an incident, using real PostGIS distance — replaces
  // picking "any available crew" with a distance-ranked list.
  nearestAvailableCrews: (incidentId, limit = 6) =>
    db.any(`
      SELECT c.*, public.ST_Distance(c.geog, i.geog) AS meters_away
      FROM crews c, incidents i
      WHERE i.id = $1
        AND c.status = 'available'
        AND c.geog IS NOT NULL AND i.geog IS NOT NULL
      ORDER BY meters_away
      LIMIT $2
    `, [incidentId, limit]),
  // ---- alarms
  alarms: () => db.any('SELECT * FROM alarms ORDER BY ts DESC'),
  updateAlarm: async (id, patch) => {
    await db.none(`UPDATE alarms SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return db.oneOrNone('SELECT * FROM alarms WHERE id=$1', [id]);
  },
  createAlarm: async (a) => {
    await db.none(`INSERT INTO alarms (id,tag,condition,limit_val,priority,message,ts,ack)
      VALUES ($/id/,$/tag/,$/condition/,$/limit_val/,$/priority/,$/message/,$/ts/,$/ack/)`, a);
    return db.oneOrNone('SELECT * FROM alarms WHERE id=$1', [a.id]);
  },

  // ---- trouble calls
  calls: () => db.any('SELECT * FROM trouble_calls ORDER BY ts DESC'),
  createCall: async (c) => {
    await db.none(`INSERT INTO trouble_calls (id,customer,phone,address,category,status,linked_id,ts)
      VALUES ($/id/,$/customer/,$/phone/,$/address/,$/category/,$/status/,$/linked_id/,$/ts/)`, c);
    return db.oneOrNone('SELECT * FROM trouble_calls WHERE id=$1', [c.id]);
  },
  updateCall: async (id, patch) => {
    await db.none(`UPDATE trouble_calls SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return db.oneOrNone('SELECT * FROM trouble_calls WHERE id=$1', [id]);
  },

  // ---- jobs (crew app)
  jobs: () => db.any('SELECT * FROM jobs ORDER BY updated_at DESC'),
  jobsForCrew: (crewId) => db.any('SELECT * FROM jobs WHERE crew_id=$1 ORDER BY updated_at DESC', [crewId]),
  jobUpdates: (jobId) => db.any('SELECT * FROM job_updates WHERE job_id=$1 ORDER BY ts ASC', [jobId]),
  job: (id) => db.oneOrNone('SELECT * FROM jobs WHERE id=$1', [id]),
  createJob: async (j) => {
    await db.none(`INSERT INTO jobs (id,incident_id,crew_id,priority,status,address,updated_at)
      VALUES ($/id/,$/incident_id/,$/crew_id/,$/priority/,$/status/,$/address/,$/updated_at/)`, j);
    return repo.job(j.id);
  },
  updateJob: async (id, patch) => {
    await db.none(`UPDATE jobs SET ${setClause(patch)} WHERE id=$/id/`, { ...patch, id });
    return repo.job(id);
  },
  addJobUpdate: async (jobId, status, lat, lon, note) => {
    const u = { id: 'JU' + nanoid(8), job_id: jobId, status, lat, lon, note, ts: new Date().toISOString() };
    await db.none(`INSERT INTO job_updates (id,job_id,status,lat,lon,note,ts)
      VALUES ($/id/,$/job_id/,$/status/,$/lat/,$/lon/,$/note/,$/ts/)`, u);
    return u;
  },

  // ---- admin / audit
  audit: async (actor, action, target) => {
    await db.none(`INSERT INTO audit_log (id,ts,actor,action,target) VALUES ($1,$2,$3,$4,$5)`,
      ['AU' + nanoid(8), new Date().toISOString(), actor, action, target]);
  },
  auditLog: () => db.any('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50'),
};