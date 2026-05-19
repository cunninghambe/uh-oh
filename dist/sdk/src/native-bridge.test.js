import { describe, expect, it, afterEach, vi } from 'vitest';
import { Platform, setUhOhNativeStub } from './__test-stubs__/react-native.js';
// Re-import nativeBridge after each Platform.OS manipulation via vi.doMock / resetModules.
describe('nativeBridge', () => {
    afterEach(() => {
        // Restore defaults between tests.
        Platform.OS = 'android';
        setUhOhNativeStub(null);
        setUhOhNativeStub({
            install: () => Promise.resolve(true),
            getPendingReports: () => Promise.resolve([]),
        });
        vi.resetModules();
    });
    it('returns null on iOS', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
            NativeModules: {
                UhOhNative: {
                    install: () => Promise.resolve(true),
                    getPendingReports: () => Promise.resolve([]),
                },
            },
        }));
        vi.resetModules();
        const { nativeBridge } = await import('./native-bridge.js');
        expect(nativeBridge()).toBeNull();
        vi.doUnmock('react-native');
        vi.resetModules();
    });
    it('returns null when UhOhNative module is absent', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'android' },
            NativeModules: {},
        }));
        vi.resetModules();
        const { nativeBridge } = await import('./native-bridge.js');
        expect(nativeBridge()).toBeNull();
        vi.doUnmock('react-native');
        vi.resetModules();
    });
    it('returns a bridge object on Android when module is present', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'android' },
            NativeModules: {
                UhOhNative: {
                    install: () => Promise.resolve(true),
                    getPendingReports: () => Promise.resolve([]),
                },
            },
        }));
        vi.resetModules();
        const { nativeBridge } = await import('./native-bridge.js');
        const bridge = nativeBridge();
        expect(bridge).not.toBeNull();
        expect(typeof bridge?.install).toBe('function');
        expect(typeof bridge?.getPendingReports).toBe('function');
        vi.doUnmock('react-native');
        vi.resetModules();
    });
    it('install resolves to true', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'android' },
            NativeModules: {
                UhOhNative: {
                    install: (_config) => Promise.resolve(true),
                    getPendingReports: () => Promise.resolve([]),
                },
            },
        }));
        vi.resetModules();
        const { nativeBridge } = await import('./native-bridge.js');
        const bridge = nativeBridge();
        const result = await bridge?.install({ debug: false });
        expect(result).toBe(true);
        vi.doUnmock('react-native');
        vi.resetModules();
    });
    it('install forwards debug flag', async () => {
        const installSpy = vi.fn().mockResolvedValue(true);
        vi.doMock('react-native', () => ({
            Platform: { OS: 'android' },
            NativeModules: {
                UhOhNative: {
                    install: installSpy,
                    getPendingReports: () => Promise.resolve([]),
                },
            },
        }));
        vi.resetModules();
        const { nativeBridge } = await import('./native-bridge.js');
        await nativeBridge()?.install({ debug: true });
        expect(installSpy).toHaveBeenCalledWith({ debug: true });
        vi.doUnmock('react-native');
        vi.resetModules();
    });
    it('getPendingReports returns empty array when no pending reports', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'android' },
            NativeModules: {
                UhOhNative: {
                    install: () => Promise.resolve(true),
                    getPendingReports: () => Promise.resolve([]),
                },
            },
        }));
        vi.resetModules();
        const { nativeBridge } = await import('./native-bridge.js');
        const reports = await nativeBridge()?.getPendingReports();
        expect(reports).toEqual([]);
        vi.doUnmock('react-native');
        vi.resetModules();
    });
    it('getPendingReports returns partial envelopes from native', async () => {
        const pending = [
            {
                mechanism: 'android-java-ueh',
                timestamp: '2024-01-01T00:00:00.000Z',
                exception: {
                    type: 'NullPointerException',
                    value: 'null ref',
                    stacktrace: [],
                    mechanism: 'android-java-ueh',
                },
                device: { osName: 'Android', osVersion: '14' },
            },
        ];
        vi.doMock('react-native', () => ({
            Platform: { OS: 'android' },
            NativeModules: {
                UhOhNative: {
                    install: () => Promise.resolve(true),
                    getPendingReports: () => Promise.resolve(pending),
                },
            },
        }));
        vi.resetModules();
        const { nativeBridge } = await import('./native-bridge.js');
        const reports = await nativeBridge()?.getPendingReports();
        expect(reports).toHaveLength(1);
        expect(reports?.[0]).toMatchObject({ mechanism: 'android-java-ueh' });
        vi.doUnmock('react-native');
        vi.resetModules();
    });
});
//# sourceMappingURL=native-bridge.test.js.map