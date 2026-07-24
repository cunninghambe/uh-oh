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

  it('rejects 100.64.0.0/10 CGNAT (RFC 6598)', () => {
    const r = validateWebhookUrl('http://100.64.0.1/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('blocked_ip');
    expect(validateWebhookUrl('http://100.127.255.255/hook').ok).toBe(false);
  });

  it('accepts 100.63.x.x and 100.128.x.x (just outside CGNAT)', () => {
    expect(validateWebhookUrl('http://100.63.0.1/hook').ok).toBe(true);
    expect(validateWebhookUrl('http://100.128.0.1/hook').ok).toBe(true);
  });

  it('rejects 192.0.0.0/24 (IETF protocol assignments)', () => {
    expect(validateWebhookUrl('http://192.0.0.8/hook').ok).toBe(false);
    // 192.0.2.0/24 (TEST-NET-1) is outside the /24 and stays allowed.
    expect(validateWebhookUrl('http://192.0.2.1/hook').ok).toBe(true);
  });

  it('rejects 198.18.0.0/15 (benchmarking)', () => {
    expect(validateWebhookUrl('http://198.18.0.1/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://198.19.255.255/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://198.17.0.1/hook').ok).toBe(true);
    expect(validateWebhookUrl('http://198.20.0.1/hook').ok).toBe(true);
  });

  it('rejects 224.0.0.0/4 multicast and 240.0.0.0/4 reserved incl. broadcast', () => {
    expect(validateWebhookUrl('http://224.0.0.1/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://239.255.255.250/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://240.0.0.1/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://255.255.255.255/hook').ok).toBe(false);
    // 223.x is the last public /8 below multicast.
    expect(validateWebhookUrl('http://223.255.255.1/hook').ok).toBe(true);
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

  it('rejects IPv6 site-local (fec0::/10)', () => {
    expect(validateWebhookUrl('http://[fec0::1]/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://[feff:1234::1]/hook').ok).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', () => {
    expect(validateWebhookUrl('http://[::ffff:127.0.0.1]/hook').ok).toBe(false);
  });

  it('rejects the whole ::/96 IPv4-compatible range, dotted and hex forms', () => {
    // The confirmed bypass: the URL parser normalizes ::127.0.0.1 to ::7f00:1,
    // which the old dotted-quad-only check never saw.
    const r = validateWebhookUrl('http://[::7f00:1]/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('blocked_ip');
    expect(validateWebhookUrl('http://[::127.0.0.1]/hook').ok).toBe(false);
    // Not only the members embedding a blocked IPv4: the whole /96 is blocked.
    expect(validateWebhookUrl('http://[::8.8.8.8]/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://[::a00:1]/hook').ok).toBe(false);
    expect(validateWebhookUrl('http://[::ffff]/hook').ok).toBe(false);
  });

  it('accepts a public IPv6 address', () => {
    expect(validateWebhookUrl('http://[2606:4700:4700::1111]/hook').ok).toBe(true);
  });

  it('does not over-block: ::/96 check leaves ordinary compressed IPv6 alone', () => {
    // More than two hextets after '::' is outside the /96.
    expect(validateWebhookUrl('http://[::1:2:3]/hook').ok).toBe(true);
    expect(validateWebhookUrl('http://[2001:db8::1]/hook').ok).toBe(true);
  });

  it('rejects a URL carrying userinfo credentials', () => {
    const r = validateWebhookUrl('http://user:s3cret@example.com/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('credentials_in_url');
    // Username alone, and password alone, are both rejected.
    expect(validateWebhookUrl('https://user@example.com/hook').ok).toBe(false);
    expect(validateWebhookUrl('https://:pw@example.com/hook').ok).toBe(false);
    // The same host without credentials stays fine.
    expect(validateWebhookUrl('https://example.com/hook').ok).toBe(true);
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

  it('blocks CGNAT / protocol-assignment / benchmarking / multicast / reserved IPv4', () => {
    expect(isBlockedIp('100.64.0.1')).toBe(true);
    expect(isBlockedIp('192.0.0.8')).toBe(true);
    expect(isBlockedIp('198.18.5.5')).toBe(true);
    expect(isBlockedIp('224.0.0.251')).toBe(true);
    expect(isBlockedIp('240.1.2.3')).toBe(true);
    expect(isBlockedIp('255.255.255.255')).toBe(true);
  });

  it('blocks loopback / ULA / link-local / site-local / mapped / compatible IPv6', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fd00::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('fec0::1')).toBe(true);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    // ::/96 IPv4-compatible, as a resolved DNS answer too.
    expect(isBlockedIp('::7f00:1')).toBe(true);
    expect(isBlockedIp('::a00:1')).toBe(true);
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
