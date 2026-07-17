/**
 * Per-IP login rate limiter with exponential backoff (SPEC §5).
 *
 * Allows up to `maxPerWindow` attempts per rolling `windowMs`. Once exceeded the
 * IP is locked out; each successive lockout doubles the previous duration,
 * capped at `maxLockoutMs`. Callers surface `retryAfterSec` via `Retry-After`.
 */

export type LoginLimiterResult = { allowed: boolean; retryAfterSec: number };

type LoginState = {
  attempts: number;
  windowStartMs: number;
  lockedUntilMs: number;
  lockoutMs: number; // duration of the last lockout applied (0 = none yet)
  lastSeenMs: number;
};

export type LoginLimiter = {
  check: (ip: string, nowMs?: number) => LoginLimiterResult;
  cleanup: (nowMs: number, ttlMs?: number) => void;
  size: () => number;
};

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const BASE_LOCKOUT_MS = 60_000; // first lockout: 1 minute
const MAX_LOCKOUT_MS = 60 * 60_000; // capped at 1 hour
const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_MAX_KEYS = 50_000;

export const createLoginLimiter = (opts?: {
  windowMs?: number;
  maxPerWindow?: number;
  baseLockoutMs?: number;
  maxLockoutMs?: number;
  maxKeys?: number;
}): LoginLimiter => {
  const windowMs = opts?.windowMs ?? WINDOW_MS;
  const maxPerWindow = opts?.maxPerWindow ?? MAX_PER_WINDOW;
  const baseLockoutMs = opts?.baseLockoutMs ?? BASE_LOCKOUT_MS;
  const maxLockoutMs = opts?.maxLockoutMs ?? MAX_LOCKOUT_MS;
  const maxKeys = opts?.maxKeys ?? DEFAULT_MAX_KEYS;

  const states = new Map<string, LoginState>();

  const check = (ip: string, nowMs: number = Date.now()): LoginLimiterResult => {
    let s = states.get(ip);
    if (!s) {
      if (states.size >= maxKeys) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined) states.delete(oldest);
      }
      s = { attempts: 0, windowStartMs: nowMs, lockedUntilMs: 0, lockoutMs: 0, lastSeenMs: nowMs };
      states.set(ip, s);
    }
    s.lastSeenMs = nowMs;

    // Currently locked out.
    if (nowMs < s.lockedUntilMs) {
      return { allowed: false, retryAfterSec: Math.ceil((s.lockedUntilMs - nowMs) / 1000) };
    }

    // Roll the window.
    if (nowMs - s.windowStartMs >= windowMs) {
      s.windowStartMs = nowMs;
      s.attempts = 0;
    }

    s.attempts += 1;
    if (s.attempts <= maxPerWindow) {
      return { allowed: true, retryAfterSec: 0 };
    }

    // Over the limit → escalating lockout (double the previous duration).
    s.lockoutMs = s.lockoutMs === 0 ? baseLockoutMs : Math.min(s.lockoutMs * 2, maxLockoutMs);
    s.lockedUntilMs = nowMs + s.lockoutMs;
    s.windowStartMs = nowMs;
    s.attempts = 0;
    return { allowed: false, retryAfterSec: Math.ceil(s.lockoutMs / 1000) };
  };

  const cleanup = (nowMs: number, ttlMs: number = DEFAULT_TTL_MS): void => {
    for (const [ip, s] of states) {
      if (nowMs - s.lastSeenMs > ttlMs && nowMs >= s.lockedUntilMs) states.delete(ip);
    }
  };

  return { check, cleanup, size: () => states.size };
};
