// Alert timestamp rendering — both halves of the timestamp, the date-crossing
// case, the UTC-zone special case, and boot-time validation of the env var.

import { describe, expect, it, vi } from 'vitest';

import {
  ALERT_LOCAL_TZ_ENV,
  DEFAULT_ALERT_LOCAL_TZ,
  formatAlertMinute,
  isValidTimeZone,
  resolveAlertLocalTz,
} from './alert-time.js';

const SUMMER = Date.parse('2026-08-29T06:31:00.000Z');

describe('formatAlertMinute', () => {
  it('renders UTC first, then the local time in the given zone', () => {
    expect(formatAlertMinute(SUMMER, 'America/New_York')).toBe('2026-08-29 06:31 UTC (02:31 EDT)');
  });

  it('follows daylight saving (EST in winter)', () => {
    expect(formatAlertMinute(Date.parse('2026-01-15T14:05:00.000Z'), 'America/New_York')).toBe(
      '2026-01-15 14:05 UTC (09:05 EST)',
    );
  });

  it('spells the local date out when it differs from the UTC date', () => {
    expect(formatAlertMinute(Date.parse('2026-01-15T04:05:00.000Z'), 'America/New_York')).toBe(
      '2026-01-15 04:05 UTC (2026-01-14 23:05 EST)',
    );
  });

  it('keeps the local date implicit at local midnight of the same UTC day', () => {
    expect(formatAlertMinute(Date.parse('2026-08-29T04:00:00.000Z'), 'America/New_York')).toBe(
      '2026-08-29 04:00 UTC (00:00 EDT)',
    );
  });

  it('drops the parenthetical when the local zone is UTC itself', () => {
    expect(formatAlertMinute(SUMMER, 'UTC')).toBe('2026-08-29 06:31 UTC');
    expect(formatAlertMinute(SUMMER, 'Etc/UTC')).toBe('2026-08-29 06:31 UTC');
  });

  it('falls back to a GMT offset for zones without an English abbreviation', () => {
    expect(formatAlertMinute(SUMMER, 'Asia/Kolkata')).toBe('2026-08-29 06:31 UTC (12:01 GMT+5:30)');
  });
});

describe('resolveAlertLocalTz', () => {
  it.each([undefined, '', '   '])('treats %j as unset and uses the default', (raw) => {
    const onInvalid = vi.fn<(message: string) => void>();
    expect(resolveAlertLocalTz(raw, onInvalid)).toBe(DEFAULT_ALERT_LOCAL_TZ);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('accepts any zone ICU knows, trimmed', () => {
    const onInvalid = vi.fn<(message: string) => void>();
    expect(resolveAlertLocalTz(' Europe/London ', onInvalid)).toBe('Europe/London');
    expect(resolveAlertLocalTz('UTC', onInvalid)).toBe('UTC');
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('reports an unknown zone by env var name and falls back rather than failing boot', () => {
    const onInvalid = vi.fn<(message: string) => void>();
    expect(resolveAlertLocalTz('Mars/Olympus', onInvalid)).toBe(DEFAULT_ALERT_LOCAL_TZ);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    const message = onInvalid.mock.calls[0]?.[0];
    expect(message).toContain(ALERT_LOCAL_TZ_ENV);
    expect(message).toContain('Mars/Olympus');
    expect(message).toContain(DEFAULT_ALERT_LOCAL_TZ);
  });
});

describe('isValidTimeZone', () => {
  it.each(['America/New_York', 'UTC', 'Etc/GMT+3', 'Australia/Sydney'])('accepts %s', (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each(['Mars/Olympus', 'not a zone', ''])('rejects %j', (tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
  });
});
