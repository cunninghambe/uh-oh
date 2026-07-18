import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { enqueueDispatch, takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { startDispatcher } from './dispatcher.js';

const NOW = 1_000_000;
const WEBHOOK_URL = 'https://hooks.example/test';

let db: Db;
let close: () => void;
let issueId: string;
let eventId: string;
let projectId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const project = createProject(db, { name: 'Test', webhookUrl: WEBHOOK_URL });
  projectId = project.id;
  const { issue } = upsertIssue(db, {
    projectId,
    fingerprint: 'fp1',
    title: 'Test error',
    ts: NOW,
  });
  issueId = issue.id;
  const event = insertEvent(db, {
    projectId,
    issueId,
    releaseId: null,
    fingerprint: 'fp1',
    level: 'error',
    platform: 'android',
    payload: '{}',
    receivedAt: NOW,
    deviceInfo: '{}',
    userInfo: null,
  });
  eventId = event.id;
});

afterEach(() => {
  close();
});

describe('startDispatcher', () => {
  it('dispatches a pending row and marks it succeeded', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);

    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handle = startDispatcher({
      db,
      fetchFn,
      now: () => NOW,
      pollIntervalMs: 10,
    });

    // Wait for the dispatcher to fire
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await handle.stop();

    expect(fetchFn).toHaveBeenCalledOnce();
    const due = takeDueDispatches(db, NOW + 999999, 10);
    expect(due).toHaveLength(0); // row is succeeded
  });

  it('retries non-2xx with 2s/8s/32s backoff progression', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);

    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    let currentNow = NOW;

    const handle = startDispatcher({
      db,
      fetchFn,
      now: () => currentNow,
      pollIntervalMs: 10,
    });

    // First attempt at NOW
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // After first failure, nextAttemptAt = NOW + 2000
    currentNow = NOW + 2000;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // After second failure, nextAttemptAt = (NOW+2000) + 8000
    currentNow = NOW + 2000 + 8000;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // After third failure, nextAttemptAt = (NOW+2000+8000) + 32000
    currentNow = NOW + 2000 + 8000 + 32000;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(fetchFn).toHaveBeenCalledTimes(4);

    await handle.stop();
  });

  it('gives up after 4 attempts (initial + 3 retries at 2s/8s/32s) and marks failed', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);

    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    let currentNow = NOW;

    const handle = startDispatcher({
      db,
      fetchFn,
      now: () => currentNow,
      pollIntervalMs: 10,
    });

    // Attempt 1 (initial)
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    currentNow = NOW + 2000;
    // Attempt 2 (retry 1 at +2s)
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    currentNow = NOW + 2000 + 8000;
    // Attempt 3 (retry 2 at +8s)
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    currentNow = NOW + 2000 + 8000 + 32000;
    // Attempt 4 (retry 3 at +32s)
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // Advance far beyond — no more retries
    currentNow = NOW + 999999;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    await handle.stop();

    expect(fetchFn).toHaveBeenCalledTimes(4);
    // Row should be failed (no pending rows)
    const due = takeDueDispatches(db, NOW + 999999, 10);
    expect(due).toHaveLength(0);
  });

  it('treats network error same as non-2xx (4 total attempts)', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);

    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    let currentNow = NOW;

    const handle = startDispatcher({
      db,
      fetchFn,
      now: () => currentNow,
      pollIntervalMs: 10,
    });

    // Attempt 1 (initial)
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    currentNow = NOW + 2000;
    // Attempt 2
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    currentNow = NOW + 2000 + 8000;
    // Attempt 3
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    currentNow = NOW + 2000 + 8000 + 32000;
    // Attempt 4
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    currentNow = NOW + 999999;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    await handle.stop();

    expect(fetchFn).toHaveBeenCalledTimes(4);
    const due = takeDueDispatches(db, NOW + 999999, 10);
    expect(due).toHaveLength(0);
  });

  it('passes an AbortSignal to fetch (for the 5s timeout)', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);

    let capturedSignal: AbortSignal | undefined;
    // Resolve immediately after capturing the signal — a never-resolving mock
    // would now hang stop(), which drains in-flight dispatches (M4).
    const fetchFn = vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal;
      return Promise.resolve({ ok: true, status: 200 });
    });

    const handle = startDispatcher({
      db,
      fetchFn,
      now: () => NOW,
      pollIntervalMs: 10,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await handle.stop();

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('stop() resolves promptly and stops the loop', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const handle = startDispatcher({
      db,
      fetchFn,
      now: () => NOW,
      pollIntervalMs: 50,
    });

    const start = Date.now();
    await handle.stop();
    const elapsed = Date.now() - start;

    // Should stop within 200ms
    expect(elapsed).toBeLessThan(200);
    // No fetches since no pending rows
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// Wrap a Db so the first `.select()` call throws once, then behaves normally.
// Functions are bound to the real target to avoid breaking private-field access.
const throwOnceOnSelect = (realDb: Db): Db => {
  let armed = true;
  return new Proxy(realDb, {
    get(target, prop, receiver): unknown {
      if (prop === 'select' && armed) {
        armed = false;
        return () => {
          throw new Error('transient SQLITE error');
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
};

describe('startDispatcher — resilience (H1)', () => {
  it('survives a thrown repo error, logs it, and keeps polling', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    const logger = { error: vi.fn(), warn: vi.fn() };
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const handle = startDispatcher({
      db: throwOnceOnSelect(db),
      fetchFn,
      now: () => NOW,
      pollIntervalMs: 10,
      logger,
      dashboardUrl: 'https://dash.example',
    });

    // First poll's takeDueDispatches throws → logged. A later poll succeeds.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await handle.stop();

    expect(logger.error).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalled();
    // The dispatch eventually succeeded (no pending rows remain).
    expect(takeDueDispatches(db, NOW + 999999, 10)).toHaveLength(0);
  });
});

describe('startDispatcher — payload (L2, L5)', () => {
  const captureFetch = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
      bodies.push(JSON.parse(opts.body) as Record<string, unknown>);
      return Promise.resolve({ ok: true, status: 200 });
    });
    return { fetchFn, bodies };
  };

  it('includes dispatchId and a url built from dashboardUrl', async () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    const { fetchFn, bodies } = captureFetch();
    const handle = startDispatcher({
      db,
      fetchFn,
      now: () => NOW,
      pollIntervalMs: 10,
      dashboardUrl: 'https://dash.example',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await handle.stop();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.['dispatchId']).toBe(row.id);
    expect(bodies[0]?.['url']).toBe(`https://dash.example/issues/${issueId}`);
  });

  it('omits url and warns once when dashboardUrl is unset', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    const { fetchFn, bodies } = captureFetch();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const handle = startDispatcher({ db, fetchFn, now: () => NOW, pollIntervalMs: 10, logger });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await handle.stop();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(bodies[0]).not.toHaveProperty('url');
    expect(bodies[0]?.['dispatchId']).toBeDefined();
  });
});

describe('startDispatcher — SSRF guard at dispatch time (H3)', () => {
  it('marks a dispatch to a blocked IP as failed without fetching', async () => {
    enqueueDispatch(db, { issueId, eventId, url: 'http://169.254.169.254/hook' }, NOW);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const logger = { error: vi.fn(), warn: vi.fn() };

    const handle = startDispatcher({ db, fetchFn, now: () => NOW, pollIntervalMs: 10, logger });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await handle.stop();

    expect(fetchFn).not.toHaveBeenCalled();
    // Permanently failed → no pending rows.
    expect(takeDueDispatches(db, NOW + 999999, 10)).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('startDispatcher — dispatch type (issue.regressed)', () => {
  it('emits the row type in the payload (issue.new default, issue.regressed when set)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
      bodies.push(JSON.parse(opts.body) as Record<string, unknown>);
      return Promise.resolve({ ok: true, status: 200 });
    });
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW); // default type
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL, type: 'issue.regressed' }, NOW);

    const handle = startDispatcher({ db, fetchFn, now: () => NOW, pollIntervalMs: 10 });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await handle.stop();

    const types = bodies.map((b) => b['type']);
    expect(types).toContain('issue.new');
    expect(types).toContain('issue.regressed');
  });
});

describe('startDispatcher — graceful drain (M4)', () => {
  it('stop() awaits an in-flight dispatch before resolving', async () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);

    let releaseFetch: (() => void) | undefined;
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: boolean; status: number }>((resolve) => {
          releaseFetch = () => {
            resolve({ ok: true, status: 200 });
          };
        }),
    );

    const handle = startDispatcher({ db, fetchFn, now: () => NOW, pollIntervalMs: 10 });

    // Wait until the fetch is in flight.
    for (let i = 0; i < 50 && fetchFn.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(fetchFn).toHaveBeenCalledOnce();

    let stopResolved = false;
    const stopP = handle.stop().then(() => {
      stopResolved = true;
    });

    // stop() must not resolve while the dispatch is still running.
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(stopResolved).toBe(false);

    releaseFetch?.();
    await stopP;
    expect(stopResolved).toBe(true);
    // The drained dispatch was marked succeeded.
    expect(takeDueDispatches(db, NOW + 999999, 10)).toHaveLength(0);
  });
});
