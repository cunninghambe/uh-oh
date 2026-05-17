import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { buildServer } from '../server.js';
import { sessionExists } from '../db/repos/sessions.js';
import { mintTestToken, TEST_SECRET } from './test-utils.js';

const TEST_PASSWORD = 'correct-test-password';

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = makeTestDb());
});

afterEach(() => {
  close();
});

const buildTestServer = (testDb: Db) =>
  buildServer({ db: testDb, secret: TEST_SECRET, password: TEST_PASSWORD });

describe('POST /api/auth/login', () => {
  it('correct password → 200 with token + jti in sessions', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const { token } = res.json<{ token: string }>();
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);

    // Verify jti was persisted
    const { verifyToken } = await import('./jwt.js');
    const payload = await verifyToken(token, TEST_SECRET);
    expect(sessionExists(db, payload.jti, Date.now())).toBe(true);
  });

  it('wrong password → 401, no session inserted', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('invalid_credentials');
  });

  it('missing password field → 400', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { notpassword: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('11th login from same IP within rate window → 429', async () => {
    const app = buildTestServer(db);
    // Each request from same IP with a mocked recent timestamp
    // We send 11 requests; first 10 are allowed, 11th is rate-limited
    let lastRes: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 11; i++) {
      lastRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
        // Simulate the same IP via x-forwarded-for
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
    }
    expect(lastRes?.statusCode).toBe(429);
  });
});

describe('POST /api/auth/logout', () => {
  it('valid token → 204, session deleted', async () => {
    const app = buildTestServer(db);
    const token = await mintTestToken(db);
    const { verifyToken } = await import('./jwt.js');
    const payload = await verifyToken(token, TEST_SECRET);
    expect(sessionExists(db, payload.jti, Date.now())).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
    expect(sessionExists(db, payload.jti, Date.now())).toBe(false);
  });

  it('no token → 401', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(401);
  });
});
