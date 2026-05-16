import type { EventEnvelope, StackFrame } from '@uh-oh/types';

const RN_INTERNAL_PREFIXES = [
  'node_modules/react-native/',
  'node_modules/@react-native/',
  'node_modules/react/',
  'node_modules/expo/',
  'node_modules/expo-modules-core/',
  'node_modules/hermes-engine/',
  '[native code]',
];

const ANDROID_INTERNAL_PREFIXES = [
  'android.',
  'androidx.',
  'java.',
  'kotlin.',
  'com.facebook.react.',
  'com.facebook.jni.',
];

const isInternalFrame = (frame: StackFrame): boolean => {
  if (frame.module && ANDROID_INTERNAL_PREFIXES.some((p) => frame.module?.startsWith(p))) {
    return true;
  }
  if (frame.filename && RN_INTERNAL_PREFIXES.some((p) => frame.filename?.includes(p))) {
    return true;
  }
  return false;
};

const pickTopFrame = (frames: StackFrame[]): StackFrame | undefined => {
  const inApp = frames.find((f) => f.inApp && !isInternalFrame(f));
  if (inApp) return inApp;
  return frames.find((f) => !isInternalFrame(f)) ?? frames[0];
};

export const computeFingerprint = (env: EventEnvelope): string => {
  if (env.fingerprint && env.fingerprint.length > 0) {
    return env.fingerprint.join('::');
  }
  const top = pickTopFrame(env.exception.stacktrace);
  const module = top?.module ?? top?.filename ?? '';
  const fn = top?.function ?? '';
  return `${env.exception.type}::${module}:${fn}`;
};

export const computeTitle = (env: EventEnvelope): string => {
  const top = pickTopFrame(env.exception.stacktrace);
  const where = top?.function ?? top?.module ?? top?.filename ?? '?';
  return `${env.exception.type}: ${env.exception.value.slice(0, 200)} at ${where}`;
};
