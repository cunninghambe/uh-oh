import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import {
  createProject,
  deleteProject,
  getProjectById,
  getProjectByPublicKey,
  listProjects,
  rotateProjectPublicKey,
  updateProject,
} from './projects.js';

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = makeTestDb());
});

afterEach(() => {
  close();
});

describe('projects repo', () => {
  it('createProject persists and returns row', () => {
    const p = createProject(db, { name: 'My App' });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.slug).toBe('my-app');
    expect(p.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(p.webhookUrl).toBeNull();
    expect(p.alertDedupeMinutes).toBe(30);
  });

  it('listProjects returns all', () => {
    createProject(db, { name: 'A' });
    createProject(db, { name: 'B' });
    expect(listProjects(db)).toHaveLength(2);
  });

  it('getProjectByPublicKey finds by key', () => {
    const p = createProject(db, { name: 'App' });
    const found = getProjectByPublicKey(db, p.publicKey);
    expect(found?.id).toBe(p.id);
  });

  it('getProjectByPublicKey returns null when missing', () => {
    expect(getProjectByPublicKey(db, 'nope')).toBeNull();
  });

  it('updateProject patches fields', () => {
    const p = createProject(db, { name: 'App' });
    const updated = updateProject(db, p.id, {
      webhookUrl: 'https://hooks.test/x',
      alertDedupeMinutes: 5,
    });
    expect(updated?.webhookUrl).toBe('https://hooks.test/x');
    expect(updated?.alertDedupeMinutes).toBe(5);
  });

  it('updateProject returns null when missing', () => {
    expect(updateProject(db, 'nope', { webhookUrl: 'x' })).toBeNull();
  });

  it('rotateProjectPublicKey generates new key', () => {
    const p = createProject(db, { name: 'App' });
    const rotated = rotateProjectPublicKey(db, p.id);
    expect(rotated?.publicKey).not.toBe(p.publicKey);
    expect(rotated?.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deleteProject removes row', () => {
    const p = createProject(db, { name: 'App' });
    expect(deleteProject(db, p.id)).toBe(true);
    expect(getProjectById(db, p.id)).toBeNull();
  });

  it('deleteProject returns false when missing', () => {
    expect(deleteProject(db, 'nope')).toBe(false);
  });

  it('slug falls back to "project" for non-alphanumeric names', () => {
    const p = createProject(db, { name: '!!!' });
    expect(p.slug).toBe('project');
  });
});
