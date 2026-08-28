import type { Breadcrumb, EventEnvelope } from '@uh-oh/types';

import type { Db } from '../db/index.js';
import { insertBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { insertEvent } from '../db/repos/events.js';
import { bumpAliasedIssue, upsertIssue, markIssueAlerted } from '../db/repos/issues.js';
import { getAliasTarget } from '../db/repos/fingerprint-aliases.js';
import { getProjectByPublicKey } from '../db/repos/projects.js';
import { upsertRelease } from '../db/repos/releases.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import {
  resolveWebhookUrl,
  warnNoWebhookTarget,
  type WebhookTargetLogger,
} from '../webhooks/resolve-url.js';
import { writeSystemAnnotation } from '../db/repos/annotations.js';
import {
  applyFixAttemptTransition,
  mostRecentlyDeployedAttempt,
} from '../db/repos/fix-attempts.js';
import type { ProjectRow } from '../db/schema.js';

import { computeFingerprint, computeTitle } from './fingerprint.js';
import type { RateLimiter } from './rate-limit.js';
import { metrics } from '../metrics/registry.js';

export type IngestResult =
  | { kind: 'stored'; eventId: string; issueId: string; isNewIssue: boolean; regressed: boolean }
  | { kind: 'rate-limited'; issueId: string; isNewIssue: boolean }
  | { kind: 'unknown-key' };

export type IngestDeps = {
  db: Db;
  rateLimiter: RateLimiter;
  now?: () => number;
  /**
   * Instance-level fallback webhook used when a project has no webhook_url of
   * its own. Threaded from UH_OH_DEFAULT_WEBHOOK_URL at startup.
   */
  defaultWebhookUrl?: string | undefined;
  /** Used to warn when an alert-worthy transition has nowhere to go. */
  logger?: WebhookTargetLogger | undefined;
};

const isoToMs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
};

export const ingest = (
  deps: IngestDeps,
  publicKey: string,
  envelope: EventEnvelope,
): IngestResult => {
  const project = getProjectByPublicKey(deps.db, publicKey);
  if (!project) return { kind: 'unknown-key' };

  const now = deps.now?.() ?? Date.now();
  const fingerprint = computeFingerprint(envelope);
  const title = computeTitle(envelope);

  // Set inside the tx when a regression fails a deployed fix attempt; the metric
  // is incremented only after the tx commits (same discipline as the others).
  let failedFixAttempt = false;

  const result = deps.db.transaction((tx): IngestResult => {
    // §24: an event whose fingerprint matches a merge alias is routed to the
    // merge target (bumping it) instead of resurrecting the merged source issue.
    // The alias is consulted BEFORE the normal (project, fingerprint) upsert.
    const aliasTargetId = getAliasTarget(tx, project.id, fingerprint);
    const aliasBump = aliasTargetId
      ? bumpAliasedIssue(tx, aliasTargetId, { ts: now, platform: envelope.platform })
      : null;
    const { issue, isNew, regressed } = aliasBump
      ? { issue: aliasBump.issue, isNew: false, regressed: aliasBump.regressed }
      : upsertIssue(tx, {
          projectId: project.id,
          fingerprint,
          title,
          ts: now,
          platform: envelope.platform,
        });

    // Token consumption stays inside the tx and before the insert on purpose:
    // a rolled-back insert must NOT refund the attacker's bucket (rate limiting
    // is about attempts, not successful persists).
    const allowed = deps.rateLimiter.consume(`${project.publicKey}::${fingerprint}`, now);
    if (!allowed) {
      return { kind: 'rate-limited', issueId: issue.id, isNewIssue: isNew };
    }

    const release = upsertRelease(tx, {
      projectId: project.id,
      version: envelope.release.version,
      build: envelope.release.build,
      platform: envelope.platform,
    });

    const event = insertEvent(tx, {
      projectId: project.id,
      issueId: issue.id,
      releaseId: release.id,
      fingerprint,
      level: envelope.level,
      platform: envelope.platform,
      payload: JSON.stringify(envelope),
      receivedAt: now,
      deviceInfo: JSON.stringify(envelope.device),
      userInfo: envelope.user ? JSON.stringify(envelope.user) : null,
    });

    if (envelope.breadcrumbs.length > 0) {
      insertBreadcrumbs(
        tx,
        event.id,
        envelope.breadcrumbs.map((b: Breadcrumb) => ({
          ts: isoToMs(b.ts),
          category: b.category,
          level: b.level,
          message: b.message,
          data: b.data ? JSON.stringify(b.data) : null,
        })),
      );
    }

    // A regression means the most-recently-deployed fix attempt did not hold:
    // flip it to 'failed' and leave the audit-trail annotation. Independent of
    // the webhook (a state change, not a notification); the issue.regressed
    // payload picks the same attempt up at dispatch time.
    if (regressed) {
      const attempt = mostRecentlyDeployedAttempt(tx, issue.id, now);
      if (attempt && attempt.state === 'deployed') {
        applyFixAttemptTransition(tx, attempt, 'failed', now);
        writeSystemAnnotation(
          tx,
          issue.id,
          `fix attempt failed: issue regressed after deploy (${attempt.prUrl}) (deployed -> failed)`,
          now,
        );
        failedFixAttempt = true;
      }
    }

    // Project webhook first, then the instance-level fallback; null means the
    // alert has nowhere to go (warned about below, never dropped silently).
    const webhookUrl = resolveWebhookUrl(project, deps.defaultWebhookUrl);
    if (regressed) {
      if (webhookUrl) {
        // The resolved -> regressed transition dispatches immediately, bypassing
        // the dedupe window for this one dispatch. last_alerted_at is updated so
        // subsequent events on the now-regressed issue respect the normal window.
        enqueueDispatch(
          tx,
          {
            issueId: issue.id,
            eventId: event.id,
            url: webhookUrl,
            type: 'issue.regressed',
          },
          now,
        );
        markIssueAlerted(tx, issue.id, now);
      } else {
        warnNoWebhookTarget(deps.logger, project, 'issue.regressed');
      }
    } else {
      const shouldFire =
        isNew ||
        issue.lastAlertedAt === null ||
        now - issue.lastAlertedAt > project.alertDedupeMinutes * 60_000;
      if (shouldFire) {
        if (webhookUrl) {
          enqueueDispatch(
            tx,
            { issueId: issue.id, eventId: event.id, url: webhookUrl, type: 'issue.new' },
            now,
          );
          markIssueAlerted(tx, issue.id, now);
        } else if (isNew) {
          // Only the genuine new-issue transition warns. With no target we also
          // never set last_alerted_at (nothing was alerted), so `shouldFire`
          // stays true for every later event on the issue — warning on those too
          // would turn the hottest path in the server into a log firehose.
          warnNoWebhookTarget(deps.logger, project, 'issue.new');
        }
      }
    }

    return {
      kind: 'stored',
      eventId: event.id,
      issueId: issue.id,
      isNewIssue: isNew,
      regressed,
    };
  });

  // Increment metrics only after the transaction commits — a rollback (or a
  // throw from the tx body) must not leave counters reflecting unpersisted work.
  if (result.kind === 'rate-limited') {
    metrics.eventsIngested.inc({ outcome: 'rate-limited' });
  } else if (result.kind === 'stored') {
    metrics.eventsIngested.inc({ outcome: 'stored' });
    if (result.isNewIssue) metrics.issuesNew.inc();
    if (result.regressed) metrics.issuesRegressed.inc();
    if (failedFixAttempt) metrics.fixFailed.inc();
  }

  return result;
};

export type IngestEntry = (publicKey: string, envelope: EventEnvelope) => IngestResult;

export const makeIngest =
  (deps: IngestDeps): IngestEntry =>
  (publicKey, envelope) =>
    ingest(deps, publicKey, envelope);

export type { ProjectRow };
