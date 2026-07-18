import { describe, expect, it } from 'vitest';

import { createLoginLimiter } from './login-limiter.js';

describe('createLoginLimiter', () => {
  it('allows up to 10 attempts per minute then locks out', () => {
    const lim = createLoginLimiter();
    for (let i = 0; i < 10; i++) {
      expect(lim.check('1.2.3.4', 0).allowed).toBe(true);
    }
    const blocked = lim.check('1.2.3.4', 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60); // first lockout = 1 minute
  });

  it('resets the window after 60s of good behavior', () => {
    const lim = createLoginLimiter();
    for (let i = 0; i < 10; i++) lim.check('1.2.3.4', 0);
    // Next minute → window rolls, attempts allowed again
    expect(lim.check('1.2.3.4', 60_000).allowed).toBe(true);
  });

  it('doubles the lockout on each successive violation, capped at 1h', () => {
    const lim = createLoginLimiter();
    let now = 0;
    const triggerLockout = (): number => {
      // exhaust the window then trip once more
      for (let i = 0; i < 10; i++) lim.check('9.9.9.9', now);
      const r = lim.check('9.9.9.9', now);
      expect(r.allowed).toBe(false);
      return r.retryAfterSec;
    };

    const first = triggerLockout();
    expect(first).toBe(60); // 1 min

    now += first * 1000 + 1; // wait out the first lockout
    const second = triggerLockout();
    expect(second).toBe(120); // 2 min

    now += second * 1000 + 1;
    const third = triggerLockout();
    expect(third).toBe(240); // 4 min
  });

  it('caps the lockout at one hour', () => {
    const lim = createLoginLimiter({ baseLockoutMs: 30 * 60_000 });
    let now = 0;
    const trigger = (): number => {
      for (let i = 0; i < 10; i++) lim.check('5.5.5.5', now);
      return lim.check('5.5.5.5', now).retryAfterSec;
    };
    expect(trigger()).toBe(1800); // 30 min
    now += 1800 * 1000 + 1;
    expect(trigger()).toBe(3600); // 60 min (capped)
    now += 3600 * 1000 + 1;
    expect(trigger()).toBe(3600); // still capped
  });

  it('isolates state per IP', () => {
    const lim = createLoginLimiter();
    for (let i = 0; i < 11; i++) lim.check('1.1.1.1', 0);
    expect(lim.check('1.1.1.1', 0).allowed).toBe(false);
    expect(lim.check('2.2.2.2', 0).allowed).toBe(true);
  });

  it('cleanup removes idle, unlocked entries', () => {
    const lim = createLoginLimiter();
    lim.check('1.2.3.4', 0);
    expect(lim.size()).toBe(1);
    lim.cleanup(2 * 60 * 60_000);
    expect(lim.size()).toBe(0);
  });

  it('cleanup keeps entries that are still locked out', () => {
    const lim = createLoginLimiter();
    for (let i = 0; i < 11; i++) lim.check('1.2.3.4', 0); // locked until 60_000
    // Far past idle TTL, but still within the lockout window → keep it.
    lim.cleanup(30_000, 1000);
    expect(lim.size()).toBe(1);
  });

  it('caps the number of tracked IPs', () => {
    const lim = createLoginLimiter({ maxKeys: 50 });
    for (let i = 0; i < 500; i++) lim.check(`10.0.0.${String(i)}`, 0);
    expect(lim.size()).toBeLessThanOrEqual(50);
  });
});
