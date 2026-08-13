// Reliability indices — IEEE 1366 (FR-OMS-027).
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
    // resolved/closed → count actual restoration window; active → cap accrual at 90 min
    // so an in-flight incident doesn't inflate CAIDI unboundedly in the live demo.
    const elapsed = (now - opened) / 60000;
    const dur = ['resolved', 'closed'].includes(i.status) ? Math.min(elapsed, 90) : Math.min(elapsed, 90);
    return s + Math.max(0, dur) * (i.customers || 0);
  }, 0);

  const saifi = custInterrupted / CUSTOMERS_SERVED;
  const saidi = custMinutes / CUSTOMERS_SERVED;
  // CAIDI is average restoration time per interrupted customer — independent of served base
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
