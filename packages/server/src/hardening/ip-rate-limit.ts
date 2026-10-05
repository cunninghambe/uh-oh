export type IpRateLimiter = {
  /** Returns true if allowed, false if over limit. */
  consume: (ip: string, nowMs: number) => boolean;
  /** Cleanup buckets older than ttlMs since last refill. */
  cleanup: (nowMs: number, ttlMs?: number) => void;
};

type Bucket = { tokens: number; lastRefillMs: number };

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Production defaults: these are what runs when the env vars are unset. */
export const DEFAULT_IP_RATE_PER_MINUTE = 600;
export const DEFAULT_IP_RATE_BURST = 100;

/**
 * Resolve one per-IP limiter env var (UH_OH_IP_RATE_PER_MIN / _BURST). Unset or
 * empty means the default. An invalid value (not a positive finite number) is
 * reported through `onInvalid` and the default is used: `Number("12O")` is NaN,
 * and a NaN bucket never refills, so after each IP's first request the server
 * would 429 everything, ingest included. A typo in a tuning knob must not do
 * that, nor take the collector down, so it degrades to the default loudly.
 */
export const resolveIpRateSetting = (
  name: string,
  raw: string | undefined,
  fallback: number,
  onInvalid: (message: string) => void,
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    onInvalid(
      `${name}=${JSON.stringify(raw)} is not a positive number; using the default ${String(fallback)}`,
    );
    return fallback;
  }
  return n;
};

export const createIpRateLimiter = (opts: { perMinute: number; burst: number }): IpRateLimiter => {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = opts.perMinute / 60_000;

  const consume = (ip: string, nowMs: number): boolean => {
    const existing = buckets.get(ip);
    if (!existing) {
      buckets.set(ip, { tokens: opts.burst - 1, lastRefillMs: nowMs });
      return true;
    }
    const elapsed = nowMs - existing.lastRefillMs;
    const refilled = Math.min(opts.burst, existing.tokens + elapsed * refillPerMs);
    if (refilled >= 1) {
      buckets.set(ip, { tokens: refilled - 1, lastRefillMs: nowMs });
      return true;
    }
    buckets.set(ip, { tokens: refilled, lastRefillMs: nowMs });
    return false;
  };

  const cleanup = (nowMs: number, ttlMs: number = DEFAULT_TTL_MS): void => {
    for (const [ip, bucket] of buckets) {
      if (nowMs - bucket.lastRefillMs > ttlMs) {
        buckets.delete(ip);
      }
    }
  };

  return { consume, cleanup };
};
