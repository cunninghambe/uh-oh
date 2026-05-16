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
