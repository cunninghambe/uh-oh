type Mechanism = 'js-global' | 'js-promise';
/**
 * Installs the React Native global error handler via ErrorUtils.
 * Returns an uninstall function that restores the previous handler.
 */
export declare function installGlobalErrorHandler(capture: (err: unknown, mechanism: 'js-global') => void): () => void;
/**
 * Installs an unhandled promise rejection handler.
 * Uses `process.on('unhandledRejection')` when available (Node / RN with Hermes),
 * falling back to `globalThis.addEventListener('unhandledrejection', ...)`.
 * Returns an uninstall function.
 */
export declare function installPromiseRejectionHandler(capture: (reason: unknown, mechanism: 'js-promise') => void): () => void;
export type { Mechanism };
//# sourceMappingURL=handlers.d.ts.map