// Extends app.json. Only the EAS "test" profile sets OMS_ALLOW_CLEARTEXT=1,
// letting that APK reach the OMS backend and Keycloak over plain HTTP on the
// LAN (see docs/MOBILE_TESTING.md). preview/production builds never allow
// cleartext traffic.
// app.json already has an expo-build-properties entry (arm64 only, code and
// resource shrinking); cleartext is merged into it rather than added as a
// second entry, so the two configurations can't overwrite each other.
export default ({ config }) => {
  if (process.env.OMS_ALLOW_CLEARTEXT !== '1') return config;
  const isBuildProps = (p) => (Array.isArray(p) ? p[0] : p) === 'expo-build-properties';
  const existing = config.plugins.find(isBuildProps);
  const options = Array.isArray(existing) ? existing[1] || {} : {};
  const merged = ['expo-build-properties', { ...options, android: { ...(options.android || {}), usesCleartextTraffic: true } }];
  return {
    ...config,
    plugins: [...config.plugins.filter((p) => !isBuildProps(p)), merged],
  };
};
