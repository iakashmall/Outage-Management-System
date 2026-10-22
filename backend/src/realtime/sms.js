// SMS gateway seam (FR-OMS-021). Every SMS the OMS sends goes through
// sendSmsVia(), which picks a driver from SMS_DRIVER. Only 'console' exists
// today: it prints the message and reports status 'logged'. A real provider
// (Brevo / Twilio / MSG91 - all need Indian DLT sender + template
// registration) is one more entry in DRIVERS returning { status: 'sent' }
// or throwing; callers and the notifications table don't change.

export const maskPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d ? '*'.repeat(Math.max(0, d.length - 4)) + d.slice(-4) : null;
};

const DRIVERS = {
  console: async ({ to, body, label }) => {
    console.log(`[sms] (console only) -> ${label || maskPhone(to)}: ${body}`);
    return { status: 'logged' };
  },
};

export const smsDriverName = () => (process.env.SMS_DRIVER || 'console').toLowerCase();

// Returns { status: 'logged' | 'sent' | 'failed', error }. Never throws, so a
// gateway outage can't break the incident flow that triggered the SMS.
export async function sendSmsVia({ to, body, label }) {
  const name = smsDriverName();
  const driver = DRIVERS[name];
  if (!driver) return { status: 'failed', error: `Unknown SMS_DRIVER "${name}"` };
  try {
    return await driver({ to, body, label });
  } catch (e) {
    console.error(`[sms] ${name} failed:`, e.message);
    return { status: 'failed', error: e.message };
  }
}
