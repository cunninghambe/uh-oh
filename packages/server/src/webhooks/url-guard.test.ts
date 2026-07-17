import { describe, expect, it } from 'vitest';

import { validateWebhookUrl, isWebhookUrlSafe } from './url-guard.js';

describe('validateWebhookUrl', () => {
  it('accepts a normal public https URL', () => {
    const r = validateWebhookUrl('https://hooks.example.com/webhook');
    expect(r.ok).toBe(true);
  });

  it('accepts a public http URL', () => {
    expect(validateWebhookUrl('http://hooks.example.com/x').ok).toBe(true);
  });

  it('rejects non-parseable input', () => {
    const r = validateWebhookUrl('not a url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_url');
  });

  it('rejects ftp scheme', () => {
    const r = validateWebhookUrl('ftp://example.com/file');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_scheme');
  });

  it('rejects file scheme', () => {
    expect(validateWebhookUrl('file:///etc/passwd').ok).toBe(false);
  });

  it('rejects localhost', () => {
    const r = validateWebhookUrl('http://localhost:8080/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('blocked_host');
  });

  it('rejects *.localhost', () => {
    expect(validateWebhookUrl('http://api.localhost/hook').ok).toBe(false);
  });

  it('rejects cloud metadata IP (169.254.169.254)', () => {
    const r = validateWebhookUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('blocked_ip');
  });

  it('rejects loopback IPv4 (127.0.0.1)', () => {
    expect(validateWebhookUrl('http://127.0.0.1/hook').ok).toBe(false);
  });

  it('rejects 0.0.0.0', () => {
    expect(validateWebhookUrl('http://0.0.0.0/hook').ok).toBe(false);
  });

  it('rejects 10.0.0.0/8 private range', () => {
    expect(validateWebhookUrl('https://10.1.2.3/hook').ok).toBe(false);
  });

  it('rejects 172.16.0.0/12 private range', () => {
    expect(validateWebhookUrl('https://172.16.0.1/hook').ok).toBe(false);
    expect(validateWebhookUrl('https://172.31.255.255/hook').ok).toBe(false);
  });

  it('accepts 172.15.x.x and 172.32.x.x (just outside the private block)', () => {
    expect(validateWebhookUrl('https://172.15.0.1/hook').ok).toBe(true);
    expect(validateWebhookUrl('https://172.32.0.1/hook').ok).toBe(true);
  });

  it('rejects 192.168.0.0/16 private range', () => {
    expect(validateWebhookUrl('https://192.168.1.1/hook').ok).toBe(false);
  });

  it('rejects IPv6 loopback (::1)', () => {
    expect(validateWebhookUrl('http://[::1]:9000/hook').ok).toBe(false);
  });

  it('rejects IPv6 unique-local (fc00::/7)', () => {
    expect(validateWebhookUrl('http://[fc00::1]/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://[fd12:3456::1]/hook').ok).toBe(false);
  });

  it('rejects IPv6 link-local (fe80::/10)', () => {
    expect(validateWebhookUrl('http://[fe80::1]/hook').ok).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', () => {
    expect(validateWebhookUrl('http://[::ffff:127.0.0.1]/hook').ok).toBe(false);
  });

  it('accepts a public IPv6 address', () => {
    expect(validateWebhookUrl('http://[2606:4700:4700::1111]/hook').ok).toBe(true);
  });

  it('isWebhookUrlSafe mirrors validateWebhookUrl', () => {
    expect(isWebhookUrlSafe('https://ok.example.com')).toBe(true);
    expect(isWebhookUrlSafe('http://127.0.0.1')).toBe(false);
  });
});
