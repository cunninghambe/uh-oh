import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import {
  upsertRelease,
  getReleaseById,
  listReleasesForProject,
  markMappingUploaded,
} from './releases.js';

let db: Db;
let close: () => void;
let projectId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const project = createProject(db, { name: 'Test App' });
  projectId = project.id;
});

afterEach(() => {
  close();
});

describe('upsertRelease', () => {
  it('creates a new release row', () => {
    const release = upsertRelease(db, {
      projectId,
      version: '1.0.0',
      build: '42',
      platform: 'android',
    });
    expect(release.id).toBeDefined();
    expect(release.version).toBe('1.0.0');
    expect(release.build).toBe('42');
    expect(release.platform).toBe('android');
    expect(release.mappingUploadedAt).toBeNull();
    expect(release.sourcemapUploadedAt).toBeNull();
  });

  it('is idempotent — returns same row on duplicate', () => {
    const input = { projectId, version: '1.0.0', build: '42', platform: 'android' as const };
    const first = upsertRelease(db, input);
    const second = upsertRelease(db, input);
    expect(second.id).toBe(first.id);
  });

  it('creates separate rows for different builds', () => {
    const a = upsertRelease(db, { projectId, version: '1.0.0', build: '1', platform: 'android' });
    const b = upsertRelease(db, { projectId, version: '1.0.0', build: '2', platform: 'android' });
    expect(a.id).not.toBe(b.id);
  });

  it('creates separate rows for different projects', () => {
    const p2 = createProject(db, { name: 'Other App' });
    const a = upsertRelease(db, { projectId, version: '1.0.0', build: '1', platform: 'android' });
    const b = upsertRelease(db, {
      projectId: p2.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe('getReleaseById', () => {
  it('returns the release by id', () => {
    const created = upsertRelease(db, {
      projectId,
      version: '2.0.0',
      build: '5',
      platform: 'android',
    });
    const found = getReleaseById(db, created.id);
    expect(found?.id).toBe(created.id);
  });

  it('returns null for unknown id', () => {
    expect(getReleaseById(db, 'no-such-id')).toBeNull();
  });
});

describe('listReleasesForProject', () => {
  it('lists all releases for a project', () => {
    upsertRelease(db, { projectId, version: '1.0.0', build: '1', platform: 'android' });
    upsertRelease(db, { projectId, version: '1.0.1', build: '2', platform: 'android' });
    const list = listReleasesForProject(db, projectId);
    expect(list).toHaveLength(2);
  });

  it('returns empty array when project has no releases', () => {
    expect(listReleasesForProject(db, projectId)).toHaveLength(0);
  });

  it('does not include releases from other projects', () => {
    const p2 = createProject(db, { name: 'Other' });
    upsertRelease(db, { projectId: p2.id, version: '1.0.0', build: '1', platform: 'android' });
    expect(listReleasesForProject(db, projectId)).toHaveLength(0);
  });
});

describe('markMappingUploaded', () => {
  it('sets mapping_uploaded_at on the release', () => {
    const release = upsertRelease(db, {
      projectId,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    expect(release.mappingUploadedAt).toBeNull();
    const ts = Date.now();
    markMappingUploaded(db, release.id, ts);
    const updated = getReleaseById(db, release.id);
    expect(updated?.mappingUploadedAt).toBe(ts);
  });
});
