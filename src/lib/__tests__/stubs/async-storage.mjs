// In-memory AsyncStorage; tests reset globalThis.__asyncStorage.
const store = (globalThis.__asyncStorage ??= new Map());
export default {
  getItem: async (key) => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async (key) => { store.delete(key); },
  multiRemove: async (keys) => { keys.forEach((key) => store.delete(key)); },
};
