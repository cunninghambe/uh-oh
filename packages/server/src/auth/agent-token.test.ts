// CONTRACT A (§23) — the scoped agent token. Env validation, constant-time
// compare, boot failure on a short token, and the route scope matrix: every
// granted route accepts it, one representative rejection per verb class
// elsewhere, and the read token still rejects the four agent writes.

import { describe, expect, it } from 'vitest';

import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { upsertFixAttempt } from '../db/repos/fix-attempts.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from './test-utils.js';
import {
  AGENT_TOKEN_HEADER,
  MIN_AGENT_TOKEN_LENGTH,
  agentTokenFromEnv,
  agentTokenMatches,
} from './agent-token.js';
import { READ_TOKEN_HEADER } from './read-token.js';

const AGENT_TOKEN = 'agent-loop-token-abcdefghijklmnop';
const READ_TOKEN = 'read-debug-token-abcdefghijklmnop';

describe('agentTokenFromEnv', () => {
  it('returns undefined when unset or empty (feature off)', () => {
    expect(agentTokenFromEnv({})).toBeUndefined();
    expect(agentTokenFromEnv({ UH_OH_AGENT_TOKEN: '' })).toBeUndefined();
  });
  it('throws when shorter than the minimum length', () => {
    const short = 'x'.repeat(MIN_AGENT_TOKEN_LENGTH - 1);
    expect(() => agentTokenFromEnv({ UH_OH_AGENT_TOKEN: short })).toThrow(/at least 16/);
  });
  it('returns the token when it meets the minimum length', () => {
    expect(agentTokenFromEnv({ UH_OH_AGENT_TOKEN: AGENT_TOKEN })).toBe(AGENT_TOKEN);
  });
});

describe('agentTokenMatches (constant-time)', () => {
  it('is true for an exact match, false otherwise (incl. different lengths)', () => {
    expect(agentTokenMatches(AGENT_TOKEN, AGENT_TOKEN)).toBe(true);
    expect(agentTokenMatches('agent-loop-token-ABCDEFGHIJKLMNOP', AGENT_TOKEN)).toBe(false);
    expect(agentTokenMatches('short', AGENT_TOKEN)).toBe(false);
  });
});

describe('buildServer — agent token boot validation', () => {
  it('throws when the configured token is a 15-char token', () => {
    const { db, close } = makeTestDb();
    try {
      expect(() =>
        buildServer({
          db,
          secret: TEST_SECRET,
          password: 'test-password',
          agentToken: 'x'.repeat(15),
        }),
      ).toThrow(/at least 16/);
    } finally {
      close();
    }
  });
  it('boots with a conforming token', () => {
    const { db, close } = makeTestDb();
    try {
      expect(() =>
        buildServer({
          db,
          secret: TEST_SECRET,
          password: 'test-password',
          agentToken: AGENT_TOKEN,
        }),
      ).not.toThrow();
    } finally {
      close();
    }
  });
});

describe('CONTRACT A — agent token route matrix (integration)', () => {
  const setup = async () => {
    const { db, close } = makeTestDb();
    const jwt = await mintTestToken(db);
    const project = createProject(db, { name: 'App' });
    const { issue } = upsertIssue(db, {
      projectId: project.id,
      fingerprint: 'fp',
      title: 'TypeError: boom',
      ts: 1,
      platform: 'web',
    });
    const { attempt } = upsertFixAttempt(db, { issueId: issue.id, prUrl: 'https://gh/pr/1' }, 1);
    const app = buildServer({
      db,
      secret: TEST_SECRET,
      password: 'test-password',
      readToken: READ_TOKEN,
      agentToken: AGENT_TOKEN,
    });
    return { db, close, jwt, project, issueId: issue.id, attemptId: attempt.id, app };
  };

  const agent = () => ({ [AGENT_TOKEN_HEADER]: AGENT_TOKEN });
  const read = () => ({ [READ_TOKEN_HEADER]: READ_TOKEN });

  it('accepts the agent token on every granted route', async () => {
    const { close, project, issueId, attemptId, app } = await setup();
    try {
      const ok = (res: { statusCode: number }, label: string) =>
        expect(res.statusCode, label).toBeLessThan(400);

      // Read surface (incl. the new GET annotations + similar).
      ok(
        await app.inject({ method: 'GET', url: '/api/projects', headers: agent() }),
        'GET projects',
      );
      ok(
        await app.inject({ method: 'GET', url: `/api/issues/${issueId}`, headers: agent() }),
        'GET issue',
      );
      ok(
        await app.inject({
          method: 'GET',
          url: `/api/issues/${issueId}/annotations`,
          headers: agent(),
        }),
        'GET annotations',
      );
      ok(
        await app.inject({
          method: 'GET',
          url: `/api/issues/${issueId}/similar`,
          headers: agent(),
        }),
        'GET similar',
      );
      ok(
        await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/monitors`,
          headers: agent(),
        }),
        'GET monitors',
      );
      ok(
        await app.inject({
          method: 'GET',
          url: `/api/projects/${project.id}/release-health`,
          headers: agent(),
        }),
        'GET release-health',
      );

      // The four writes.
      ok(
        await app.inject({
          method: 'PATCH',
          url: `/api/issues/${issueId}`,
          headers: agent(),
          payload: { status: 'resolved' },
        }),
        'PATCH issue',
      );
      ok(
        await app.inject({
          method: 'POST',
          url: `/api/issues/${issueId}/annotations`,
          headers: agent(),
          payload: { body: 'root cause here', kind: 'root_cause' },
        }),
        'POST annotation',
      );
      ok(
        await app.inject({
          method: 'POST',
          url: `/api/issues/${issueId}/fix-attempts`,
          headers: agent(),
          payload: { prUrl: 'https://gh/pr/2' },
        }),
        'POST fix-attempt',
      );
      ok(
        await app.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/${attemptId}`,
          headers: agent(),
          payload: { state: 'deployed' },
        }),
        'PATCH fix-attempt',
      );
    } finally {
      close();
    }
  });

  it('rejects the agent token off its allowlist (one per verb class) without leaking it', async () => {
    const { close, project, app } = await setup();
    try {
      const reject = async (
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: Record<string, unknown>,
      ) => {
        const res = await app.inject({
          method,
          url,
          headers: agent(),
          ...(payload ? { payload } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.body).not.toContain(AGENT_TOKEN);
      };
      await reject('POST', '/api/projects', { name: 'X' }); // POST (not granted)
      await reject('PATCH', `/api/projects/${project.id}`, { name: 'Y' }); // PATCH (not granted)
      await reject('DELETE', `/api/projects/${project.id}`); // DELETE
      await reject('POST', `/api/projects/${project.id}/rotate-key`); // POST admin
      await reject('GET', '/api/top-issues'); // GET off the read allowlist
      await reject('POST', `/api/projects/${project.id}/releases`, {
        version: '9.9.9',
        build: '99',
        platform: 'web',
      }); // release upsert is NOT agent-granted
      // §24: issue merge is JWT-only, deliberately NOT agent-scoped (rejected at
      // the auth layer before the id is ever looked up).
      await reject('POST', '/api/issues/any-issue/merge', { into: 'whatever' });
    } finally {
      close();
    }
  });

  it('the read token is REJECTED on all four agent writes (scope boundary)', async () => {
    const { close, issueId, attemptId, app } = await setup();
    try {
      const reject = async (
        method: 'POST' | 'PATCH',
        url: string,
        payload?: Record<string, unknown>,
      ) => {
        const res = await app.inject({
          method,
          url,
          headers: read(),
          ...(payload ? { payload } : {}),
        });
        expect(res.statusCode, `read token on ${method} ${url}`).toBe(401);
      };
      await reject('PATCH', `/api/issues/${issueId}`, { status: 'resolved' });
      await reject('POST', `/api/issues/${issueId}/annotations`, { body: 'x' });
      await reject('POST', `/api/issues/${issueId}/fix-attempts`, { prUrl: 'https://gh/pr/9' });
      await reject('PATCH', `/api/fix-attempts/${attemptId}`, { state: 'deployed' });
    } finally {
      close();
    }
  });

  it('the read token IS accepted on the new GET annotations + similar routes', async () => {
    const { close, issueId, app } = await setup();
    try {
      const a = await app.inject({
        method: 'GET',
        url: `/api/issues/${issueId}/annotations`,
        headers: read(),
      });
      expect(a.statusCode).toBe(200);
      const s = await app.inject({
        method: 'GET',
        url: `/api/issues/${issueId}/similar`,
        headers: read(),
      });
      expect(s.statusCode).toBe(200);
    } finally {
      close();
    }
  });
});
