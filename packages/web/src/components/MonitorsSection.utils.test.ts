import { describe, expect, it } from 'vitest';

import {
  MONITOR_SLUG_PATTERN,
  checkInUrlPattern,
  httpProbeSummary,
  monitorKind,
  statusPillStyle,
  toggleStatusAction,
} from './MonitorsSection.utils.js';

describe('statusPillStyle', () => {
  it('gives ok a green style', () => {
    expect(statusPillStyle('ok').className).toContain('emerald');
  });

  it('gives missed a red, emphasized style — the dead-man-switch case must be loud', () => {
    const style = statusPillStyle('missed');
    expect(style.className).toContain('red');
    expect(style.className).toContain('font-semibold');
  });

  it('gives paused a muted style', () => {
    const style = statusPillStyle('paused');
    expect(style.className).toContain('zinc');
    expect(style.className).not.toContain('emerald');
    expect(style.className).not.toContain('red');
  });

  it('every status has a distinct label matching itself', () => {
    expect(statusPillStyle('ok').label).toBe('ok');
    expect(statusPillStyle('missed').label).toBe('missed');
    expect(statusPillStyle('paused').label).toBe('paused');
  });
});

describe('checkInUrlPattern', () => {
  it('substitutes the real publicKey but keeps slug/interval as placeholders', () => {
    expect(checkInUrlPattern('pk_abc123')).toBe(
      'POST /ingest/pk_abc123/check-in/<slug>?intervalMinutes=N',
    );
  });
});

describe('toggleStatusAction', () => {
  it('offers "Pause" (-> paused) for an ok monitor', () => {
    expect(toggleStatusAction('ok')).toEqual({ label: 'Pause', next: 'paused' });
  });

  it('offers "Pause" (-> paused) for a missed monitor too — pausing silences the alarm', () => {
    expect(toggleStatusAction('missed')).toEqual({ label: 'Pause', next: 'paused' });
  });

  it('offers "Resume" (-> ok) for a paused monitor', () => {
    expect(toggleStatusAction('paused')).toEqual({ label: 'Resume', next: 'ok' });
  });
});

describe('monitorKind (v0.9 CONTRACT — SPEC §24 uptime probes)', () => {
  it('defaults an absent kind to "checkin" (older server, predates migration 0008)', () => {
    // `{}` (property omitted, not set to undefined) is how an older server response would
    // deserialize — exactOptionalPropertyTypes forbids the literal `{ kind: undefined }` here
    // since that's a distinct (disallowed) shape (same convention as Issue.utils.test.ts's
    // resolvedPlatform tests).
    expect(monitorKind({})).toBe('checkin');
  });

  it('passes through an explicit kind', () => {
    expect(monitorKind({ kind: 'checkin' })).toBe('checkin');
    expect(monitorKind({ kind: 'http' })).toBe('http');
  });
});

describe('httpProbeSummary', () => {
  it('is "never" and hasProbed:false when lastProbeAt is absent', () => {
    expect(httpProbeSummary({})).toEqual({
      hasProbed: false,
      status: 'never',
    });
  });

  it('is "never" and hasProbed:false when lastProbeAt is null', () => {
    expect(httpProbeSummary({ lastProbeAt: null, lastProbeStatus: null })).toEqual({
      hasProbed: false,
      status: 'never',
    });
  });

  it('reports the raw HTTP status once probed', () => {
    expect(httpProbeSummary({ lastProbeAt: Date.now(), lastProbeStatus: 200 })).toEqual({
      hasProbed: true,
      status: '200',
    });
  });

  it('reports "error" for a probe that failed before a status line (DNS/connect/timeout)', () => {
    expect(httpProbeSummary({ lastProbeAt: Date.now(), lastProbeStatus: null })).toEqual({
      hasProbed: true,
      status: 'error',
    });
  });
});

describe('MONITOR_SLUG_PATTERN (SPEC §24: slug is [a-z0-9-]{1,64})', () => {
  it('accepts lowercase letters, digits, and hyphens', () => {
    expect(MONITOR_SLUG_PATTERN.test('api-health-2')).toBe(true);
  });

  it('rejects uppercase, spaces, and other punctuation', () => {
    expect(MONITOR_SLUG_PATTERN.test('API-health')).toBe(false);
    expect(MONITOR_SLUG_PATTERN.test('api health')).toBe(false);
    expect(MONITOR_SLUG_PATTERN.test('api_health')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(MONITOR_SLUG_PATTERN.test('')).toBe(false);
  });
});
