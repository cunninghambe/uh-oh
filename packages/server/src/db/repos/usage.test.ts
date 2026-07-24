import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import {
  computeVisitorHash,
  getOrCreateDailySalt,
  insertUsageEvent,
  utcDayString,
} from './usage.js';
import { createProject } from './projects.js';
import { usageSalts } from '../schema.js';

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = makeTestDb());
});
afterEach(() => close());

describe('daily salt lifecycle', () => {
  it('creates a salt lazily and returns the same salt for the same day', () => {
    const a = getOrCreateDailySalt(db, '2026-07-18');
    const b = getOrCreateDailySalt(db, '2026-07-18');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
    expect(db.select().from(usageSalts).all()).toHaveLength(1);
  });

  it('creates a different salt for a different day', () => {
    const d1 = getOrCreateDailySalt(db, '2026-07-18');
    const d2 = getOrCreateDailySalt(db, '2026-07-19');
    expect(d1).not.toBe(d2);
    expect(db.select().from(usageSalts).all()).toHaveLength(2);
  });

  it('utcDayString buckets an epoch-ms timestamp into a UTC YYYY-MM-DD', () => {
    expect(utcDayString(Date.UTC(2026, 6, 18, 23, 59))).toBe('2026-07-18');
    expect(utcDayString(Date.UTC(2026, 6, 19, 0, 1))).toBe('2026-07-19');
  });
});

describe('visitor hash recipe', () => {
  const base = { salt: 'SALT', publicKey: 'pk', clientIp: '203.0.113.1', userAgent: 'UA/1' };

  it('is a deterministic 16-char hex truncation of sha256', () => {
    const h = computeVisitorHash(base);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(computeVisitorHash(base)).toBe(h);
  });

  it('changes when any of salt / publicKey / ip / userAgent changes', () => {
    const h = computeVisitorHash(base);
    expect(computeVisitorHash({ ...base, salt: 'OTHER' })).not.toBe(h);
    expect(computeVisitorHash({ ...base, publicKey: 'pk2' })).not.toBe(h);
    expect(computeVisitorHash({ ...base, clientIp: '198.51.100.2' })).not.toBe(h);
    expect(computeVisitorHash({ ...base, userAgent: 'UA/2' })).not.toBe(h);
  });

  it('is uncorrelatable across days: same visitor, different day salt -> different hash', () => {
    const project = createProject(db, { name: 'App' });
    const day1 = getOrCreateDailySalt(db, '2026-07-18');
    const day2 = getOrCreateDailySalt(db, '2026-07-19');
    const input = { publicKey: project.publicKey, clientIp: '203.0.113.5', userAgent: 'Same UA' };
    const h1 = computeVisitorHash({ ...input, salt: day1 });
    const h2 = computeVisitorHash({ ...input, salt: day2 });
    expect(h1).not.toBe(h2);
  });
});

describe('insertUsageEvent', () => {
  it('persists a row with a generated id and no IP/UA columns', () => {
    const project = createProject(db, { name: 'App' });
    const row = insertUsageEvent(db, {
      projectId: project.id,
      type: 'pageview',
      name: null,
      path: '/home',
      referrerDomain: 'google.com',
      visitor: 'abcdef0123456789',
      props: null,
      receivedAt: Date.now(),
    });
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
    // The row shape carries no IP/UA field at all.
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'name',
        'path',
        'projectId',
        'props',
        'receivedAt',
        'referrerDomain',
        'release',
        'type',
        'visitor',
      ].sort(),
    );
  });
});
