// Counts loadServer calls so tests can see the headless path loads the server.
export const serverStub = (globalThis.__serverStub ??= { loads: 0 });
export const loadServer = async () => { serverStub.loads += 1; };
export const keycloakUrl = () => "http://keycloak.test";
export const apiBase = () => "http://api.test/api";
