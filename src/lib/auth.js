// src/lib/auth.js
// Keycloak login via OAuth (expo-auth-session). Token stored securely.
// This is the native equivalent of the web app's keycloak-js session.
import { Platform } from "react-native";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { REALM, CLIENT_ID, REDIRECT_SCHEME } from "../config";
import { keycloakUrl, loadServer } from "./server";
import { encryptString, decryptString } from "./webCrypto";

// Encrypted, persistent token storage on both platforms:
//   - Native: expo-secure-store, backed by the OS Keychain/Keystore
//     (hardware-protected on most devices).
//   - Web: expo-secure-store isn't supported in the browser, so tokens are
//     AES-GCM encrypted (see webCrypto.js) before being written to
//     localStorage, and decrypted on read. Falls back to an in-memory-only
//     store if the browser's crypto API is unavailable, so a storage
//     failure degrades gracefully instead of hanging the app.
const IS_WEB = Platform.OS === "web";
const memoryStore = new Map();
const SafeStore = {
  async getItemAsync(key) {
    if (IS_WEB) {
      try {
        const stored = localStorage.getItem(key);
        if (!stored) return memoryStore.get(key) ?? null;
        return await decryptString(stored);
      } catch {
        return memoryStore.get(key) ?? null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async setItemAsync(key, value) {
    if (IS_WEB) {
      try {
        localStorage.setItem(key, await encryptString(value));
      } catch {
        memoryStore.set(key, value);
      }
      return;
    }
    return SecureStore.setItemAsync(key, value);
  },
  async deleteItemAsync(key) {
    if (IS_WEB) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
      memoryStore.delete(key);
      return;
    }
    return SecureStore.deleteItemAsync(key);
  },
};

// Keycloak endpoints for the currently configured server (lib/server.js).
export function getDiscovery() {
  const base = `${keycloakUrl()}/realms/${REALM}/protocol/openid-connect`;
  return {
    authorizationEndpoint: `${base}/auth`,
    tokenEndpoint: `${base}/token`,
    endSessionEndpoint: `${base}/logout`,
  };
}

// A path is required: Keycloak rejects "omscrew://" (empty host) as an
// invalid redirect URI. "omscrew://auth" matches the client's omscrew://* rule.
export const redirectUri = AuthSession.makeRedirectUri({ scheme: REDIRECT_SCHEME, path: "auth" });

let accessToken = null;
let refreshToken = null;
let tokenParsed = null;

export function getToken() {
  return accessToken;
}

function parseJwt(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(base64))));
  } catch {
    return {};
  }
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const response = await fetch(getDiscovery().tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return response.json();
}

let refreshTimer = null;
// The one refresh in flight: concurrent callers (timer, API requests, GPS
// uploads, the map header) all wait on it instead of each sending their own.
let refreshPromise = null;
// When Keycloak last could not be reached. Callers within REFRESH_RETRY_MS
// get "unreachable" at once instead of each waiting on another timeout; the
// retry timer keeps trying meanwhile.
let lastUnreachableAt = 0;
// Bumped on login and logout, so a refresh that finishes after the crew
// signed out (or in as someone else) does not bring the old session back.
let sessionGeneration = 0;

const REFRESH_TIMEOUT_MS = 10000;
const REFRESH_RETRY_MS = 30000;
const EXPIRY_MARGIN_MS = 30000;
// restoreSession must answer before NativeApp's 4 s startup limit.
const RESTORE_REFRESH_WAIT_MS = 3000;

// Keycloak access tokens are short-lived (typically ~5 min). Without this,
// a session left open for more than a few minutes — exactly what happens
// during a real device test — starts failing every API call and every
// background location ping with 401, silently, since both just log/queue
// the failure instead of surfacing it.
function scheduleTokenRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!tokenParsed?.exp || !refreshToken) return;
  const msUntilExpiry = tokenParsed.exp * 1000 - Date.now();
  const delay = Math.max(msUntilExpiry - 60000, 5000); // refresh 60s before expiry
  refreshTimer = setTimeout(() => {
    refreshOnce({ force: true }).catch(() => {});
  }, delay);
}

// No signal: try again every 30 s while the crew is still signed in.
function scheduleRetry() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshOnce({ force: true }).catch(() => {});
  }, REFRESH_RETRY_MS);
}

// One token request. "ok" | "rejected" (Keycloak said no: the refresh token
// expired or was revoked, or there is none) | "unreachable" (no signal,
// timeout, server error). Reads the refresh token from storage first: it is
// shared with a headless background instance, which may have refreshed.
async function requestRefresh() {
  await loadServer(); // may be a fresh headless JS instance
  const token = (await SafeStore.getItemAsync("oms_refresh_token")) ?? refreshToken;
  if (!token) return "rejected";
  const generation = sessionGeneration;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  let response, data;
  try {
    response = await fetch(getDiscovery().tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: token }).toString(),
      signal: controller.signal,
    });
    data = await response.json().catch(() => ({}));
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || !data.access_token) {
    return response.status >= 400 && response.status < 500 ? "rejected" : "unreachable";
  }
  if (generation !== sessionGeneration) return "rejected"; // signed out meanwhile

  accessToken = data.access_token;
  refreshToken = data.refresh_token ?? token;
  tokenParsed = parseJwt(accessToken);

  await SafeStore.setItemAsync("oms_token", accessToken);
  if (data.refresh_token) await SafeStore.setItemAsync("oms_refresh_token", refreshToken);

  scheduleTokenRefresh();
  return "ok";
}

// Single-flight wrapper around requestRefresh. force: run even though
// Keycloak was unreachable moments ago (the timers use it).
function refreshOnce({ force = false } = {}) {
  if (!force && lastUnreachableAt && Date.now() - lastUnreachableAt < REFRESH_RETRY_MS) {
    return Promise.resolve("unreachable");
  }
  if (!refreshPromise) {
    refreshPromise = requestRefresh()
      .catch(() => "unreachable")
      .then((outcome) => {
        lastUnreachableAt = outcome === "unreachable" ? Date.now() : 0;
        if (outcome === "unreachable" && accessToken) scheduleRetry();
        return outcome;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

// True when a new access token was obtained. A failure does not clear the
// session, so an in-flight request can still try with the stale token
// rather than the crew being force-logged-out mid-task.
export async function refreshAccessToken() {
  return (await refreshOnce()) === "ok";
}

// Call from a login screen with the `promptAsync`/`request` pair returned by
// `AuthSession.useAuthRequest`. Returns a result so callers can distinguish
// cancellation/network errors from an actual rejected sign-in.
export async function login(promptAsync, request) {
  const result = await promptAsync();
  if (result?.type !== "success") {
    return { success: false, countFailure: result?.type === "error" };
  }

  const data = await exchangeCode(result.params.code, request.codeVerifier);
  if (!data.access_token) return { success: false, countFailure: true };

  sessionGeneration += 1;
  lastUnreachableAt = 0;
  accessToken = data.access_token;
  refreshToken = data.refresh_token ?? null;
  tokenParsed = parseJwt(accessToken);

  await SafeStore.setItemAsync("oms_token", accessToken);
  if (refreshToken) await SafeStore.setItemAsync("oms_refresh_token", refreshToken);
  scheduleTokenRefresh();
  return { success: true };
}

// Attempt to restore a session from SecureStore (e.g. on app relaunch).
// Never throws — always resolves to false on any failure so callers
// (e.g. a startup spinner) can't hang waiting on this.
// An expired access token (they live ~5 min, so this is most relaunches) is
// refreshed with the stored refresh token. Only a refresh Keycloak rejects
// signs the crew out: with no signal the session is kept, so the crew can
// keep working into Pending Sync, and the refresh is retried every 30 s.
export async function restoreSession() {
  try {
    await loadServer();
    const stored = await SafeStore.getItemAsync("oms_token");
    if (!stored) return false;
    const parsed = parseJwt(stored);
    accessToken = stored;
    tokenParsed = parsed;
    refreshToken = (await SafeStore.getItemAsync("oms_refresh_token")) ?? null;
    const expiresAtMs = (parsed?.exp ?? 0) * 1000;
    if (!expiresAtMs || expiresAtMs > Date.now()) {
      scheduleTokenRefresh();
      return true;
    }
    const outcome = await Promise.race([
      refreshOnce({ force: true }),
      new Promise((resolve) => setTimeout(() => resolve("unreachable"), RESTORE_REFRESH_WAIT_MS)),
    ]);
    if (outcome === "rejected") {
      refreshToken = null; // dead: no point ending it on Keycloak
      await logout();
      return false;
    }
    return true; // "ok", or no signal: refreshOnce retries by itself
  } catch {
    return false;
  }
}

export function authHeader() {
  return accessToken ? { Authorization: "Bearer " + accessToken } : {};
}

// Standalone token fetch for code that may run in a headless JS context
// with no in-memory auth state — Android can wake the background location
// task in a fresh JS instance after the app process was killed, where the
// `accessToken`/`refreshToken` module variables above are simply unset.
// Reads straight from SecureStore, refreshing first if the stored token is
// expired or about to be, and persists any refreshed pair back to storage
// (refreshAccessToken reads the refresh token from storage too, and keeps
// the in-memory singleton in sync for when this runs in the live app).
// Also used before every API request (session.js freshAuthHeader), so a
// token still good in memory is returned without touching storage.
export async function getFreshAccessToken() {
  try {
    if (accessToken && (tokenParsed?.exp ?? 0) * 1000 - Date.now() > EXPIRY_MARGIN_MS) return accessToken;
    await loadServer(); // may be a fresh headless JS instance
    const stored = await SafeStore.getItemAsync("oms_token");
    if (!stored) return null;
    const parsed = parseJwt(stored);
    const expiresAtMs = (parsed?.exp ?? 0) * 1000;
    if (expiresAtMs && expiresAtMs - Date.now() > EXPIRY_MARGIN_MS) return stored;

    if (await refreshAccessToken()) return accessToken;
    return expiresAtMs > Date.now() ? stored : null;
  } catch {
    return null;
  }
}

export function isAuthenticated() {
  return Boolean(accessToken);
}

// Crew id: prefer a crew_id claim from the token, else map by username
// (matches the mapping used by the web app for the same demo accounts).
const USER_TO_CREW = { "test.operator": "C003", "test.scada": "C002" };

export function myCrewId() {
  if (tokenParsed?.crew_id) return tokenParsed.crew_id;
  return USER_TO_CREW[tokenParsed?.preferred_username] || "C003";
}

export function currentUsername() {
  return tokenParsed?.preferred_username ?? tokenParsed?.name ?? null;
}

export async function logout() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  sessionGeneration += 1;
  lastUnreachableAt = 0;
  // End the Keycloak session too. Clearing only our tokens leaves Keycloak's
  // SSO cookie in the browser, and the next sign-in on this phone would
  // silently come back as the previous crew. Best effort: offline, the
  // tokens are still cleared (and sign-in always asks again, see prompt).
  if (refreshToken) {
    try {
      await Promise.race([
        fetch(getDiscovery().endSessionEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: CLIENT_ID, refresh_token: refreshToken }).toString(),
        }),
        new Promise((resolve) => setTimeout(resolve, 5000)), // don't hold sign-out up on a slow network
      ]);
    } catch {
      // ignore: no network or server down
    }
  }
  accessToken = null;
  refreshToken = null;
  tokenParsed = null;
  await SafeStore.deleteItemAsync("oms_token");
  await SafeStore.deleteItemAsync("oms_refresh_token");
}

// Whether the crew member has opted in to unlocking a restored session
// with Face ID / fingerprint instead of it being granted automatically.
export async function isBiometricEnabled() {
  return (await SafeStore.getItemAsync("oms_biometric_enabled")) === "true";
}

export async function setBiometricEnabled(enabled) {
  if (enabled) await SafeStore.setItemAsync("oms_biometric_enabled", "true");
  else await SafeStore.deleteItemAsync("oms_biometric_enabled");
}
