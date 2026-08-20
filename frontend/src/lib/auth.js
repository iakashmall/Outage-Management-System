import Keycloak from 'keycloak-js';

export const keycloak = new Keycloak({
  url: 'http://localhost:8080',
  realm: 'oms-upcl',
  clientId: 'oms-web',
});

// Call once, before rendering the app. Resolves true once the user has a
// valid session (redirecting to Keycloak's login page first if needed).
export function initKeycloak() {
  return keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256' });
}

// Attach this to every API call so the backend can verify who's asking.
export function authHeader() {
  return keycloak.token ? { Authorization: `Bearer ${keycloak.token}` } : {};
}