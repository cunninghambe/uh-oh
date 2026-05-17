import type { Db } from '../db/index.js';
import { insertSession } from '../db/repos/sessions.js';
import { issueToken } from './jwt.js';

const TEST_SECRET_RAW = 'test-secret-for-vitest-do-not-use-in-prod!!!';

export const TEST_SECRET = new TextEncoder().encode(TEST_SECRET_RAW);

export const mintTestToken = async (db: Db): Promise<string> => {
  const { token, jti, expiresAt } = await issueToken(TEST_SECRET);
  insertSession(db, jti, expiresAt);
  return token;
};
