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
export const NativeModules = {};
//# sourceMappingURL=react-native.js.map