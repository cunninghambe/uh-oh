// Minimal React Native stub for testing.
// Vitest aliases 'react-native' to this file.

type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;

let _globalHandler: GlobalErrorHandler = () => undefined;

export const ErrorUtils = {
  setGlobalHandler(fn: GlobalErrorHandler): void {
    _globalHandler = fn;
  },
  getGlobalHandler(): GlobalErrorHandler {
    return _globalHandler;
  },
  // Simulate triggering global error (for tests)
  _triggerError(error: Error, isFatal?: boolean): void {
    _globalHandler(error, isFatal);
  },
};

export const Platform = {
  OS: 'android' as 'android' | 'ios',
};

type UhOhNativeStub = {
  install: (config: { debug: boolean }) => Promise<boolean>;
  getPendingReports: () => Promise<unknown[]>;
};

const uhOhNativeStub: UhOhNativeStub = {
  install: (_config) => Promise.resolve(true),
  getPendingReports: () => Promise.resolve([]),
};

export const NativeModules: Record<string, unknown> = {
  UhOhNative: uhOhNativeStub,
};

/** Exposed so tests can override NativeModules.UhOhNative per-test. */
export function setUhOhNativeStub(stub: Partial<UhOhNativeStub> | null): void {
  if (stub === null) {
    delete NativeModules['UhOhNative'];
  } else {
    NativeModules['UhOhNative'] = { ...uhOhNativeStub, ...stub };
  }
}
