type Mechanism = 'js-global' | 'js-promise';

/**
 * Installs the React Native global error handler via ErrorUtils.
 * Returns an uninstall function that restores the previous handler.
 *
 * The capture is wrapped in try/catch and the previously-installed handler is
 * ALWAYS invoked afterwards, so RedBox still shows in dev and fatal errors
 * still crash the app in prod even if our capture throws (C2).
 */
export function installGlobalErrorHandler(
  capture: (err: unknown, mechanism: 'js-global') => void,
): () => void {
  // ErrorUtils is a React Native global; it may not exist in all environments.
  const eu = (globalThis as Record<string, unknown>)['ErrorUtils'] as
    | {
        setGlobalHandler(fn: (e: Error, fatal?: boolean) => void): void;
        getGlobalHandler?(): ((e: Error, fatal?: boolean) => void) | undefined;
      }
    | undefined;

  if (!eu || typeof eu.setGlobalHandler !== 'function') return () => undefined;

  const prev = typeof eu.getGlobalHandler === 'function' ? eu.getGlobalHandler() : undefined;

  eu.setGlobalHandler((error: Error, isFatal?: boolean) => {
    try {
      capture(error, 'js-global');
    } catch {
      // Never let a capture failure swallow the app's own error handling.
    }
    // Always chain to the previous handler so the app crashes / shows RedBox
    // exactly as it would have without us installed.
    if (typeof prev === 'function') {
      prev(error, isFatal);
    }
  });

  return () => {
    if (typeof prev === 'function') {
      eu.setGlobalHandler(prev);
    }
  };
}

type RejectionTracking = {
  enable(opts: {
    allRejections?: boolean;
    onUnhandled?: (id: unknown, error: unknown) => void;
    onHandled?: (id: unknown) => void;
  }): void;
  disable?(): void;
};

type ProcessLike = {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type EventTargetLike = {
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
};

export type RejectionHandlerDeps = {
  /** Loads RN's promise-rejection tracking module; returns null if absent. */
  loadRejectionTracking?: () => RejectionTracking | null;
  /** Process-like object; pass null to simulate a runtime without `process`. */
  proc?: ProcessLike | null;
  /** Global event target; pass null to simulate absence of addEventListener. */
  eventTarget?: EventTargetLike | null;
};

function defaultLoadRejectionTracking(): RejectionTracking | null {
  try {
    // The `promise` polyfill bundled with React Native / Hermes exposes
    // rejection tracking here. Absent in plain Node — hence the guard.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('promise/setimmediate/rejection-tracking') as
      | RejectionTracking
      | { default?: RejectionTracking };
    const tracking = (mod as { default?: RejectionTracking }).default ?? (mod as RejectionTracking);
    return typeof tracking?.enable === 'function' ? tracking : null;
  } catch {
    return null;
  }
}

/**
 * Installs an unhandled promise rejection handler.
 *
 * On React Native / Hermes there is no global `addEventListener` and the RN
 * `process` shim has no `.on`, so the primary path uses the bundled `promise`
 * polyfill's rejection tracking. `process.on` and `addEventListener` remain as
 * fallbacks for Node-ish / web-ish environments. Every branch is existence-
 * checked so installation never throws (C3).
 *
 * Returns an uninstall function.
 */
export function installPromiseRejectionHandler(
  capture: (reason: unknown, mechanism: 'js-promise') => void,
  deps: RejectionHandlerDeps = {},
): () => void {
  const loadRejectionTracking = deps.loadRejectionTracking ?? defaultLoadRejectionTracking;
  const proc: ProcessLike | null =
    deps.proc !== undefined ? deps.proc : typeof process !== 'undefined' ? process : null;
  const eventTarget: EventTargetLike | null =
    deps.eventTarget !== undefined ? deps.eventTarget : globalThis;

  const uninstalls: Array<() => void> = [];
  let installed = false;

  // 1. React Native / Hermes: the bundled promise polyfill's rejection tracking.
  const tracking = loadRejectionTracking();
  if (tracking) {
    try {
      tracking.enable({
        allRejections: true,
        onUnhandled: (_id, error) => capture(error, 'js-promise'),
        onHandled: () => undefined,
      });
      installed = true;
      uninstalls.push(() => {
        try {
          tracking.disable?.();
        } catch {
          // best-effort teardown
        }
      });
    } catch {
      // fall through to the other strategies
    }
  }

  // 2. Node-ish: process.on('unhandledRejection').
  if (!installed && proc && typeof proc.on === 'function') {
    const handler = (reason: unknown) => capture(reason, 'js-promise');
    proc.on('unhandledRejection', handler as (...args: unknown[]) => void);
    installed = true;
    uninstalls.push(() => {
      if (typeof proc.off === 'function') {
        proc.off('unhandledRejection', handler as (...args: unknown[]) => void);
      }
    });
  }

  // 3. Web-ish: globalThis.addEventListener('unhandledrejection').
  if (!installed && eventTarget && typeof eventTarget.addEventListener === 'function') {
    const windowHandler = (event: PromiseRejectionEvent) => capture(event.reason, 'js-promise');
    eventTarget.addEventListener('unhandledrejection', windowHandler as EventListener);
    installed = true;
    uninstalls.push(() => {
      if (typeof eventTarget.removeEventListener === 'function') {
        eventTarget.removeEventListener('unhandledrejection', windowHandler as EventListener);
      }
    });
  }

  return () => {
    for (const fn of uninstalls) fn();
  };
}

export type { Mechanism };
