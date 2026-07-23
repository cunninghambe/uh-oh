// The uh-oh MCP tool registry — the SINGLE source of truth for every tool.
// registerUhOhTools() is written once against the UhOhBackend interface, so the
// exact same tools run over the in-process backend (inside the server's /mcp
// route) and the HTTP backend (the stdio bin talking to a remote server).
//
// Output discipline: every tool returns a compact JSON string (these results
// are read by an LLM). We drop null/undefined, render epoch-ms timestamps as
// ISO 8601, cap lists at their limit param, and emit stack frames as the
// minimal { function, file, line, col, inApp, status }.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  BackendError,
  type Annotation,
  type BreadcrumbRecord,
  type EventRecord,
  type FixAttempt,
  type Issue,
  type ListIssuesInput,
  type Monitor,
  type Project,
  type Release,
  type ResolvedFrame,
  type SimilarIssue,
  type TopIssue,
  type UhOhBackend,
  type UpdateProjectInput,
} from './backend.js';

// ── Envelope parsing (payload is validated at ingest; read it defensively) ────

interface RawFrame {
  function?: string;
  module?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
}

interface ParsedEnvelope {
  sdk?: { name?: string; version?: string };
  timestamp?: string;
  release?: { version?: string; build?: string };
  exception?: { type?: string; value?: string; mechanism?: string; stacktrace?: RawFrame[] };
  user?: unknown;
  context?: Record<string, unknown>;
  tags?: Record<string, string>;
  device?: unknown;
}

const parseEnvelope = (payload: string): ParsedEnvelope => {
  try {
    const value: unknown = JSON.parse(payload);
    return value && typeof value === 'object' ? (value as ParsedEnvelope) : {};
  } catch {
    return {};
  }
};

// ── Formatting helpers ────────────────────────────────────────────────────────

const toIso = (ms: number | null | undefined): string | undefined =>
  ms == null ? undefined : new Date(ms).toISOString();

/** Recursively drop `undefined` (and top-level `null`) so JSON stays compact. */
const clean = <T extends Record<string, unknown>>(obj: T): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
};

const formatProject = (p: Project): Record<string, unknown> =>
  clean({
    id: p.id,
    name: p.name,
    slug: p.slug,
    publicKey: p.publicKey,
    webhookUrl: p.webhookUrl,
    alertDedupeMinutes: p.alertDedupeMinutes,
    createdAt: toIso(p.createdAt),
  });

const formatIssue = (i: Issue): Record<string, unknown> =>
  clean({
    id: i.id,
    projectId: i.projectId,
    fingerprint: i.fingerprint,
    title: i.title,
    status: i.status,
    eventCount: i.eventCount,
    firstSeen: toIso(i.firstSeen),
    lastSeen: toIso(i.lastSeen),
    lastAlertedAt: toIso(i.lastAlertedAt),
  });

const formatRelease = (r: Release): Record<string, unknown> =>
  clean({
    id: r.id,
    projectId: r.projectId,
    version: r.version,
    build: r.build,
    platform: r.platform,
    mappingUploadedAt: toIso(r.mappingUploadedAt),
    sourcemapUploadedAt: toIso(r.sourcemapUploadedAt),
  });

/** Merge raw payload frames (col, inApp) with resolved frames (function, file,
 *  line, status) index-wise into the minimal shape. */
const formatFrames = (
  raw: RawFrame[] | undefined,
  resolved: ResolvedFrame[] | undefined,
): Record<string, unknown>[] => {
  const rawFrames = raw ?? [];
  const count = Math.max(rawFrames.length, resolved?.length ?? 0);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const rf = rawFrames[i];
    const res = resolved?.[i];
    out.push(
      clean({
        function: res?.function ?? rf?.function,
        file: res?.filename ?? res?.module ?? rf?.filename ?? rf?.module,
        line: res?.lineno ?? rf?.lineno,
        col: rf?.colno,
        inApp: rf?.inApp,
        status: res?.status,
      }),
    );
  }
  return out;
};

const formatBreadcrumbs = (
  rows: BreadcrumbRecord[],
  cap = 20,
): { breadcrumbs: Record<string, unknown>[]; breadcrumbsTruncated?: number } => {
  const kept = rows.length > cap ? rows.slice(rows.length - cap) : rows;
  const breadcrumbs = kept.map((b) => {
    let data: unknown;
    if (b.data != null) {
      try {
        data = JSON.parse(b.data);
      } catch {
        data = b.data;
      }
    }
    return clean({
      ts: toIso(b.ts),
      category: b.category,
      level: b.level,
      message: b.message,
      data,
    });
  });
  return rows.length > cap
    ? { breadcrumbs, breadcrumbsTruncated: rows.length - cap }
    : { breadcrumbs };
};

const formatTopIssue = (t: TopIssue): Record<string, unknown> =>
  clean({
    issueId: t.issueId,
    title: t.title,
    status: t.status,
    platform: t.platform,
    projectSlug: t.projectSlug,
    projectName: t.projectName,
    windowEvents: t.windowEvents,
    eventCount: t.eventCount,
    firstSeen: toIso(t.firstSeen),
    lastSeen: toIso(t.lastSeen),
  });

const formatMonitor = (m: Monitor): Record<string, unknown> =>
  clean({
    id: m.id,
    projectSlug: m.projectSlug,
    slug: m.slug,
    name: m.name,
    intervalMinutes: m.intervalMinutes,
    graceMinutes: m.graceMinutes,
    status: m.status,
    overdue: m.overdue,
    lastCheckInAt: toIso(m.lastCheckInAt),
    createdAt: toIso(m.createdAt),
  });

const formatAnnotation = (a: Annotation): Record<string, unknown> =>
  clean({
    id: a.id,
    issueId: a.issueId,
    author: a.author,
    kind: a.kind,
    body: a.body,
    createdAt: toIso(a.createdAt),
  });

const formatFixAttempt = (f: FixAttempt): Record<string, unknown> =>
  clean({
    id: f.id,
    issueId: f.issueId,
    prUrl: f.prUrl,
    commitSha: f.commitSha,
    state: f.state,
    createdAt: toIso(f.createdAt),
    deployedAt: toIso(f.deployedAt),
    updatedAt: toIso(f.updatedAt),
  });

const formatSimilarIssue = (s: SimilarIssue): Record<string, unknown> =>
  clean({
    issue: clean({
      id: s.issue.id,
      projectId: s.issue.projectId,
      projectSlug: s.issue.projectSlug,
      title: s.issue.title,
      status: s.issue.status,
      platform: s.issue.platform,
      lastSeen: toIso(s.issue.lastSeen),
      eventCount: s.issue.eventCount,
    }),
    fixAttempts: s.fixAttempts.map(formatFixAttempt),
    annotationCount: s.annotationCount,
  });

const formatEventSummary = (e: EventRecord): Record<string, unknown> => {
  const env = parseEnvelope(e.payload);
  return clean({
    id: e.id,
    level: e.level,
    platform: e.platform,
    releaseId: e.releaseId,
    receivedAt: toIso(e.receivedAt),
    release: env.release,
    exception: env.exception
      ? clean({
          type: env.exception.type,
          value: env.exception.value,
          mechanism: env.exception.mechanism,
        })
      : undefined,
  });
};

const formatFullEvent = (
  e: EventRecord,
  resolved: ResolvedFrame[] | undefined,
): Record<string, unknown> => {
  const env = parseEnvelope(e.payload);
  let device: unknown = env.device;
  if (device === undefined) {
    try {
      device = JSON.parse(e.deviceInfo);
    } catch {
      device = undefined;
    }
  }
  return clean({
    id: e.id,
    issueId: e.issueId,
    releaseId: e.releaseId,
    level: e.level,
    platform: e.platform,
    receivedAt: toIso(e.receivedAt),
    sdk: env.sdk,
    timestamp: env.timestamp,
    release: env.release,
    exception: env.exception
      ? clean({
          type: env.exception.type,
          value: env.exception.value,
          mechanism: env.exception.mechanism,
          frames: formatFrames(env.exception.stacktrace, resolved),
        })
      : undefined,
    user: env.user,
    context: env.context,
    tags: env.tags,
    device,
  });
};

// ── Result helpers ────────────────────────────────────────────────────────────

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const fail = (err: unknown): CallToolResult => {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof BackendError ? err.code : 'error';
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
};

/** Run a handler, converting any thrown BackendError (or other error) into an
 *  `isError` tool result instead of letting it propagate. */
const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
};

/** Resolve a project reference (id or slug) to a concrete project id via the
 *  projects list — shared by list_issues and list_releases. */
const resolveProjectId = async (backend: UhOhBackend, ref: string): Promise<string> => {
  const projects = await backend.listProjects();
  const match = projects.find((p) => p.id === ref) ?? projects.find((p) => p.slug === ref);
  if (!match) {
    throw new BackendError(`no project matching '${ref}'`, {
      code: 'project_not_found',
      status: 404,
    });
  }
  return match.id;
};

// ── Shared annotation presets ─────────────────────────────────────────────────

const READ = { readOnlyHint: true, destructiveHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

// ── Scope model (v0.7 §22, generalized in v0.8 §23) ───────────────────────────

/** How a caller is authorized to use the registry. The read token yields
 *  `readonly`; the agent token yields `agent`; the JWT-authenticated HTTP path
 *  and the stdio backend are `full`. */
export type ToolScope = 'full' | 'agent' | 'readonly';

/**
 * Per-tool minimum scope required to invoke it — the SINGLE source of truth for
 * the scope gate. `read` tools run under any request scope; `agent` tools
 * require at least the agent token; `admin` tools require the JWT (stdio is
 * always `full`). The gate reads THIS table (data), never the tool name, and
 * each flag is asserted per tool in the tests. `read` is what v0.7 called
 * `readonly: true`.
 */
export type RequiredScope = 'read' | 'agent' | 'admin';

export const TOOL_SCOPE: Record<string, RequiredScope> = {
  list_projects: 'read',
  create_project: 'admin',
  update_project: 'admin',
  list_issues: 'read',
  get_issue: 'read',
  list_issue_events: 'read',
  get_event: 'read',
  // v0.8 §23: reclassified from admin to agent — the agent loop needs to move
  // an issue through open/resolved/ignored without a JWT.
  set_issue_status: 'agent',
  list_releases: 'read',
  get_server_health: 'read',
  get_issue_bundle: 'read',
  list_top_issues: 'read',
  list_monitors: 'read',
  get_usage_summary: 'read',
  list_similar_issues: 'read',
  annotate_issue: 'agent',
  record_fix_attempt: 'agent',
};

/**
 * The tool error a request scope narrower than a tool's requirement returns.
 * `requestingScope` names which token was too narrow — `readonly` (the v0.7
 * read token) is the default, matching the original §22 message shape exactly;
 * `agent` (the v0.8 agent token) names itself analogously.
 */
export const scopeError = (
  tool: string,
  requestingScope: 'readonly' | 'agent' = 'readonly',
): CallToolResult => {
  const label = requestingScope === 'readonly' ? 'read token' : 'agent token';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: requestingScope === 'readonly' ? 'read_scope' : 'agent_scope',
          message: `${label} cannot ${tool}; use the JWT-authenticated dashboard or stdio backend`,
        }),
      },
    ],
    isError: true,
  };
};

// User-settable statuses (set_issue_status). 'regressed' is system-set.
const STATUS = z.enum(['open', 'resolved', 'ignored']);
// list_issues filter — additionally accepts the system-set 'regressed'.
const FILTER_STATUS = z.enum(['open', 'resolved', 'ignored', 'regressed']);
const SORT = z.enum(['lastSeen', 'eventCount', 'firstSeen']);

// annotate_issue (§23). 'system' is server-written only (the fix-attempt audit
// trail), so it is intentionally absent — passing it is a schema-level
// "Invalid arguments" tool error, never reaching the backend. Caps mirror the
// server's MAX_ANNOTATION_BODY / MAX_ANNOTATION_AUTHOR.
const CLIENT_ANNOTATION_KIND = z.enum(['note', 'root_cause', 'fix_plan', 'verification']);
const ANNOTATION_BODY_MAX = 16 * 1024;
const ANNOTATION_AUTHOR_MAX = 128;

// record_fix_attempt (§23). 'filed' is the implicit creation state (never a
// transition target) and 'verified' is system-set only, so neither is a valid
// input — both are schema-level "Invalid arguments" tool errors. Cap and regex
// mirror the server's MAX_PR_URL / COMMIT_SHA_RE (releases.commit_sha).
const CLIENT_FIX_TRANSITION = z.enum(['deployed', 'failed']);
const PR_URL_MAX = 512;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Register every uh-oh tool on `server`, backed by `backend`. This is the only
 * place tools are defined; both transports call it. Under a `readonly` scope
 * (the read token) only `read` tools run; under an `agent` scope (the agent
 * token) `read` and `agent` tools run; a request scope narrower than a tool's
 * required scope returns the scope error instead of touching the backend.
 */
export const registerUhOhTools = (
  server: McpServer,
  backend: UhOhBackend,
  opts: { scope?: ToolScope } = {},
): void => {
  const scope = opts.scope ?? 'full';

  // A tool invoked under a request scope narrower than its TOOL_SCOPE
  // requirement returns the scope error and does NOT reach the backend. `full`
  // always runs everything; `agent` additionally runs `agent` tools; `readonly`
  // runs only `read` tools. The allow/deny decision reads the TOOL_SCOPE table
  // (data), never the tool name. Only `agent`/`admin` tools are wrapped: a
  // `read` tool is allowed under every request scope, so wrapping it would be a
  // no-op passthrough (TOOL_SCOPE stays exhaustive either way; tests assert it).
  const guard = (name: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    if (scope === 'full') return fn();
    const required = TOOL_SCOPE[name] ?? 'admin';
    const allowed = required === 'read' || (scope === 'agent' && required === 'agent');
    return allowed ? fn() : Promise.resolve(scopeError(name, scope));
  };

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List all uh-oh projects with their public key, webhook URL and dedupe window.',
      annotations: READ,
    },
    () => run(async () => ok({ projects: (await backend.listProjects()).map(formatProject) })),
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description:
        'Create a new project. Returns the project with its generated slug and public key.',
      inputSchema: { name: z.string().min(1).max(128) },
      annotations: WRITE,
    },
    (args) =>
      guard('create_project', () =>
        run(async () =>
          ok({ project: formatProject(await backend.createProject({ name: args.name })) }),
        ),
      ),
  );

  server.registerTool(
    'update_project',
    {
      title: 'Update project',
      description:
        'Update a project name, webhook URL (SSRF-validated by the server; a rejected URL is returned as a tool error) or alert dedupe minutes. Pass webhookUrl null to clear it.',
      inputSchema: {
        projectId: z.string().min(1),
        name: z.string().min(1).max(128).optional(),
        webhookUrl: z.string().max(1024).nullable().optional(),
        alertDedupeMinutes: z.number().int().min(0).optional(),
      },
      annotations: WRITE,
    },
    (args) =>
      guard('update_project', () =>
        run(async () => {
          const input: UpdateProjectInput = {
            projectId: args.projectId,
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.webhookUrl !== undefined ? { webhookUrl: args.webhookUrl } : {}),
            ...(args.alertDedupeMinutes !== undefined
              ? { alertDedupeMinutes: args.alertDedupeMinutes }
              : {}),
          };
          return ok({ project: formatProject(await backend.updateProject(input)) });
        }),
      ),
  );

  server.registerTool(
    'list_issues',
    {
      title: 'List issues',
      description:
        'List issues for a project (by id or slug), optionally filtered by status (open, resolved, ignored, or the system-set regressed) and sorted. Returns issues plus the total count.',
      inputSchema: {
        project: z.string().min(1),
        status: FILTER_STATUS.optional(),
        sort: SORT.optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const projectId = await resolveProjectId(backend, args.project);
        const input: ListIssuesInput = {
          projectId,
          limit: args.limit,
          offset: args.offset,
          ...(args.status ? { status: args.status } : {}),
          ...(args.sort ? { sort: args.sort } : {}),
        };
        const { issues, total } = await backend.listIssues(input);
        return ok({ issues: issues.map(formatIssue), total });
      }),
  );

  server.registerTool(
    'get_issue',
    {
      title: 'Get issue',
      description:
        'Get an issue with a summary of its latest event, symbolicated stack frames when available, and its recent breadcrumbs (last 20).',
      inputSchema: { issueId: z.string().min(1) },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const detail = await backend.getIssue({ issueId: args.issueId });
        if (!detail) throw new BackendError('issue not found', { code: 'not_found', status: 404 });
        const env = detail.latestEvent ? parseEnvelope(detail.latestEvent.payload) : {};
        return ok({
          issue: formatIssue(detail.issue),
          latestEvent: detail.latestEvent ? formatEventSummary(detail.latestEvent) : null,
          ...(detail.latestEvent
            ? { frames: formatFrames(env.exception?.stacktrace, detail.frames) }
            : {}),
          ...formatBreadcrumbs(detail.breadcrumbs),
        });
      }),
  );

  server.registerTool(
    'list_issue_events',
    {
      title: 'List issue events',
      description: 'List the individual events grouped under an issue, newest first, paginated.',
      inputSchema: {
        issueId: z.string().min(1),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(10),
      },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const { events, total } = await backend.listIssueEvents({
          issueId: args.issueId,
          page: args.page,
          limit: args.limit,
        });
        return ok({ events: events.map(formatEventSummary), total });
      }),
  );

  server.registerTool(
    'get_event',
    {
      title: 'Get event',
      description:
        'Get a single event as a cleaned-up envelope (noise dropped) with resolved stack frames. Set symbolicate false to skip symbolication.',
      inputSchema: {
        eventId: z.string().min(1),
        symbolicate: z.boolean().default(true),
      },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const detail = await backend.getEvent({
          eventId: args.eventId,
          symbolicate: args.symbolicate,
        });
        if (!detail) throw new BackendError('event not found', { code: 'not_found', status: 404 });
        return ok({
          event: formatFullEvent(detail.event, detail.frames),
          ...formatBreadcrumbs(detail.breadcrumbs),
        });
      }),
  );

  server.registerTool(
    'set_issue_status',
    {
      title: 'Set issue status',
      description:
        "Set an issue status to open, resolved or ignored. The 'regressed' status is system-set (a resolved issue that received a new event) and cannot be set here; PATCH a regressed issue to resolved to re-arm regression detection.",
      inputSchema: { issueId: z.string().min(1), status: STATUS },
      annotations: WRITE,
    },
    (args) =>
      guard('set_issue_status', () =>
        run(async () => {
          const updated = await backend.setIssueStatus({
            issueId: args.issueId,
            status: args.status,
          });
          if (!updated)
            throw new BackendError('issue not found', { code: 'not_found', status: 404 });
          return ok({ issue: formatIssue(updated) });
        }),
      ),
  );

  server.registerTool(
    'list_releases',
    {
      title: 'List releases',
      description:
        'List releases for a project (by id or slug), including whether ProGuard mapping and Hermes source map symbols have been uploaded.',
      inputSchema: { project: z.string().min(1) },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const projectId = await resolveProjectId(backend, args.project);
        return ok({ releases: (await backend.listReleases({ projectId })).map(formatRelease) });
      }),
  );

  server.registerTool(
    'get_server_health',
    {
      title: 'Get server health',
      description:
        'Report server health (/healthz) plus a parsed subset of /metrics: total events ingested, new issues, and permanent webhook failures.',
      annotations: READ,
    },
    () =>
      run(async () => {
        const h = await backend.getHealth();
        return ok(
          clean({
            ok: h.ok,
            metricsAvailable: h.metricsAvailable,
            eventsIngested: h.metricsAvailable ? h.eventsIngested : undefined,
            issuesNew: h.metricsAvailable ? h.issuesNew : undefined,
            webhookFailures: h.metricsAvailable ? h.webhookFailures : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    'get_issue_bundle',
    {
      title: 'Get issue bundle',
      description:
        'Fetch the complete fix-dossier for an issue in ONE call: project, issue, impact roll-up, the latest event fully symbolicated with source context and breadcrumbs, recent events, and symbol availability. Deterministic and size-bounded (~64KB); the `truncated` field flags any dropped context/breadcrumbs. Timestamps are epoch milliseconds.',
      inputSchema: { issueId: z.string().min(1) },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const bundle = await backend.getIssueBundle({ issueId: args.issueId });
        if (!bundle) throw new BackendError('issue not found', { code: 'not_found', status: 404 });
        return ok(bundle);
      }),
  );

  server.registerTool(
    'list_top_issues',
    {
      title: 'List top issues',
      description:
        'List open and regressed issues across ALL projects, ranked by event volume within the last N days. Each carries its project slug, platform, and windowed + all-time counts.',
      inputSchema: {
        limit: z.number().int().min(1).max(25).default(10),
        days: z.number().int().min(1).max(30).default(14),
      },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const issues = await backend.listTopIssues({ limit: args.limit, days: args.days });
        return ok({ issues: issues.map(formatTopIssue) });
      }),
  );

  server.registerTool(
    'list_monitors',
    {
      title: 'List monitors',
      description:
        'List check-in monitors, optionally scoped to one project (by id or slug). Each includes its cadence, status (ok, missed, or paused), last check-in, and a computed overdue flag.',
      inputSchema: { project: z.string().min(1).optional() },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const input =
          args.project !== undefined
            ? { projectId: await resolveProjectId(backend, args.project) }
            : {};
        const monitors = await backend.listMonitors(input);
        return ok({ monitors: monitors.map(formatMonitor) });
      }),
  );

  server.registerTool(
    'get_usage_summary',
    {
      title: 'Get usage summary',
      description:
        'Privacy-first usage analytics for a project (by id or slug) over the last N days (default 30, clamped 1..90): per-day pageviews/visitors/events (ascending, zero-filled), top pages, top referrer domains (direct excluded), top custom events, and window totals. Visitor counts use a daily-rotating hash, so repeat visitors across days are intentionally over-counted (the privacy trade); no raw IP or User-Agent is ever exposed.',
      inputSchema: {
        project: z.string().min(1),
        days: z.number().int().min(1).max(90).default(30),
      },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const projectId = await resolveProjectId(backend, args.project);
        return ok(await backend.getUsageSummary({ projectId, days: args.days }));
      }),
  );

  // ── v0.8 agent-loop tools (§23) ──────────────────────────────────────────

  server.registerTool(
    'list_similar_issues',
    {
      title: 'List similar issues',
      description:
        "Find fleet-wide issues that share this issue's exception-type prefix (the title text before the first ':', or the whole title when it has none), ranked by has-verified-fix, then annotation count, then recency. Each entry carries the candidate issue plus its fix attempts and annotation count — \"have we seen this before, and what fixed it\" in one call. Capped at 10.",
      inputSchema: { issueId: z.string().min(1) },
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const similar = await backend.listSimilarIssues({ issueId: args.issueId });
        if (similar === null)
          throw new BackendError('issue not found', { code: 'not_found', status: 404 });
        return ok({ similar: similar.map(formatSimilarIssue) });
      }),
  );

  server.registerTool(
    'annotate_issue',
    {
      title: 'Annotate issue',
      description:
        "Add an investigation note to an issue — a free-text 'note', 'root_cause', 'fix_plan', or 'verification' record — so the next investigation of the same crash does not start from zero. Body capped at 16KB (413 over); author defaults to 'agent'. The 'system' kind is written by the server only (the fix-attempt audit trail) and cannot be set here.",
      inputSchema: {
        issueId: z.string().min(1),
        body: z.string().min(1).max(ANNOTATION_BODY_MAX),
        kind: CLIENT_ANNOTATION_KIND.optional(),
        author: z.string().min(1).max(ANNOTATION_AUTHOR_MAX).optional(),
      },
      annotations: WRITE,
    },
    (args) =>
      guard('annotate_issue', () =>
        run(async () => {
          const annotation = await backend.createAnnotation({
            issueId: args.issueId,
            body: args.body,
            ...(args.kind !== undefined ? { kind: args.kind } : {}),
            ...(args.author !== undefined ? { author: args.author } : {}),
          });
          return ok({ annotation: formatAnnotation(annotation) });
        }),
      ),
  );

  server.registerTool(
    'record_fix_attempt',
    {
      title: 'Record fix attempt',
      description:
        "Record or update a fix attempt for an issue by its PR URL: upserts by (issue, prUrl) into state 'filed' (a re-record with a different commitSha updates it), then — when state is given and differs from the attempt's current state — transitions it. Allowed transitions: filed->deployed, filed->failed, deployed->failed; anything else (including 'verified', which is system-set by the hourly verify sweep) is rejected. Marking 'deployed' resolves an open/regressed issue, re-arming regression detection. Returns the final fix attempt.",
      inputSchema: {
        issueId: z.string().min(1),
        prUrl: z.string().min(1).max(PR_URL_MAX),
        commitSha: z.string().regex(COMMIT_SHA_RE).optional(),
        state: CLIENT_FIX_TRANSITION.optional(),
      },
      annotations: WRITE,
    },
    (args) =>
      guard('record_fix_attempt', () =>
        run(async () => {
          let attempt = await backend.upsertFixAttempt({
            issueId: args.issueId,
            prUrl: args.prUrl,
            ...(args.commitSha !== undefined ? { commitSha: args.commitSha.toLowerCase() } : {}),
          });
          if (args.state !== undefined && args.state !== attempt.state) {
            attempt = await backend.transitionFixAttempt({
              fixAttemptId: attempt.id,
              state: args.state,
            });
          }
          return ok({ fixAttempt: formatFixAttempt(attempt) });
        }),
      ),
  );

  // Prompt: instruct an agent to pull the bundle and produce a fix. Kept short
  // and imperative — the heavy lifting is the deterministic bundle behind it.
  server.registerPrompt(
    'fix_crash',
    {
      title: 'Fix a crash',
      description:
        'Diagnose and fix a specific uh-oh issue by pulling its bundle and patching the offending code.',
      argsSchema: { issueId: z.string().min(1) },
    },
    ({ issueId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Fix uh-oh issue ${issueId}. First call get_issue_bundle with issueId "${issueId}". Read the symbolicated stack frames, their source context, the breadcrumbs, and the impact to pinpoint the root cause. Then find the offending code in this repository and apply the smallest correct fix. Report the root cause, the exact frame(s) it maps to, and the change you made.`,
          },
        },
      ],
    }),
  );
};

/** Convenience: a fully-wired McpServer with every uh-oh tool registered. Pass
 *  `{ scope: 'readonly' }` (the read token on `POST /mcp`) to gate the mutating
 *  tools behind the scope error. */
export const createUhOhMcpServer = (
  backend: UhOhBackend,
  opts: { scope?: ToolScope } = {},
): McpServer => {
  const server = new McpServer({ name: 'uh-oh', version: '0.1.0' });
  registerUhOhTools(server, backend, opts);
  return server;
};
