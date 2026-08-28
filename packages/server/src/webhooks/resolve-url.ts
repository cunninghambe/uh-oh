// Webhook target resolution — the single place that answers "where does this
// alert go?".
//
// Every alert-worthy transition (monitor.missed / monitor.recovered /
// issue.new / issue.regressed / issue.spike / fix.verified) used to be gated
// directly on `project.webhookUrl`, and a project without one silently dropped
// the alert on the floor — no row, no log, nothing. That is how a 'missed'
// dead-man's-switch monitor sat unnoticed for six days in production.
//
// Two fixes live here:
//   1. `resolveWebhookUrl` adds an instance-level fallback
//      (`UH_OH_DEFAULT_WEBHOOK_URL`) behind the per-project URL, so a collector
//      with one configured destination alerts for every project on it.
//   2. `warnNoWebhookTarget` makes the remaining "nowhere to go" case audible:
//      one warn naming the project, the event, and how to fix it.
//
// Resolution order is deliberately project-first: an operator who set a
// per-project webhook expects that project's alerts there, not on the shared
// instance fallback.

import type { DispatchType } from '../db/repos/webhook-dispatches.js';
import { validateWebhookUrl } from './url-guard.js';

/** Name of the instance-level fallback env var, quoted in operator-facing text. */
export const DEFAULT_WEBHOOK_URL_ENV = 'UH_OH_DEFAULT_WEBHOOK_URL';

/** The fields of a project row webhook resolution and its warning need. */
export type WebhookTargetProject = {
  id: string;
  name: string;
  webhookUrl: string | null;
};

/**
 * Logger shape for the "nowhere to go" warning. Structurally satisfied by
 * `app.log` and by the sweeps' `SweepLogger`; optional everywhere so tests and
 * library callers can omit it (matching the dispatcher's own logger type).
 */
export type WebhookTargetLogger = {
  warn?: (msg: string, meta?: object) => void;
};

/** Treat '' like unset — the old `if (project.webhookUrl)` gate did too. */
const nonEmpty = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Resolve the URL an alert for `project` should be POSTed to:
 * `project.webhookUrl ?? defaultWebhookUrl ?? null`.
 *
 * A missing project resolves to `null` rather than the fallback: with no
 * project row the dispatcher cannot build a payload, so enqueueing would only
 * manufacture a dispatch that fails at build time.
 */
export const resolveWebhookUrl = (
  project: Pick<WebhookTargetProject, 'webhookUrl'> | null | undefined,
  defaultWebhookUrl?: string,
): string | null => {
  if (!project) return null;
  return nonEmpty(project.webhookUrl) ?? nonEmpty(defaultWebhookUrl);
};

/**
 * Log the one warning an operator needs when an alert-worthy transition has no
 * resolvable target. Called only on the transition itself (a miss, a recovery,
 * a new issue, a spike, a verification) — these are rare edges, never hot
 * paths — so this needs no dedupe state of its own.
 */
export const warnNoWebhookTarget = (
  logger: WebhookTargetLogger | undefined,
  project: Pick<WebhookTargetProject, 'id' | 'name'>,
  type: DispatchType,
): void => {
  logger?.warn?.(
    `${type} alert for project "${project.name}" (${project.id}) was not delivered: ` +
      `no webhook target. Set the project's webhook_url or the ` +
      `${DEFAULT_WEBHOOK_URL_ENV} env var to receive these alerts.`,
    { projectId: project.id, project: project.name, type },
  );
};

/**
 * Validate `UH_OH_DEFAULT_WEBHOOK_URL` at startup. Unset/empty → `undefined`
 * (feature off). Set but invalid → `onInvalid` is called and `undefined` is
 * returned: a typo in the fallback webhook must never stop the collector from
 * booting, because a collector that is up with imperfect alerting still beats a
 * collector that is down.
 */
export const resolveDefaultWebhookUrl = (
  raw: string | undefined,
  onInvalid?: (message: string) => void,
): string | undefined => {
  const value = nonEmpty(raw);
  if (value === null) return undefined;
  const guard = validateWebhookUrl(value);
  if (!guard.ok) {
    onInvalid?.(
      `${DEFAULT_WEBHOOK_URL_ENV} is not a usable webhook URL (${guard.reason}); ` +
        `continuing without an instance-level fallback webhook`,
    );
    return undefined;
  }
  return value;
};
