import type { EventEnvelope } from '@uh-oh/types';
import { describe, expect, it } from 'vitest';

import { computeFingerprint, computeTitle } from './fingerprint.js';

const baseEnv = (overrides: Partial<EventEnvelope> = {}): EventEnvelope =>
  ({
    sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
    timestamp: '2026-05-16T12:00:00.000Z',
    platform: 'android',
    release: { version: '1.0.0', build: '1' },
    level: 'error',
    exception: {
      type: 'TypeError',
      value: 'cannot read x',
      stacktrace: [
        { module: 'src/App.tsx', function: 'render', inApp: true },
        { module: 'node_modules/react-native/Libraries/foo.js', function: 'x', inApp: false },
      ],
      mechanism: 'js-global',
    },
    breadcrumbs: [],
    device: { osName: 'Android', osVersion: '14' },
    ...overrides,
  }) as EventEnvelope;

describe('computeFingerprint', () => {
  it('respects SDK-provided fingerprint override', () => {
    expect(computeFingerprint(baseEnv({ fingerprint: ['a', 'b'] }))).toBe('a::b');
  });

  it('uses exception type + top in-app frame by default', () => {
    expect(computeFingerprint(baseEnv())).toBe('TypeError::src/App.tsx:render');
  });

  it('skips internal RN frames marked inApp=false', () => {
    const env = baseEnv({
      exception: {
        type: 'Error',
        value: 'x',
        mechanism: 'js-global',
        stacktrace: [
          { filename: 'node_modules/react-native/Libraries/x.js', function: 'rn', inApp: false },
          { module: 'src/Screen.tsx', function: 'load', inApp: true },
        ],
      },
    });
    expect(computeFingerprint(env)).toBe('Error::src/Screen.tsx:load');
  });

  it('skips android.* internal frames even when inApp=true', () => {
    const env = baseEnv({
      exception: {
        type: 'NullPointerException',
        value: 'x',
        mechanism: 'android-java-ueh',
        stacktrace: [
          { module: 'android.os.Handler', function: 'handleMessage', inApp: true },
          { module: 'com.myapp.MainActivity', function: 'onCreate', inApp: true },
        ],
      },
    });
    expect(computeFingerprint(env)).toBe('NullPointerException::com.myapp.MainActivity:onCreate');
  });

  it('falls back to first frame when no non-internal frames exist', () => {
    const env = baseEnv({
      exception: {
        type: 'Error',
        value: 'x',
        mechanism: 'js-global',
        stacktrace: [{ filename: '[native code]', function: 'foo', inApp: false }],
      },
    });
    expect(computeFingerprint(env)).toBe('Error::[native code]:foo');
  });

  it('handles empty stacktrace', () => {
    const env = baseEnv({
      exception: { type: 'Error', value: 'x', mechanism: 'js-global', stacktrace: [] },
    });
    expect(computeFingerprint(env)).toBe('Error:::');
  });

  it('groups same fingerprint across different releases', () => {
    const a = computeFingerprint(baseEnv({ release: { version: '1.0.0', build: '1' } }));
    const b = computeFingerprint(baseEnv({ release: { version: '2.0.0', build: '99' } }));
    expect(a).toBe(b);
  });
});

describe('computeTitle', () => {
  it('formats as type: value at frame', () => {
    expect(computeTitle(baseEnv())).toBe('TypeError: cannot read x at render');
  });

  it('truncates very long value', () => {
    const env = baseEnv({
      exception: { ...baseEnv().exception, value: 'x'.repeat(500) },
    });
    expect(computeTitle(env)).toContain('x'.repeat(200));
    expect(computeTitle(env)).not.toContain('x'.repeat(201));
  });
});
