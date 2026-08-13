import { db } from './db.js';
import { nanoid } from 'nanoid';

// The only module that talks SQL. Replace with a Postgres/Prisma implementation
// and the routes/domain layers are untouched (clean-architecture seam).
const parseSkills = (r) => r ? { ...r, skills: r.skills ? r.skills.split(',') : [] } : r;

export const repo = {
  // ---- incidents
  incidents: () => db.prepare('SELECT * FROM incidents ORDER BY opened_at DESC').all(),
  incident: (id) => db.prepare('SELECT * FROM incidents WHERE id=?').get(id),
  incidentEvents: (id) => db.prepare('SELECT * FROM incident_events WHERE incident_id=? ORDER BY ts ASC').all(id),
  nextIncidentId: () => {
    const n = db.prepare("SELECT COUNT(*) c FROM incidents").get().c + 1;
    return 'INC-2026-' + String(n).padStart(6, '0');
  },
  createIncident: (i) => {
    db.prepare(`INSERT INTO incidents
      (id,type,severity,status,zone,feeder,customers,cause,lat,lon,crew_id,opened_at,ert,sla_due_at,source,substation)
      VALUES (@id,@type,@severity,@status,@zone,@feeder,@customers,@cause,@lat,@lon,@crew_id,@opened_at,@ert,@sla_due_at,@source,@substation)`).run({ substation: null, ...i });
    return repo.incident(i.id);
  },
  updateIncident: (id, patch) => {
    const cols = Object.keys(patch).map(k => `${k}=@${k}`).join(',');
    db.prepare(`UPDATE incidents SET ${cols} WHERE id=@id`).run({ ...patch, id });
    return repo.incident(id);
  },
  addIncidentEvent: (incidentId, actor, kind, note) => {
    const ev = { id: 'EV' + nanoid(8), incident_id: incidentId, ts: new Date().toISOString(), actor, kind, note };
    db.prepare(`INSERT INTO incident_events (id,incident_id,ts,actor,kind,note) VALUES (@id,@incident_id,@ts,@actor,@kind,@note)`).run(ev);
    return ev;
  },

  // ---- complaints (external REST intake, dedup + merge, traceability)
  complaints: () => db.prepare('SELECT * FROM complaints ORDER BY ts DESC').all(),
  complaint: (qid) => db.prepare('SELECT * FROM complaints WHERE qid=?').get(qid),
  complaintsForIncident: (incidentId) => db.prepare('SELECT * FROM complaints WHERE incident_id=? ORDER BY ts ASC').all(incidentId),
  nextQueryId: () => {
    const n = db.prepare('SELECT COUNT(*) c FROM complaints').get().c + 1;
    return 'QRY-2026-' + String(n).padStart(6, '0');
  },
  addComplaint: (c) => {
    db.prepare(`INSERT INTO complaints
      (qid,external_id,customer,phone,address,category,lat,lon,dt_id,feeder,substation,incident_id,action,ts)
      VALUES (@qid,@external_id,@customer,@phone,@address,@category,@lat,@lon,@dt_id,@feeder,@substation,@incident_id,@action,@ts)`).run(c);
    return repo.complaint(c.qid);
  },
  // Active incidents at a substation within the correlation window (most recent first).
  activeIncidentsAtSubstation: (substation, windowMin = 240) => {
    const cutoff = new Date(Date.now() - windowMin * 60000).toISOString();
    return db.prepare(
      `SELECT * FROM incidents
       WHERE substation IS @substation
         AND status NOT IN ('resolved','closed','cancelled')
         AND opened_at >= @cutoff
       ORDER BY opened_at DESC`
    ).all({ substation, cutoff });
  },

  // ---- crews
  crews: () => db.prepare('SELECT * FROM crews ORDER BY name').all().map(parseSkills),
  crew: (id) => parseSkills(db.prepare('SELECT * FROM crews WHERE id=?').get(id)),
  updateCrew: (id, patch) => {
    const cols = Object.keys(patch).map(k => `${k}=@${k}`).join(',');
    db.prepare(`UPDATE crews SET ${cols} WHERE id=@id`).run({ ...patch, id });
    return repo.crew(id);
  },

  // ---- alarms
  alarms: () => db.prepare('SELECT * FROM alarms ORDER BY ts DESC').all(),
  updateAlarm: (id, patch) => {
    const cols = Object.keys(patch).map(k => `${k}=@${k}`).join(',');
    db.prepare(`UPDATE alarms SET ${cols} WHERE id=@id`).run({ ...patch, id });
    return db.prepare('SELECT * FROM alarms WHERE id=?').get(id);
  },
  createAlarm: (a) => {
    db.prepare(`INSERT INTO alarms (id,tag,condition,limit_val,priority,message,ts,ack)
      VALUES (@id,@tag,@condition,@limit_val,@priority,@message,@ts,@ack)`).run(a);
    return db.prepare('SELECT * FROM alarms WHERE id=?').get(a.id);
  },

  // ---- trouble calls
  calls: () => db.prepare('SELECT * FROM trouble_calls ORDER BY ts DESC').all(),
  createCall: (c) => {
    db.prepare(`INSERT INTO trouble_calls (id,customer,phone,address,category,status,linked_id,ts)
      VALUES (@id,@customer,@phone,@address,@category,@status,@linked_id,@ts)`).run(c);
    return db.prepare('SELECT * FROM trouble_calls WHERE id=?').get(c.id);
  },
  updateCall: (id, patch) => {
    const cols = Object.keys(patch).map(k => `${k}=@${k}`).join(',');
    db.prepare(`UPDATE trouble_calls SET ${cols} WHERE id=@id`).run({ ...patch, id });
    return db.prepare('SELECT * FROM trouble_calls WHERE id=?').get(id);
  },

  // ---- jobs (crew app)
  jobs: () => db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC').all(),
  jobsForCrew: (crewId) => db.prepare('SELECT * FROM jobs WHERE crew_id=? ORDER BY updated_at DESC').all(crewId),
  jobUpdates: (jobId) => db.prepare('SELECT * FROM job_updates WHERE job_id=? ORDER BY ts ASC').all(jobId),
  job: (id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id),
  createJob: (j) => {
    db.prepare(`INSERT INTO jobs (id,incident_id,crew_id,priority,status,address,updated_at)
      VALUES (@id,@incident_id,@crew_id,@priority,@status,@address,@updated_at)`).run(j);
    return repo.job(j.id);
  },
  updateJob: (id, patch) => {
    const cols = Object.keys(patch).map(k => `${k}=@${k}`).join(',');
    db.prepare(`UPDATE jobs SET ${cols} WHERE id=@id`).run({ ...patch, id });
    return repo.job(id);
  },
  addJobUpdate: (jobId, status, lat, lon, note) => {
    const u = { id: 'JU' + nanoid(8), job_id: jobId, status, lat, lon, note, ts: new Date().toISOString() };
    db.prepare(`INSERT INTO job_updates (id,job_id,status,lat,lon,note,ts) VALUES (@id,@job_id,@status,@lat,@lon,@note,@ts)`).run(u);
    return u;
  },

  audit: (actor, action, target) => {
    db.prepare(`INSERT INTO audit_log (id,ts,actor,action,target) VALUES (?,?,?,?,?)`)
      .run('AU' + nanoid(8), new Date().toISOString(), actor, action, target);
  },
  auditLog: () => db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50').all(),
};
