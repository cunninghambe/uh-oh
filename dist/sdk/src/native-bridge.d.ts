import type { EventEnvelope } from '../../_uh_oh_types';
export type NativeBridge = {
    install(config: {
        debug: boolean;
    }): Promise<boolean>;
    getPendingReports(): Promise<Partial<EventEnvelope>[]>;
};
/**
 * Returns the native bridge on Android when the native module is registered,
 * or null on iOS (SDK is a no-op) and when the module is absent (e.g. tests
 * with enableNative: false, or Expo Go without the native module built in).
 */
export declare function nativeBridge(): NativeBridge | null;
//# sourceMappingURL=native-bridge.d.ts.map