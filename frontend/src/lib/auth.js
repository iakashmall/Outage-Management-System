import Keycloak from 'keycloak-js';
import { createTokenManager } from './tokenRefresh.js';

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
  return keycloak
    .init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false })
    .then((authenticated) => { if (authenticated) startAutoRefresh(); return authenticated; });
}

// Access tokens last 5 minutes and nothing else renews them, so a form filled in slowly would be refused as
// "invalid/expired token". tokenRefresh.js renews the token while the session (refresh token) is alive, shares one
// renewal between simultaneous callers, and, if the Keycloak session itself has ended, sends the user to sign in
// again (once) instead of failing silently. 60 s is how early a token is renewed.
const tokens = createTokenManager(keycloak, { onLoginRequired: () => keycloak.login(), minValidity: 60 });
export const refreshToken = (force = false) => tokens.refresh(force);

function startAutoRefresh() {
  const quietly = () => { tokens.refresh(false).catch(() => {}); };
  keycloak.onTokenExpired = quietly;                                                          // renew when it expires
  document.addEventListener('visibilitychange', () => { if (!document.hidden) quietly(); });  // tab or laptop woke up
  setInterval(quietly, 30 * 1000);                                                            // no-op unless <60 s are left
}

// Attach this to every API call so the backend can verify who's asking.
export function authHeader() {
  return keycloak.token ? { Authorization: `Bearer ${keycloak.token}` } : {};
}
// Same, but renews the token first when it is about to expire. Prefer this for requests.
export async function freshAuthHeader() {
  try { await tokens.refresh(false); } catch { /* the sign-in redirect has already been triggered */ }
  return authHeader();
}
export function currentUser() {
  const t = keycloak.tokenParsed || {};
  return { username: t.preferred_username || 'user', roles: (t.realm_access && t.realm_access.roles) || [] };
}

export function logout() {
  keycloak.logout({ redirectUri: window.location.origin });
}