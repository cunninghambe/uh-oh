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
    // 'issue.regressed' for the resolved->regressed transition, or the v0.5
    // monitor lifecycle types.
    type: text('type', {
      enum: ['issue.new', 'issue.regressed', 'monitor.missed', 'monitor.recovered'],
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
