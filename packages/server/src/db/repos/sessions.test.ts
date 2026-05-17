import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { insertSession, sessionExists, deleteSession, cleanupExpiredSessions } from './sessions.js';

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = makeTestDb());
});

afterEach(() => {
  close();
});

const future = () => Date.now() + 1_000_000;
const past = () => Date.now() - 1;

describe('insertSession + sessionExists', () => {
  it('round-trips a session', () => {
    const jti = crypto.randomUUID();
    insertSession(db, jti, future());
    expect(sessionExists(db, jti, Date.now())).toBe(true);
  });

  it('returns false for unknown jti', () => {
    expect(sessionExists(db, crypto.randomUUID(), Date.now())).toBe(false);
  });
});

describe('sessionExists', () => {
  it('returns false past expiry', () => {
    const jti = crypto.randomUUID();
    insertSession(db, jti, past());
    expect(sessionExists(db, jti, Date.now())).toBe(false);
  });
});

describe('deleteSession', () => {
  it('removes the row', () => {
    const jti = crypto.randomUUID();
    insertSession(db, jti, future());
    deleteSession(db, jti);
    expect(sessionExists(db, jti, Date.now())).toBe(false);
  });

  it('is a no-op for unknown jti', () => {
    expect(() => deleteSession(db, crypto.randomUUID())).not.toThrow();
  });
});

describe('cleanupExpiredSessions', () => {
  it('removes only expired rows', () => {
    const alive = crypto.randomUUID();
    const expired = crypto.randomUUID();
    insertSession(db, alive, future());
    insertSession(db, expired, past());
    const deleted = cleanupExpiredSessions(db, Date.now());
    expect(deleted).toBe(1);
    expect(sessionExists(db, alive, Date.now())).toBe(true);
    expect(sessionExists(db, expired, Date.now())).toBe(false);
  });

  it('returns 0 when nothing expired', () => {
    insertSession(db, crypto.randomUUID(), future());
    expect(cleanupExpiredSessions(db, Date.now())).toBe(0);
  });
});
