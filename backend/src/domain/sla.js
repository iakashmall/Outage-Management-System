// Restoration SLA by severity, in minutes (FR-OMS-008). Shared by every path
// that opens an incident (manual, SCADA) so escalation treats them alike.
export const SLA_MINUTES = { critical: 90, high: 180, medium: 360, low: 720 };

export const slaMinutes = (severity) => SLA_MINUTES[severity] || SLA_MINUTES.medium;

export const slaDueAt = (severity, openedAt = new Date()) =>
  new Date(new Date(openedAt).getTime() + slaMinutes(severity) * 60000).toISOString();
