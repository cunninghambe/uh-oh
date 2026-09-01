// Alert timestamp rendering — the one place a chat alert turns an epoch-ms
// instant into text.
//
// The box that runs uh-oh writes every log in its local zone while the
// dispatcher rendered alerts in UTC; during the 2026-08-29 incident the
// four-hour gap made the Discord alerts look unrelated to the journal lines
// that caused them. An alert now carries both halves: UTC first (unambiguous,
// and the same clock as the epoch-ms in the JSON payload), then the operator's
// local time in parentheses. The JSON payload itself is untouched — its shape
// is the receiver contract.

/** Name of the local-zone env var, quoted in operator-facing text. */
export const ALERT_LOCAL_TZ_ENV = 'UH_OH_ALERT_LOCAL_TZ';

/**
 * Zone used when `UH_OH_ALERT_LOCAL_TZ` is unset. A fixed default rather than
 * the host's own zone: a VPS is routinely left on UTC, which would turn the
 * parenthetical into a duplicate of the first half, and a fixed value keeps
 * rendered alerts deterministic across hosts and in tests.
 */
export const DEFAULT_ALERT_LOCAL_TZ = 'America/New_York';

/** True when ICU recognises `tz` as a time zone (it throws RangeError otherwise). */
export const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve `UH_OH_ALERT_LOCAL_TZ` at startup. Unset/blank → the default. Set but
 * unknown to ICU → `onInvalid` is called and the default is used: a typo in a
 * display preference must never stop the collector from booting, and it must
 * not surface later as a RangeError inside every Discord dispatch either —
 * which is why validation happens here, once, and never at render time.
 */
export const resolveAlertLocalTz = (
  raw: string | undefined,
  onInvalid?: (message: string) => void,
): string => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) return DEFAULT_ALERT_LOCAL_TZ;
  if (isValidTimeZone(value)) return value;
  onInvalid?.(
    `${ALERT_LOCAL_TZ_ENV} is not a time zone ICU recognises (${JSON.stringify(value)}); ` +
      `rendering alert times in ${DEFAULT_ALERT_LOCAL_TZ}`,
  );
  return DEFAULT_ALERT_LOCAL_TZ;
};

// One formatter per zone: building one is the expensive part, and a single
// sweep can flip many monitors at once.
const formatters = new Map<string, Intl.DateTimeFormat>();

// en-US names the North American zones (EDT/EST/PDT…) and falls back to a GMT
// offset (`GMT+1`, `GMT+5:30`) elsewhere — less pretty than a local
// abbreviation but never ambiguous, which matters more in an alert.
const formatterFor = (tz: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    formatters.set(tz, formatter);
  }
  return formatter;
};

/**
 * `1787985060000` → `2026-08-29 06:31 UTC (02:31 EDT)`.
 *
 * The local date is spelled out only when it differs from the UTC date, so an
 * alert just after midnight UTC reads `2026-08-29 02:15 UTC (2026-08-28 22:15 EDT)`
 * instead of implying the same day. A zone that resolves to UTC gets no
 * parenthetical at all — it would only repeat the first half.
 */
export const formatAlertMinute = (ms: number, tz: string): string => {
  const iso = new Date(ms).toISOString();
  const utcDate = iso.slice(0, 10);
  const utc = `${utcDate} ${iso.slice(11, 16)} UTC`;

  const formatter = formatterFor(tz);
  if (formatter.resolvedOptions().timeZone === 'UTC') return utc;

  const part: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of formatter.formatToParts(new Date(ms))) part[p.type] = p.value;
  const localDate = `${part.year ?? ''}-${part.month ?? ''}-${part.day ?? ''}`;
  const localTime = `${part.hour ?? ''}:${part.minute ?? ''}`;
  const zone = part.timeZoneName ?? tz;
  return `${utc} (${localDate === utcDate ? '' : `${localDate} `}${localTime} ${zone})`;
};
