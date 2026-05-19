declare const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    _reset(): void;
};
export default AsyncStorage;
//# sourceMappingURL=async-storage.d.ts.map