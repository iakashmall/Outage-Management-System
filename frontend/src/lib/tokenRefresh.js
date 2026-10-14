// Keeps the Keycloak access token fresh.
//
// The access token only lives a few minutes (300 s in our realm). Without a refresh the
// dashboard works for ~5 minutes after page load and then every API call is rejected with
// 401 until the page is reloaded. This wrapper refreshes it through keycloak-js
// (updateToken) and is deliberately free of keycloak-js / DOM imports so it can be
// unit-tested with a fake `kc`.
//
//  - refresh(false): renew only when the token expires within `minValidity` seconds
//                    (cheap no-op otherwise, no network call).
//  - refresh(true):  force a renewal now (used after the server answered 401).
//  - Concurrent callers share one in-flight refresh.
//  - If the refresh fails (the Keycloak session ended: idle 30 min / max 10 h) the user must
//    sign in again: onLoginRequired runs once, and the error is rethrown to the caller.
export function createTokenManager(kc, { onLoginRequired, minValidity = 30 } = {}) {
  let inflight = null;
  let loginTriggered = false;

  function refresh(force = false) {
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => kc.updateToken(force ? -1 : minValidity))
      .then(() => true, (err) => {
        if (!loginTriggered) {
          loginTriggered = true;
          try { if (onLoginRequired) onLoginRequired(err); } catch { /* nothing more to do */ }
        }
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return { refresh };
}
