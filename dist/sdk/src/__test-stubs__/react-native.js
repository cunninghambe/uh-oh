// Minimal React Native stub for testing.
// Vitest aliases 'react-native' to this file.
let _globalHandler = () => undefined;
export const ErrorUtils = {
    setGlobalHandler(fn) {
        _globalHandler = fn;
    },
    getGlobalHandler() {
        return _globalHandler;
    },
    // Simulate triggering global error (for tests)
    _triggerError(error, isFatal) {
        _globalHandler(error, isFatal);
    },
};
export const Platform = {
    OS: 'android',
};
const uhOhNativeStub = {
    install: (_config) => Promise.resolve(true),
    getPendingReports: () => Promise.resolve([]),
};
export const NativeModules = {
    UhOhNative: uhOhNativeStub,
};
/** Exposed so tests can override NativeModules.UhOhNative per-test. */
export function setUhOhNativeStub(stub) {
    if (stub === null) {
        delete NativeModules['UhOhNative'];
    }
    else {
        NativeModules['UhOhNative'] = { ...uhOhNativeStub, ...stub };
    }
}
//# sourceMappingURL=react-native.js.map