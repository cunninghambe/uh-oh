import type { Db } from '../db/index.js';
import { getIssue } from '../db/repos/issues.js';
import { getEvent } from '../db/repos/events.js';
import { getProjectById } from '../db/repos/projects.js';
import { takeDueDispatches, markDispatchAttempt } from '../db/repos/webhook-dispatches.js';
import { metrics } from '../metrics/registry.js';

const BACKOFF_MS = [2000, 8000, 32000] as const;
const MAX_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 5000;
const DASHBOARD_URL = process.env['UH_OH_DASHBOARD_URL'] ?? '';

export type DispatcherDeps = {
  db: Db;
  fetchFn?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  logger?: { error: (msg: string, meta?: object) => void };
};

export type DispatcherHandle = {
  stop: () => Promise<void>;
};

const buildPayload = (db: Db, dispatch: { issueId: string; eventId: string }): object | null => {
  const issue = getIssue(db, dispatch.issueId);
  const event = getEvent(db, dispatch.eventId);
  if (!issue || !event) return null;
  const project = getProjectById(db, issue.projectId);
  if (!project) return null;
  return {
    type: 'issue.new',
    project: { id: project.id, name: project.name, slug: project.slug },
    issue: {
      id: issue.id,
      fingerprint: issue.fingerprint,
      title: issue.title,
      eventCount: issue.eventCount,
    },
    event: {
      id: event.id,
      level: event.level,
      platform: event.platform,
      receivedAt: event.receivedAt,
    },
    url: `${DASHBOARD_URL}/issues/${issue.id}`,
  };
};

const dispatchOne = async (
  db: Db,
  dispatch: { id: string; issueId: string; eventId: string; url: string; attempt: number },
  fetchFn: typeof fetch,
  now: number,
  logger?: { error: (msg: string, meta?: object) => void },
): Promise<void> => {
  const payload = buildPayload(db, dispatch);
  if (!payload) {
    markDispatchAttempt(db, dispatch.id, {
      ok: false,
      statusCode: null,
      error: 'missing issue/event/project',
      at: now,
      nextAttemptAt: null,
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  let statusCode: number | null = null;
  let errorMsg: string | null = null;

  try {
    const res = await fetchFn(dispatch.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    statusCode = res.status;
    if (res.ok) {
      markDispatchAttempt(db, dispatch.id, { ok: true, statusCode, at: now });
      return;
    }
    errorMsg = `HTTP ${statusCode}`;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }

  const nextAttemptAt =
    dispatch.attempt < MAX_ATTEMPTS - 1
      ? now + (BACKOFF_MS[dispatch.attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!)
      : null;

  if (nextAttemptAt === null) {
    metrics.webhookFailures.inc();
    logger?.error('webhook dispatch failed permanently', {
      id: dispatch.id,
      url: dispatch.url,
      error: errorMsg,
      statusCode,
    });
  }

  markDispatchAttempt(db, dispatch.id, {
    ok: false,
    statusCode,
    error: errorMsg ?? 'unknown error',
    at: now,
    nextAttemptAt,
  });
};

export const startDispatcher = (deps: DispatcherDeps): DispatcherHandle => {
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowFn = deps.now ?? (() => Date.now());

  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const poll = (): void => {
    if (stopped) return;

    const now = nowFn();
    const due = takeDueDispatches(deps.db, now, 10);
    const work = due.map((d) => dispatchOne(deps.db, d, fetchFn, now, deps.logger));

    void Promise.all(work).then(() => {
      if (!stopped) {
        pollTimer = setTimeout(poll, pollIntervalMs);
      }
    });
  };

  pollTimer = setTimeout(poll, pollIntervalMs);

  return {
    stop: () => {
      stopped = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      return Promise.resolve();
    },
  };
};
