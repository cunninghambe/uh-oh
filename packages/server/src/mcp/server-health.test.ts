// get_server_health must still show a dead alert webhook after the server
// restarts. The only signal used to be uh_oh_webhook_failures_total, an
// in-memory counter that starts at 0 in every new process. These tests run a
// real permanent failure through the dispatcher on a SQLite FILE, then close
// the database, reset the metric registry (what a new process starts with),
// reopen the file and build a new server, and read health through every path
// a caller has: POST /mcp with the read token (the daily triage), the stdio
// MCP's HttpBackend, and GET /api/health.

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, HttpBackend, StreamableHTTPClientTransport, parseMetricsSubset } from '@uh-oh/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';
import { READ_TOKEN_HEADER } from '../auth/read-token.js';
import { applyMigrations, openDb, type Db } from '../db/index.js';
import { createMonitor } from '../db/repos/monitors.js';
import { createProject } from '../db/repos/projects.js';
import { enqueueDispatch, summarizeFailedDispatches } from '../db/repos/webhook-dispatches.js';
import { registry } from '../metrics/registry.js';
import { buildServer } from '../server.js';
import { startDispatcher, type DnsLookupAll } from '../webhooks/dispatcher.js';

const PASSWORD = 'test-password';
const READ_TOKEN = 'read-token-for-health-tests';
// A Discord webhook that was deleted answers 404 to every POST.
const DEAD_DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/123456/deleted-token';
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
// Initial attempt, then the 2 s / 8 s / 32 s retries: the final one runs at +42 s.
const ATTEMPT_TIMES = [T0, T0 + 2_000, T0 + 10_000, T0 + 42_000];
const FINAL_ATTEMPT_AT = T0 + 42_000;
// The dispatcher polls every 5 ms; the generous ceiling only matters on a loaded CI box.
const WAIT = { timeout: 5_000, interval: 5 };

const publicLookup: DnsLookupAll = () =>
  Promise.resolve([{ address: '162.159.128.233', family: 4 }]);

let dir: string;
let dbFile: string;
let db: Db;
let closeDb: (() => void) | undefined;
let app: ReturnType<typeof buildServer> | undefined;

const open = (): Db => {
  const opened = openDb(dbFile);
  applyMigrations(opened.db);
  closeDb = opened.close;
  return opened.db;
};

const startServer = async (): Promise<string> => {
  app = buildServer({ db, secret: TEST_SECRET, password: PASSWORD, readToken: READ_TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
};

/** One monitor.missed alert to a dead Discord webhook, run to permanent failure. */
const failOneAlertForGood = async (): Promise<void> => {
  const project = createProject(db, { name: 'Ops' });
  const monitor = createMonitor(db, {
    projectId: project.id,
    slug: 'nightly-backup',
    intervalMinutes: 60,
    graceMinutes: 15,
    now: T0,
  });
  enqueueDispatch(
    db,
    { monitorId: monitor.id, url: DEAD_DISCORD_WEBHOOK, type: 'monitor.missed' },
    T0,
  );

  const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
  let now = T0;
  const handle = startDispatcher({
    db,
    fetchFn,
    lookupFn: publicLookup,
    now: () => now,
    pollIntervalMs: 5,
  });
  try {
    for (const [i, at] of ATTEMPT_TIMES.entries()) {
      now = at;
      await vi.waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(i + 1);
      }, WAIT);
    }
    await vi.waitFor(() => {
      expect(summarizeFailedDispatches(db).failed).toBe(1);
    }, WAIT);
  } finally {
    await handle.stop();
  }
};

/** Close the database and forget every in-memory metric, as a process exit does. */
const restart = async (): Promise<void> => {
  if (app) await app.close();
  app = undefined;
  closeDb?.();
  closeDb = undefined;
  registry.resetMetrics();
  db = open();
};

const callTool = async (baseUrl: string, name: string): Promise<Record<string, unknown>> => {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { [READ_TOKEN_HEADER]: READ_TOKEN } },
  });
  const client = new Client({ name: 'health-test', version: '0.0.0' });
  await client.connect(transport as Parameters<typeof client.connect>[0]);
  try {
    const res = await client.callTool({ name, arguments: {} });
    expect(res.isError).not.toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
  } finally {
    await client.close();
  }
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'uh-oh-health-'));
  dbFile = path.join(dir, 'uh-oh.db');
  registry.resetMetrics();
  db = open();
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  closeDb?.();
  closeDb = undefined;
  registry.resetMetrics();
  rmSync(dir, { recursive: true, force: true });
});

describe('webhook delivery failures survive a restart in get_server_health', () => {
  it('the in-memory counter alone forgets the failure on restart', async () => {
    await failOneAlertForGood();
    expect(parseMetricsSubset(await registry.metrics()).webhookFailures).toBe(1);

    await restart();
    expect(parseMetricsSubset(await registry.metrics()).webhookFailures).toBe(0);
  });

  it('POST /mcp (read token, as the daily triage calls it) still reports it', async () => {
    await failOneAlertForGood();
    await restart();
    const baseUrl = await startServer();

    const health = await callTool(baseUrl, 'get_server_health');
    expect(health).toMatchObject({
      ok: true,
      webhookFailures: 0,
      failedWebhookDispatches: 1,
      lastWebhookFailureAt: new Date(FINAL_ATTEMPT_AT).toISOString(),
    });
  });

  it('the HttpBackend (stdio MCP) still reports it, over GET /api/health', async () => {
    await failOneAlertForGood();
    await restart();
    const baseUrl = await startServer();

    const health = await new HttpBackend({
      serverUrl: baseUrl,
      adminPassword: PASSWORD,
    }).getHealth();
    expect(health.webhookFailures).toBe(0);
    expect(health.failedWebhookDispatches).toEqual({ failed: 1, lastFailedAt: FINAL_ATTEMPT_AT });
  });

  it('GET /api/health answers with a JWT and rejects no auth and the read token', async () => {
    await failOneAlertForGood();
    await restart();
    await startServer();
    const server = app!;

    const token = await mintTestToken(db);
    const authed = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual({
      failedWebhookDispatches: { failed: 1, lastFailedAt: FINAL_ATTEMPT_AT },
    });

    const anonymous = await server.inject({ method: 'GET', url: '/api/health' });
    expect(anonymous.statusCode).toBe(401);
    // JWT only, like /api/top-issues: the read token reaches the same figures
    // through get_server_health on /mcp, not through this route.
    const readToken = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { [READ_TOKEN_HEADER]: READ_TOKEN },
    });
    expect(readToken.statusCode).toBe(401);
  });

  it('a server with no failed dispatch reports zero and no failure time', async () => {
    const baseUrl = await startServer();
    const health = await callTool(baseUrl, 'get_server_health');
    expect(health['failedWebhookDispatches']).toBe(0);
    expect(health).not.toHaveProperty('lastWebhookFailureAt');
  });

  it('against a server without GET /api/health the HttpBackend still reports the rest', async () => {
    const baseUrl = await startServer();
    const olderServer = (url: string, init?: RequestInit): Promise<Response> =>
      url.endsWith('/api/health')
        ? Promise.resolve(new Response('{"error":"not_found"}', { status: 404 }))
        : fetch(url, init);

    const health = await new HttpBackend({
      serverUrl: baseUrl,
      adminPassword: PASSWORD,
      fetchImpl: olderServer,
    }).getHealth();
    expect(health.ok).toBe(true);
    expect(health.metricsAvailable).toBe(true);
    expect(health.failedWebhookDispatches).toBeNull();
  });
});
