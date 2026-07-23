import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BackendError,
  type Annotation,
  type BreadcrumbRecord,
  type ClientAnnotationKind,
  type ClientFixAttemptTransition,
  type EventRecord,
  type FixAttempt,
  type FixAttemptState,
  type HealthReport,
  type Issue,
  type IssueBundle,
  type IssueDetail,
  type IssueStatus,
  type ListIssuesInput,
  type ListMonitorsInput,
  type ListTopIssuesInput,
  type Monitor,
  type Project,
  type Release,
  type ResolvedFrame,
  type SimilarIssue,
  type TopIssue,
  type UhOhBackend,
  type UpdateProjectInput,
  type UsageSummary,
} from './backend.js';
import {
  createUhOhMcpServer,
  TOOL_SCOPE,
  scopeError,
  type RequiredScope,
  type ToolScope,
} from './tools.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT: Project = {
  id: 'p1',
  name: 'My App',
  slug: 'my-app',
  publicKey: 'pk_1',
  webhookUrl: null,
  alertDedupeMinutes: 30,
  createdAt: 1_700_000_000_000,
};

const ENVELOPE = {
  sdk: { name: '@uh-oh/react-native', version: '0.1.0' },
  timestamp: '2026-07-01T00:00:00.000Z',
  platform: 'android',
  release: { version: '1.2.3', build: '45' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'boom',
    mechanism: 'js-global',
    stacktrace: [
      {
        function: 'render',
        module: 'a.b.C',
        filename: 'index.android.bundle',
        lineno: 5,
        colno: 12,
        inApp: true,
      },
      { function: 'run', filename: 'foo.js', lineno: 2, colno: 3, inApp: false },
    ],
  },
  breadcrumbs: [],
  device: { osName: 'Android', osVersion: '14' },
  context: { environment: 'production', eventId: 'e1' },
  tags: { area: 'checkout' },
};

const EVENT: EventRecord = {
  id: 'e1',
  projectId: 'p1',
  issueId: 'i1',
  releaseId: 'r1',
  fingerprint: 'fp',
  level: 'error',
  platform: 'android',
  payload: JSON.stringify(ENVELOPE),
  receivedAt: 1_700_000_100_000,
  deviceInfo: JSON.stringify(ENVELOPE.device),
  userInfo: null,
};

const RESOLVED: ResolvedFrame[] = [
  { function: 'render', filename: 'src/App.tsx', lineno: 42, status: 'ok' },
  { function: 'run', filename: 'src/run.ts', lineno: 7, status: 'ok' },
];

const ISSUE: Issue = {
  id: 'i1',
  projectId: 'p1',
  fingerprint: 'fp',
  title: 'TypeError: boom',
  firstSeen: 1_700_000_050_000,
  lastSeen: 1_700_000_100_000,
  eventCount: 3,
  status: 'open',
  lastAlertedAt: null,
};

const RELEASE: Release = {
  id: 'r1',
  projectId: 'p1',
  version: '1.2.3',
  build: '45',
  platform: 'android',
  mappingUploadedAt: 1_700_000_000_000,
  sourcemapUploadedAt: null,
};

const BREADCRUMBS: BreadcrumbRecord[] = Array.from({ length: 25 }, (_, i) => ({
  eventId: 'e1',
  idx: i,
  ts: 1_700_000_000_000 + i * 1000,
  category: 'nav',
  level: 'info',
  message: `step ${i}`,
  data: i === 24 ? JSON.stringify({ to: 'checkout' }) : null,
}));

const ANNOTATION: Annotation = {
  id: 'an1',
  issueId: 'i1',
  author: 'agent',
  kind: 'note',
  body: 'looked into it, seems to be a null deref',
  createdAt: 1_700_000_150_000,
};

const FIX_ATTEMPT: FixAttempt = {
  id: 'fa1',
  issueId: 'i1',
  prUrl: 'https://github.com/org/repo/pull/1',
  commitSha: null,
  state: 'filed',
  createdAt: 1_700_000_160_000,
  deployedAt: null,
  updatedAt: 1_700_000_160_000,
};

const SIMILAR_ISSUE: SimilarIssue = {
  issue: {
    id: 'i2',
    projectId: 'p1',
    projectSlug: 'my-app',
    title: 'TypeError: boom',
    status: 'resolved',
    platform: 'android',
    lastSeen: 1_700_000_140_000,
    eventCount: 9,
  },
  fixAttempts: [{ ...FIX_ATTEMPT, id: 'fa2', state: 'verified' }],
  annotationCount: 4,
};

const BUNDLE: IssueBundle = {
  project: { id: 'p1', name: 'My App', slug: 'my-app', repoUrl: null },
  issue: {
    id: 'i1',
    title: 'TypeError: boom',
    fingerprint: 'fp',
    platform: 'android',
    status: 'open',
    firstSeen: 1_700_000_050_000,
    lastSeen: 1_700_000_100_000,
    eventCount: 3,
  },
  impact: {
    distinctUsers: 2,
    topDevices: [{ model: 'Pixel', events: 3 }],
    topOs: [{ os: 'Android 14', events: 3 }],
    releases: [{ release: '1.2.3+45', events: 3 }],
    platforms: [{ platform: 'android', events: 3 }],
  },
  latestEvent: {
    id: 'e1',
    receivedAt: 1_700_000_100_000,
    level: 'error',
    platform: 'android',
    release: '1.2.3+45',
    exception: { type: 'TypeError', value: 'boom', mechanism: 'js-global' },
    frames: [
      {
        function: 'render',
        filename: 'src/App.tsx',
        lineno: 42,
        status: 'ok',
        context: { pre: ['const x = 1;'], line: 'render();', post: ['return x;'] },
      },
    ],
    breadcrumbs: [{ ts: 1_700_000_099_000, category: 'nav', level: 'info', message: 'home' }],
  },
  recentEvents: [
    {
      id: 'e1',
      receivedAt: 1_700_000_100_000,
      level: 'error',
      platform: 'android',
      release: '1.2.3+45',
    },
  ],
  symbols: {
    releaseId: 'r1',
    platform: 'android',
    mappingUploaded: true,
    sourcemapUploaded: false,
    maps: { web: 0, node: 0 },
  },
  annotations: [],
  fixAttempts: [],
  truncated: { context: false, breadcrumbs: false, annotations: false },
};

const TOP_ISSUE: TopIssue = {
  issueId: 'i1',
  title: 'TypeError: boom',
  status: 'open',
  platform: 'android',
  projectId: 'p1',
  projectSlug: 'my-app',
  projectName: 'My App',
  windowEvents: 5,
  eventCount: 12,
  firstSeen: 1_700_000_050_000,
  lastSeen: 1_700_000_100_000,
};

const MONITOR: Monitor = {
  id: 'm1',
  projectId: 'p1',
  projectSlug: 'my-app',
  slug: 'nightly',
  name: 'Nightly',
  intervalMinutes: 60,
  graceMinutes: 15,
  status: 'ok',
  lastCheckInAt: 1_700_000_000_000,
  createdAt: 1_699_000_000_000,
  overdue: false,
};

// ── Fake backend ──────────────────────────────────────────────────────────────

const SSRF_URL = 'http://169.254.169.254/';

// Mirrors the server's ALLOWED_CLIENT_TRANSITIONS (db/repos/fix-attempts.ts).
const ALLOWED_FIX_TRANSITIONS: Record<FixAttemptState, readonly FixAttemptState[]> = {
  filed: ['deployed', 'failed'],
  deployed: ['failed'],
  verified: [],
  failed: [],
};

class FakeBackend implements UhOhBackend {
  projects: Project[] = [{ ...PROJECT }];
  // Widened to the surfaced Issue status so tests can exercise 'regressed'
  // (system-set) flowing through list_issues / get_issue.
  issueStatus: Issue['status'] = 'open';
  // Tracks the one seeded fix attempt (fa1) across upsert/transition calls.
  fixState: FixAttemptState = 'filed';
  calls: Array<{ method: string; input?: unknown }> = [];

  private rec(method: string, input?: unknown): void {
    this.calls.push({ method, input });
  }

  last(method: string): unknown {
    const hit = [...this.calls].reverse().find((c) => c.method === method);
    return hit?.input;
  }

  listProjects(): Promise<Project[]> {
    this.rec('listProjects');
    return Promise.resolve(this.projects.map((p) => ({ ...p })));
  }

  createProject(input: { name: string }): Promise<Project> {
    this.rec('createProject', input);
    const p: Project = {
      id: 'p2',
      name: input.name,
      slug: input.name.toLowerCase().replace(/\s+/g, '-'),
      publicKey: 'pk_2',
      webhookUrl: null,
      alertDedupeMinutes: 30,
      createdAt: 1_700_000_200_000,
    };
    this.projects.push(p);
    return Promise.resolve({ ...p });
  }

  updateProject(input: UpdateProjectInput): Promise<Project> {
    this.rec('updateProject', input);
    if (input.webhookUrl === SSRF_URL) {
      throw new BackendError('webhook URL rejected', { code: 'invalid_webhookUrl', status: 400 });
    }
    const base = this.projects[0] as Project;
    return Promise.resolve({
      ...base,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
      ...(input.alertDedupeMinutes !== undefined
        ? { alertDedupeMinutes: input.alertDedupeMinutes }
        : {}),
    });
  }

  listIssues(input: ListIssuesInput): Promise<{ issues: Issue[]; total: number }> {
    this.rec('listIssues', input);
    return Promise.resolve({ issues: [{ ...ISSUE, status: this.issueStatus }], total: 1 });
  }

  getIssue(input: { issueId: string }): Promise<IssueDetail | null> {
    this.rec('getIssue', input);
    if (input.issueId !== 'i1') return Promise.resolve(null);
    return Promise.resolve({
      issue: { ...ISSUE, status: this.issueStatus },
      latestEvent: { ...EVENT },
      frames: RESOLVED,
      breadcrumbs: BREADCRUMBS,
    });
  }

  listIssueEvents(input: {
    issueId: string;
    page: number;
    limit: number;
  }): Promise<{ events: EventRecord[]; total: number }> {
    this.rec('listIssueEvents', input);
    return Promise.resolve({ events: [{ ...EVENT }], total: 1 });
  }

  getEvent(input: { eventId: string; symbolicate: boolean }): Promise<{
    event: EventRecord;
    breadcrumbs: BreadcrumbRecord[];
    frames?: ResolvedFrame[];
  } | null> {
    this.rec('getEvent', input);
    if (input.eventId !== 'e1') return Promise.resolve(null);
    return Promise.resolve({
      event: { ...EVENT },
      breadcrumbs: BREADCRUMBS.slice(0, 3),
      ...(input.symbolicate ? { frames: RESOLVED } : {}),
    });
  }

  setIssueStatus(input: { issueId: string; status: IssueStatus }): Promise<Issue | null> {
    this.rec('setIssueStatus', input);
    if (input.issueId !== 'i1') return Promise.resolve(null);
    this.issueStatus = input.status;
    return Promise.resolve({ ...ISSUE, status: input.status });
  }

  listReleases(input: { projectId: string }): Promise<Release[]> {
    this.rec('listReleases', input);
    return Promise.resolve([{ ...RELEASE }]);
  }

  getHealth(): Promise<HealthReport> {
    this.rec('getHealth');
    return Promise.resolve({
      ok: true,
      metricsAvailable: true,
      eventsIngested: 12,
      issuesNew: 3,
      webhookFailures: 1,
    });
  }

  getIssueBundle(input: { issueId: string }): Promise<IssueBundle | null> {
    this.rec('getIssueBundle', input);
    return Promise.resolve(input.issueId === 'i1' ? { ...BUNDLE } : null);
  }

  listTopIssues(input: ListTopIssuesInput): Promise<TopIssue[]> {
    this.rec('listTopIssues', input);
    return Promise.resolve([{ ...TOP_ISSUE }]);
  }

  listMonitors(input: ListMonitorsInput): Promise<Monitor[]> {
    this.rec('listMonitors', input);
    return Promise.resolve([{ ...MONITOR }]);
  }

  getUsageSummary(input: { projectId: string; days: number }): Promise<UsageSummary> {
    this.rec('getUsageSummary', input);
    return Promise.resolve({
      days: [{ date: '2026-07-18', pageviews: 3, visitors: 2, events: 1 }],
      topPages: [{ path: '/home', pageviews: 3, visitors: 2 }],
      topReferrers: [{ referrer: 'google.com', pageviews: 2 }],
      topEvents: [{ name: 'signup', count: 1 }],
      totals: { pageviews: 3, visitors: 2, events: 1 },
    });
  }

  listSimilarIssues(input: { issueId: string }): Promise<SimilarIssue[] | null> {
    this.rec('listSimilarIssues', input);
    if (input.issueId !== 'i1') return Promise.resolve(null);
    return Promise.resolve([{ ...SIMILAR_ISSUE }]);
  }

  createAnnotation(input: {
    issueId: string;
    body: string;
    kind?: ClientAnnotationKind;
    author?: string;
  }): Promise<Annotation> {
    this.rec('createAnnotation', input);
    if (input.issueId !== 'i1') {
      throw new BackendError('issue not found', { code: 'not_found', status: 404 });
    }
    return Promise.resolve({
      ...ANNOTATION,
      body: input.body,
      kind: input.kind ?? 'note',
      author: input.author && input.author.length > 0 ? input.author : 'agent',
    });
  }

  upsertFixAttempt(input: {
    issueId: string;
    prUrl: string;
    commitSha?: string;
  }): Promise<FixAttempt> {
    this.rec('upsertFixAttempt', input);
    if (input.issueId !== 'i1') {
      throw new BackendError('issue not found', { code: 'not_found', status: 404 });
    }
    return Promise.resolve({
      ...FIX_ATTEMPT,
      prUrl: input.prUrl,
      commitSha: input.commitSha ?? FIX_ATTEMPT.commitSha,
      state: this.fixState,
    });
  }

  transitionFixAttempt(input: {
    fixAttemptId: string;
    state: ClientFixAttemptTransition;
  }): Promise<FixAttempt> {
    this.rec('transitionFixAttempt', input);
    if (input.fixAttemptId !== 'fa1') {
      throw new BackendError('fix attempt not found', { code: 'not_found', status: 404 });
    }
    if (!ALLOWED_FIX_TRANSITIONS[this.fixState].includes(input.state)) {
      throw new BackendError(`invalid transition ${this.fixState} -> ${input.state}`, {
        code: 'invalid_transition',
        status: 400,
      });
    }
    this.fixState = input.state;
    return Promise.resolve({ ...FIX_ATTEMPT, state: this.fixState });
  }
}

// ── Harness ───────────────────────────────────────────────────────────────────

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

const makeClient = async (
  backend: UhOhBackend,
  opts: { scope?: ToolScope } = {},
): Promise<Client> => {
  const server = createUhOhMcpServer(backend, opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> => {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? '';
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { isError: res.isError === true, data, text };
};

let backend: FakeBackend;
let client: Client;

beforeEach(async () => {
  backend = new FakeBackend();
  client = await makeClient(backend);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

const ALL_TOOL_NAMES = [
  'create_project',
  'get_event',
  'get_issue',
  'get_issue_bundle',
  'get_server_health',
  'get_usage_summary',
  'list_issue_events',
  'list_issues',
  'list_monitors',
  'list_projects',
  'list_releases',
  'list_similar_issues',
  'list_top_issues',
  'set_issue_status',
  'update_project',
  'annotate_issue',
  'record_fix_attempt',
].sort();

describe('tool registry', () => {
  it('registers all seventeen tools exactly once', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(ALL_TOOL_NAMES);
    // No accidental duplicate registrations.
    expect(new Set(names).size).toBe(names.length);
  });

  it('annotates reads readOnly and writes non-readOnly, all non-destructive', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    const writes = new Set([
      'create_project',
      'update_project',
      'set_issue_status',
      'annotate_issue',
      'record_fix_attempt',
    ]);
    for (const [name, ann] of byName) {
      expect(ann?.destructiveHint, `${name} destructiveHint`).toBe(false);
      expect(ann?.readOnlyHint, `${name} readOnlyHint`).toBe(!writes.has(name));
    }
  });
});

describe('scope model (v0.7 §22, generalized in v0.8 §23)', () => {
  // The per-tool TOOL_SCOPE table is the data source for the scope gate. It
  // must exactly match the readOnlyHint annotation (for 'read' tools) and cover
  // every registered tool exactly once.
  const EXPECTED_SCOPE: Record<string, RequiredScope> = {
    list_projects: 'read',
    create_project: 'admin',
    update_project: 'admin',
    list_issues: 'read',
    get_issue: 'read',
    list_issue_events: 'read',
    get_event: 'read',
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

  it('flags each tool with its expected scope (and every registered tool once)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    // The TOOL_SCOPE table covers exactly the registered tools.
    expect(Object.keys(TOOL_SCOPE).sort()).toEqual(names);
    for (const name of names) {
      expect(TOOL_SCOPE[name], `${name} scope`).toBe(EXPECTED_SCOPE[name]);
    }
  });

  it("a 'read' scope tool's readOnlyHint is true; every other tool's is false", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, `${t.name}`).toBe(TOOL_SCOPE[t.name] === 'read');
    }
  });

  it('scopeError defaults to the read-token shape (§22, unchanged)', () => {
    const res = scopeError('set_issue_status');
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]?.text ?? '{}') as { error: string; message: string };
    expect(parsed.error).toBe('read_scope');
    expect(parsed.message).toBe(
      'read token cannot set_issue_status; use the JWT-authenticated dashboard or stdio backend',
    );
  });

  it("scopeError('agent') names the agent token analogously", () => {
    const res = scopeError('create_project', 'agent');
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]?.text ?? '{}') as { error: string; message: string };
    expect(parsed.error).toBe('agent_scope');
    expect(parsed.message).toBe(
      'agent token cannot create_project; use the JWT-authenticated dashboard or stdio backend',
    );
  });

  describe('with a readonly-scoped server (the read token)', () => {
    let readClient: Client;
    let readBackend: FakeBackend;

    beforeEach(async () => {
      readBackend = new FakeBackend();
      readClient = await makeClient(readBackend, { scope: 'readonly' });
    });

    it('read tools still work under a read scope', async () => {
      const { isError, data } = await call(readClient, 'list_projects');
      expect(isError).toBe(false);
      expect((data['projects'] as unknown[]).length).toBe(1);

      const issue = await call(readClient, 'get_issue', { issueId: 'i1' });
      expect(issue.isError).toBe(false);
    });

    for (const tool of [
      'create_project',
      'update_project',
      'set_issue_status',
      'annotate_issue',
      'record_fix_attempt',
    ] as const) {
      it(`${tool} (scope ${
        tool === 'create_project' || tool === 'update_project' ? 'admin' : 'agent'
      }) returns the read_scope error and does NOT touch the backend`, async () => {
        const args =
          tool === 'create_project'
            ? { name: 'X' }
            : tool === 'update_project'
              ? { projectId: 'p1', name: 'Y' }
              : tool === 'set_issue_status'
                ? { issueId: 'i1', status: 'resolved' }
                : tool === 'annotate_issue'
                  ? { issueId: 'i1', body: 'note' }
                  : { issueId: 'i1', prUrl: 'https://gh/pr/1' };
        const { isError, data } = await call(readClient, tool, args);
        expect(isError).toBe(true);
        expect(data['error']).toBe('read_scope');
        expect(data['message']).toContain(tool);
        // The backend method was never invoked.
        const method =
          tool === 'create_project'
            ? 'createProject'
            : tool === 'update_project'
              ? 'updateProject'
              : tool === 'set_issue_status'
                ? 'setIssueStatus'
                : tool === 'annotate_issue'
                  ? 'createAnnotation'
                  : 'upsertFixAttempt';
        expect(readBackend.calls.some((c) => c.method === method)).toBe(false);
      });
    }

    it('the full (default) scope still executes mutating tools', async () => {
      const { isError, data } = await call(client, 'create_project', { name: 'Second App' });
      expect(isError).toBe(false);
      expect(data['project']).toMatchObject({ name: 'Second App' });
    });
  });

  describe('with an agent-scoped server (the agent token, §23)', () => {
    let agentClient: Client;
    let agentBackend: FakeBackend;

    beforeEach(async () => {
      agentBackend = new FakeBackend();
      agentClient = await makeClient(agentBackend, { scope: 'agent' });
    });

    it('read tools work under an agent scope', async () => {
      const { isError } = await call(agentClient, 'list_projects');
      expect(isError).toBe(false);
    });

    it('agent tools (set_issue_status, annotate_issue, record_fix_attempt) work under an agent scope', async () => {
      const status = await call(agentClient, 'set_issue_status', {
        issueId: 'i1',
        status: 'resolved',
      });
      expect(status.isError).toBe(false);

      const annotation = await call(agentClient, 'annotate_issue', {
        issueId: 'i1',
        body: 'investigated',
      });
      expect(annotation.isError).toBe(false);

      const fix = await call(agentClient, 'record_fix_attempt', {
        issueId: 'i1',
        prUrl: 'https://gh/pr/1',
      });
      expect(fix.isError).toBe(false);
    });

    for (const tool of ['create_project', 'update_project'] as const) {
      it(`admin tool ${tool} returns the agent_scope error naming the agent token, and does NOT touch the backend`, async () => {
        const args = tool === 'create_project' ? { name: 'X' } : { projectId: 'p1', name: 'Y' };
        const { isError, data } = await call(agentClient, tool, args);
        expect(isError).toBe(true);
        expect(data['error']).toBe('agent_scope');
        expect(data['message']).toContain('agent token');
        expect(data['message']).toContain(tool);
        const method = tool === 'create_project' ? 'createProject' : 'updateProject';
        expect(agentBackend.calls.some((c) => c.method === method)).toBe(false);
      });
    }
  });
});

describe('projects', () => {
  it('list_projects renders ISO timestamps and drops null webhookUrl', async () => {
    const { isError, data } = await call(client, 'list_projects');
    expect(isError).toBe(false);
    const projects = data['projects'] as Record<string, unknown>[];
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: 'p1', slug: 'my-app', publicKey: 'pk_1' });
    expect(projects[0]?.['createdAt']).toBe('2023-11-14T22:13:20.000Z');
    expect(projects[0]).not.toHaveProperty('webhookUrl');
  });

  it('create_project creates and returns the project', async () => {
    const { isError, data } = await call(client, 'create_project', { name: 'Second App' });
    expect(isError).toBe(false);
    expect(data['project']).toMatchObject({ id: 'p2', name: 'Second App', slug: 'second-app' });
  });

  it('update_project forwards only the provided fields', async () => {
    const { isError } = await call(client, 'update_project', {
      projectId: 'p1',
      alertDedupeMinutes: 60,
    });
    expect(isError).toBe(false);
    expect(backend.last('updateProject')).toEqual({ projectId: 'p1', alertDedupeMinutes: 60 });
  });

  it('surfaces an SSRF-rejected webhook URL as a tool error', async () => {
    const { isError, text } = await call(client, 'update_project', {
      projectId: 'p1',
      webhookUrl: SSRF_URL,
    });
    expect(isError).toBe(true);
    expect(text).toContain('invalid_webhookUrl');
  });
});

describe('issues', () => {
  it('list_issues resolves a slug to the project id', async () => {
    const { isError, data } = await call(client, 'list_issues', { project: 'my-app' });
    expect(isError).toBe(false);
    expect((backend.last('listIssues') as ListIssuesInput).projectId).toBe('p1');
    expect(data['total']).toBe(1);
    expect(data['issues'] as unknown[]).toHaveLength(1);
  });

  it('list_issues resolves a raw project id too', async () => {
    await call(client, 'list_issues', { project: 'p1' });
    expect((backend.last('listIssues') as ListIssuesInput).projectId).toBe('p1');
  });

  it('list_issues on an unknown project returns a tool error', async () => {
    const { isError, text } = await call(client, 'list_issues', { project: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('project_not_found');
  });

  it('list_issues passes status, sort, limit and offset through', async () => {
    await call(client, 'list_issues', {
      project: 'p1',
      status: 'resolved',
      sort: 'eventCount',
      limit: 5,
      offset: 10,
    });
    expect(backend.last('listIssues')).toMatchObject({
      projectId: 'p1',
      status: 'resolved',
      sort: 'eventCount',
      limit: 5,
      offset: 10,
    });
  });

  it('get_issue merges raw + resolved frames into { function, file, line, col, inApp, status }', async () => {
    const { isError, data } = await call(client, 'get_issue', { issueId: 'i1' });
    expect(isError).toBe(false);
    const frames = data['frames'] as Record<string, unknown>[];
    expect(frames[0]).toEqual({
      function: 'render',
      file: 'src/App.tsx', // resolved filename wins
      line: 42, // resolved lineno wins
      col: 12, // col comes from the raw frame
      inApp: true, // inApp comes from the raw frame
      status: 'ok',
    });
  });

  it('get_issue caps breadcrumbs at the last 20 and reports the truncation', async () => {
    const { data } = await call(client, 'get_issue', { issueId: 'i1' });
    const crumbs = data['breadcrumbs'] as Record<string, unknown>[];
    expect(crumbs).toHaveLength(20);
    expect(data['breadcrumbsTruncated']).toBe(5);
    // The kept window is the LAST 20 (step 5 … step 24).
    expect(crumbs[0]?.['message']).toBe('step 5');
    expect(crumbs[19]?.['message']).toBe('step 24');
    expect(crumbs[19]?.['data']).toEqual({ to: 'checkout' });
  });

  it('get_issue on an unknown issue returns a tool error', async () => {
    const { isError, text } = await call(client, 'get_issue', { issueId: 'ghost' });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });

  it('set_issue_status transitions the status', async () => {
    const { isError, data } = await call(client, 'set_issue_status', {
      issueId: 'i1',
      status: 'resolved',
    });
    expect(isError).toBe(false);
    expect((data['issue'] as Record<string, unknown>)['status']).toBe('resolved');
  });

  it('set_issue_status on an unknown issue returns a tool error', async () => {
    const { isError, text } = await call(client, 'set_issue_status', {
      issueId: 'ghost',
      status: 'ignored',
    });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });
});

describe('regressed status (§CONTRACT M)', () => {
  it('surfaces a regressed issue status through list_issues', async () => {
    backend.issueStatus = 'regressed';
    const { isError, data } = await call(client, 'list_issues', { project: 'p1' });
    expect(isError).toBe(false);
    const issues = data['issues'] as Record<string, unknown>[];
    expect(issues[0]?.['status']).toBe('regressed');
  });

  it('surfaces a regressed status through get_issue', async () => {
    backend.issueStatus = 'regressed';
    const { isError, data } = await call(client, 'get_issue', { issueId: 'i1' });
    expect(isError).toBe(false);
    expect((data['issue'] as Record<string, unknown>)['status']).toBe('regressed');
  });

  it('list_issues accepts and forwards a regressed status filter', async () => {
    const { isError } = await call(client, 'list_issues', { project: 'p1', status: 'regressed' });
    expect(isError).toBe(false);
    expect((backend.last('listIssues') as ListIssuesInput).status).toBe('regressed');
  });

  it('set_issue_status REJECTS regressed (system-set, not user-settable)', async () => {
    const { isError } = await call(client, 'set_issue_status', {
      issueId: 'i1',
      status: 'regressed',
    });
    expect(isError).toBe(true);
  });

  it('list_issues tool description advertises the regressed filter option', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'list_issues');
    expect(t?.description).toMatch(/regressed/);
  });

  it('set_issue_status tool description states regressed is system-set', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'set_issue_status');
    expect(t?.description).toMatch(/regressed/i);
    expect(t?.description).toMatch(/system-set/i);
  });
});

describe('events', () => {
  it('list_issue_events paginates and summarizes', async () => {
    const { isError, data } = await call(client, 'list_issue_events', {
      issueId: 'i1',
      page: 2,
      limit: 5,
    });
    expect(isError).toBe(false);
    expect(backend.last('listIssueEvents')).toEqual({ issueId: 'i1', page: 2, limit: 5 });
    const events = data['events'] as Record<string, unknown>[];
    expect(events[0]).toMatchObject({ id: 'e1', level: 'error', platform: 'android' });
  });

  it('get_event returns a cleaned envelope with resolved frames and no raw stacktrace', async () => {
    const { isError, data } = await call(client, 'get_event', { eventId: 'e1' });
    expect(isError).toBe(false);
    const event = data['event'] as Record<string, unknown>;
    const exception = event['exception'] as Record<string, unknown>;
    expect(exception).not.toHaveProperty('stacktrace');
    const frames = exception['frames'] as Record<string, unknown>[];
    expect(frames[0]).toMatchObject({ file: 'src/App.tsx', line: 42, col: 12, status: 'ok' });
    expect(event['tags']).toEqual({ area: 'checkout' });
    // symbolicate defaults to true.
    expect(backend.last('getEvent')).toEqual({ eventId: 'e1', symbolicate: true });
  });

  it('get_event with symbolicate false shows raw frames without a status', async () => {
    const { isError, data } = await call(client, 'get_event', {
      eventId: 'e1',
      symbolicate: false,
    });
    expect(isError).toBe(false);
    expect(backend.last('getEvent')).toEqual({ eventId: 'e1', symbolicate: false });
    const frames = (data['event'] as Record<string, unknown>)['exception'] as Record<
      string,
      unknown
    >;
    const list = frames['frames'] as Record<string, unknown>[];
    expect(list[0]).toMatchObject({
      function: 'render',
      file: 'index.android.bundle',
      inApp: true,
    });
    expect(list[0]).not.toHaveProperty('status');
  });

  it('get_event on an unknown event returns a tool error', async () => {
    const { isError, text } = await call(client, 'get_event', { eventId: 'ghost' });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });
});

describe('releases + health', () => {
  it('list_releases resolves the project and renders symbol timestamps', async () => {
    const { isError, data } = await call(client, 'list_releases', { project: 'my-app' });
    expect(isError).toBe(false);
    expect((backend.last('listReleases') as { projectId: string }).projectId).toBe('p1');
    const releases = data['releases'] as Record<string, unknown>[];
    expect(releases[0]?.['mappingUploadedAt']).toBe('2023-11-14T22:13:20.000Z');
    expect(releases[0]).not.toHaveProperty('sourcemapUploadedAt');
  });

  it('get_server_health reports ok plus the metrics subset', async () => {
    const { isError, data } = await call(client, 'get_server_health');
    expect(isError).toBe(false);
    expect(data).toMatchObject({
      ok: true,
      metricsAvailable: true,
      eventsIngested: 12,
      issuesNew: 3,
      webhookFailures: 1,
    });
  });
});

describe('input validation', () => {
  it('rejects create_project with no name', async () => {
    const { isError, text } = await call(client, 'create_project', {});
    expect(isError).toBe(true);
    expect(text).toContain('Invalid arguments');
  });

  it('rejects list_issues with a limit over the 100 cap', async () => {
    const { isError } = await call(client, 'list_issues', { project: 'p1', limit: 500 });
    expect(isError).toBe(true);
  });

  it('rejects set_issue_status with an invalid status', async () => {
    const { isError } = await call(client, 'set_issue_status', { issueId: 'i1', status: 'nope' });
    expect(isError).toBe(true);
  });
});

describe('bundle / top-issues / monitors (v0.5)', () => {
  it('get_issue_bundle returns the bundle verbatim, including the §23 investigation record', async () => {
    const { isError, data } = await call(client, 'get_issue_bundle', { issueId: 'i1' });
    expect(isError).toBe(false);
    expect((data['issue'] as Record<string, unknown>)['id']).toBe('i1');
    expect(data['truncated']).toEqual({ context: false, breadcrumbs: false, annotations: false });
    expect((data['project'] as Record<string, unknown>)['repoUrl']).toBeNull();
    expect(data['annotations']).toEqual([]);
    expect(data['fixAttempts']).toEqual([]);
    const frames = (data['latestEvent'] as Record<string, unknown>)['frames'] as Record<
      string,
      unknown
    >[];
    expect(frames[0]?.['context']).toMatchObject({ line: 'render();' });
  });

  it('get_issue_bundle is a not_found tool error for a missing issue', async () => {
    const { isError, text } = await call(client, 'get_issue_bundle', { issueId: 'ghost' });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });

  it('list_top_issues forwards limit/days and renders ISO timestamps', async () => {
    const { isError, data } = await call(client, 'list_top_issues', { limit: 5, days: 7 });
    expect(isError).toBe(false);
    expect(backend.last('listTopIssues')).toEqual({ limit: 5, days: 7 });
    const issues = data['issues'] as Record<string, unknown>[];
    expect(issues[0]).toMatchObject({ issueId: 'i1', projectSlug: 'my-app', windowEvents: 5 });
    expect(issues[0]?.['lastSeen']).toBe('2023-11-14T22:15:00.000Z');
  });

  it('list_top_issues applies defaults', async () => {
    await call(client, 'list_top_issues');
    expect(backend.last('listTopIssues')).toEqual({ limit: 10, days: 14 });
  });

  it('list_monitors resolves an optional project ref to an id', async () => {
    const { isError, data } = await call(client, 'list_monitors', { project: 'my-app' });
    expect(isError).toBe(false);
    expect(backend.last('listMonitors')).toEqual({ projectId: 'p1' });
    const monitors = data['monitors'] as Record<string, unknown>[];
    expect(monitors[0]).toMatchObject({ slug: 'nightly', projectSlug: 'my-app', overdue: false });
    expect(monitors[0]?.['lastCheckInAt']).toBe('2023-11-14T22:13:20.000Z');
  });

  it('list_monitors with no project lists across all projects', async () => {
    const { isError } = await call(client, 'list_monitors');
    expect(isError).toBe(false);
    expect(backend.last('listMonitors')).toEqual({});
  });

  it('list_monitors on an unknown project ref is a tool error', async () => {
    const { isError, text } = await call(client, 'list_monitors', { project: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('project_not_found');
  });
});

describe('usage summary (v0.6)', () => {
  it('get_usage_summary resolves a slug to the project id and forwards days', async () => {
    const { isError, data } = await call(client, 'get_usage_summary', {
      project: 'my-app',
      days: 7,
    });
    expect(isError).toBe(false);
    expect(backend.last('getUsageSummary')).toEqual({ projectId: 'p1', days: 7 });
    expect(data['totals']).toEqual({ pageviews: 3, visitors: 2, events: 1 });
    expect((data['topReferrers'] as unknown[])[0]).toEqual({
      referrer: 'google.com',
      pageviews: 2,
    });
  });

  it('get_usage_summary defaults days to 30', async () => {
    await call(client, 'get_usage_summary', { project: 'p1' });
    expect((backend.last('getUsageSummary') as { days: number }).days).toBe(30);
  });

  it('get_usage_summary on an unknown project ref is a tool error', async () => {
    const { isError, text } = await call(client, 'get_usage_summary', { project: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('project_not_found');
  });

  it('get_usage_summary is annotated read-only', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'get_usage_summary');
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('fix_crash prompt', () => {
  it('is registered and renders imperative text referencing the issue', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('fix_crash');
    const got = await client.getPrompt({ name: 'fix_crash', arguments: { issueId: 'i1' } });
    const text = (got.messages[0]?.content as { type: string; text: string }).text;
    expect(text).toContain('get_issue_bundle');
    expect(text).toContain('i1');
  });
});

describe('list_similar_issues (v0.8 §23)', () => {
  it('returns similar issues, ISO timestamps, with fix attempts and annotation count', async () => {
    const { isError, data } = await call(client, 'list_similar_issues', { issueId: 'i1' });
    expect(isError).toBe(false);
    expect(backend.last('listSimilarIssues')).toEqual({ issueId: 'i1' });
    const similar = data['similar'] as Record<string, unknown>[];
    expect(similar).toHaveLength(1);
    const entry = similar[0] as Record<string, unknown>;
    expect(entry['issue']).toMatchObject({ id: 'i2', projectSlug: 'my-app', status: 'resolved' });
    expect((entry['issue'] as Record<string, unknown>)['lastSeen']).toBe(
      '2023-11-14T22:15:40.000Z',
    );
    expect(entry['annotationCount']).toBe(4);
    const fixAttempts = entry['fixAttempts'] as Record<string, unknown>[];
    expect(fixAttempts[0]).toMatchObject({ id: 'fa2', state: 'verified' });
  });

  it('is a not_found tool error for an unknown issue', async () => {
    const { isError, text } = await call(client, 'list_similar_issues', { issueId: 'ghost' });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });

  it('is annotated read-only', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'list_similar_issues');
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('annotate_issue (v0.8 §23)', () => {
  it('creates an annotation, defaulting kind to note and author to agent', async () => {
    const { isError, data } = await call(client, 'annotate_issue', {
      issueId: 'i1',
      body: 'root cause found',
    });
    expect(isError).toBe(false);
    expect(backend.last('createAnnotation')).toMatchObject({
      issueId: 'i1',
      body: 'root cause found',
    });
    const annotation = data['annotation'] as Record<string, unknown>;
    expect(annotation).toMatchObject({ kind: 'note', author: 'agent', body: 'root cause found' });
    expect(annotation['createdAt']).toBe('2023-11-14T22:15:50.000Z');
  });

  it('accepts an explicit kind and author', async () => {
    const { isError, data } = await call(client, 'annotate_issue', {
      issueId: 'i1',
      body: 'shipped the fix in #42',
      kind: 'fix_plan',
      author: 'triage-bot',
    });
    expect(isError).toBe(false);
    expect(data['annotation']).toMatchObject({ kind: 'fix_plan', author: 'triage-bot' });
  });

  it("rejects kind 'system' at the schema level (server-written only, never reaches the backend)", async () => {
    const { isError, text } = await call(client, 'annotate_issue', {
      issueId: 'i1',
      body: 'nope',
      kind: 'system',
    });
    expect(isError).toBe(true);
    expect(text).toContain('Invalid arguments');
    expect(backend.calls.some((c) => c.method === 'createAnnotation')).toBe(false);
  });

  it('rejects a missing body', async () => {
    const { isError } = await call(client, 'annotate_issue', { issueId: 'i1' });
    expect(isError).toBe(true);
  });

  it('is a not_found tool error for an unknown issue', async () => {
    const { isError, text } = await call(client, 'annotate_issue', {
      issueId: 'ghost',
      body: 'x',
    });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });

  it('is annotated a non-readOnly, non-destructive write', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'annotate_issue');
    expect(t?.annotations?.readOnlyHint).toBe(false);
    expect(t?.annotations?.destructiveHint).toBe(false);
  });
});

describe('record_fix_attempt (v0.8 §23)', () => {
  it('upserts a fix attempt without a state (stays filed)', async () => {
    const { isError, data } = await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    expect(isError).toBe(false);
    expect(backend.last('upsertFixAttempt')).toMatchObject({
      issueId: 'i1',
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    expect(data['fixAttempt']).toMatchObject({ id: 'fa1', state: 'filed' });
    // No transition call — the requested state was never provided.
    expect(backend.calls.some((c) => c.method === 'transitionFixAttempt')).toBe(false);
  });

  it('lower-cases a provided commitSha before upserting', async () => {
    await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      commitSha: 'ABCDEF0',
    });
    expect(backend.last('upsertFixAttempt')).toMatchObject({ commitSha: 'abcdef0' });
  });

  it('upserts then transitions in one call when state differs from the current state', async () => {
    const { isError, data } = await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      state: 'deployed',
    });
    expect(isError).toBe(false);
    expect(backend.last('upsertFixAttempt')).toMatchObject({ issueId: 'i1' });
    expect(backend.last('transitionFixAttempt')).toEqual({
      fixAttemptId: 'fa1',
      state: 'deployed',
    });
    expect(data['fixAttempt']).toMatchObject({ state: 'deployed' });
  });

  it('skips the transition call when the requested state already matches (idempotent re-record)', async () => {
    await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      state: 'deployed',
    });
    backend.calls.length = 0;
    const { isError, data } = await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      state: 'deployed',
    });
    expect(isError).toBe(false);
    expect(data['fixAttempt']).toMatchObject({ state: 'deployed' });
    expect(backend.calls.some((c) => c.method === 'transitionFixAttempt')).toBe(false);
  });

  it('surfaces an invalid transition (the server 400) as a tool error', async () => {
    // filed -> failed is allowed; failed -> deployed is not.
    await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      state: 'failed',
    });
    const { isError, text } = await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      state: 'deployed',
    });
    expect(isError).toBe(true);
    expect(text).toContain('invalid_transition');
  });

  it("rejects state 'verified' at the schema level (system-set only, never reaches the backend)", async () => {
    const { isError, text } = await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      state: 'verified',
    });
    expect(isError).toBe(true);
    expect(text).toContain('Invalid arguments');
    expect(backend.calls.some((c) => c.method === 'upsertFixAttempt')).toBe(false);
  });

  it("rejects state 'filed' at the schema level (the implicit creation state, never a transition target)", async () => {
    const { isError, text } = await call(client, 'record_fix_attempt', {
      issueId: 'i1',
      prUrl: 'https://gh/pr/1',
      state: 'filed',
    });
    expect(isError).toBe(true);
    expect(text).toContain('Invalid arguments');
  });

  it('rejects a missing prUrl', async () => {
    const { isError } = await call(client, 'record_fix_attempt', { issueId: 'i1' });
    expect(isError).toBe(true);
  });

  it('is a not_found tool error for an unknown issue', async () => {
    const { isError, text } = await call(client, 'record_fix_attempt', {
      issueId: 'ghost',
      prUrl: 'https://gh/pr/1',
    });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });

  it('is annotated a non-readOnly, non-destructive write', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'record_fix_attempt');
    expect(t?.annotations?.readOnlyHint).toBe(false);
    expect(t?.annotations?.destructiveHint).toBe(false);
  });
});
