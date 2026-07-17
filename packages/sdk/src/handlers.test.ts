import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// We need to set up ErrorUtils on globalThis before importing handlers
const mockPrevHandler = vi.fn();
let currentHandler: ((e: Error, fatal?: boolean) => void) | null = null;

const MockErrorUtils = {
  setGlobalHandler: vi.fn((fn: (e: Error, fatal?: boolean) => void) => {
    currentHandler = fn;
  }),
  getGlobalHandler: vi.fn(() => mockPrevHandler),
};

describe('installGlobalErrorHandler', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)['ErrorUtils'] = MockErrorUtils;
    currentHandler = null;
    vi.clearAllMocks();
    MockErrorUtils.getGlobalHandler.mockReturnValue(mockPrevHandler);
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['ErrorUtils'];
  });

  it('installs handler and captures errors', async () => {
    const { installGlobalErrorHandler } = await import('./handlers.js');
    const captured: unknown[] = [];
    installGlobalErrorHandler((err) => captured.push(err));

    expect(MockErrorUtils.setGlobalHandler).toHaveBeenCalledOnce();
    const err = new Error('boom');
    currentHandler?.(err);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(err);
  });

  it('uninstall restores previous handler', async () => {
    const { installGlobalErrorHandler } = await import('./handlers.js');
    const uninstall = installGlobalErrorHandler(() => undefined);
    uninstall();
    expect(MockErrorUtils.setGlobalHandler).toHaveBeenLastCalledWith(mockPrevHandler);
  });

  it('C2: always chains to the previous handler, even when capture throws', async () => {
    const { installGlobalErrorHandler } = await import('./handlers.js');
    installGlobalErrorHandler(() => {
      throw new Error('capture blew up');
    });
    const err = new Error('boom');
    // Firing must not throw despite the capture failure...
    expect(() => currentHandler?.(err, true)).not.toThrow();
    // ...and the previous handler must still run with the same args.
    expect(mockPrevHandler).toHaveBeenCalledWith(err, true);
  });

  it('returns no-op uninstall when ErrorUtils is unavailable', async () => {
    delete (globalThis as Record<string, unknown>)['ErrorUtils'];
    const { installGlobalErrorHandler } = await import('./handlers.js');
    const uninstall = installGlobalErrorHandler(() => undefined);
    expect(() => uninstall()).not.toThrow();
  });
});

describe('installPromiseRejectionHandler', () => {
  // Force the process.on fallback (rejection-tracking unavailable) so these
  // tests are deterministic regardless of whether the `promise` polyfill is
  // resolvable in the environment.
  const noTracking = { loadRejectionTracking: () => null };

  it('captures unhandled rejections via process.on', async () => {
    const { installPromiseRejectionHandler } = await import('./handlers.js');
    const captured: unknown[] = [];
    const uninstall = installPromiseRejectionHandler((reason) => captured.push(reason), noTracking);

    process.emit('unhandledRejection', 'test-reason', Promise.resolve());
    expect(captured).toContain('test-reason');
    uninstall();
  });

  it('uninstall removes the process listener', async () => {
    const { installPromiseRejectionHandler } = await import('./handlers.js');
    const captured: unknown[] = [];
    const uninstall = installPromiseRejectionHandler((reason) => captured.push(reason), noTracking);
    uninstall();

    // After uninstall, manually verify listener count decreased (indirect check)
    // We can't emit unhandledRejection safely as vitest catches it
    // Instead verify the listener was removed by checking that capture is no longer called
    const listenersBefore = process.listenerCount('unhandledRejection');
    const uninstall2 = installPromiseRejectionHandler(
      (reason) => captured.push(reason),
      noTracking,
    );
    const listenersAfter = process.listenerCount('unhandledRejection');
    expect(listenersAfter).toBe(listenersBefore + 1);
    uninstall2();
    expect(process.listenerCount('unhandledRejection')).toBe(listenersBefore);
  });

  it('C3: does not throw when neither process.on nor addEventListener exist', async () => {
    const { installPromiseRejectionHandler } = await import('./handlers.js');
    expect(() =>
      installPromiseRejectionHandler(() => undefined, {
        loadRejectionTracking: () => null,
        proc: null,
        eventTarget: null,
      }),
    ).not.toThrow();
  });

  it('C3: captures rejections via rejection-tracking when available', async () => {
    const { installPromiseRejectionHandler } = await import('./handlers.js');
    const captured: unknown[] = [];
    let onUnhandled: ((id: unknown, error: unknown) => void) | undefined;
    const fakeTracking = {
      enable(opts: {
        allRejections?: boolean;
        onUnhandled?: (id: unknown, error: unknown) => void;
        onHandled?: (id: unknown) => void;
      }) {
        onUnhandled = opts.onUnhandled;
      },
      disable() {
        /* noop */
      },
    };

    const uninstall = installPromiseRejectionHandler((reason) => captured.push(reason), {
      loadRejectionTracking: () => fakeTracking,
      // Ensure no process/window fallback is used even if present.
      proc: null,
      eventTarget: null,
    });

    const err = new Error('async boom');
    onUnhandled?.('id-1', err);
    expect(captured).toContain(err);
    uninstall();
  });
});
