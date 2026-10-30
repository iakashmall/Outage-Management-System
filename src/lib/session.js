// src/lib/session.js
// The signed-in crew session as lib/api.js sees it. Native build: the
// expo-auth-session login in ./auth. The web build resolves session.web.js
// instead (Metro and vite.config.js both prefer .web.js on web).
import { authHeader, getFreshAccessToken } from "./auth";

export { isAuthenticated, myCrewId, currentUsername, logout } from "./auth";

// Refreshes first when the token is expired or about to be: Android pauses
// the refresh timer while the app is in the background, and requests made
// right after coming back would otherwise go out with an expired token.
// No new token (no signal): the stale one, which the server may still take.
export async function freshAuthHeader() {
  const token = await getFreshAccessToken();
  return token ? { Authorization: "Bearer " + token } : authHeader();
}
