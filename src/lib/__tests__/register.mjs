// src/lib/__tests__/register.mjs
// Lets src/lib modules run under `node --test` (npm run test:app): phone-only
// modules (React Native, Expo, AsyncStorage) and the network-facing lib
// modules are swapped for the in-memory stand-ins in ./stubs, and the
// extensionless relative imports Metro accepts get their ".js".
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
