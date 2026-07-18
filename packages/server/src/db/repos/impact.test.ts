import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue } from './issues.js';
import { insertEvent } from './events.js';
import { computeImpact } from './impact.js';

let db: Db;
let close: () => void;
let issueId: string;
let projectId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const project = createProject(db, { name: 'App' });
  projectId = project.id;
  const { issue } = upsertIssue(db, {
    projectId,
    fingerprint: 'fp',
    title: 't',
    ts: Date.now(),
    platform: 'web',
  });
  issueId = issue.id;
});

afterEach(() => {
  close();
});

type Seed = {
  platform?: 'web' | 'node' | 'android' | 'ios';
  device?: Record<string, unknown>;
  user?: Record<string, unknown> | null;
  release?: { version: string; build: string };
};

let n = 0;
const seed = (s: Seed = {}): void => {
  const platform = s.platform ?? 'web';
  const release = s.release ?? { version: '1.0.0', build: '1' };
  const device = s.device ?? { osName: 'iOS', osVersion: '17', deviceModel: 'iPhone' };
  const payload = JSON.stringify({
    sdk: { name: 'x', version: '1' },
    timestamp: '2026-01-01T00:00:00.000Z',
    platform,
    release,
    level: 'error',
    exception: { type: 'E', value: 'v', stacktrace: [], mechanism: 'm' },
    breadcrumbs: [],
    device,
  });
  insertEvent(db, {
    projectId,
    issueId,
    releaseId: null,
    fingerprint: 'fp',
    level: 'error',
    platform,
    payload,
    receivedAt: Date.now() + n++,
    deviceInfo: JSON.stringify(device),
    userInfo: s.user === null ? null : JSON.stringify(s.user ?? { id: 'u1' }),
  });
};

describe('computeImpact', () => {
  it('returns empty aggregates and null distinctUsers for an issue with no events', () => {
    const impact = computeImpact(db, issueId);
    expect(impact.distinctUsers).toBeNull();
    expect(impact.topDevices).toEqual([]);
    expect(impact.topOs).toEqual([]);
    expect(impact.releases).toEqual([]);
    expect(impact.platforms).toEqual([]);
  });

  it('counts distinct users, or null when no event carries a user', () => {
    seed({ user: { id: 'a' } });
    seed({ user: { id: 'a' } });
    seed({ user: { id: 'b' } });
    expect(computeImpact(db, issueId).distinctUsers).toBe(2);
  });

  it('returns null distinctUsers when every event is anonymous', () => {
    seed({ user: null });
    seed({ user: null });
    expect(computeImpact(db, issueId).distinctUsers).toBeNull();
  });

  it('ranks devices by volume, ties broken alphabetically, capped at 5', () => {
    for (let i = 0; i < 3; i++)
      seed({ device: { osName: 'iOS', osVersion: '17', deviceModel: 'Pixel' } });
    seed({ device: { osName: 'iOS', osVersion: '17', deviceModel: 'Galaxy' } });
    seed({ device: { osName: 'iOS', osVersion: '17', deviceModel: 'Nexus' } });
    // A device with no model is excluded from topDevices.
    seed({ device: { osName: 'iOS', osVersion: '17' } });
    const impact = computeImpact(db, issueId);
    expect(impact.topDevices[0]).toEqual({ model: 'Pixel', events: 3 });
    expect(impact.topDevices.map((d) => d.model)).toEqual(['Pixel', 'Galaxy', 'Nexus']);
  });

  it('formats os as "osName osVersion"', () => {
    seed({ device: { osName: 'Android', osVersion: '14', deviceModel: 'X' } });
    seed({ device: { osName: 'Android', osVersion: '14', deviceModel: 'X' } });
    seed({ device: { osName: 'iOS', osVersion: '17', deviceModel: 'X' } });
    const impact = computeImpact(db, issueId);
    expect(impact.topOs[0]).toEqual({ os: 'Android 14', events: 2 });
    expect(impact.topOs.map((o) => o.os)).toContain('iOS 17');
  });

  it('formats releases as "version+build" and platforms by volume', () => {
    seed({ platform: 'web', release: { version: '2.0.0', build: '9' } });
    seed({ platform: 'web', release: { version: '2.0.0', build: '9' } });
    seed({ platform: 'node', release: { version: '2.0.0', build: '10' } });
    const impact = computeImpact(db, issueId);
    expect(impact.releases[0]).toEqual({ release: '2.0.0+9', events: 2 });
    expect(impact.platforms[0]).toEqual({ platform: 'web', events: 2 });
    expect(impact.platforms.map((p) => p.platform)).toContain('node');
  });

  it('caps device / os / release lists at 5', () => {
    for (let i = 0; i < 7; i++) {
      seed({
        device: { osName: `os${i}`, osVersion: '1', deviceModel: `m${i}` },
        release: { version: `${i}`, build: '1' },
      });
    }
    const impact = computeImpact(db, issueId);
    expect(impact.topDevices).toHaveLength(5);
    expect(impact.topOs).toHaveLength(5);
    expect(impact.releases).toHaveLength(5);
  });
});
