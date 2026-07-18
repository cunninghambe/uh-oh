/**
 * Webhook URL validation guarding against SSRF.
 *
 * v0.1 scope: literal-IP + scheme checks only. This does NOT resolve DNS, so a
 * hostname that resolves to a private address (DNS rebinding) is not blocked
 * here. Combined with `redirect: 'error'` at fetch time, this covers the common
 * cases (localhost/loopback, RFC1918, cloud metadata) without a resolver.
 */

export type UrlGuardResult = { ok: true; url: URL } | { ok: false; reason: string };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const isBlockedIpv4 = (host: string): boolean => {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((o) => Number(o));
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
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
  return false;
};

/**
 * Validate a webhook URL. Rejects non-http(s) schemes and URLs whose hostname is
 * a literal loopback/private/link-local/metadata IP, or `localhost`.
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
