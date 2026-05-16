export type Bucket = { tokens: number; lastRefillMs: number };

export type RateLimiter = {
  consume: (key: string, nowMs?: number) => boolean;
  size: () => number;
};

export const createRateLimiter = (opts: {
  capacity: number;
  refillPerSec: number;
}): RateLimiter => {
  const buckets = new Map<string, Bucket>();

  const consume = (key: string, nowMs: number = Date.now()): boolean => {
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { tokens: opts.capacity - 1, lastRefillMs: nowMs });
      return true;
    }
    const elapsedSec = (nowMs - existing.lastRefillMs) / 1000;
    const refreshed = Math.min(opts.capacity, existing.tokens + elapsedSec * opts.refillPerSec);
    if (refreshed >= 1) {
      buckets.set(key, { tokens: refreshed - 1, lastRefillMs: nowMs });
      return true;
    }
    buckets.set(key, { tokens: refreshed, lastRefillMs: nowMs });
    return false;
  };

  return { consume, size: () => buckets.size };
};
