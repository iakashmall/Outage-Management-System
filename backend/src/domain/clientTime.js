// When something the crew app reports actually happened. A confirmation
// recorded offline carries `at` (when it happened, phone clock) and `sentAt`
// (when it was sent, same clock); the difference is applied to the server's
// clock, so a phone whose clock is off still lands at the right time.
// No `at`, an unparsable one, or one older than maxAgeMs -> now. Never in the
// future. 72 h is the crew app's offline limit (FR-APP-010); the raw client
// values are kept in the safety log, so a replaced time stays visible.
export const MAX_CLIENT_AGE_MS = 72 * 3600 * 1000;
export function clientTime(at, sentAt, { now = Date.now(), maxAgeMs = MAX_CLIENT_AGE_MS } = {}) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return new Date(now).toISOString();
  const s = Date.parse(sentAt);
  const corrected = Number.isFinite(s) ? now - (s - t) : t;
  if (corrected > now || now - corrected > maxAgeMs) return new Date(now).toISOString();
  return new Date(corrected).toISOString();
}
