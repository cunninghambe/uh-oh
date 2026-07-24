import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    publicKey: text('public_key').notNull(),
    webhookUrl: text('webhook_url'),
    alertDedupeMinutes: integer('alert_dedupe_minutes').notNull().default(30),
    // Repository URL (v0.8 §23), nullable, ≤512 chars enforced at the route. The
    // server never contacts the git host; it only stores this so an agent holding
    // a checkout can build `<repoUrl>/commit/<sha>` links and diff commits itself.
    repoUrl: text('repo_url'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('projects_slug_uniq').on(t.slug),
    uniqueIndex('projects_public_key_uniq').on(t.publicKey),
  ],
);

export const releases = sqliteTable(
  'releases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    build: text('build').notNull(),
    platform: text('platform', { enum: ['ios', 'android', 'web', 'node'] }).notNull(),
    mappingUploadedAt: integer('mapping_uploaded_at'),
    sourcemapUploadedAt: integer('sourcemap_uploaded_at'),
    // Commit the release was built from (v0.8 §23), nullable; validated against
    // /^[0-9a-f]{7,40}$/i and stored lower-case at the upsert route.
    commitSha: text('commit_sha'),
  },
  (t) => [
    uniqueIndex('releases_proj_ver_build_plat_uniq').on(
      t.projectId,
      t.version,
      t.build,
      t.platform,
    ),
  ],
);

export const issues = sqliteTable(
  'issues',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    firstSeen: integer('first_seen').notNull(),
    lastSeen: integer('last_seen').notNull(),
    eventCount: integer('event_count').notNull().default(1),
    status: text('status', { enum: ['open', 'resolved', 'ignored', 'regressed'] })
      .notNull()
      .default('open'),
    lastAlertedAt: integer('last_alerted_at'),
    // Nullable: reflects the issue's latest event platform (§CONTRACT P). Old
    // issues predating migration 0004 are backfilled from their most recent
    // event; an issue with no events stays null.
    platform: text('platform', { enum: ['ios', 'android', 'web', 'node'] }),
    // Spike state (v0.8 §23). Set by the 5-minute spike sweep on the transition
    // into spiking (dispatching issue.spike once) and cleared silently when the
    // condition clears — the transition is the webhook dedupe, like monitors.
    spikeActive: integer('spike_active', { mode: 'boolean' }).notNull().default(false),
    lastSpikeAt: integer('last_spike_at'),
  },
  (t) => [
    uniqueIndex('issues_proj_fp_uniq').on(t.projectId, t.fingerprint),
    index('issues_proj_lastseen_idx').on(t.projectId, t.lastSeen),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    releaseId: text('release_id').references(() => releases.id, { onDelete: 'set null' }),
    fingerprint: text('fingerprint').notNull(),
    level: text('level').notNull(),
    platform: text('platform', { enum: ['ios', 'android', 'web', 'node'] }).notNull(),
    payload: text('payload').notNull(),
    receivedAt: integer('received_at').notNull(),
    deviceInfo: text('device_info').notNull(),
    userInfo: text('user_info'),
  },
  (t) => [
    index('events_issue_received_idx').on(t.issueId, t.receivedAt),
    index('events_project_received_idx').on(t.projectId, t.receivedAt),
  ],
);

export const breadcrumbs = sqliteTable(
  'breadcrumbs',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    ts: integer('ts').notNull(),
    category: text('category').notNull(),
    level: text('level').notNull(),
    message: text('message').notNull(),
    data: text('data'),
  },
  (t) => [uniqueIndex('breadcrumbs_event_idx_pk').on(t.eventId, t.idx)],
);

export const symbolications = sqliteTable(
  'symbolications',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    frameIdx: integer('frame_idx').notNull(),
    resolved: text('resolved').notNull(),
  },
  (t) => [uniqueIndex('symbolications_event_frame_pk').on(t.eventId, t.frameIdx)],
);

export const sessions = sqliteTable('sessions', {
  jti: text('jti').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
});

// Check-in monitors (dead-man's-switch, §CONTRACT M). A monitor is "ok" while it
// keeps pinging within interval+grace; a 60s sweep flips overdue monitors to
// "missed" (dispatching once); the next ping recovers it. "paused" opts out.
export const monitors = sqliteTable(
  'monitors',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Unique per project; validated against `[a-z0-9-]{1,64}` at the route.
    slug: text('slug').notNull(),
    name: text('name'),
    intervalMinutes: integer('interval_minutes').notNull(),
    graceMinutes: integer('grace_minutes').notNull(),
    status: text('status', { enum: ['ok', 'missed', 'paused'] })
      .notNull()
      .default('ok'),
    lastCheckInAt: integer('last_check_in_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('monitors_project_slug_uniq').on(t.projectId, t.slug)],
);

export const webhookDispatches = sqliteTable(
  'webhook_dispatches',
  {
    id: text('id').primaryKey(),
    // Nullable since v0.5: monitor dispatches (monitor.missed / monitor.recovered)
    // carry no issue/event, only a monitorId. Issue dispatches keep both set.
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    eventId: text('event_id').references(() => events.id, { onDelete: 'cascade' }),
    // Set only for monitor.* dispatches; null for issue.* dispatches.
    monitorId: text('monitor_id').references(() => monitors.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    // Webhook body `type` — 'issue.new' (default, preserves existing rows),
    // 'issue.regressed' for the resolved->regressed transition, the v0.5 monitor
    // lifecycle types, or the v0.8 agent-loop types ('issue.spike' when a spike
    // sweep transitions an issue into spiking, 'fix.verified' when the verify
    // sweep confirms a deployed fix held). The column is plain TEXT in SQLite, so
    // new enum values need no migration beyond this type widening.
    type: text('type', {
      enum: [
        'issue.new',
        'issue.regressed',
        'monitor.missed',
        'monitor.recovered',
        'issue.spike',
        'fix.verified',
      ],
    })
      .notNull()
      .default('issue.new'),
    attempt: integer('attempt').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    lastError: text('last_error'),
    lastResponseCode: integer('last_response_code'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('webhook_dispatches_status_due_idx').on(t.status, t.nextAttemptAt)],
);

// ── Usage analytics (v0.6, CONTRACT U-IN / U-API) ─────────────────────────────
// Privacy is the product: raw IP and raw User-Agent are NEVER persisted here.
// They feed the visitor hash and are discarded. The daily salt rotates the hash
// so a visitor is uncorrelatable across UTC days.

// One crypto-random salt per UTC day, created lazily on first usage event that
// day and pruned (>2 days old) by the retention job. Never appears in any API
// response or log.
export const usageSalts = sqliteTable('usage_salts', {
  // UTC day the salt is valid for, as 'YYYY-MM-DD'.
  date: text('date').primaryKey(),
  // 32 random bytes, hex.
  salt: text('salt').notNull(),
});

export const usageEvents = sqliteTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['pageview', 'event'] }).notNull(),
    // Set for 'event' rows (the event name); null for pageviews.
    name: text('name'),
    // Set for 'pageview' rows (query + fragment stripped); null for events.
    path: text('path'),
    // Referrer DOMAIN only (never the full URL); null for direct / same-origin /
    // unparseable referrers.
    referrerDomain: text('referrer_domain'),
    // 16-char truncated sha256 daily visitor hash — the ONLY identity artifact.
    visitor: text('visitor').notNull(),
    // Small JSON blob (<=10 keys), or null.
    props: text('props'),
    receivedAt: integer('received_at').notNull(),
  },
  (t) => [index('usage_events_project_received_idx').on(t.projectId, t.receivedAt)],
);

// ── Agent loop (v0.8, §23) ────────────────────────────────────────────────────
// An investigation record + fix-verification substrate so the agent fleet stops
// starting each triage from zero. Both tables cascade with their issue.

// Free-text investigation notes an agent (or the server, kind 'system') accretes
// on an issue: root causes, fix plans, verification results, and the audit trail
// of every fix-attempt state transition.
export const issueAnnotations = sqliteTable(
  'issue_annotations',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    // Author label (agent session name / 'agent' default), ≤128 at the route.
    author: text('author').notNull().default('agent'),
    kind: text('kind', {
      enum: ['note', 'root_cause', 'fix_plan', 'verification', 'system'],
    })
      .notNull()
      .default('note'),
    // Body, ≤16KB enforced at the route (413 over).
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  // Listing is newest-first per issue, so index the (issue, created_at) pair.
  (t) => [index('issue_annotations_issue_created_idx').on(t.issueId, t.createdAt)],
);

// A fix attempt tracked from filed -> deployed -> {verified|failed}. UNIQUE per
// (issue, pr_url) so re-recording the same PR upserts. `verified` is system-set
// by the hourly verify sweep; `failed` is set by a PATCH or by the regression
// hook when a post-deploy event proves the fix did not hold.
export const fixAttempts = sqliteTable(
  'fix_attempts',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    // PR URL, ≤512 at the route.
    prUrl: text('pr_url').notNull(),
    // Commit the fix shipped as; same regex/lower-casing as releases.commit_sha.
    commitSha: text('commit_sha'),
    state: text('state', { enum: ['filed', 'deployed', 'verified', 'failed'] })
      .notNull()
      .default('filed'),
    createdAt: integer('created_at').notNull(),
    // Stamped when the attempt is marked 'deployed'; the verify window counts
    // from here.
    deployedAt: integer('deployed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('fix_attempts_issue_pr_uniq').on(t.issueId, t.prUrl),
    // Per-issue newest-first listing.
    index('fix_attempts_issue_created_idx').on(t.issueId, t.createdAt),
    // The verify sweep scans deployed attempts fleet-wide by their deploy time.
    index('fix_attempts_state_deployed_idx').on(t.state, t.deployedAt),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type IssueRow = typeof issues.$inferSelect;
export type IssueInsert = typeof issues.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type BreadcrumbRow = typeof breadcrumbs.$inferSelect;
export type BreadcrumbInsert = typeof breadcrumbs.$inferInsert;
export type ReleaseRow = typeof releases.$inferSelect;
export type SymbolicationRow = typeof symbolications.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type WebhookDispatchRow = typeof webhookDispatches.$inferSelect;
export type WebhookDispatchInsert = typeof webhookDispatches.$inferInsert;
export type MonitorRow = typeof monitors.$inferSelect;
export type MonitorInsert = typeof monitors.$inferInsert;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type UsageEventInsert = typeof usageEvents.$inferInsert;
export type UsageSaltRow = typeof usageSalts.$inferSelect;
export type IssueAnnotationRow = typeof issueAnnotations.$inferSelect;
export type IssueAnnotationInsert = typeof issueAnnotations.$inferInsert;
export type FixAttemptRow = typeof fixAttempts.$inferSelect;
export type FixAttemptInsert = typeof fixAttempts.$inferInsert;
