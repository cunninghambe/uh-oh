import { describe, expect, it } from 'vitest';

import { validateWebhookUrl, isWebhookUrlSafe, isBlockedIp, isIpLiteralHost } from './url-guard.js';

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

describe('isBlockedIp (resolved-address check, shared with the DNS re-check)', () => {
  it('blocks loopback / private / link-local / metadata IPv4', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.0.0.5')).toBe(true);
    expect(isBlockedIp('172.16.9.9')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isBlockedIp('0.0.0.0')).toBe(true);
  });

  it('blocks loopback / ULA / link-local / mapped IPv6', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fd00::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('allows public IPv4 and IPv6 addresses', () => {
    expect(isBlockedIp('93.184.216.34')).toBe(false);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isIpLiteralHost', () => {
  it('recognizes dotted-quad IPv4 literals', () => {
    expect(isIpLiteralHost('127.0.0.1')).toBe(true);
    expect(isIpLiteralHost('93.184.216.34')).toBe(true);
  });

  it('recognizes bracketed IPv6 literals', () => {
    expect(isIpLiteralHost('[::1]')).toBe(true);
    expect(isIpLiteralHost('[2606:4700:4700::1111]')).toBe(true);
  });

  it('treats real hostnames as non-literals', () => {
    expect(isIpLiteralHost('hooks.example.com')).toBe(false);
    expect(isIpLiteralHost('localhost')).toBe(false);
    // A shape with an out-of-range octet is not a valid IPv4 literal.
    expect(isIpLiteralHost('999.1.1.1')).toBe(false);
  });
});
