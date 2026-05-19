// Minimal AsyncStorage stub for testing.
// Vitest aliases '@react-native-async-storage/async-storage' to this file.
const store = new Map();
const AsyncStorage = {
    getItem(key) {
        return Promise.resolve(store.get(key) ?? null);
    },
    setItem(key, value) {
        store.set(key, value);
        return Promise.resolve();
    },
    removeItem(key) {
        store.delete(key);
        return Promise.resolve();
    },
    _reset() {
        store.clear();
    },
};
export default AsyncStorage;
//# sourceMappingURL=async-storage.js.map