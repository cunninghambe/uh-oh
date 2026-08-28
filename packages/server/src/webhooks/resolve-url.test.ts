// Webhook target resolution — the fallback order, the startup validation of
// UH_OH_DEFAULT_WEBHOOK_URL, and the warning that makes an undeliverable alert
// audible instead of silent.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WEBHOOK_URL_ENV,
  resolveDefaultWebhookUrl,
  resolveWebhookUrl,
  warnNoWebhookTarget,
} from './resolve-url.js';

const PROJECT_URL = 'https://hooks.example/project';
const DEFAULT_URL = 'https://hooks.example/instance';

describe('resolveWebhookUrl', () => {
  it('prefers the project webhook over the instance default', () => {
    expect(resolveWebhookUrl({ webhookUrl: PROJECT_URL }, DEFAULT_URL)).toBe(PROJECT_URL);
  });

  it('falls back to the instance default when the project has none', () => {
    expect(resolveWebhookUrl({ webhookUrl: null }, DEFAULT_URL)).toBe(DEFAULT_URL);
  });

  it('returns null when neither is set', () => {
    expect(resolveWebhookUrl({ webhookUrl: null }, undefined)).toBeNull();
    expect(resolveWebhookUrl({ webhookUrl: null })).toBeNull();
  });

  it('treats an empty string like unset at both levels', () => {
    expect(resolveWebhookUrl({ webhookUrl: '' }, DEFAULT_URL)).toBe(DEFAULT_URL);
    expect(resolveWebhookUrl({ webhookUrl: '' }, '')).toBeNull();
    expect(resolveWebhookUrl({ webhookUrl: null }, '')).toBeNull();
  });

  it('returns null for a missing project even when a default exists', () => {
    // No project row means the dispatcher cannot build a payload, so enqueueing
    // against the fallback would only manufacture a doomed dispatch.
    expect(resolveWebhookUrl(null, DEFAULT_URL)).toBeNull();
    expect(resolveWebhookUrl(undefined, DEFAULT_URL)).toBeNull();
  });
});

describe('warnNoWebhookTarget', () => {
  const project = { id: 'p_1', name: 'Whitespace' };

  it('emits exactly one warn naming the project, the event, and both remedies', () => {
    const warn = vi.fn();
    warnNoWebhookTarget({ warn }, project, 'monitor.missed');

    expect(warn).toHaveBeenCalledOnce();
    const [msg, meta] = warn.mock.calls[0] as [string, object];
    expect(msg).toContain('monitor.missed');
    expect(msg).toContain('Whitespace');
    expect(msg).toContain('p_1');
    expect(msg).toContain('webhook_url');
    expect(msg).toContain(DEFAULT_WEBHOOK_URL_ENV);
    expect(meta).toEqual({ projectId: 'p_1', project: 'Whitespace', type: 'monitor.missed' });
  });

  it('is a no-op for a logger without warn, or no logger at all', () => {
    expect(() => {
      warnNoWebhookTarget(undefined, project, 'issue.new');
    }).not.toThrow();
    expect(() => {
      warnNoWebhookTarget({}, project, 'issue.new');
    }).not.toThrow();
  });
});

describe('resolveDefaultWebhookUrl', () => {
  it('is undefined (feature off) when unset or empty, without complaining', () => {
    const onInvalid = vi.fn();
    expect(resolveDefaultWebhookUrl(undefined, onInvalid)).toBeUndefined();
    expect(resolveDefaultWebhookUrl('', onInvalid)).toBeUndefined();
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('accepts a valid https webhook URL', () => {
    const onInvalid = vi.fn();
    expect(resolveDefaultWebhookUrl(DEFAULT_URL, onInvalid)).toBe(DEFAULT_URL);
    expect(resolveDefaultWebhookUrl('https://discord.com/api/webhooks/1/abc')).toBe(
      'https://discord.com/api/webhooks/1/abc',
    );
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it.each([
    ['not-a-url', 'invalid_url'],
    ['ftp://hooks.example/x', 'invalid_scheme'],
    ['http://localhost:3300/hook', 'blocked_host'],
    ['http://127.0.0.1/hook', 'blocked_ip'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked_ip'],
    ['https://user:pass@hooks.example/x', 'credentials_in_url'],
  ])('reports %s and boots WITHOUT it rather than throwing', (raw, reason) => {
    const onInvalid = vi.fn();
    let resolved: string | undefined;
    expect(() => {
      resolved = resolveDefaultWebhookUrl(raw, onInvalid);
    }).not.toThrow();

    expect(resolved).toBeUndefined();
    expect(onInvalid).toHaveBeenCalledOnce();
    const message = String(onInvalid.mock.calls[0]?.[0]);
    expect(message).toContain(DEFAULT_WEBHOOK_URL_ENV);
    expect(message).toContain(reason);
  });

  it('survives an invalid value with no reporter attached', () => {
    expect(resolveDefaultWebhookUrl('not-a-url')).toBeUndefined();
  });
});
