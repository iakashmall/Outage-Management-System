// src/lib/__tests__/hooks.mjs — module resolve hooks for register.mjs.
const stub = (name) => new URL(`./stubs/${name}.mjs`, import.meta.url).href;

const PACKAGES = {
  "react-native": stub("react-native"),
  "expo-auth-session": stub("expo-auth-session"),
  "expo-secure-store": stub("expo-secure-store"),
  "expo-file-system": stub("expo-file-system"),
  "@react-native-async-storage/async-storage": stub("async-storage"),
};

// Lib modules that talk to the network or the device, replaced for tests.
const LIB_STUBS = { server: stub("server"), webCrypto: stub("webCrypto"), api: stub("api") };

export async function resolve(specifier, context, nextResolve) {
  if (PACKAGES[specifier]) return { url: PACKAGES[specifier], shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.includes("/src/lib/") && !context.parentURL.includes("/__tests__/")) {
    const name = specifier.replace(/^\.\//, "");
    if (LIB_STUBS[name]) return { url: LIB_STUBS[name], shortCircuit: true };
    if (!/\.[cm]?js$/.test(specifier)) return nextResolve(specifier + ".js", context);
  }
  return nextResolve(specifier, context);
}
