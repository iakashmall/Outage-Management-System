// Reliability indices — IEEE 1366 (FR-OMS-027).
// SAIFI = total customers interrupted / customers served
// SAIDI = total customer-interruption-minutes / customers served
// CAIDI = SAIDI / SAIFI  = average outage duration per interrupted customer (minutes)
// MAIFI = momentary interruptions / customers served
const CUSTOMERS_SERVED = 18500; // UPCL Ganga corridor served base (config in prod)

// P7.2 requires filtering "by date, zone and asset type." The incidents
// table doesn't track a distinct asset-type field (transformer/feeder/
// switch/breaker) today — the closest existing field is `source`
// (SCADA/TCS/MANUAL/PLANNED). Filtering on that is included below as the
// practical stand-in, but it isn't the same thing as true asset-type
// filtering, and that gap is real, not hidden — flag it before this ships
// as an official regulatory report filter, since a regulator or manager
// reading "asset type: SCADA" would reasonably expect "transformer" or
// "breaker," not a signal-source label.
export function filterIncidents(incidents, filters = {}) {
  let out = incidents;
  if (filters.from) {
    const from = new Date(filters.from).getTime();
    out = out.filter((i) => new Date(i.opened_at).getTime() >= from);
  }
  if (filters.to) {
    const to = new Date(filters.to).getTime();
    out = out.filter((i) => new Date(i.opened_at).getTime() <= to);
  }
  if (filters.zone) {
    out = out.filter((i) => (i.zone || '').toLowerCase() === filters.zone.toLowerCase());
  }
  if (filters.assetType) {
    out = out.filter((i) => (i.source || '').toLowerCase() === filters.assetType.toLowerCase());
  }
  return out;
}

export function computeIndices(incidents, filters = {}) {
  const scoped = filterIncidents(incidents, filters);
  const interrupting = scoped.filter((i) => i.type !== 'Scheduled' && i.severity !== 'low');
  const custInterrupted = interrupting.reduce((s, i) => s + (i.customers || 0), 0);

  const now = Date.now();
  const custMinutes = interrupting.reduce((s, i) => {
    const opened = new Date(i.opened_at).getTime();
    const elapsed = (now - opened) / 60000;
    const dur = ['resolved', 'closed'].includes(i.status) ? Math.min(elapsed, 90) : Math.min(elapsed, 90);
    return s + Math.max(0, dur) * (i.customers || 0);
  }, 0);

  const saifi = custInterrupted / CUSTOMERS_SERVED;
  const saidi = custMinutes / CUSTOMERS_SERVED;
  const caidi = custInterrupted ? custMinutes / custInterrupted : 0;
  // MAIFI: still a fixed placeholder, unchanged from the original
  // calculation — flagging rather than quietly leaving it unexplained,
  // since a real regulatory export implies every number on it is real.
  // Computing a genuine MAIFI needs momentary-interruption events (breaker
  // auto-reclose within <5 min per the SDP's own definition), which isn't
  // tracked as a distinct event type in the current incidents schema.
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
    incidentCount: interrupting.length,
    filters: {
      from: filters.from || null,
      to: filters.to || null,
      zone: filters.zone || null,
      assetType: filters.assetType || null,
    },
  };
}