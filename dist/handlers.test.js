import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
// We need to set up ErrorUtils on globalThis before importing handlers
const mockPrevHandler = vi.fn();
let currentHandler = null;
const MockErrorUtils = {
    setGlobalHandler: vi.fn((fn) => {
        currentHandler = fn;
    }),
    getGlobalHandler: vi.fn(() => mockPrevHandler),
};
describe('installGlobalErrorHandler', () => {
    beforeEach(() => {
        globalThis['ErrorUtils'] = MockErrorUtils;
        currentHandler = null;
        vi.clearAllMocks();
        MockErrorUtils.getGlobalHandler.mockReturnValue(mockPrevHandler);
    });
    afterEach(() => {
        delete globalThis['ErrorUtils'];
    });
    it('installs handler and captures errors', async () => {
        const { installGlobalErrorHandler } = await import('./handlers.js');
        const captured = [];
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
    it('returns no-op uninstall when ErrorUtils is unavailable', async () => {
        delete globalThis['ErrorUtils'];
        const { installGlobalErrorHandler } = await import('./handlers.js');
        const uninstall = installGlobalErrorHandler(() => undefined);
        expect(() => uninstall()).not.toThrow();
    });
});
describe('installPromiseRejectionHandler', () => {
    it('captures unhandled rejections via process.on', async () => {
        const { installPromiseRejectionHandler } = await import('./handlers.js');
        const captured = [];
        const uninstall = installPromiseRejectionHandler((reason) => captured.push(reason));
        process.emit('unhandledRejection', 'test-reason', Promise.resolve());
        expect(captured).toContain('test-reason');
        uninstall();
    });
    it('uninstall removes the process listener', async () => {
        const { installPromiseRejectionHandler } = await import('./handlers.js');
        const captured = [];
        const uninstall = installPromiseRejectionHandler((reason) => captured.push(reason));
        uninstall();
        // After uninstall, manually verify listener count decreased (indirect check)
        // We can't emit unhandledRejection safely as vitest catches it
        // Instead verify the listener was removed by checking that capture is no longer called
        const listenersBefore = process.listenerCount('unhandledRejection');
        const uninstall2 = installPromiseRejectionHandler((reason) => captured.push(reason));
        const listenersAfter = process.listenerCount('unhandledRejection');
        expect(listenersAfter).toBe(listenersBefore + 1);
        uninstall2();
        expect(process.listenerCount('unhandledRejection')).toBe(listenersBefore);
    });
});
//# sourceMappingURL=handlers.test.js.map