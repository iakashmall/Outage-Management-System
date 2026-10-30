// In-memory SecureStore; tests read and reset globalThis.__secureStore.
const store = (globalThis.__secureStore ??= new Map());
export const getItemAsync = async (key) => (store.has(key) ? store.get(key) : null);
export const setItemAsync = async (key, value) => { store.set(key, value); };
export const deleteItemAsync = async (key) => { store.delete(key); };
