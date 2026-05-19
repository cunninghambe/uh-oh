type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;
export declare const ErrorUtils: {
    setGlobalHandler(fn: GlobalErrorHandler): void;
    getGlobalHandler(): GlobalErrorHandler;
    _triggerError(error: Error, isFatal?: boolean): void;
};
export declare const Platform: {
    OS: "android" | "ios";
};
type UhOhNativeStub = {
    install: (config: {
        debug: boolean;
    }) => Promise<boolean>;
    getPendingReports: () => Promise<unknown[]>;
};
export declare const NativeModules: Record<string, unknown>;
/** Exposed so tests can override NativeModules.UhOhNative per-test. */
export declare function setUhOhNativeStub(stub: Partial<UhOhNativeStub> | null): void;
export {};
//# sourceMappingURL=react-native.d.ts.map