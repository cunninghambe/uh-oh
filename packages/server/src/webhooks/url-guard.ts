/**
 * Webhook URL validation guarding against SSRF.
 *
 * Scope: literal-IP + scheme + userinfo checks only. This does NOT resolve DNS,
 * so a hostname that resolves to a private address (DNS rebinding) is not
 * blocked here. Combined with `redirect: 'error'` at fetch time, this covers the
 * common cases (localhost/loopback, RFC1918, CGNAT, cloud metadata, multicast /
 * reserved space) without a resolver.
 */

export type UrlGuardResult = { ok: true; url: URL } | { ok: false; reason: string };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const isBlockedIpv4 = (host: string): boolean => {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((o) => Number(o));
  if (octets.some((o) => o > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking (RFC 2544)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved, incl. 255.255.255.255 broadcast
  return false;
};

const isBlockedIpv6 = (raw: string): boolean => {
  let host = raw;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  const lower = host.toLowerCase();
  if (!lower.includes(':')) return false; // not an IPv6 literal
  if (lower === '::1') return true; // loopback
  if (lower === '::') return true; // unspecified (equivalent to 0.0.0.0)
  // ::/96 IPv4-compatible (deprecated) addresses: ::127.0.0.1 and the hex form
  // the URL parser normalizes it to, ::7f00:1. The WHOLE /96 is blocked, not
  // just the members embedding a blocked IPv4: the range is deprecated and the
  // only reason to dial one is to sneak past an IPv4 blocklist. Both the URL
  // parser and dns.lookup emit the canonical compressed form, so "first 96 bits
  // zero" is exactly "starts with '::' and at most two hextets remain".
  if (lower.startsWith('::') && lower.length > 2) {
    const rest = lower.slice(2);
    const parts = rest.split(':');
    // A trailing dotted quad occupies the final two hextets.
    const hextets = (parts[parts.length - 1] ?? '').includes('.') ? parts.length + 1 : parts.length;
    if (hextets <= 2 && parts.every((p) => p.length > 0)) return true;
  }
  // IPv4-mapped addresses in dotted form (e.g. ::ffff:127.0.0.1)
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted && isBlockedIpv4(dotted[1] ?? '')) return true;
  // IPv4-mapped addresses the URL parser normalized to hex (::ffff:7f00:1)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1] ?? '0', 16);
    const lo = parseInt(mappedHex[2] ?? '0', 16);
    const ipv4 = `${String((hi >> 8) & 0xff)}.${String(hi & 0xff)}.${String((lo >> 8) & 0xff)}.${String(lo & 0xff)}`;
    if (isBlockedIpv4(ipv4)) return true;
  }
  const firstHextet = lower.split(':')[0] ?? '';
  // fc00::/7 unique-local (first hextet fc.. or fd..)
  if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true;
  // fe80::/10 link-local (first hextet fe80..febf)
  if (/^fe[89ab]/.test(firstHextet)) return true;
  // fec0::/10 site-local (deprecated but still routed on some networks)
  if (/^fe[c-f]/.test(firstHextet)) return true;
  return false;
};

/**
 * Validate a webhook URL. Rejects non-http(s) schemes, URLs carrying userinfo
 * credentials, and URLs whose hostname is a literal
 * loopback/private/link-local/metadata IP, or `localhost`.
 */
export const validateWebhookUrl = (raw: string): UrlGuardResult => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_scheme' };
  }
  // Userinfo credentials (`http://user:pass@host/`) are rejected outright: they
  // would be stored in plaintext and echoed back by every reader of the row,
  // including the read-token monitor list and MCP `list_monitors`, whose scope
  // is narrower than the JWT that set them. Credentials belong in a header, and
  // `user@host` is also a classic way to disguise the real host from a reviewer.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'blocked_host' };
  }
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isBlockedIpv4(bare) || isBlockedIpv6(host)) {
    return { ok: false, reason: 'blocked_ip' };
  }
  return { ok: true, url };
};

export const isWebhookUrlSafe = (raw: string): boolean => validateWebhookUrl(raw).ok;

/**
 * True when `address` (a bare IP literal, e.g. a `dns.lookup` result) is a
 * loopback/private/link-local/metadata address that must never be fetched.
 * Shared with the dispatcher's dispatch-time DNS re-check so both call sites
 * apply identical IP-blocking rules (no duplicated range logic).
 */
export const isBlockedIp = (address: string): boolean =>
  isBlockedIpv4(address) || isBlockedIpv6(address);

/**
 * True when a URL hostname is a literal IP address (dotted-quad IPv4 or a
 * bracketed IPv6 literal). Literal-IP hosts are fully covered by the
 * synchronous {@link validateWebhookUrl} guard, so the dispatcher skips the
 * async DNS re-check for them.
 */
export const isIpLiteralHost = (hostname: string): boolean => {
  if (hostname.startsWith('[')) return true; // bracketed IPv6 literal
  const m = IPV4_RE.exec(hostname);
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255);
};
