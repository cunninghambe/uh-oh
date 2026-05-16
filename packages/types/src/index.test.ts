import { describe, expect, it } from 'vitest';
import {
  BreadcrumbSchema,
  DeviceInfoSchema,
  EventEnvelopeSchema,
  JsonValueSchema,
  StackFrameSchema,
  UserSchema,
} from './index.js';

const validFrame = {
  function: 'render',
  module: 'src/App.tsx',
  filename: 'App.tsx',
  lineno: 42,
  colno: 7,
  inApp: true,
};

const validEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
  timestamp: '2026-05-16T12:34:56.000Z',
  platform: 'android' as const,
  release: { version: '1.2.3', build: '42' },
  level: 'error' as const,
  exception: {
    type: 'TypeError',
    value: "Cannot read property 'x' of undefined",
    stacktrace: [validFrame],
    mechanism: 'js-global' as const,
  },
  breadcrumbs: [
    {
      category: 'navigation',
      message: 'Home -> Profile',
      level: 'info' as const,
      ts: '2026-05-16T12:34:55.000Z',
    },
  ],
  device: { osName: 'Android', osVersion: '14' },
};

describe('StackFrameSchema', () => {
  it('accepts a valid frame', () => {
    expect(StackFrameSchema.parse(validFrame)).toMatchObject(validFrame);
  });

  it('requires inApp', () => {
    const { inApp: _drop, ...rest } = validFrame;
    const r = StackFrameSchema.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['inApp']);
    }
  });

  it('rejects malformed instructionAddr', () => {
    const r = StackFrameSchema.safeParse({ ...validFrame, instructionAddr: '12345' });
    expect(r.success).toBe(false);
  });

  it('accepts valid hex instructionAddr', () => {
    const r = StackFrameSchema.safeParse({ ...validFrame, instructionAddr: '0xdeadbeef' });
    expect(r.success).toBe(true);
  });

  it('rejects negative lineno (boundary)', () => {
    const r = StackFrameSchema.safeParse({ ...validFrame, lineno: -1 });
    expect(r.success).toBe(false);
  });
});

describe('BreadcrumbSchema', () => {
  const validBc = {
    category: 'navigation',
    message: 'Home -> Profile',
    ts: '2026-05-16T12:34:55.000Z',
  };

  it('accepts minimal breadcrumb with default level', () => {
    const r = BreadcrumbSchema.parse(validBc);
    expect(r.level).toBe('info');
  });

  it('rejects empty category', () => {
    const r = BreadcrumbSchema.safeParse({ ...validBc, category: '' });
    expect(r.success).toBe(false);
  });

  it('rejects message above 1024 chars (boundary)', () => {
    const r = BreadcrumbSchema.safeParse({ ...validBc, message: 'x'.repeat(1025) });
    expect(r.success).toBe(false);
  });

  it('accepts message at 1024 chars (boundary)', () => {
    const r = BreadcrumbSchema.safeParse({ ...validBc, message: 'x'.repeat(1024) });
    expect(r.success).toBe(true);
  });

  it('rejects non-ISO timestamp', () => {
    const r = BreadcrumbSchema.safeParse({ ...validBc, ts: 'yesterday' });
    expect(r.success).toBe(false);
  });
});

describe('DeviceInfoSchema', () => {
  it('accepts minimal device info', () => {
    expect(DeviceInfoSchema.parse({ osName: 'Android', osVersion: '14' })).toMatchObject({
      osName: 'Android',
      osVersion: '14',
    });
  });

  it('requires osName', () => {
    const r = DeviceInfoSchema.safeParse({ osVersion: '14' });
    expect(r.success).toBe(false);
  });

  it('rejects negative memoryTotal', () => {
    const r = DeviceInfoSchema.safeParse({
      osName: 'Android',
      osVersion: '14',
      memoryTotal: -1,
    });
    expect(r.success).toBe(false);
  });
});

describe('UserSchema', () => {
  it('accepts id-only user', () => {
    expect(UserSchema.parse({ id: 'u-1' })).toEqual({ id: 'u-1' });
  });

  it('rejects malformed email', () => {
    const r = UserSchema.safeParse({ id: 'u-1', email: 'not-an-email' });
    expect(r.success).toBe(false);
  });

  it('rejects empty id', () => {
    const r = UserSchema.safeParse({ id: '' });
    expect(r.success).toBe(false);
  });
});

describe('JsonValueSchema', () => {
  it('accepts nested object/array structure', () => {
    const v = { a: 1, b: [true, null, { c: 'x' }] };
    expect(JsonValueSchema.parse(v)).toEqual(v);
  });

  it('rejects function value', () => {
    const r = JsonValueSchema.safeParse({ fn: () => 1 });
    expect(r.success).toBe(false);
  });
});

describe('EventEnvelopeSchema', () => {
  it('parses a valid envelope', () => {
    const r = EventEnvelopeSchema.parse(validEnvelope);
    expect(r.exception.type).toBe('TypeError');
    expect(r.breadcrumbs).toHaveLength(1);
  });

  it('preserves unknown top-level fields (forward-compat)', () => {
    const withUnknown = { ...validEnvelope, futureField: { hello: 'world' } };
    const r = EventEnvelopeSchema.parse(withUnknown) as Record<string, unknown>;
    expect(r['futureField']).toEqual({ hello: 'world' });
  });

  it('rejects missing exception', () => {
    const { exception: _drop, ...rest } = validEnvelope;
    const r = EventEnvelopeSchema.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === 'exception')).toBe(true);
    }
  });

  it('rejects invalid platform', () => {
    const r = EventEnvelopeSchema.safeParse({ ...validEnvelope, platform: 'windows' });
    expect(r.success).toBe(false);
  });

  it('rejects invalid mechanism', () => {
    const r = EventEnvelopeSchema.safeParse({
      ...validEnvelope,
      exception: { ...validEnvelope.exception, mechanism: 'something-else' },
    });
    expect(r.success).toBe(false);
  });

  it('defaults breadcrumbs to empty array', () => {
    const { breadcrumbs: _drop, ...rest } = validEnvelope;
    const r = EventEnvelopeSchema.parse(rest);
    expect(r.breadcrumbs).toEqual([]);
  });

  it('rejects more than 100 breadcrumbs (boundary)', () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      category: 'log',
      message: `msg ${String(i)}`,
      ts: '2026-05-16T12:34:55.000Z',
    }));
    const r = EventEnvelopeSchema.safeParse({ ...validEnvelope, breadcrumbs: tooMany });
    expect(r.success).toBe(false);
  });

  it('accepts exactly 100 breadcrumbs (boundary)', () => {
    const exactly = Array.from({ length: 100 }, (_, i) => ({
      category: 'log',
      message: `msg ${String(i)}`,
      ts: '2026-05-16T12:34:55.000Z',
    }));
    const r = EventEnvelopeSchema.safeParse({ ...validEnvelope, breadcrumbs: exactly });
    expect(r.success).toBe(true);
  });

  it('rejects fingerprint with empty string', () => {
    const r = EventEnvelopeSchema.safeParse({ ...validEnvelope, fingerprint: ['ok', ''] });
    expect(r.success).toBe(false);
  });

  it('rejects fingerprint above max length (boundary)', () => {
    const r = EventEnvelopeSchema.safeParse({
      ...validEnvelope,
      fingerprint: Array.from({ length: 9 }, (_, i) => `p${String(i)}`),
    });
    expect(r.success).toBe(false);
  });

  it('reports field path in error issues', () => {
    const r = EventEnvelopeSchema.safeParse({
      ...validEnvelope,
      exception: { ...validEnvelope.exception, type: '' },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['exception', 'type']);
    }
  });
});
