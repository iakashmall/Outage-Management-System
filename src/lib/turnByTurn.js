// src/lib/turnByTurn.js
// Turn-by-turn instructions for the in-app navigation, worked out from the
// road route's geometry (roadRouting.js gives only the line, no street
// names): every bend sharper than TURN_DEG becomes a turn, and the crew's
// distance along the route says which turn is next and how far away it is.
// Pure functions, no React Native imports.

const TURN_DEG = 35; // a smaller bend is the road curving, not a turn
const MERGE_M = 25; // bends closer together than this are one turn (a junction drawn as two points)
const START_M = 20; // the hop from the crew's GPS fix onto the road is not a turn

const rad = (d) => (d * Math.PI) / 180;

function meters(a, b) {
  const dx = (b[1] - a[1]) * 111320 * Math.cos(rad((a[0] + b[0]) / 2));
  const dy = (b[0] - a[0]) * 111320;
  return Math.hypot(dx, dy);
}

function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Signed change of heading, -180..180 (positive = to the right).
const delta = (from, to) => ((to - from + 540) % 360) - 180;

function turnWord(d) {
  const a = Math.abs(d);
  const side = d > 0 ? 'right' : 'left';
  if (a >= 150) return 'Make a U-turn';
  if (a >= 110) return `Turn sharp ${side}`;
  if (a >= 60) return `Turn ${side}`;
  return `Keep ${side}`;
}

// coords: [[lat, lon], ...] as the route gives them. Returns the route's
// length and its steps: { at (metres from the start), text, kind } -- every
// turn, then the arrival.
export function buildSteps(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return { length: 0, steps: [] };
  // Cumulative distance at each point; repeated points dropped.
  const pts = [coords[0]];
  const cum = [0];
  for (let i = 1; i < coords.length; i += 1) {
    const d = meters(pts[pts.length - 1], coords[i]);
    if (d < 0.5) continue;
    pts.push(coords[i]);
    cum.push(cum[cum.length - 1] + d);
  }
  const length = cum[cum.length - 1];
  const steps = [];
  for (let i = 1; i < pts.length - 1; i += 1) {
    // Heading in and out of the bend, over a few metres each side so a
    // jagged point in the line does not read as a turn.
    let j = i - 1;
    while (j > 0 && cum[i] - cum[j] < MERGE_M) j -= 1;
    let k = i + 1;
    while (k < pts.length - 1 && cum[k] - cum[i] < MERGE_M) k += 1;
    const d = delta(bearing(pts[j], pts[i]), bearing(pts[i], pts[k]));
    if (Math.abs(d) < TURN_DEG || cum[i] < START_M) continue;
    const last = steps[steps.length - 1];
    if (last && cum[i] - last.at < MERGE_M) {
      // Same junction: keep the sharper reading.
      if (Math.abs(d) > Math.abs(last.deg)) Object.assign(last, { deg: d, text: turnWord(d) });
      continue;
    }
    steps.push({ at: cum[i], deg: d, text: turnWord(d), kind: 'turn' });
  }
  steps.push({ at: length, deg: 0, text: 'Arrive at the site', kind: 'arrive' });
  return { length, steps };
}

// The next step for a crew `left` metres from the end of the route, and how
// far ahead it is. null with no route.
export function nextStep(plan, left) {
  if (!plan?.steps?.length || !Number.isFinite(left)) return null;
  const along = Math.max(0, plan.length - left);
  const step = plan.steps.find((s) => s.at > along + 3) || plan.steps[plan.steps.length - 1];
  const after = plan.steps[plan.steps.indexOf(step) + 1] || null;
  return { ...step, inM: Math.max(0, step.at - along), then: after };
}

// "In 120 m, turn left" / "Turn left now".
export function stepSentence(step) {
  if (!step) return '';
  if (step.inM < 15) return step.kind === 'arrive' ? 'You have arrived at the site' : `${step.text} now`;
  const d = step.inM < 1000 ? `${Math.round(step.inM / 10) * 10} m` : `${(step.inM / 1000).toFixed(1)} km`;
  return `In ${d}, ${step.text.charAt(0).toLowerCase()}${step.text.slice(1)}`;
}

// The distances at which a step is spoken (once each, as the crew closes in).
export const ANNOUNCE_AT_M = [400, 150, 40];
