import { describe, expect, it } from 'vitest';

import {
  crashRatioBadgeStyle,
  formatRatio,
  isReleaseHealthDaysOption,
  releaseLabel,
} from './ReleaseHealthSection.utils.js';

describe('isReleaseHealthDaysOption', () => {
  it('accepts exactly 7, 30, 90 — same window set as UsageSection', () => {
    expect(isReleaseHealthDaysOption(7)).toBe(true);
    expect(isReleaseHealthDaysOption(30)).toBe(true);
    expect(isReleaseHealthDaysOption(90)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isReleaseHealthDaysOption(14)).toBe(false);
    expect(isReleaseHealthDaysOption(0)).toBe(false);
    expect(isReleaseHealthDaysOption(-30)).toBe(false);
  });
});

describe('formatRatio', () => {
  it('is a dash for null (SPEC §24: pageviews is 0 — analytics off, non-web, or unattributed)', () => {
    expect(formatRatio(null)).toBe('—');
  });

  it('renders a numeric ratio as-is (server already rounds to 1 decimal)', () => {
    expect(formatRatio(0)).toBe('0');
    expect(formatRatio(3.4)).toBe('3.4');
    expect(formatRatio(41.7)).toBe('41.7');
  });
});

describe('crashRatioBadgeStyle', () => {
  it('gives null a neutral dash badge, never treating it as zero', () => {
    const style = crashRatioBadgeStyle(null);
    expect(style.label).toBe('—');
    expect(style.className).toContain('zinc');
  });

  it('gives exactly 0 an emerald (healthy) badge', () => {
    expect(crashRatioBadgeStyle(0).className).toContain('emerald');
  });

  it('gives a low nonzero ratio an amber badge', () => {
    expect(crashRatioBadgeStyle(5).className).toContain('amber');
  });

  it('gives a mid ratio an orange badge', () => {
    expect(crashRatioBadgeStyle(20).className).toContain('orange');
  });

  it('gives a high ratio a red badge', () => {
    expect(crashRatioBadgeStyle(20.1).className).toContain('red');
  });
});

describe('releaseLabel', () => {
  it('joins version and build with a plus, matching the Releases page format', () => {
    expect(releaseLabel('1.2.3', '45')).toBe('1.2.3+45');
  });
});
