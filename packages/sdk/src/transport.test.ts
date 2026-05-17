import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@uh-oh/types';
import { sendEvent } from './transport.js';

const minEnv: EventEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
  timestamp: '2026-05-16T12:00:00.000Z',
  platform: 'android',
  release: { version: '1.0.0', build: '1' },
  level: 'error',
  exception: {
    type: 'Error',
    value: 'test',
    stacktrace: [{ inApp: true }],
    mechanism: 'js-global',
  },
  breadcrumbs: [],
  device: { osName: 'Android', osVersion: '14' },
};

describe('sendEvent', () => {
  it('returns ok:true on 202', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const result = await sendEvent('https://errors.example.com', 'mykey', minEnv, { fetchFn });
    expect(result).toEqual({ ok: true, status: 202 });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://errors.example.com/ingest/mykey',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns ok:false with status on 401', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await sendEvent('https://errors.example.com', 'mykey', minEnv, { fetchFn });
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns ok:false with status 413', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 413 });
    const result = await sendEvent('https://errors.example.com', 'mykey', minEnv, { fetchFn });
    expect(result).toEqual({ ok: false, status: 413 });
  });

  it('returns ok:false on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('Network Error'));
    const result = await sendEvent('https://errors.example.com', 'mykey', minEnv, { fetchFn });
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false on timeout (AbortError)', async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, opts: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (opts.signal) {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
        }),
    );
    const result = await sendEvent('https://errors.example.com', 'mykey', minEnv, {
      fetchFn,
      timeoutMs: 10,
    });
    expect(result).toEqual({ ok: false });
  });
});
