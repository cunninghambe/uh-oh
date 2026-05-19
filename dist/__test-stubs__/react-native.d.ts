type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;
export declare const ErrorUtils: {
    setGlobalHandler(fn: GlobalErrorHandler): void;
    getGlobalHandler(): GlobalErrorHandler;
    _triggerError(error: Error, isFatal?: boolean): void;
};
export declare const Platform: {
    OS: "android" | "ios";
};
export declare const NativeModules: Record<string, unknown>;
export {};
//# sourceMappingURL=react-native.d.ts.map