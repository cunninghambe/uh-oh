import { Platform } from 'react-native';

/**
 * Detects the current platform by reading from react-native's Platform module.
 * Falls back to 'unknown' if not running inside a React Native environment.
 */
export function platform(): 'ios' | 'android' | 'unknown' {
  const os = Platform.OS as string;
  if (os === 'ios') return 'ios';
  if (os === 'android') return 'android';
  return 'unknown';
}

/**
 * Returns the OS version string via `Platform.Version` when available
 * (a number — the API level — on Android), or 'unknown' if not exposed.
 */
export function osVersion(): string {
  const version = (Platform as { Version?: string | number }).Version;
  if (version === undefined || version === null) return 'unknown';
  return String(version);
}
