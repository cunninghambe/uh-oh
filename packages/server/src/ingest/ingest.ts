import type { Breadcrumb, EventEnvelope } from '@uh-oh/types';

import type { Db } from '../db/index.js';
import { insertBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { insertEvent } from '../db/repos/events.js';
import { upsertIssue, markIssueAlerted } from '../db/repos/issues.js';
import { getProjectByPublicKey } from '../db/repos/projects.js';
import { upsertRelease } from '../db/repos/releases.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
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

  const result = deps.db.transaction((tx): IngestResult => {
    const { issue, isNew, regressed } = upsertIssue(tx, {
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

    if (project.webhookUrl) {
      if (regressed) {
        // The resolved -> regressed transition dispatches immediately, bypassing
        // the dedupe window for this one dispatch. last_alerted_at is updated so
        // subsequent events on the now-regressed issue respect the normal window.
        enqueueDispatch(
          tx,
          {
            issueId: issue.id,
            eventId: event.id,
            url: project.webhookUrl,
            type: 'issue.regressed',
          },
          now,
        );
        markIssueAlerted(tx, issue.id, now);
      } else {
        const shouldFire =
          isNew ||
          issue.lastAlertedAt === null ||
          now - issue.lastAlertedAt > project.alertDedupeMinutes * 60_000;
        if (shouldFire) {
          enqueueDispatch(
            tx,
            { issueId: issue.id, eventId: event.id, url: project.webhookUrl, type: 'issue.new' },
            now,
          );
          markIssueAlerted(tx, issue.id, now);
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
  }

  return result;
};

export type IngestEntry = (publicKey: string, envelope: EventEnvelope) => IngestResult;

export const makeIngest =
  (deps: IngestDeps): IngestEntry =>
  (publicKey, envelope) =>
    ingest(deps, publicKey, envelope);

export type { ProjectRow };
