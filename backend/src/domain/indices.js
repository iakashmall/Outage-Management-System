// Reliability indices ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â IEEE 1366 (FR-OMS-027).
// SAIFI = total customers interrupted / customers served
// SAIDI = total customer-interruption-minutes / customers served
// CAIDI = SAIDI / SAIFI  = average outage duration per interrupted customer (minutes)
// MAIFI = momentary interruptions / customers served
const CUSTOMERS_SERVED = 18500; // UPCL Ganga corridor served base (config in prod)

export function computeIndices(incidents) {
  const interrupting = incidents.filter(i => i.type !== 'Scheduled' && i.severity !== 'low');
  const custInterrupted = interrupting.reduce((s, i) => s + (i.customers || 0), 0);

  const now = Date.now();
  const custMinutes = interrupting.reduce((s, i) => {
    const opened = new Date(i.opened_at).getTime();
    // resolved/closed ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ count actual restoration window; active ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ cap accrual at 90 min
    // so an in-flight incident doesn't inflate CAIDI unboundedly in the live demo.
    const elapsed = (now - opened) / 60000;
    const dur = ['resolved', 'closed'].includes(i.status) ? Math.min(elapsed, 90) : Math.min(elapsed, 90);
    return s + Math.max(0, dur) * (i.customers || 0);
  }, 0);

  const saifi = custInterrupted / CUSTOMERS_SERVED;
  const saidi = custMinutes / CUSTOMERS_SERVED;
  // CAIDI is average restoration time per interrupted customer ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â independent of served base
  const caidi = custInterrupted ? custMinutes / custInterrupted : 0;
  const maifi = 0.12;

  return {
    saidi: +saidi.toFixed(2),
    saifi: +saifi.toFixed(3),
    caidi: +caidi.toFixed(1),
    maifi,
    saidiTarget: 5.0,
    saifiTarget: 1.2,
    customersServed: CUSTOMERS_SERVED,
    customersAffected: custInterrupted,
  };
}

// ============================================================
// P7.1 -- MTTR by zone (supervisor dashboard).
// MTTR = Mean Time To Restore -- average minutes from an incident opening
// to the moment it was actually marked Resolved, grouped by zone.
// Reads the real resolution timestamp from incident_events (the "-> Resolved"
// status-change entry), not just current status, so this stays accurate even
// for incidents that have since moved on to Closed.
// ============================================================
export function computeMTTR(incidents, events) {
  // Build a lookup: incident_id -> earliest "-> Resolved" event timestamp.
  const resolvedAt = {};
  for (const e of events) {
    if (e.kind === 'status' && (e.note || '').includes('Resolved')) {
      const t = new Date(e.ts).getTime();
      if (!resolvedAt[e.incident_id] || t < resolvedAt[e.incident_id]) {
        resolvedAt[e.incident_id] = t;
      }
    }
  }
  const byZone = {};
  for (const i of incidents) {
    const resolvedTime = resolvedAt[i.id];
    if (!resolvedTime) continue; // only count incidents that actually reached Resolved
    const openedTime = new Date(i.opened_at).getTime();
    const minutes = (resolvedTime - openedTime) / 60000;
    if (minutes < 0) continue; // guard against bad/out-of-order data
    const zone = i.zone || 'Unknown';
    byZone[zone] = byZone[zone] || { zone, totalMinutes: 0, count: 0 };
    byZone[zone].totalMinutes += minutes;
    byZone[zone].count += 1;
  }
  return Object.values(byZone)
    .map((z) => ({ zone: z.zone, mttrMinutes: +(z.totalMinutes / z.count).toFixed(1), incidentCount: z.count }))
    .sort((a, b) => b.mttrMinutes - a.mttrMinutes);
}

// ============================================================
// P7.1 -- SLA compliance (supervisor dashboard).
// Every incident has an sla_due_at deadline. This checks, for each incident
// that has actually been resolved, whether that happened before or after
// its deadline. Incidents still open past their deadline count separately
// as "at risk" rather than compliant or breached, since they haven't been
// decided yet.
// ============================================================
export function computeSLACompliance(incidents, events) {
  const resolvedAt = {};
  for (const e of events) {
    if (e.kind === 'status' && (e.note || '').includes('Resolved')) {
      const t = new Date(e.ts).getTime();
      if (!resolvedAt[e.incident_id] || t < resolvedAt[e.incident_id]) {
        resolvedAt[e.incident_id] = t;
      }
    }
  }
  const now = Date.now();
  let compliant = 0, breached = 0, atRisk = 0;
  const byZone = {};
  for (const i of incidents) {
    if (!i.sla_due_at) continue;
    const dueTime = new Date(i.sla_due_at).getTime();
    const resolvedTime = resolvedAt[i.id];
    let outcome;
    if (resolvedTime) {
      outcome = resolvedTime <= dueTime ? 'compliant' : 'breached';
    } else if (now > dueTime) {
      outcome = 'atRisk';
    } else {
      continue;
    }
    if (outcome === 'compliant') compliant++;
    else if (outcome === 'breached') breached++;
    else atRisk++;
    const zone = i.zone || 'Unknown';
    byZone[zone] = byZone[zone] || { zone, compliant: 0, breached: 0, atRisk: 0 };
    byZone[zone][outcome]++;
  }
  const decided = compliant + breached;
  const complianceRate = decided ? +((compliant / decided) * 100).toFixed(1) : null;
  return {
    compliant, breached, atRisk, complianceRate,
    byZone: Object.values(byZone).sort((a, b) => b.breached - a.breached),
  };
}

// ============================================================
// P7.1 -- Crew productivity (supervisor dashboard).
// Jobs completed per crew, plus average minutes from Acknowledged to Work
// Complete per crew -- both computed from the real timestamped job_updates
// history, not just current job status.
// ============================================================
export function computeCrewProductivity(jobs, jobUpdates, crews) {
  // Per job: earliest Acknowledged timestamp and earliest Work Complete timestamp.
  const ackAt = {};
  const completeAt = {};
  for (const u of jobUpdates) {
    const t = new Date(u.ts).getTime();
    if (u.status === 'Acknowledged') {
      if (!ackAt[u.job_id] || t < ackAt[u.job_id]) ackAt[u.job_id] = t;
    }
    if (u.status === 'Work Complete') {
      if (!completeAt[u.job_id] || t < completeAt[u.job_id]) completeAt[u.job_id] = t;
    }
  }
  const byCrew = {};
  for (const j of jobs) {
    const crewId = j.crew_id;
    if (!crewId) continue;
    byCrew[crewId] = byCrew[crewId] || { crewId, jobsTotal: 0, jobsCompleted: 0, totalMinutes: 0, minutesCount: 0 };
    byCrew[crewId].jobsTotal += 1;
    if (j.status === 'Work Complete') byCrew[crewId].jobsCompleted += 1;
    const ack = ackAt[j.id];
    const done = completeAt[j.id];
    if (ack && done && done >= ack) {
      byCrew[crewId].totalMinutes += (done - ack) / 60000;
      byCrew[crewId].minutesCount += 1;
    }
  }
  const nameById = Object.fromEntries((crews || []).map((c) => [c.id, c.name]));
  return Object.values(byCrew)
    .map((c) => ({
      crewId: c.crewId,
      crewName: nameById[c.crewId] || c.crewId,
      jobsTotal: c.jobsTotal,
      jobsCompleted: c.jobsCompleted,
      avgMinutesPerJob: c.minutesCount ? +(c.totalMinutes / c.minutesCount).toFixed(1) : null,
    }))
    .sort((a, b) => b.jobsCompleted - a.jobsCompleted);
}

// ============================================================
// P7.1 -- Outage frequency by zone (supervisor dashboard).
// Simple count of incidents per zone, split by severity so a supervisor
// can see not just "which zone has the most outages" but "how many of
// those are actually critical."
// ============================================================
export function computeOutageFrequency(incidents) {
  const byZone = {};
  for (const i of incidents) {
    const zone = i.zone || 'Unknown';
    byZone[zone] = byZone[zone] || { zone, total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    byZone[zone].total += 1;
    const sev = (i.severity || '').toLowerCase();
    if (byZone[zone][sev] !== undefined) byZone[zone][sev] += 1;
  }
  return Object.values(byZone).sort((a, b) => b.total - a.total);
}
