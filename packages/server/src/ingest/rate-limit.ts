import { createHash } from 'node:crypto';

export type Bucket = { tokens: number; lastRefillMs: number };

export type RateLimiter = {
  consume: (key: string, nowMs?: number) => boolean;
  /** Drop buckets idle (no consume) for longer than ttlMs. */
  cleanup: (nowMs: number, ttlMs?: number) => void;
  size: () => number;
};

// Buckets untouched for this long are dropped by cleanup().
const DEFAULT_TTL_MS = 10 * 60 * 1000;
// Hard cap on distinct keys held at once. Prevents OOM from attacker-controlled
// keys (e.g. SDK-overridable fingerprints in a public ingest key).
const DEFAULT_MAX_KEYS = 50_000;
// Keys longer than this are hashed so a hostile fingerprint can't bloat memory.
const MAX_KEY_LEN = 200;

export const createRateLimiter = (opts: {
  capacity: number;
  refillPerSec: number;
  maxKeys?: number;
  ttlMs?: number;
}): RateLimiter => {
  const buckets = new Map<string, Bucket>();
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;

  const normalizeKey = (key: string): string =>
    key.length <= MAX_KEY_LEN ? key : createHash('sha256').update(key).digest('hex');

  const consume = (rawKey: string, nowMs: number = Date.now()): boolean => {
    const key = normalizeKey(rawKey);
    const existing = buckets.get(key);
    if (existing) {
      // Re-insert to keep the map in least-recently-used order (Map preserves
      // insertion order; deleting + setting moves this key to the newest slot).
      buckets.delete(key);
      const elapsedSec = (nowMs - existing.lastRefillMs) / 1000;
      const refreshed = Math.min(opts.capacity, existing.tokens + elapsedSec * opts.refillPerSec);
      if (refreshed >= 1) {
        buckets.set(key, { tokens: refreshed - 1, lastRefillMs: nowMs });
        return true;
      }
      buckets.set(key, { tokens: refreshed, lastRefillMs: nowMs });
      return false;
    }

    // New key. Evict the least-recently-used entry if we're at the cap.
    if (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(key, { tokens: opts.capacity - 1, lastRefillMs: nowMs });
    return true;
  };

  const cleanup = (nowMs: number, ttlMs: number = opts.ttlMs ?? DEFAULT_TTL_MS): void => {
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.lastRefillMs > ttlMs) buckets.delete(key);
    }
  };

  return { consume, cleanup, size: () => buckets.size };
};
