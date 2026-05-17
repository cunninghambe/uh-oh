type Mechanism = 'js-global' | 'js-promise';

/**
 * Installs the React Native global error handler via ErrorUtils.
 * Returns an uninstall function that restores the previous handler.
 */
export function installGlobalErrorHandler(
  capture: (err: unknown, mechanism: 'js-global') => void,
): () => void {
  // ErrorUtils is a React Native global; it may not exist in all environments
  const eu = (globalThis as Record<string, unknown>)['ErrorUtils'] as
    | {
        setGlobalHandler(fn: (e: Error, fatal?: boolean) => void): void;
        getGlobalHandler(): (e: Error, fatal?: boolean) => void;
      }
    | undefined;

  if (!eu) return () => undefined;

  const prev = eu.getGlobalHandler();
  eu.setGlobalHandler((error: Error, _isFatal?: boolean) => {
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
export function installPromiseRejectionHandler(
  capture: (reason: unknown, mechanism: 'js-promise') => void,
): () => void {
  const handler = (reason: unknown) => {
    capture(reason, 'js-promise');
  };

  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('unhandledRejection', handler);
    return () => {
      process.off('unhandledRejection', handler);
    };
  }

  const windowHandler = (event: PromiseRejectionEvent) => {
    capture(event.reason, 'js-promise');
  };
  globalThis.addEventListener('unhandledrejection', windowHandler as EventListener);
  return () => {
    globalThis.removeEventListener('unhandledrejection', windowHandler as EventListener);
  };
}

export type { Mechanism };
