import { describe, expect, it } from 'vitest';

import type { ImpactSummary } from '../api.js';
import { barPercent, impactLists, isImpactEmpty } from './ImpactPanel.utils.js';

const empty: ImpactSummary = {
  distinctUsers: null,
  topDevices: [],
  topOs: [],
  releases: [],
  platforms: [],
};

describe('barPercent', () => {
  it('is 0 when max is 0 (empty list)', () => {
    expect(barPercent(0, 0)).toBe(0);
  });

  it('is 0 for a zero-count row even with a positive max', () => {
    expect(barPercent(0, 10)).toBe(0);
  });

  it('is 100 for the max row itself', () => {
    expect(barPercent(10, 10)).toBe(100);
  });

  it('scales proportionally between 0 and max', () => {
    expect(barPercent(5, 10)).toBe(50);
  });

  it('floors small nonzero values at 4 so a sliver is always visible', () => {
    expect(barPercent(1, 1000)).toBe(4);
  });
});

describe('impactLists', () => {
  it('is empty when every list on the payload is empty', () => {
    expect(impactLists(empty)).toEqual([]);
  });

  it('skips only the empty lists, keeping populated ones', () => {
    const impact: ImpactSummary = {
      ...empty,
      topDevices: [{ model: 'Pixel 8', events: 12 }],
      releases: [{ release: '1.2.0+40', events: 5 }],
    };
    const lists = impactLists(impact);
    expect(lists.map((l) => l.title)).toEqual(['Devices', 'Releases']);
  });

  it('computes each list max independently from its own rows', () => {
    const impact: ImpactSummary = {
      ...empty,
      topDevices: [
        { model: 'Pixel 8', events: 3 },
        { model: 'iPhone 15', events: 9 },
      ],
      topOs: [{ os: 'Android 14', events: 100 }],
    };
    const lists = impactLists(impact);
    const devices = lists.find((l) => l.title === 'Devices');
    const os = lists.find((l) => l.title === 'OS');
    expect(devices?.max).toBe(9);
    expect(os?.max).toBe(100);
  });

  it('maps platforms/os label fields correctly', () => {
    const impact: ImpactSummary = {
      ...empty,
      topOs: [{ os: 'iOS 17.4', events: 2 }],
      platforms: [{ platform: 'web', events: 7 }],
    };
    const lists = impactLists(impact);
    expect(lists.find((l) => l.title === 'OS')?.rows).toEqual([{ label: 'iOS 17.4', events: 2 }]);
    expect(lists.find((l) => l.title === 'Platforms')?.rows).toEqual([{ label: 'web', events: 7 }]);
  });
});

describe('isImpactEmpty', () => {
  it('is true when distinctUsers is null and every list is empty', () => {
    expect(isImpactEmpty(empty)).toBe(true);
  });

  it('is false when distinctUsers is a number, even with every list empty', () => {
    expect(isImpactEmpty({ ...empty, distinctUsers: 0 })).toBe(false);
  });

  it('is false when at least one list has rows', () => {
    expect(isImpactEmpty({ ...empty, platforms: [{ platform: 'node', events: 1 }] })).toBe(false);
  });
});
