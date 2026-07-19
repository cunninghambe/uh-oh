import type { AddressInfo } from 'node:net';

import type { EventEnvelope } from '@uh-oh/types';
import { Client, StreamableHTTPClientTransport } from '@uh-oh/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import type { ProjectRow } from '../db/schema.js';
import { ingest } from '../ingest/ingest.js';
import { createRateLimiter } from '../ingest/rate-limit.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';
import { READ_TOKEN_HEADER } from '../auth/read-token.js';

const envelope: EventEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.1.0' },
  timestamp: '2026-07-01T00:00:00.000Z',
  platform: 'android',
  release: { version: '1.0.0', build: '1' },
  level: 'error',
  exception: {
    type: 'Error',
    value: 'nope',
    mechanism: 'js-global',
    stacktrace: [{ module: 'A', function: 'f', inApp: true }],
  },
  breadcrumbs: [],
  device: { osName: 'Android', osVersion: '14' },
};

let db: Db;
let close: () => void;
let app: ReturnType<typeof buildServer>;
let project: ProjectRow;
let token: string;
let baseUrl: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'My App' });
  const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
  ingest({ db, rateLimiter: rl }, project.publicKey, envelope);
  token = await mintTestToken(db);

  app = buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await app.close();
  close();
});

describe('POST /mcp auth + method gating', () => {
  it('rejects a request with no bearer token (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bad token (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer not-a-real-token',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 405 for GET and DELETE (stateless mode is POST-only)', async () => {
    const get = await app.inject({ method: 'GET', url: '/mcp' });
    expect(get.statusCode).toBe(405);
    expect(get.headers['allow']).toContain('POST');
    const del = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(del.statusCode).toBe(405);
  });
});

describe('POST /mcp with a valid token (real MCP client)', () => {
  const connect = async (): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'endpoint-test', version: '0.0.0' });
    // exactOptionalPropertyTypes vs the SDK's transport types (sessionId is
    // `string | undefined`); the class implements Transport — assert past it.
    await client.connect(transport as Parameters<typeof client.connect>[0]);
    return client;
  };

  it('lists all fourteen tools', async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(14);
      const names = tools.map((t) => t.name);
      expect(names).toContain('get_server_health');
      expect(names).toContain('get_issue_bundle');
      expect(names).toContain('list_top_issues');
      expect(names).toContain('list_monitors');
      expect(names).toContain('get_usage_summary');
    } finally {
      await client.close();
    }
  });

  it('exposes the fix_crash prompt', async () => {
    const client = await connect();
    try {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toContain('fix_crash');
      const got = await client.getPrompt({ name: 'fix_crash', arguments: { issueId: 'iX' } });
      const text = (got.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toContain('get_issue_bundle');
      expect(text).toContain('iX');
    } finally {
      await client.close();
    }
  });

  it('calls a tool and gets the seeded project back', async () => {
    const client = await connect();
    try {
      const res = await client.callTool({ name: 'list_projects', arguments: {} });
      const content = (res.content ?? []) as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]?.text ?? '{}') as {
        projects: Array<{ id: string; slug: string }>;
      };
      expect(res.isError).toBeFalsy();
      expect(data.projects[0]).toMatchObject({ id: project.id, slug: 'my-app' });
    } finally {
      await client.close();
    }
  });
});

describe('POST /mcp with the read token (readonly scope, §22)', () => {
  const READ_TOKEN = 'read-debug-token-abcdefghijklmnop';
  let tokenApp: ReturnType<typeof buildServer>;
  let tokenUrl: string;

  const textOf = (res: Awaited<ReturnType<Client['callTool']>>): string => {
    const content = (res.content ?? []) as Array<{ type: string; text: string }>;
    return content[0]?.text ?? '';
  };

  const connectWith = async (headers: Record<string, string>): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${tokenUrl}/mcp`), {
      requestInit: { headers },
    });
    const c = new Client({ name: 'read-scope-test', version: '0.0.0' });
    await c.connect(transport as Parameters<typeof c.connect>[0]);
    return c;
  };

  beforeEach(async () => {
    // Reuse the outer db (already seeded with a project + one ingested event).
    tokenApp = buildServer({
      db,
      secret: TEST_SECRET,
      password: 'test-password',
      readToken: READ_TOKEN,
    });
    await tokenApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = tokenApp.server.address() as AddressInfo;
    tokenUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await tokenApp.close();
  });

  it('rejects a request with no auth at all (401)', async () => {
    const res = await tokenApp.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('read tools work under the read token, and a status change returns the scope error', async () => {
    const client = await connectWith({ [READ_TOKEN_HEADER]: READ_TOKEN });
    try {
      // A read tool succeeds and returns the seeded issue.
      const listed = await client.callTool({
        name: 'list_issues',
        arguments: { project: project.id },
      });
      expect(listed.isError).toBeFalsy();
      const issues = (JSON.parse(textOf(listed)) as { issues: Array<{ id: string }> }).issues;
      expect(issues.length).toBeGreaterThan(0);
      const issueId = issues[0]!.id;

      // A mutating tool returns the scope error and changes nothing.
      const write = await client.callTool({
        name: 'set_issue_status',
        arguments: { issueId, status: 'resolved' },
      });
      expect(write.isError).toBe(true);
      const err = JSON.parse(textOf(write)) as { error: string; message: string };
      expect(err.error).toBe('read_scope');
      expect(err.message).toContain('set_issue_status');

      // The status is unchanged (still open, not resolved).
      const after = await client.callTool({ name: 'get_issue', arguments: { issueId } });
      const issue = (JSON.parse(textOf(after)) as { issue: { status: string } }).issue;
      expect(issue.status).toBe('open');
    } finally {
      await client.close();
    }
  });

  it('a JWT over the same endpoint keeps the full scope (status change succeeds)', async () => {
    const client = await connectWith({ authorization: `Bearer ${token}` });
    try {
      const listed = await client.callTool({
        name: 'list_issues',
        arguments: { project: project.id },
      });
      const issueId = (JSON.parse(textOf(listed)) as { issues: Array<{ id: string }> }).issues[0]!
        .id;
      const write = await client.callTool({
        name: 'set_issue_status',
        arguments: { issueId, status: 'resolved' },
      });
      expect(write.isError).toBeFalsy();
      const issue = (JSON.parse(textOf(write)) as { issue: { status: string } }).issue;
      expect(issue.status).toBe('resolved');
    } finally {
      await client.close();
    }
  });
});
