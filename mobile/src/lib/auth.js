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

// Which crew is this logged-in user? For now we read a crew_id claim from
// the token. Until that Keycloak mapping is set up, this falls back to a
// temporary hardcoded crew so we can test the rest of the wiring first.
export function myCrewId() {
  const t = keycloak.tokenParsed || {};
  return t.crew_id || 'C003';
}
