import { describe, expect, it } from 'vitest';

import { checkInUrlPattern, statusPillStyle, toggleStatusAction } from './MonitorsSection.utils.js';

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
