/**
 * Installs the React Native global error handler via ErrorUtils.
 * Returns an uninstall function that restores the previous handler.
 */
export function installGlobalErrorHandler(capture) {
    // ErrorUtils is a React Native global; it may not exist in all environments
    const eu = globalThis['ErrorUtils'];
    if (!eu)
        return () => undefined;
    const prev = eu.getGlobalHandler();
    eu.setGlobalHandler((error, _isFatal) => {
        capture(error, 'js-global');
    });
    return () => {
        eu.setGlobalHandler(prev);
    };
}
/**
 * Installs an unhandled promise rejection handler.
 * Uses `process.on('unhandledRejection')` when available (Node / RN with Hermes),
 * falling back to `globalThis.addEventListener('unhandledrejection', ...)`.
 * Returns an uninstall function.
 */
export function installPromiseRejectionHandler(capture) {
    const handler = (reason) => {
        capture(reason, 'js-promise');
    };
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
        process.on('unhandledRejection', handler);
        return () => {
            process.off('unhandledRejection', handler);
        };
    }
    const windowHandler = (event) => {
        capture(event.reason, 'js-promise');
    };
    globalThis.addEventListener('unhandledrejection', windowHandler);
    return () => {
        globalThis.removeEventListener('unhandledrejection', windowHandler);
    };
}
//# sourceMappingURL=handlers.js.map