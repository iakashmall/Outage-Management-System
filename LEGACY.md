# Legacy and live code at the repo root

The repo root holds both the live crew app and leftovers of the original
pre-Phase-8 prototype. They share `src/`, so check which is which before
editing.

## Live: the crew app (Android APK)

The root Expo app **is the crew APK**. Develop the crew app here:

- `index.js` registers `src/NativeApp.jsx`
- `src/NativeApp.jsx`, `src/components/`, `src/lib/`, `src/config.js`
- `app.json`, `app.config.js`, `eas.json` (package `com.omscrew.mobile`;
  build with `eas build --profile test --platform android`)

How to run it against a local stack and install it on a phone:
`docs/MOBILE_TESTING.md`.

## Not the crew APK

- `mobile/` is a Vite web PWA for crews (workspace `mobile`), not the
  native app.
- `mobile-native-fixed/` is an older Expo copy of the crew app with a
  different EAS project. It is stale; do not build or fix it.
- `mobile_backup/` and `mobile_pre_adeeb_merge/` are git-ignored local copies.

## Legacy prototype

These root paths are the **original pre-Phase-8 prototype** (the combined
web crew app and photo upload service; see `INTEGRATION_NOTES.md`), kept
for reference:

- `server/`
- `index.html`
- `vite.config.js` (the root web build, `src/main.jsx` / `src/App.jsx`)

The deployed control room and API live in `frontend/` and `backend/`.

## Not part of the deployed stack

The root code (crew app and prototype alike) is **not referenced by**:

- `helm-oms/` (the Helm chart deploys `oms-frontend`/`oms-backend` images
  built from `frontend/Dockerfile` and `backend/Dockerfile`)
- Any Dockerfile in this repo
- `.github/workflows/ci.yml`

The crew app ships as an APK built with EAS, not as a container.
