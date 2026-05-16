# uh-oh — v0.1 Spec

Lightweight self-hosted crash reporting for React Native.

## Problem Statement

A self-hosted crash and error reporting service for React Native apps, used by one developer across multiple apps. Captures JS exceptions and Android native crashes; groups them into issues; surfaces them in a single-user dashboard; notifies via outbound webhook per project.

v0.1 is sufficient for one developer to replace Sentry on their RN apps, not a SaaS product.

## Boundaries

### In scope (v0.1)

- React Native SDK (`@uh-oh/react-native`): JS error capture on iOS+Android, Android native crash bridge (Java UncaughtExceptionHandler + xCrash)
- Ingest server: receive events, group by fingerprint, persist, fan out webhooks
- Dashboard: list projects, list issues per project, view issue detail, manage project settings, symbol uploads
- CLI (`uh-oh`): upload ProGuard mapping per release
- Symbolication: Android ProGuard retrace, on-demand at view time, cached
- Auth: single password → JWT (one user, env-configured)
- Generic outbound webhook per project, with per-fingerprint dedupe window

### Out of scope (v0.1)

- **iOS native crashes** — deferred to v0.2 (will use KSCrash)
- Performance / tracing
- Session replay
- Hermes source-map symbolication for JS stacks — phase 2
- Multi-user, orgs, teams, RBAC, billing
- Runtimes other than RN (web, Node, Python — phase 3+)
- Alert rules beyond "new issue + per-fingerprint dedupe"
- Email/Slack/Discord integrations (wire those off the generic webhook)

### External dependencies

- Server: Fastify, Drizzle ORM, better-sqlite3, Zod, jose (JWT), pino
- Web: Vite, React, TanStack Query, TanStack Router, Tailwind
- SDK: xCrash (Android, BSD-3, via Gradle)
- CLI: commander; retrace (vendored) on the server

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  RN app                 │ HTTPS   │  Hetzner :3300               │
│  ┌────────────────────┐ │ ──────► │  ├── /ingest/:publicKey      │
│  │ @uh-oh/react-native│ │         │  ├── /api/* (auth-gated)     │
│  │  - JS handler      │ │         │  ├── /symbols/upload         │
│  │  - xCrash (Android)│ │         │  └── (outbound webhooks)     │
│  │  - AsyncStorage    │ │         │  SQLite: /var/lib/uh-oh/db   │
│  │    spool & retry   │ │         │  Symbols: /var/lib/uh-oh/sym │
│  └────────────────────┘ │         └──────────────────────────────┘
└─────────────────────────┘                       │
                                                  ▼
                                         project.webhook_url
```

## Data Model (SQLite, Drizzle)

```
projects        { id, name, slug, public_key, webhook_url?, alert_dedupe_minutes, created_at }
releases        { id, project_id, version, build, platform, mapping_uploaded_at? }
events          { id, project_id, release_id?, fingerprint, level, platform,
                  payload (JSON), received_at, device_info (JSON), user (JSON?) }
issues          { id, project_id, fingerprint, title, first_seen, last_seen, event_count,
                  status: 'open' | 'resolved' | 'ignored', last_alerted_at? }
breadcrumbs     { event_id, idx, ts, category, level, message, data (JSON?) }
symbolications  { event_id, frame_idx, resolved (JSON) }
sessions        { id, jti, expires_at }
```

## Fingerprinting

- **JS:** `${errorType}::${topNonInternalFrame.module}:${topNonInternalFrame.function}`
- **Android native:** `${exceptionClass}::${topAppFrame.method}` (excluding `android.*`, `com.facebook.react.*`, `java.*`)
- Override via SDK `setFingerprint(parts: string[])`

## Interface Contracts

### Ingest (public — project public_key in URL)

```ts
POST /ingest/:publicKey
Body: EventEnvelope
Returns: 202 { eventId } | 400 ZodError | 401 unknown key | 429 rate-limited

type EventEnvelope = {
  sdk: { name: string; version: string };
  timestamp: string;
  platform: 'ios' | 'android';
  release: { version: string; build: string };
  level: 'fatal' | 'error' | 'warning' | 'info';
  exception: {
    type: string;
    value: string;
    stacktrace: StackFrame[];
    mechanism: 'js-global' | 'js-promise' | 'js-manual' | 'android-java-ueh' | 'android-ndk-signal' | 'android-anr';
  };
  breadcrumbs: Breadcrumb[];
  user?: { id: string; email?: string; username?: string };
  context?: Record<string, JsonValue>;
  device: DeviceInfo;
  fingerprint?: string[];
};

type StackFrame = {
  function?: string;
  module?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  instructionAddr?: string;
  imageAddr?: string;
  inApp: boolean;
};
```

### Internal API (JWT-gated)

```
POST   /api/auth/login              { password } → { token }
GET    /api/projects                → Project[]
POST   /api/projects                { name } → Project
PATCH  /api/projects/:id            { webhook_url?, alert_dedupe_minutes? } → Project
DELETE /api/projects/:id            → 204
POST   /api/projects/:id/rotate-key → { public_key }

GET    /api/projects/:id/issues?status=&sort=&page= → { issues, total }
GET    /api/issues/:id              → IssueDetail
PATCH  /api/issues/:id              { status } → Issue

GET    /api/issues/:id/events?page= → Event[]
GET    /api/events/:id              → EventDetail

POST   /api/releases/:id/symbols    multipart: mapping.txt → 200
```

### SDK surface

```ts
import {
  init,
  captureException,
  addBreadcrumb,
  setUser,
  setContext,
  setFingerprint,
} from '@uh-oh/react-native';

init({
  dsn: string;
  release: string;
  environment?: string;
  beforeSend?: (e: EventEnvelope) => EventEnvelope | null;
  maxBreadcrumbs?: number;
  debug?: boolean;
}): void;

captureException(error: unknown, ctx?: { tags?: Record<string,string>; extra?: Record<string,unknown> }): void;
addBreadcrumb(b: { category: string; message: string; level?: BreadcrumbLevel; data?: Record<string,unknown> }): void;
setUser(u: { id: string; email?: string } | null): void;
setContext(key: string, value: Record<string, unknown> | null): void;
setFingerprint(parts: string[] | null): void;
```

## Edge Cases

| #   | Scenario                                         | Behavior                                                                                                 |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1   | App crashes natively before JS thread can report | Native module writes report async-signal-safe; SDK init reads, sends, deletes                            |
| 2   | Offline at crash time                            | Spool to AsyncStorage (JS) / xCrash store (Android); flush on connectivity + on next init                |
| 3   | Spool grows unbounded                            | Cap at 100 events; oldest dropped                                                                        |
| 4   | Same crash 10,000×/min                           | Server rate-limits per `publicKey + fingerprint`: 1 store/sec, increments `event_count` only beyond that |
| 5   | Webhook endpoint slow/down                       | Outbound webhook async, 3 retries w/ expo backoff, then drop + log                                       |
| 6   | Webhook dedupe                                   | `last_alerted_at + alert_dedupe_minutes` check                                                           |
| 7   | Unknown publicKey                                | 401; do not echo why                                                                                     |
| 8   | Malformed payload                                | Zod validation → 400 with field path; no partial persist                                                 |
| 9   | No mapping uploaded                              | Frames returned raw, marked `unsymbolicated: true`                                                       |
| 10  | Corrupt mapping                                  | Cache failure, surface in UI, do not retry on every view                                                 |
| 11  | Hermes JS stack with bytecode offsets            | Stored as-is; symbolication phase 2                                                                      |
| 12  | Wrong grouping                                   | Manual `setFingerprint` from SDK is the escape hatch                                                     |
| 13  | Payload > 1 MB                                   | Reject 413; SDK trims breadcrumbs then context, retries once                                             |
| 14  | Native handler installed twice                   | xCrash no-op on double-install; we assert via flag                                                       |
| 15  | RN reload in dev                                 | Breadcrumbs in-memory, cleared on reload (matches Sentry)                                                |
| 16  | Mapping upload races incoming events             | Events store raw; UI symbolicates on read; cache invalidated on new upload                               |
| 17  | Clock skew                                       | Server uses `received_at`; client `timestamp` informational only                                         |
| 18  | JWT stolen                                       | 24h expiry + jti table; logout deletes jti; no refresh tokens                                            |

## Acceptance Criteria

### Ingest

- Valid envelope → 202 with `eventId`; 1 event row, 1 new issue or incremented existing.
- Unknown field → accepted and persisted in `payload` (forward-compatible).
- Missing required field → 400 with field path.
- 100 events / 1s same fingerprint → 10 rows stored (rate-limit), `event_count` = 100.

### Grouping

- Same `errorType` + same top non-RN frame → same `issue.id`.
- Same event different `release` → still same `issue.id`.

### SDK

- `throw new Error('x')` unhandled → captured via global handler, sent within 5s online, spooled offline.
- Android NPE in Java → xCrash captures, SDK sends on next launch with `mechanism: 'android-java-ueh'`.
- `beforeSend` returns `null` → not sent.

### Dashboard

- Issue with mapping uploaded → frames symbolicated.
- Issue without mapping → raw frames with banner.
- Resolve → status flips, removed from default list.

### Alerts

- New fingerprint → webhook `POST { type: 'issue.new', project, issue, event, url }` within 5s.
- Second event of same fingerprint inside dedupe window → no webhook.
- Webhook returns 500 → retry 3× at 2s/8s/32s, then drop + log.

## Decomposition

Each subtask is independently completable, separately specced, separately verified, separately committed.

1. **Repo + monorepo scaffolding** — pnpm workspaces, TS configs, shared `types` package, CI skeleton
2. **`types` package** — Zod schemas + inferred TS types
3. **Server: DB layer** — Drizzle schema, migrations, repository functions
4. **Server: ingest endpoint** — validation, rate limit, fingerprint, store
5. **Server: webhook worker** — async outbound, retries, dedupe
6. **Server: auth + internal API** — login, projects, issues, events CRUD
7. **Server: symbolication** — Android ProGuard retrace, cache, lazy
8. **Web: dashboard shell** — Vite, router, auth flow, layout
9. **Web: issues list + detail** — virtualized list, frame viewer
10. **Web: project + release settings** — webhook URL, key rotation, mapping upload
11. **SDK: JS-only core** — handlers, breadcrumbs, transport, AsyncStorage spool
12. **SDK: Android native module** — Java UEH + xCrash, on-launch send, Gradle
13. **CLI** — `uh-oh upload mapping --release X.Y.Z`
14. **Deploy** — systemd unit, IP:3300, daily SQLite backup
15. **Hardening** — rate limits, payload size caps, structured logs, metrics

### v0.2 backlog

- iOS native crash capture (KSCrash)
- iOS dSYM upload + server-side symbolication (`atos` or `llvm-symbolizer`)
- Hermes source map upload + JS symbolication
- nginx vhost + TLS
