import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { buildAuthMiddleware } from './middleware.js';
import { mintTestToken, TEST_SECRET } from './test-utils.js';

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = makeTestDb());
});

afterEach(() => {
  close();
});

const buildTestApp = (db: Db) => {
  const app = Fastify();
  const auth = buildAuthMiddleware({ db, secret: TEST_SECRET });
  app.get('/protected', { preHandler: auth }, (_req, reply) => {
    reply.send({ ok: true });
  });
  return app;
};

describe('buildAuthMiddleware', () => {
  it('no Authorization header → 401', async () => {
    const app = buildTestApp(db);
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('wrong scheme (Basic ...) → 401', async () => {
    const app = buildTestApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('invalid token → 401', async () => {
    const app = buildTestApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not.a.valid.token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('valid token but jti not in sessions → 401', async () => {
    const app = buildTestApp(db);
    // Mint with a different DB that shares the same secret, but jti not inserted into our db
    const { db: otherDb, close: otherClose } = makeTestDb();
    const token = await mintTestToken(otherDb);
    otherClose();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('valid token + session in db → 200', async () => {
    const app = buildTestApp(db);
    const token = await mintTestToken(db);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
