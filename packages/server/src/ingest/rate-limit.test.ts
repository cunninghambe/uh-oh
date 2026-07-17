import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rate-limit.js';

describe('createRateLimiter (token bucket)', () => {
  it('allows up to capacity in a single burst', () => {
    const rl = createRateLimiter({ capacity: 5, refillPerSec: 1 });
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      if (rl.consume('k', 1000)) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it('rejects beyond capacity at the same instant', () => {
    const rl = createRateLimiter({ capacity: 3, refillPerSec: 1 });
    for (let i = 0; i < 3; i++) rl.consume('k', 1000);
    expect(rl.consume('k', 1000)).toBe(false);
  });

  it('refills over time at refillPerSec', () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 1 });
    expect(rl.consume('k', 1000)).toBe(true);
    expect(rl.consume('k', 1500)).toBe(false);
    expect(rl.consume('k', 2000)).toBe(true);
  });

  it('caps refill at capacity', () => {
    const rl = createRateLimiter({ capacity: 2, refillPerSec: 10 });
    rl.consume('k', 1000);
    rl.consume('k', 1000);
    expect(rl.consume('k', 1_000_000)).toBe(true);
    expect(rl.consume('k', 1_000_000)).toBe(true);
    expect(rl.consume('k', 1_000_000)).toBe(false);
  });

  it('isolates buckets per key', () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 1 });
    expect(rl.consume('a', 1000)).toBe(true);
    expect(rl.consume('b', 1000)).toBe(true);
    expect(rl.consume('a', 1000)).toBe(false);
  });

  it('flood of 100 same-key calls in same ms yields exactly capacity allowed', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (rl.consume('k', 1000)) allowed++;
    }
    expect(allowed).toBe(10);
  });
});

describe('createRateLimiter — bounded memory (H2)', () => {
  it('caps map size and evicts oldest on overflow', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) {
      rl.consume(`fingerprint-${String(i)}`, 1000);
    }
    expect(rl.size()).toBeLessThanOrEqual(100);
  });

  it('evicts the least-recently-used key first', () => {
    const rl = createRateLimiter({ capacity: 2, refillPerSec: 0, maxKeys: 2 });
    rl.consume('a', 1000); // a: 1 token left
    rl.consume('b', 1000); // b: 1 token left
    rl.consume('a', 1000); // touch a (now 0 tokens) → a is MRU, b is LRU
    rl.consume('c', 1000); // over cap → evicts b (LRU). map = {a, c}
    // a survived and is exhausted — checking it adds no key, so no eviction.
    expect(rl.consume('a', 1000)).toBe(false);
    // b was the LRU that got evicted → fresh bucket → allowed
    expect(rl.consume('b', 1000)).toBe(true);
  });

  it('cleanup removes idle buckets beyond the TTL', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1, ttlMs: 60_000 });
    rl.consume('x', 0);
    rl.consume('y', 0);
    expect(rl.size()).toBe(2);
    rl.cleanup(61_000);
    expect(rl.size()).toBe(0);
  });

  it('cleanup retains buckets touched within the TTL', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1, ttlMs: 60_000 });
    rl.consume('x', 0);
    rl.consume('y', 50_000);
    rl.cleanup(61_000);
    // x is stale (idle 61s), y was touched at 50s so it survives
    expect(rl.size()).toBe(1);
  });

  it('caps key length so an oversized fingerprint cannot bloat memory', () => {
    const rl = createRateLimiter({ capacity: 2, refillPerSec: 0 });
    const huge = 'f'.repeat(100_000);
    // Same oversized key hashes to the same bucket → still rate-limited normally.
    expect(rl.consume(huge, 1000)).toBe(true);
    expect(rl.consume(huge, 1000)).toBe(true);
    expect(rl.consume(huge, 1000)).toBe(false);
    expect(rl.size()).toBe(1);
  });
});
