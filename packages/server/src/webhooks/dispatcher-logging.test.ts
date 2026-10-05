// What an operator sees in the journal when an alert cannot be delivered. The
// dispatcher runs with the production logger chain (pino behind
// toStructuredLogger), so these tests fail if the context is dropped again or if
// a webhook credential ever reaches a log line.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import { webhookDispatches } from '../db/schema.js';
import { toStructuredLogger } from '../logging/structured-logger.js';
import { captureLog } from '../logging/test-utils.js';
import { startDispatcher, webhookLogTarget, type DnsLookupAll } from './dispatcher.js';

const NOW = 1_000_000;
const SECRET = 'SECRET-TOKEN-must-not-be-logged';
const DISCORD_URL = `https://discord.com/api/webhooks/123456/${SECRET}`;

const publicLookup: DnsLookupAll = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

let db: Db;
let close: () => void;
let issueId: string;
let eventId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const project = createProject(db, { name: 'Ops' });
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: 'fp1',
    title: 'Boom',
    ts: NOW,
  });
  issueId = issue.id;
  eventId = insertEvent(db, {
    projectId: project.id,
    issueId,
    releaseId: null,
    fingerprint: 'fp1',
    level: 'error',
    platform: 'node',
    payload: '{}',
    receivedAt: NOW,
    deviceInfo: '{}',
    userInfo: null,
  }).id;
});

afterEach(() => {
  close();
});

describe('webhookLogTarget', () => {
  it('keeps only the origin, never the credential in the path, query or userinfo', () => {
    expect(webhookLogTarget(DISCORD_URL)).toBe('https://discord.com');
    expect(webhookLogTarget('https://hooks.slack.com/services/T0/B0/abc123')).toBe(
      'https://hooks.slack.com',
    );
    expect(webhookLogTarget('https://user:pass@hooks.example:8443/x?token=abc')).toBe(
      'https://hooks.example:8443',
    );
  });

  it('degrades to a placeholder for a URL it cannot parse', () => {
    expect(webhookLogTarget('not a url')).toBe('<unparseable url>');
    expect(webhookLogTarget('data:text/plain,secret')).toBe('<unparseable url>');
  });
});

describe('dispatcher failure logs (production logger chain)', () => {
  it('a permanently failed alert logs id, type, target, error and status, without the token', async () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: DISCORD_URL, type: 'issue.new' }, NOW);
    // Three retries already spent: the next failure is the permanent one.
    db.update(webhookDispatches).set({ attempt: 3 }).where(eq(webhookDispatches.id, row.id)).run();

    const { lines, raw, logger } = captureLog();
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const handle = startDispatcher({
      db,
      fetchFn,
      lookupFn: publicLookup,
      now: () => NOW,
      pollIntervalMs: 10,
      logger: toStructuredLogger(logger),
    });
    try {
      await vi.waitFor(() => {
        expect(lines.some((l) => l['msg'] === 'webhook dispatch failed permanently')).toBe(true);
      });
    } finally {
      await handle.stop();
    }

    const failure = lines.find((l) => l['msg'] === 'webhook dispatch failed permanently');
    expect(failure).toMatchObject({
      level: 50,
      id: row.id,
      type: 'issue.new',
      target: 'https://discord.com',
      error: 'HTTP 404',
      statusCode: 404,
    });
    expect(failure).not.toHaveProperty('url');
    expect(raw.join('\n')).not.toContain(SECRET);
  });

  it('an SSRF-blocked target is logged by origin only', async () => {
    const row = enqueueDispatch(
      db,
      { issueId, eventId, url: `http://169.254.169.254/hook?token=${SECRET}`, type: 'issue.new' },
      NOW,
    );

    const { lines, raw, logger } = captureLog();
    const fetchFn = vi.fn();
    const handle = startDispatcher({
      db,
      fetchFn,
      lookupFn: publicLookup,
      now: () => NOW,
      pollIntervalMs: 10,
      logger: toStructuredLogger(logger),
    });
    try {
      await vi.waitFor(() => {
        expect(lines.some((l) => l['msg'] === 'webhook url blocked (SSRF guard)')).toBe(true);
      });
    } finally {
      await handle.stop();
    }

    const blocked = lines.find((l) => l['msg'] === 'webhook url blocked (SSRF guard)');
    expect(blocked).toMatchObject({
      level: 50,
      id: row.id,
      type: 'issue.new',
      target: 'http://169.254.169.254',
    });
    expect(typeof blocked?.['reason']).toBe('string');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(raw.join('\n')).not.toContain(SECRET);
  });

  it('a hostname that resolves to a blocked address is logged by origin only', async () => {
    const row = enqueueDispatch(
      db,
      {
        issueId,
        eventId,
        url: `https://rebind.example/api/webhooks/9/${SECRET}`,
        type: 'issue.new',
      },
      NOW,
    );

    const { lines, raw, logger } = captureLog();
    const fetchFn = vi.fn();
    const msg = 'webhook host resolves to a blocked address (SSRF guard)';
    const handle = startDispatcher({
      db,
      fetchFn,
      lookupFn: () => Promise.resolve([{ address: '10.0.0.7', family: 4 }]),
      now: () => NOW,
      pollIntervalMs: 10,
      logger: toStructuredLogger(logger),
    });
    try {
      await vi.waitFor(() => {
        expect(lines.some((l) => l['msg'] === msg)).toBe(true);
      });
    } finally {
      await handle.stop();
    }

    expect(lines.find((l) => l['msg'] === msg)).toMatchObject({
      level: 50,
      id: row.id,
      type: 'issue.new',
      target: 'https://rebind.example',
      address: '10.0.0.7',
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(raw.join('\n')).not.toContain(SECRET);
  });
});
