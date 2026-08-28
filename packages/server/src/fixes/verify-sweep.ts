// CONTRACT V — the fix-verification sweep (v0.8 §23). An hourly in-process job
// (same lifecycle pattern as the monitor sweep) that flips a `deployed` fix
// attempt to `verified` once its deploy is old enough (now − deployed_at ≥
// UH_OH_FIX_VERIFY_DAYS) AND the issue has had zero events since the deploy,
// dispatching `fix.verified`. A post-deploy event instead regresses the issue
// and fails the attempt (the ingest hook), so such an attempt never reaches this
// sweep as `deployed`.

import type { Db } from '../db/index.js';
import { writeSystemAnnotation } from '../db/repos/annotations.js';
import { hasEventSince } from '../db/repos/events.js';
import {
  applyFixAttemptTransition,
  listDeployedAttemptsToVerify,
} from '../db/repos/fix-attempts.js';
import { getIssue } from '../db/repos/issues.js';
import { getProjectById } from '../db/repos/projects.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import { resolveWebhookUrl, warnNoWebhookTarget } from '../webhooks/resolve-url.js';
import { metrics } from '../metrics/registry.js';

const DAY_MS = 86_400_000;

/** Default verify window (days). */
export const DEFAULT_FIX_VERIFY_DAYS = 7;
/** Floor on the verify window. */
export const MIN_FIX_VERIFY_DAYS = 1;

/**
 * Parse `UH_OH_FIX_VERIFY_DAYS` (days). Unset → default 7. Set but not an
 * integer ≥ 1 → throws (fail boot, mirroring the token env validation).
 */
export const resolveFixVerifyDays = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') return DEFAULT_FIX_VERIFY_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_FIX_VERIFY_DAYS) {
    throw new Error(
      `UH_OH_FIX_VERIFY_DAYS must be an integer >= ${String(MIN_FIX_VERIFY_DAYS)} (days)`,
    );
  }
  return n;
};

export type SweepLogger = {
  error: (msg: string, meta?: object) => void;
  info?: (msg: string, meta?: object) => void;
  warn?: (msg: string, meta?: object) => void;
};

/** Options for one sweep pass. */
export type FixVerifySweepOptions = {
  logger?: SweepLogger | undefined;
  /** Instance-level fallback webhook (UH_OH_DEFAULT_WEBHOOK_URL). */
  defaultWebhookUrl?: string | undefined;
};

export type FixVerifySweepDeps = {
  db: Db;
  /** Verify window in days (default 7). */
  verifyDays?: number;
  now?: () => number;
  /** Sweep cadence (default 1 hour). */
  intervalMs?: number;
  logger?: SweepLogger;
  /**
   * Instance-level fallback webhook used when a project has no webhook_url of
   * its own. Threaded from UH_OH_DEFAULT_WEBHOOK_URL at startup.
   */
  defaultWebhookUrl?: string | undefined;
};

export type FixVerifySweepHandle = {
  stop: () => void;
  /** Run one sweep synchronously (used by tests + the scheduled tick). */
  sweepOnce: (now?: number) => number;
};

/**
 * Verify every deployed attempt whose deploy is old enough and whose issue has
 * stayed silent since the deploy. Each verification is its own transaction
 * (transition + audit annotation + optional dispatch) so one bad row can't abort
 * the sweep. Returns the number of newly-verified attempts.
 */
export const sweepFixVerification = (
  db: Db,
  now: number,
  verifyDays: number,
  opts: FixVerifySweepOptions = {},
): number => {
  const { logger, defaultWebhookUrl } = opts;
  const deployedBefore = now - verifyDays * DAY_MS;
  let verified = 0;
  for (const attempt of listDeployedAttemptsToVerify(db, deployedBefore)) {
    // deployed_at is guaranteed non-null for a 'deployed' attempt.
    if (attempt.deployedAt === null) continue;
    // A single post-deploy event means the fix did not fully hold: skip.
    if (hasEventSince(db, attempt.issueId, attempt.deployedAt)) continue;
    try {
      db.transaction((tx) => {
        applyFixAttemptTransition(tx, attempt, 'verified', now);
        writeSystemAnnotation(
          tx,
          attempt.issueId,
          `fix attempt verified: ${attempt.prUrl} held for the verify window (deployed -> verified)`,
          now,
        );
        const issue = getIssue(tx, attempt.issueId);
        const project = issue ? getProjectById(tx, issue.projectId) : null;
        const url = resolveWebhookUrl(project, defaultWebhookUrl);
        if (url) {
          enqueueDispatch(tx, { issueId: attempt.issueId, url, type: 'fix.verified' }, now);
        } else if (project) {
          warnNoWebhookTarget(logger, project, 'fix.verified');
        }
      });
      metrics.fixVerified.inc();
      verified++;
    } catch (err) {
      logger?.error('fix verify sweep transition failed', {
        id: attempt.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return verified;
};

export const startFixVerifySweep = (deps: FixVerifySweepDeps): FixVerifySweepHandle => {
  const intervalMs = deps.intervalMs ?? 60 * 60_000;
  const verifyDays = deps.verifyDays ?? DEFAULT_FIX_VERIFY_DAYS;
  const nowFn = deps.now ?? (() => Date.now());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sweepOptions: FixVerifySweepOptions = {
    logger: deps.logger,
    defaultWebhookUrl: deps.defaultWebhookUrl,
  };

  const tick = (): void => {
    if (stopped) return;
    try {
      sweepFixVerification(deps.db, nowFn(), verifyDays, sweepOptions);
    } catch (err) {
      deps.logger?.error('fix verify sweep iteration failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    sweepOnce: (now?: number) =>
      sweepFixVerification(deps.db, now ?? nowFn(), verifyDays, sweepOptions),
  };
};
