import { NativeModules, Platform } from 'react-native';
/**
 * Returns the native bridge on Android when the native module is registered,
 * or null on iOS (SDK is a no-op) and when the module is absent (e.g. tests
 * with enableNative: false, or Expo Go without the native module built in).
 */
export function nativeBridge() {
    if (Platform.OS !== 'android')
        return null;
    const mod = NativeModules['UhOhNative'];
    if (!mod)
        return null;
    return {
        install: (config) => mod.install(config),
        getPendingReports: async () => {
            const raw = await mod.getPendingReports();
            // Each element is a partial EventEnvelope written by CrashWriter.
            // We trust the shape coming from our own native code; unknown fields
            // are stripped when buildEnvelopeFromPartial constructs the full envelope.
            return raw;
        },
    };
}
//# sourceMappingURL=native-bridge.js.map