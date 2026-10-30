// src/lib/__tests__/auth.test.mjs — npm run test:app
// Session restore and token refresh (lib/auth.js) with SecureStore and the
// Keycloak token endpoint faked in memory. Each test loads a fresh copy of
// auth.js, like an app relaunch or a headless background instance.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

const secure = (globalThis.__secureStore ??= new Map());
const server = (globalThis.__serverStub ??= { loads: 0 });

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (expInSeconds, extra = {}) =>
  `${b64url({ alg: "none" })}.${b64url({ exp: Math.floor(Date.now() / 1000) + expInSeconds, preferred_username: "crew01", ...extra })}.sig`;

let loads = 0;
const freshAuth = () => import(`../auth.js?instance=${++loads}`);

// fetch stand-in: records token requests and answers with `reply`.
let tokenRequests;
function fakeKeycloak(reply) {
  tokenRequests = [];
  globalThis.fetch = async (url, options) => {
    tokenRequests.push({ url, body: new URLSearchParams(options.body) });
    return reply();
  };
}
const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  secure.clear();
  server.loads = 0;
  // The refresh / retry timers are minutes long; never let them fire or
  // keep the test process alive.
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => mock.timers.reset());

test("relaunch with an expired access token and a valid refresh token restores the session", async () => {
  const fresh = jwt(300);
  secure.set("oms_token", jwt(-60));
  secure.set("oms_refresh_token", "refresh-1");
  fakeKeycloak(() => answer(200, { access_token: fresh, refresh_token: "refresh-2" }));
  const auth = await freshAuth();

  assert.equal(await auth.restoreSession(), true);
  assert.equal(auth.isAuthenticated(), true);
  assert.equal(auth.getToken(), fresh);
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].body.get("grant_type"), "refresh_token");
  assert.equal(tokenRequests[0].body.get("refresh_token"), "refresh-1");
  assert.equal(secure.get("oms_token"), fresh);
  assert.equal(secure.get("oms_refresh_token"), "refresh-2");
});

test("relaunch whose refresh token Keycloak rejects signs out", async () => {
  secure.set("oms_token", jwt(-60));
  secure.set("oms_refresh_token", "dead");
  fakeKeycloak(() => answer(400, { error: "invalid_grant" }));
  const auth = await freshAuth();

  assert.equal(await auth.restoreSession(), false);
  assert.equal(auth.isAuthenticated(), false);
  assert.equal(secure.has("oms_token"), false);
  assert.equal(secure.has("oms_refresh_token"), false);
  assert.equal(tokenRequests.length, 1, "no end-session call with a dead refresh token");
});

test("relaunch with no signal keeps the session so the crew can work offline", async () => {
  const stale = jwt(-60);
  secure.set("oms_token", stale);
  secure.set("oms_refresh_token", "refresh-1");
  fakeKeycloak(() => Promise.reject(new TypeError("Network request failed")));
  const auth = await freshAuth();

  assert.equal(await auth.restoreSession(), true);
  assert.equal(auth.isAuthenticated(), true);
  assert.equal(auth.getToken(), stale);
  assert.equal(secure.get("oms_refresh_token"), "refresh-1", "nothing cleared");
});

test("relaunch with a still-valid access token needs no token request", async () => {
  const valid = jwt(300);
  secure.set("oms_token", valid);
  secure.set("oms_refresh_token", "refresh-1");
  fakeKeycloak(() => answer(200, {}));
  const auth = await freshAuth();

  assert.equal(await auth.restoreSession(), true);
  assert.equal(auth.getToken(), valid);
  assert.equal(tokenRequests.length, 0);
});

test("concurrent refresh callers share ONE token request", async () => {
  const fresh = jwt(300);
  secure.set("oms_token", jwt(-60));
  secure.set("oms_refresh_token", "refresh-1");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  fakeKeycloak(() => held.then(() => answer(200, { access_token: fresh, refresh_token: "refresh-2" })));
  const auth = await freshAuth();

  // Timer refresh, API requests and GPS uploads all at once.
  const callers = [
    auth.refreshAccessToken(),
    auth.refreshAccessToken(),
    auth.getFreshAccessToken(),
    auth.getFreshAccessToken(),
    auth.refreshAccessToken(),
  ];
  await new Promise((resolve) => setImmediate(resolve)); // let all of them reach the refresh
  release();
  const results = await Promise.all(callers);

  assert.equal(tokenRequests.length, 1);
  assert.deepEqual(results, [true, true, fresh, fresh, true]);
  assert.equal(secure.get("oms_refresh_token"), "refresh-2");
});

test("a failed refresh returns false and does not clear the session", async () => {
  const stale = jwt(-60);
  secure.set("oms_token", stale);
  secure.set("oms_refresh_token", "refresh-1");
  fakeKeycloak(() => Promise.reject(new TypeError("Network request failed")));
  const auth = await freshAuth();
  await auth.restoreSession();

  assert.equal(await auth.refreshAccessToken(), false);
  assert.equal(auth.getToken(), stale);
  assert.equal(secure.get("oms_token"), stale);
});

test("headless instance (nothing in memory) refreshes from storage and loads the server first", async () => {
  const fresh = jwt(300);
  secure.set("oms_token", jwt(-60));
  secure.set("oms_refresh_token", "refresh-1");
  fakeKeycloak(() => answer(200, { access_token: fresh }));
  const auth = await freshAuth(); // no restoreSession: module variables unset

  assert.equal(await auth.getFreshAccessToken(), fresh);
  assert.ok(server.loads >= 1, "loadServer called");
  assert.equal(tokenRequests[0].url, "http://keycloak.test/realms/oms-upcl/protocol/openid-connect/token");
  assert.equal(secure.get("oms_token"), fresh);
  assert.equal(secure.get("oms_refresh_token"), "refresh-1", "kept when Keycloak sends no new one");
});

test("headless instance with no stored session returns null", async () => {
  fakeKeycloak(() => answer(200, {}));
  const auth = await freshAuth();
  assert.equal(await auth.getFreshAccessToken(), null);
  assert.equal(tokenRequests.length, 0);
});

test("API requests (freshAuthHeader) refresh an expired token first", async () => {
  const fresh = jwt(300);
  secure.set("oms_token", jwt(-60));
  secure.set("oms_refresh_token", "refresh-1");
  fakeKeycloak(() => answer(200, { access_token: fresh }));
  const session = await import("../session.js");

  assert.deepEqual(await session.freshAuthHeader(), { Authorization: "Bearer " + fresh });
  assert.equal(tokenRequests.length, 1);
});
