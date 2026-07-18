export type IpRateLimiter = {
  /** Returns true if allowed, false if over limit. */
  consume: (ip: string, nowMs: number) => boolean;
  /** Cleanup buckets older than ttlMs since last refill. */
  cleanup: (nowMs: number, ttlMs?: number) => void;
};

type Bucket = { tokens: number; lastRefillMs: number };

const DEFAULT_TTL_MS = 5 * 60 * 1000;

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
