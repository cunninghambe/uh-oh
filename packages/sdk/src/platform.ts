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
