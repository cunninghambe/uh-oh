import { NativeModules, Platform } from 'react-native';
import type { EventEnvelope } from '@uh-oh/types';

/** A pending native crash report plus the id used to ack (delete) it. */
export type PendingReport = { id: string; payload: Partial<EventEnvelope> };

export type NativeBridge = {
  install(config: { debug: boolean }): Promise<boolean>;
  getPendingReports(): Promise<PendingReport[]>;
  /** Deletes the on-disk report file once JS has durably taken ownership. */
  ackReport(id: string): Promise<void>;
};

type UhOhNativeModule = {
  install(config: { debug: boolean }): Promise<boolean>;
  getPendingReports(): Promise<unknown[]>;
  ackReport?(id: string): Promise<void>;
};

/**
 * Returns the native bridge on Android when the native module is registered,
 * or null on iOS (SDK is a no-op) and when the module is absent (e.g. tests
 * with enableNative: false, or Expo Go without the native module built in).
 */
export function nativeBridge(): NativeBridge | null {
  if (Platform.OS !== 'android') return null;

  const mod = (NativeModules as Record<string, unknown>)['UhOhNative'] as
    | UhOhNativeModule
    | undefined;
  if (!mod) return null;

  return {
    install: (config) => mod.install(config),
    getPendingReports: async () => {
      const raw = await mod.getPendingReports();
      // New native shape: each element is { id, payload }. We do NOT delete
      // files here — the JS layer acks each report only after it is durably
      // spooled, so a kill mid-handoff can't lose a report (M1).
      return raw.map((item): PendingReport => {
        if (item !== null && typeof item === 'object' && 'payload' in item) {
          const it = item as { id?: unknown; payload?: unknown };
          return {
            id: typeof it.id === 'string' ? it.id : '',
            payload: (it.payload ?? {}) as Partial<EventEnvelope>,
          };
        }
        // Backward-compat: an older native module returned bare partial
        // envelopes with no id (and deleted files itself). Treat the whole
        // item as the payload; without an id there is nothing to ack.
        return { id: '', payload: item as Partial<EventEnvelope> };
      });
    },
    ackReport: async (id: string) => {
      if (!id) return;
      if (typeof mod.ackReport === 'function') {
        await mod.ackReport(id);
      }
    },
  };
}
