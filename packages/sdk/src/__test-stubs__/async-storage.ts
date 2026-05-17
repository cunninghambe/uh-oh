// Minimal AsyncStorage stub for testing.
// Vitest aliases '@react-native-async-storage/async-storage' to this file.

const store = new Map<string, string>();

const AsyncStorage = {
  getItem(key: string): Promise<string | null> {
    return Promise.resolve(store.get(key) ?? null);
  },
  setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
    return Promise.resolve();
  },
  removeItem(key: string): Promise<void> {
    store.delete(key);
    return Promise.resolve();
  },
  _reset(): void {
    store.clear();
  },
};

export default AsyncStorage;
