import Keycloak from 'keycloak-js';

// Same reasoning as frontend/src/lib/auth.js â€” this runs in the browser,
// so "localhost" means the visitor's own machine, not the server's.
export const keycloak = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080',
  realm: 'oms-upcl',
  clientId: 'oms-mobile',
});

export function initKeycloak() {
  // checkLoginIframe disabled: it relies on a hidden cross-port iframe
  // (app on 5174, Keycloak on 8081) that modern Chrome blocks by default as
  // part of third-party cookie restrictions â€” causing a permanent timeout
  // rather than a real login failure. This only disables Keycloak's
  // periodic "is my session still valid" background check; login itself
  // and token verification are unaffected.
  return keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false });
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