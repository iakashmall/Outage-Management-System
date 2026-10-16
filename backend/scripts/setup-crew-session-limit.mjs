// One crew login = one phone at a time.
//
// Keycloak lets a user be signed in on any number of devices, so two people
// could use the same crewXX login at once (two GPS trails for one crew, both
// changing the same jobs). This adds Keycloak's "User session count limiter"
// to the sign-in flow, for users with the field_crew role only:
//   - at most 1 session per crew login in the crew app (client oms-mobile);
//     a crew may still be signed in to the dashboard at the same time
//   - signing in on a second phone ends the session on the first one
//     ("Terminate oldest session"), so a crew that changes phones, or whose
//     app was removed without signing out, is never locked out.
// The first phone keeps working until its access token runs out (at most
// accessTokenLifespan, 5 minutes), then its token refresh is refused.
// Operators and other users are not affected.
//
// Idempotent — safe to re-run. Talks to Keycloak's admin REST API, so it
// works on an existing Keycloak (the realm JSON in infra/ is only read on a
// fresh import). Only touches the sign-in flow: no users or passwords.
//
// Usage (from backend/, with Keycloak running; needs the field_crew role,
// see npm run keycloak:mobile):
//   npm run keycloak:session-limit
// On the server:
//   KEYCLOAK_ADMIN_PASSWORD='<admin password>' npm run keycloak:session-limit
//
// Env:
//   KEYCLOAK_URL             default http://localhost:18080
//   KEYCLOAK_ADMIN           default admin
//   KEYCLOAK_ADMIN_PASSWORD  default admin

const KC = (process.env.KEYCLOAK_URL || 'http://localhost:18080').replace(/\/$/, '');
const REALM = 'oms-upcl';
const ADMIN_USER = process.env.KEYCLOAK_ADMIN || 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';
const CREW_ROLE = 'field_crew';
const SUBFLOW = 'Crew one phone per login';

let token = null;

async function kc(method, path, body) {
  const response = await fetch(`${KC}/admin/realms/${REALM}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function adminLogin() {
  const response = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: ADMIN_USER, password: ADMIN_PASSWORD }),
  }).catch((err) => {
    throw new Error(`Cannot reach Keycloak at ${KC} (${err.cause?.code || err.message}). Is it running?`);
  });
  if (!response.ok) throw new Error(`Keycloak admin login failed (${response.status}) — check KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD.`);
  token = (await response.json()).access_token;
}

const flowPath = (alias) => `/authentication/flows/${encodeURIComponent(alias)}`;
const executions = (alias) => kc('GET', `${flowPath(alias)}/executions`);

async function setRequirement(flowAlias, execution, requirement) {
  if (execution.requirement === requirement) return;
  await kc('PUT', `${flowPath(flowAlias)}/executions`, { ...execution, requirement });
}

// Adds the authenticator to the flow once, makes it REQUIRED and writes its settings.
async function ensureStep(flowAlias, provider, configAlias, config) {
  let step = (await executions(flowAlias)).find((e) => e.providerId === provider);
  if (!step) {
    await kc('POST', `${flowPath(flowAlias)}/executions/execution`, { provider });
    step = (await executions(flowAlias)).find((e) => e.providerId === provider);
  }
  await setRequirement(flowAlias, step, 'REQUIRED');
  if (step.authenticationConfig) {
    await kc('PUT', `/authentication/config/${step.authenticationConfig}`, { id: step.authenticationConfig, alias: configAlias, config });
  } else {
    await kc('POST', `/authentication/executions/${step.id}/config`, { alias: configAlias, config });
  }
}

async function main() {
  console.log(`Limiting crew logins to one phone at a time in ${KC}/realms/${REALM}`);
  await adminLogin();
  const realm = await kc('GET', '');
  if (!realm) throw new Error(`Realm ${REALM} does not exist in ${KC}. Import infra/keycloak-realm.json first.`);
  if (!(await kc('GET', `/roles/${CREW_ROLE}`))) throw new Error(`Role ${CREW_ROLE} is missing: run npm run keycloak:mobile first.`);

  // The form part of the sign-in flow: username + password, then the operators' OTP.
  // The cookie step above it signs a user straight back in on a phone that already
  // has a session, so the limit only runs on a real new sign-in.
  const browser = (await kc('GET', '/authentication/flows')).find((f) => f.alias === realm.browserFlow);
  const forms = browser?.authenticationExecutions.find((e) => e.authenticatorFlow && e.requirement !== 'DISABLED')?.flowAlias;
  if (!forms) throw new Error(`Could not find the form step in sign-in flow "${realm.browserFlow}".`);

  let sub = (await executions(forms)).find((e) => e.authenticationFlow && e.displayName === SUBFLOW);
  if (!sub) {
    await kc('POST', `${flowPath(forms)}/executions/flow`, { alias: SUBFLOW, type: 'basic-flow', provider: 'registration-page-form', description: 'field_crew users: one crew app session per login' });
    sub = (await executions(forms)).find((e) => e.authenticationFlow && e.displayName === SUBFLOW);
  }
  await setRequirement(forms, sub, 'CONDITIONAL');
  await ensureStep(SUBFLOW, 'conditional-user-role', 'crew-one-phone-role', { condUserRole: CREW_ROLE, negate: 'false' });
  await ensureStep(SUBFLOW, 'user-session-limits', 'crew-one-phone-limit', {
    userRealmLimit: '0', // 0 = no limit across all apps (the dashboard is not limited)
    userClientLimit: '1', // per app: one crew app session per login
    behavior: 'Terminate oldest session',
    errorMessage: '',
  });

  console.log(`  flow "${realm.browserFlow}" > "${forms}" > "${SUBFLOW}"`);
  for (const e of await executions(SUBFLOW)) console.log(`    ${e.requirement.padEnd(11)} ${e.displayName}`);
  console.log('\nDone. A second sign-in with the same crew login now signs the first phone out (within 5 minutes).');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
