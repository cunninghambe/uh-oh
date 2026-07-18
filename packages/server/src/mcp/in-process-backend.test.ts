import type { EventEnvelope } from '@uh-oh/types';
import { Client, InMemoryTransport, createUhOhMcpServer } from '@uh-oh/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import type { ProjectRow } from '../db/schema.js';
import { ingest } from '../ingest/ingest.js';
import { createRateLimiter } from '../ingest/rate-limit.js';
import { InProcessBackend } from './in-process-backend.js';

const envelope: EventEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.1.0' },
  timestamp: '2026-07-01T00:00:00.000Z',
  platform: 'android',
  release: { version: '1.2.3', build: '45' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'boom',
    mechanism: 'js-global',
    stacktrace: [
      { module: 'com.app.MainActivity', function: 'onCreate', lineno: 10, inApp: true },
      { filename: 'index.android.bundle', function: 'render', lineno: 5, colno: 12, inApp: true },
    ],
  },
  breadcrumbs: [
    { ts: '2026-06-30T23:59:50.000Z', category: 'nav', level: 'info', message: 'home' },
    { ts: '2026-06-30T23:59:55.000Z', category: 'nav', level: 'info', message: 'checkout' },
  ],
  device: { osName: 'Android', osVersion: '14' },
};

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> => {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? '';
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { isError: res.isError === true, data, text };
};

let db: Db;
let close: () => void;
let project: ProjectRow;
let seeded: { eventId: string; issueId: string };
let client: Client;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'My App' });
  const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
  const res = ingest({ db, rateLimiter: rl }, project.publicKey, envelope);
  if (res.kind !== 'stored') throw new Error(`seed ingest failed: ${res.kind}`);
  seeded = { eventId: res.eventId, issueId: res.issueId };

  const server = createUhOhMcpServer(new InProcessBackend(db));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(() => {
  close();
});

describe('InProcessBackend over MCP (InMemoryTransport)', () => {
  it('lists the seeded project', async () => {
    const { isError, data } = await call(client, 'list_projects');
    expect(isError).toBe(false);
    const projects = data['projects'] as Record<string, unknown>[];
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: project.id, slug: 'my-app' });
  });

  it('creates a project through the tool and lists it back', async () => {
    const created = await call(client, 'create_project', { name: 'Second' });
    expect(created.isError).toBe(false);
    const { data } = await call(client, 'list_projects');
    expect(data['projects'] as unknown[]).toHaveLength(2);
  });

  it('resolves a slug in list_issues and returns the seeded issue', async () => {
    const { isError, data } = await call(client, 'list_issues', { project: 'my-app' });
    expect(isError).toBe(false);
    expect(data['total']).toBe(1);
    expect((data['issues'] as Record<string, unknown>[])[0]).toMatchObject({ id: seeded.issueId });
  });

  it('get_issue returns the latest event, symbolicated frames and breadcrumbs', async () => {
    const { isError, data } = await call(client, 'get_issue', { issueId: seeded.issueId });
    expect(isError).toBe(false);
    expect((data['latestEvent'] as Record<string, unknown>)['id']).toBe(seeded.eventId);
    const frames = data['frames'] as Record<string, unknown>[];
    expect(frames).toHaveLength(2);
    // No symbols uploaded for this release → the symbolicate path returns frames
    // marked no_symbols (exercised end-to-end, not just formatted).
    expect(frames[0]).toMatchObject({ function: 'onCreate', inApp: true, status: 'no_symbols' });
    expect((data['breadcrumbs'] as unknown[]).length).toBe(2);
  });

  it('get_event returns the cleaned envelope with resolved frames', async () => {
    const { isError, data } = await call(client, 'get_event', { eventId: seeded.eventId });
    expect(isError).toBe(false);
    const event = data['event'] as Record<string, unknown>;
    const exception = event['exception'] as Record<string, unknown>;
    expect(exception).not.toHaveProperty('stacktrace');
    expect((exception['frames'] as unknown[]).length).toBe(2);
  });

  it('list_issue_events returns the seeded event', async () => {
    const { isError, data } = await call(client, 'list_issue_events', { issueId: seeded.issueId });
    expect(isError).toBe(false);
    expect(data['total']).toBe(1);
    expect((data['events'] as Record<string, unknown>[])[0]).toMatchObject({ id: seeded.eventId });
  });

  it('set_issue_status flips the status and the filter reflects it', async () => {
    await call(client, 'set_issue_status', { issueId: seeded.issueId, status: 'resolved' });
    const open = await call(client, 'list_issues', { project: 'my-app', status: 'open' });
    expect(open.data['total']).toBe(0);
    const resolved = await call(client, 'list_issues', { project: 'my-app', status: 'resolved' });
    expect(resolved.data['total']).toBe(1);
  });

  it('surfaces a system-set regressed status end-to-end (§CONTRACT M, no adapter)', async () => {
    // Resolve the seeded issue, then a new event with the same fingerprint
    // transitions it resolved -> regressed (system-set by ingest).
    await call(client, 'set_issue_status', { issueId: seeded.issueId, status: 'resolved' });
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    const again = ingest({ db, rateLimiter: rl }, project.publicKey, envelope);
    expect(again.kind).toBe('stored');

    // The regressed filter (now accepted by list_issues) returns the issue.
    const regressed = await call(client, 'list_issues', { project: 'my-app', status: 'regressed' });
    expect(regressed.data['total']).toBe(1);
    expect((regressed.data['issues'] as Record<string, unknown>[])[0]).toMatchObject({
      id: seeded.issueId,
      status: 'regressed',
    });

    // get_issue surfaces the regressed status directly (the widened Issue type).
    const detail = await call(client, 'get_issue', { issueId: seeded.issueId });
    expect((detail.data['issue'] as Record<string, unknown>)['status']).toBe('regressed');
  });

  it('set_issue_status rejects the system-set regressed status', async () => {
    const { isError } = await call(client, 'set_issue_status', {
      issueId: seeded.issueId,
      status: 'regressed',
    });
    expect(isError).toBe(true);
  });

  it('list_releases returns the release created at ingest', async () => {
    const { isError, data } = await call(client, 'list_releases', { project: 'my-app' });
    expect(isError).toBe(false);
    const releases = data['releases'] as Record<string, unknown>[];
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ version: '1.2.3', build: '45', platform: 'android' });
  });

  it('update_project applies a valid patch and rejects an SSRF webhook URL', async () => {
    const good = await call(client, 'update_project', {
      projectId: project.id,
      alertDedupeMinutes: 15,
    });
    expect(good.isError).toBe(false);
    expect((good.data['project'] as Record<string, unknown>)['alertDedupeMinutes']).toBe(15);

    const bad = await call(client, 'update_project', {
      projectId: project.id,
      webhookUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('invalid_webhookUrl');
  });

  it('get_server_health reports ok and the in-process metrics subset', async () => {
    const { isError, data } = await call(client, 'get_server_health');
    expect(isError).toBe(false);
    expect(data['ok']).toBe(true);
    expect(data['metricsAvailable']).toBe(true);
    expect(typeof data['eventsIngested']).toBe('number');
  });

  it('reports a not_found tool error for a missing issue', async () => {
    const { isError, text } = await call(client, 'get_issue', { issueId: 'does-not-exist' });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });

  it('list_issue_events on a missing issue is a not_found error (matches the route)', async () => {
    const { isError, text } = await call(client, 'list_issue_events', { issueId: 'ghost' });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });
});
