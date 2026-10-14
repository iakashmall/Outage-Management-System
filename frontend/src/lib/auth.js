import Keycloak from 'keycloak-js';

// Configurable at build time (see .env.production / Vite's VITE_ prefix
// convention). This URL runs in the VISITOR'S BROWSER, not on the server â€”
// hardcoding "localhost" here means every visitor's browser tries to reach
// Keycloak on their OWN machine, not the server's, which only ever worked
// by accident on a laptop where the app and Keycloak run on the same box.
// For any real deployment this must be the server's actual public address.
export const keycloak = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:18080',
  realm: 'oms-upcl',
  clientId: 'oms-web',
});

// Call once, before rendering the app. Resolves true once the user has a
// valid session (redirecting to Keycloak's login page first if needed).
// checkLoginIframe disabled: it relies on a hidden cross-port iframe (app on
// 5173, Keycloak on 8081) that modern Chrome blocks by default as part of
// third-party cookie restrictions, causing a permanent timeout rather than
// a real login failure. This only disables Keycloak's periodic background
// session-validity check; login itself and token verification still work.
export function initKeycloak() {
  return keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false }).then((ok) => {
    // Access tokens last 5 minutes and nothing else renews them, so a form
    // filled in slowly would be refused as "invalid/expired token". Renew in
    // the background while the session (refresh token) is still alive.
    keycloak.onTokenExpired = () => keycloak.updateToken(30).catch(() => {});
    setInterval(() => keycloak.updateToken(60).catch(() => {}), 30000);
    return ok;
  });
}

// Attach this to every API call so the backend can verify who's asking.
export function authHeader() {
  return keycloak.token ? { Authorization: `Bearer ${keycloak.token}` } : {};
}
export function currentUser() {
  const t = keycloak.tokenParsed || {};
  return { username: t.preferred_username || 'user', roles: (t.realm_access && t.realm_access.roles) || [] };
}

export function logout() {
  keycloak.logout({ redirectUri: window.location.origin });
}