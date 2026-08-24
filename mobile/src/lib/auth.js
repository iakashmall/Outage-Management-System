import Keycloak from 'keycloak-js';

export const keycloak = new Keycloak({
  url: 'http://localhost:8080',
  realm: 'oms-upcl',
  clientId: 'oms-mobile',
});

export function initKeycloak() {
  return keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256' });
}

export function authHeader() {
  return keycloak.token ? { Authorization: 'Bearer ' + keycloak.token } : {};
}

export function logout() {
  keycloak.logout({ redirectUri: window.location.origin });
}

// Map the logged-in user to a crew. At deployment this comes from a
// crew_id token claim (via Active Directory); for now we map by username.
const USER_TO_CREW = {
  'test.operator': 'C003',
  'test.scada': 'C002',
};

export function myCrewId() {
  const t = keycloak.tokenParsed || {};
  if (t.crew_id) return t.crew_id;              // future: real claim
  const user = t.preferred_username || '';
  return USER_TO_CREW[user] || 'C003';          // fallback
}
