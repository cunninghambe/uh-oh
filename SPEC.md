# uh-oh — v0.1 Spec (FINAL — Android only)

Lightweight self-hosted crash reporting for React Native **Android apps**. Single developer, multiple projects, production-ready on a single Hetzner node.

This spec is the contract for implementers. Where ambiguity exists, this document wins; if it disagrees with the code, fix the code or update this doc with a PR.

iOS is **out of scope** for v0.1. The wire format reserves `platform: 'ios'` for future use, but no iOS code (native module, symbolication, SDK bridge) ships.

---

## 1. Problem statement

A single developer (Brad) ships multiple React Native **Android** apps. They need a self-hosted crash and error reporting service that:

- Captures JS exceptions and Android native crashes from their RN apps
- Groups events into issues by fingerprint
- Symbolicates stack traces server-side (Hermes JS, Android ProGuard)
- Presents issues + breadcrumbs + context in a single-user web dashboard
- Fires a generic outbound webhook per project when new issues appear
- Runs on a single Hetzner box behind nginx + TLS, with daily SQLite backups

v0.1 is feature-complete enough to replace Sentry for one developer's RN Android apps.

---

## 2. Scope

### In scope (v0.1)

**Crash capture (SDK — Android only):**

- React Native SDK `@uh-oh/react-native`: JS error capture (ErrorUtils global handler + unhandled promise rejection)
- Android native crash bridge: `Thread.setDefaultUncaughtExceptionHandler` (Java/Kotlin uncaught) + xCrash (BSD-3, NDK signals + ANR)
- AsyncStorage-backed event spool, flushed on connectivity restoration and on next app launch (handles offline-at-crash-time and crash-before-network)
- Breadcrumbs, user context, tags, custom context, beforeSend hook
- SDK fingerprint override via `setFingerprint(parts)`
- SDK is a no-op on iOS (so RN apps that happen to ship to both don't crash); only Android native module is built

**Server (ingest + API + workers):**

- Fastify + SQLite + Drizzle ORM
- `POST /ingest/:publicKey` — Zod validation, token-bucket rate limit per (publicKey, fingerprint), atomic upsert-issue + insert-event + insert-breadcrumbs
- JWT-gated `/api/*` — single password env-configured, 24h tokens, jti revocation table
- Webhook dispatcher: async, retries with exponential backoff (3 attempts at 2s/8s/32s), per-fingerprint dedupe window
- Symbolication: Android ProGuard retrace, Hermes JS via source maps — on-demand at view time, results cached in DB
- Symbol upload endpoints: `POST /api/releases/:id/symbols` accepts ProGuard mapping.txt or Hermes source map .map

**Dashboard (web):**

- Vite + React 19 + TanStack Router + TanStack Query + Tailwind v4
- Login screen → JWT stored in localStorage → all `/api/*` calls send Authorization: Bearer
- Projects: list, create, settings (name, webhook URL, alert dedupe minutes, public-key rotation)
- Issues: list (sortable by lastSeen / eventCount / firstSeen, filter by status), detail (symbolicated stack, breadcrumbs, context, status toggle, list of events for the issue)
- Releases: per-project release list, symbol upload UI (drag-drop with progress)

**CLI (`@uh-oh/cli`):**

- `uh-oh login --server URL` — prompts for password, stores token
- `uh-oh upload mapping --project SLUG --release VERSION+BUILD --file mapping.txt`
- `uh-oh upload sourcemap --project SLUG --release VERSION+BUILD --file index.android.bundle.map`

**Deployment:**

- systemd unit for the server (`uh-oh-server.service`)
- nginx vhost terminating TLS via Let's Encrypt / certbot
- UFW rules: 22, 80, 443 open; 3300 closed (proxied via nginx only)
- Daily SQLite backup: `sqlite3 .backup` to a dated file in `/var/backups/uh-oh/`, with 30-day retention

**Hardening:**

- Per-IP global rate limit (separate from per-fingerprint)
- Payload size cap (1 MB) — SDK trims breadcrumbs then context then retries once on 413
- Structured logs (pino) — JSON, levels, request IDs
- `/metrics` endpoint (Prometheus text format) — events_ingested_total, issues_total, webhook_failures_total, request_duration_seconds histogram
- CSP + security headers on dashboard
- CORS: ingest open, `/api/*` allows same-origin only

### Out of scope (v0.1)

- **iOS in any form** (no native module, no dSYM symbolication, no iOS bridge code)
- Performance / tracing
- Session replay
- Multi-user, orgs, teams, RBAC, billing
- Email/Slack/Discord native integrations (wire those off the generic webhook)
- Alert rules beyond "new issue + per-fingerprint dedupe"
- Search (regex over event payloads). Filter by status + sort is enough for v0.1.
- Runtimes other than RN (web JS, Node, Python) — phase 3+
- Migration tooling (drizzle-kit migrations only; no zero-downtime migration patterns)

---

## 3. Architecture

```
┌──────────────────────────┐  HTTPS  ┌────────────────────────────────────┐
│  RN Android app          │ ──────► │ nginx :443  (TLS via certbot)      │
│  ┌────────────────────┐  │         │  ├── proxy_pass http://127.0.0.1:3300 │
│  │ @uh-oh/react-native│  │         │  └── HSTS, CSP, gzip               │
│  │  - JS handler      │  │         └────────────────┬───────────────────┘
│  │  - UEH (Java)      │  │                          │
│  │  - xCrash (NDK)    │  │                          ▼
│  │  - AsyncStorage    │  │         ┌────────────────────────────────────┐
│  │    spool + retry   │  │         │ uh-oh-server :3300 (Fastify)       │
│  └────────────────────┘  │         │  ├── POST /ingest/:publicKey       │
└──────────────────────────┘         │  ├── /api/* (JWT-gated)            │
                                     │  ├── /metrics                       │
                                     │  └── /healthz                       │
                                     │  workers:                           │
                                     │   ├── webhook dispatcher            │
                                     │   └── symbolicator (lazy)           │
                                     │  state:                             │
                                     │   ├── SQLite /var/lib/uh-oh/uh-oh.db│
                                     │   └── /var/lib/uh-oh/symbols/       │
                                     └────────────────────────────────────┘
                                                      │
                                                      ▼
                                              project.webhook_url
```

**Process model:** single Node process. Webhook dispatcher is an in-process queue with a single worker (`setImmediate` loop pulling from an in-memory + DB-backed queue). Symbolicator is on-demand at issue-view time. No separate workers for v0.1.

**File layout on disk:**

```
/var/lib/uh-oh/
  uh-oh.db             # SQLite, WAL mode
  symbols/
    <release-id>/
      mapping.txt      # Android ProGuard
      sourcemap.map    # Hermes JS source map
/var/backups/uh-oh/
  uh-oh-YYYYMMDD.db    # 30 days kept
```

---

## 4. Data model (SQLite, Drizzle)

All timestamps are integer epoch ms. All IDs are UUID v4 strings (`crypto.randomUUID()`). JSON columns are TEXT.

```
projects
  id TEXT PK
  name TEXT NOT NULL
  slug TEXT NOT NULL UNIQUE
  public_key TEXT NOT NULL UNIQUE
  webhook_url TEXT
  alert_dedupe_minutes INTEGER NOT NULL DEFAULT 30
  created_at INTEGER NOT NULL

releases
  id TEXT PK
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  version TEXT NOT NULL
  build TEXT NOT NULL
  platform TEXT NOT NULL CHECK (platform IN ('ios','android'))   -- ios reserved, not used by SDK in v0.1
  mapping_uploaded_at INTEGER       -- Android ProGuard
  sourcemap_uploaded_at INTEGER     -- Hermes
  UNIQUE(project_id, version, build, platform)

issues
  id TEXT PK
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  fingerprint TEXT NOT NULL
  title TEXT NOT NULL
  first_seen INTEGER NOT NULL
  last_seen INTEGER NOT NULL
  event_count INTEGER NOT NULL DEFAULT 1
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored'))
  last_alerted_at INTEGER
  UNIQUE(project_id, fingerprint)
  INDEX (project_id, last_seen DESC)

events
  id TEXT PK
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL
  fingerprint TEXT NOT NULL
  level TEXT NOT NULL
  platform TEXT NOT NULL
  payload TEXT NOT NULL              -- full EventEnvelope JSON
  received_at INTEGER NOT NULL
  device_info TEXT NOT NULL           -- JSON
  user_info TEXT                      -- JSON, nullable
  INDEX (issue_id, received_at DESC)
  INDEX (project_id, received_at DESC)

breadcrumbs
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE
  idx INTEGER NOT NULL
  ts INTEGER NOT NULL
  category TEXT NOT NULL
  level TEXT NOT NULL
  message TEXT NOT NULL
  data TEXT                           -- JSON, nullable
  PRIMARY KEY (event_id, idx)

symbolications
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE
  frame_idx INTEGER NOT NULL
  resolved TEXT NOT NULL              -- JSON: { function?, file?, line?, col?, status }
  PRIMARY KEY (event_id, frame_idx)

sessions
  jti TEXT PK
  expires_at INTEGER NOT NULL

webhook_dispatches
  id TEXT PK
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE
  url TEXT NOT NULL
  attempt INTEGER NOT NULL DEFAULT 0
  next_attempt_at INTEGER NOT NULL
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed'))
  last_error TEXT
  last_response_code INTEGER
  created_at INTEGER NOT NULL
  INDEX (status, next_attempt_at)
```

Existing schema in `packages/server/src/db/schema.ts` already includes `releases`, `symbolications`, `sessions`. **Implementers must add `webhook_dispatches` and the `sourcemap_uploaded_at` column on `releases` via a new Drizzle migration** rather than editing the initial migration.

---

## 5. Auth model

- One user. Password set via env var `UH_OH_ADMIN_PASSWORD` (required at boot; server fails to start if missing).
- `POST /api/auth/login` validates password constant-time (`crypto.timingSafeEqual`), issues JWT signed with `UH_OH_JWT_SECRET` (HS256, 24h), inserts row in `sessions` with the JWT's `jti`.
- All `/api/*` routes except `/api/auth/login` require `Authorization: Bearer <jwt>`. Middleware verifies signature + expiry + jti present in `sessions`.
- `POST /api/auth/logout` deletes the row by jti.
- A periodic cleanup task (every hour) deletes sessions where `expires_at < now`.
- Login attempts rate-limited per IP: 10/min, exponential backoff after that.

No refresh tokens, no signup, no password reset, no MFA — v0.2 if ever.

---

## 6. Wire format (EventEnvelope)

The package `@uh-oh/types` is the single source of truth. Zod schemas there are the contract; both SDK and server import them. **Already implemented; do not modify the wire format in v0.1.**

```ts
type EventEnvelope = {
  sdk: { name: string; version: string };
  timestamp: string; // ISO 8601
  platform: 'ios' | 'android'; // 'ios' reserved, not produced by SDK in v0.1
  release: { version: string; build: string };
  level: 'fatal' | 'error' | 'warning' | 'info';
  exception: {
    type: string;
    value: string;
    stacktrace: StackFrame[];
    mechanism:
      | 'js-global'
      | 'js-promise'
      | 'js-manual'
      | 'android-java-ueh'
      | 'android-ndk-signal'
      | 'android-anr';
    // (ios mechanisms are reserved but not produced)
  };
  breadcrumbs: Breadcrumb[]; // max 100
  user?: { id: string; email?: string; username?: string };
  context?: Record<string, JsonValue>;
  tags?: Record<string, string>; // implementer of subtask 11 must ADD this to schema
  device: DeviceInfo;
  fingerprint?: string[]; // SDK override; 1..8 entries
};
```

**Note:** `tags?: Record<string, string>` is not yet in `@uh-oh/types` schema. Implementer of subtask 11 (SDK) must add it to `EventEnvelopeSchema` in `packages/types/src/index.ts` with `z.record(z.string(), z.string()).optional()` and corresponding test.

---

## 7. Fingerprinting

Deterministic, fully testable, no LLM in the loop. **Already implemented at `packages/server/src/ingest/fingerprint.ts`.** Do not modify.

---

## 8. Symbolication

All symbolication is **server-side, on-demand, cached**. The web dashboard requests a symbolicated view; the server symbolicates if not cached, persists to `symbolications`, returns.

### Android (ProGuard)

- `POST /api/releases/:id/symbols` with `platform=android` accepts a `mapping.txt` (multipart form-data, field name `file`).
- Server writes to `/var/lib/uh-oh/symbols/<release-id>/mapping.txt`, sets `releases.mapping_uploaded_at`.
- At symbolicate time: read mapping, parse ProGuard format in pure TS (no Java dep), apply per-frame.

### Hermes JS (source map)

- `POST /api/releases/:id/symbols` with `platform=android` and `sourcemap=true` accepts `index.android.bundle.map`.
- Server stores at `/var/lib/uh-oh/symbols/<release-id>/sourcemap.map`, sets `releases.sourcemap_uploaded_at`.
- At symbolicate time for JS frames: use `source-map` npm library to resolve `lineno`/`colno` → original source position.

### Cache semantics

- Each symbolicated frame is stored in `symbolications` keyed by `(event_id, frame_idx)`.
- On new symbol upload for a release: invalidate `symbolications` rows for events whose `release_id` matches.
- API: `GET /api/events/:id?symbolicate=true` returns symbolicated frames merged into the event payload.

---

## 9. Internal API (full route table)

All `/api/*` routes (except `/api/auth/*`) require `Authorization: Bearer <jwt>` after subtask 6 ships.

```
POST   /api/auth/login           { password }                    → { token }
POST   /api/auth/logout                                          → 204

GET    /api/projects                                             → { projects: Project[] }       [exists]
POST   /api/projects             { name }                        → { project: Project }          [exists]
GET    /api/projects/:id                                         → { project: Project }          [TODO subtask 10]
PATCH  /api/projects/:id         { name?, webhookUrl?, alertDedupeMinutes? }
                                                                 → { project: Project }          [exists]
DELETE /api/projects/:id                                         → 204                           [TODO subtask 10]
POST   /api/projects/:id/rotate-key                              → { project: Project }          [exists]

GET    /api/projects/:id/releases                                → { releases: Release[] }       [TODO subtask 7a/7c]
GET    /api/projects/:id/issues?status=&sort=&page=&limit=       → { issues, total, page, limit } [exists - sort param TODO]

GET    /api/issues/:id                                           → { issue, latestEvent, breadcrumbs } [exists]
PATCH  /api/issues/:id           { status }                      → { issue }                     [exists]
GET    /api/issues/:id/events?page=&limit=                       → { events, total }             [exists - total TODO]

GET    /api/events/:id?symbolicate=true|false                    → { event, breadcrumbs, frames? } [exists; symbolicate=true TODO subtask 7a/7c]

POST   /api/releases/:id/symbols (multipart: file, platform, sourcemap?)
                                                                 → { release }                   [TODO subtask 7a/7c]

GET    /healthz                                                  → { ok: true }                  [exists]
GET    /metrics                                                  → Prometheus text format        [TODO subtask 16]
```

---

## 10. SDK surface

### `@uh-oh/react-native` (TS, the only public API users touch)

```ts
import {
  init, captureException, captureMessage,
  addBreadcrumb, setUser, setContext, setTag, setFingerprint,
} from '@uh-oh/react-native';

init({
  dsn: string;                                  // https://<publicKey>@<host>
  release: string;                              // app version+build, e.g. "1.2.3+47"
  environment?: string;
  beforeSend?: (e: EventEnvelope) => EventEnvelope | null;
  maxBreadcrumbs?: number;                      // default 100
  debug?: boolean;
  enableNative?: boolean;                       // default true; set false for tests
}): void;
```

**Platform behavior:**

- On Android: full JS + native handlers
- On iOS: SDK functions are no-ops (`init` logs a debug message and returns; subsequent calls do nothing). Wire-format-compatible but no events sent. This keeps cross-platform apps from crashing on import.

### Android native module (`packages/sdk/android/src/main/java/com/uhoh/`)

- Java `Thread.setDefaultUncaughtExceptionHandler` captures all Java/Kotlin uncaught.
- `xCrash.init(...)` captures NDK signals + ANRs.
- Reports buffered to app cache dir; on app launch, native module emits events to JS bridge.

---

## 11. CLI (`@uh-oh/cli`)

```
uh-oh login --server https://errors.example.com
  prompts for password, writes token to ~/.config/uh-oh/token

uh-oh upload mapping --project <slug> --release <version>+<build> --file mapping.txt
uh-oh upload sourcemap --project <slug> --release <version>+<build> --file index.android.bundle.map
```

Implementation: `commander` for parsing, `node:fs` for file reads, `FormData` + `fetch` for upload. Token loaded from `~/.config/uh-oh/token`. Server URL persisted alongside.

---

## 12. Edge cases

| #   | Scenario                                   | Behavior                                                                                                                                                      |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Native crash before JS thread can report   | xCrash writes report to disk async-signal-safe; on next launch, native module reads, posts via JS transport, deletes file.                                    |
| 2   | Offline at crash time                      | Spool to AsyncStorage (JS) or native crash store (Android); flush on connectivity + on next `init`.                                                           |
| 3   | Spool grows unbounded                      | Cap at 100 events; drop oldest. SDK logs to debug.                                                                                                            |
| 4   | Same crash 10,000×/min                     | Server token-bucket per `(publicKey, fingerprint)`: cap 10, refill 1/sec. Rate-limited events still bump `issues.event_count` but skip event/breadcrumb rows. |
| 5   | Webhook endpoint down                      | 3 retries at 2s/8s/32s; then mark dispatch `failed` and log.                                                                                                  |
| 6   | Webhook dedupe                             | `issues.last_alerted_at + project.alert_dedupe_minutes` check. Always fire on first occurrence.                                                               |
| 7   | Unknown publicKey                          | 401, no echo.                                                                                                                                                 |
| 8   | Malformed payload                          | 400 with field path; no partial persist.                                                                                                                      |
| 9   | No symbols uploaded                        | Frames returned raw, marked `unsymbolicated: true`. Banner in UI: "Upload <symbol type> for this release."                                                    |
| 10  | Corrupt symbol file                        | Cache symbolication failure, surface in UI. Re-symbolicate when a new upload arrives.                                                                         |
| 11  | Hermes bytecode offsets without source map | Frames returned as-is; banner.                                                                                                                                |
| 12  | Mis-grouping                               | SDK `setFingerprint` is the v0.1 escape hatch. No server-side merge UI.                                                                                       |
| 13  | Payload > 1 MB                             | 413. SDK trims breadcrumbs to last 50, retries once; on second 413 drops event with debug log.                                                                |
| 14  | Native handler installed twice             | xCrash no-ops on double-install; SDK asserts via flag.                                                                                                        |
| 15  | RN reload in dev                           | Breadcrumbs in-memory; cleared on reload (matches Sentry).                                                                                                    |
| 16  | Symbol upload race with incoming events    | Events stored raw; symbolication lazy at view-time; cache invalidated on new upload.                                                                          |
| 17  | Clock skew                                 | Server `received_at` is authoritative; client `timestamp` is informational.                                                                                   |
| 18  | JWT stolen                                 | 24h expiry + jti table; logout deletes jti. No refresh tokens.                                                                                                |
| 19  | Password compromise                        | Rotate `UH_OH_ADMIN_PASSWORD`, restart, all old tokens invalid (because `UH_OH_JWT_SECRET` should also be rotated).                                           |
| 20  | TLS cert renewal                           | certbot handles via cron; nginx reload triggered.                                                                                                             |
| 21  | Disk fills                                 | systemd OnFailure unit logs error; basic monitoring deferred.                                                                                                 |
| 22  | SDK loaded on iOS                          | All SDK functions no-op; debug message logged. No native module loaded.                                                                                       |

---

## 13. Acceptance criteria (per area)

### Ingest (existing — do not regress)

- Valid envelope → 202 with `eventId`; 1 event row, 1 new issue or incremented existing.
- Unknown field → accepted and stored in `payload` (forward-compat via `.loose()`).
- Missing required field → 400 with field path in `issues[].path`.
- Same fingerprint flood (100 events / 1 sec) → 10 event rows stored (token bucket capacity), `issues.event_count = 100`.

### Auth (subtask 6)

- `POST /api/auth/login` with correct password → 200 with token, jti row in `sessions`.
- Wrong password → 401, generic error message ("invalid credentials"), no info leak.
- Login attempts > 10/min/IP → 429 with Retry-After.
- `/api/projects` without token → 401.
- `/api/projects` with token whose jti was deleted (logout) → 401.
- Boot without `UH_OH_ADMIN_PASSWORD` → process exits with clear error.
- Boot without `UH_OH_JWT_SECRET` → process exits with clear error.

### Webhook (subtask 5)

- New fingerprint → webhook dispatched within 5s, body `{ type:'issue.new', project, issue, event, url }`.
- Second event same fingerprint inside dedupe window → no webhook (no row in `webhook_dispatches`).
- Webhook 500 → retried at +2s, +8s, +32s; after third failure marked `failed`, `last_response_code` stored.
- Webhook 200 → marked `succeeded`.
- Webhook URL unset on project → no dispatch.

### Symbolication (subtask 7a Android, 7c Hermes)

- Android: upload `mapping.txt` → `GET /api/events/:id?symbolicate=true` returns deobfuscated class/method/line. Mismatched mapping → frames returned with `status:'unsymbolicated'`.
- Hermes: upload `.map` → JS lineno+colno resolves to original source position.
- No upload → frames returned raw with `status:'no_symbols'`.

### SDK (subtasks 11, 13)

- `throw new Error('x')` unhandled → captured via global handler, sent within 5s online, spooled offline.
- Android NPE in Java → UEH captures, SDK sends on next launch with `mechanism:'android-java-ueh'`.
- `beforeSend` returns null → not sent.
- 100 captureException calls offline → spool caps at 100, oldest dropped, all sent on reconnect.
- SDK loaded on iOS: `init` returns without throwing, subsequent calls no-op.

### Dashboard (subtask 10)

- Login flow: wrong password shows error; correct password redirects to home.
- Logout: token revoked, all subsequent calls 401.
- Issue with symbols → frames symbolicated and visually highlighted (in-app frames in amber).
- Issue without symbols → raw frames + banner.
- Resolve issue → status flips, removed from default list, re-appears under `status=resolved` filter.
- Settings page: edit webhook URL, edit dedupe minutes, rotate public key.
- Symbol upload page per release: drag-drop mapping.txt or sourcemap.map, see upload progress, see success.

### Deploy (subtasks 15a, 15b)

- `systemctl status uh-oh-server` → active (running).
- `curl https://<domain>/healthz` → 200.
- `curl http://localhost:3300/healthz` from box → 200; from outside box → connection refused (UFW blocks).
- Daily SQLite backup file appears in `/var/backups/uh-oh/` and is restorable.
- `journalctl -u uh-oh-server` shows structured JSON logs.

---

## 14. Decomposition (full subtask list)

Status legend: `[done]` `[next]` `[blocked]`.

| #   | Subtask                                                  | Depends on | Status    |
| --- | -------------------------------------------------------- | ---------- | --------- |
| 1   | Repo + monorepo scaffolding                              | —          | [done]    |
| 2   | `@uh-oh/types` Zod schemas                               | 1          | [done]    |
| 3   | Server DB layer (Drizzle schema + repos)                 | 1, 2       | [done]    |
| 4   | Server ingest endpoint                                   | 3          | [done]    |
| 5   | Server webhook dispatcher                                | 3, 4       | [done]    |
| 6   | Server auth + JWT middleware (retrofit /api/\*)          | 3, 4       | [done]    |
| 7a  | Android ProGuard symbolication                           | 3          | [done]    |
| 7c  | Hermes JS source-map symbolication                       | 3          | [next]    |
| 8   | Dashboard shell                                          | —          | [done]    |
| 9   | Dashboard: projects + issues list + issue detail         | 8          | [done]    |
| 10  | Dashboard: login + settings + symbol upload UI           | 6, 7a, 7c  | [blocked] |
| 11  | SDK JS core (`@uh-oh/react-native`)                      | 2, 4       | [next]    |
| 13  | SDK Android native module (xCrash + UEH)                 | 11         | [blocked] |
| 14  | CLI (`@uh-oh/cli`)                                       | 6          | [blocked] |
| 15a | Deploy: systemd + UFW + daily backup                     | 6, 16      | [blocked] |
| 15b | Deploy: nginx vhost + TLS via certbot                    | 15a        | [blocked] |
| 16  | Hardening: per-IP rate limit, payload caps, metrics, CSP | 6          | [next]    |

Subtask numbers 7b (iOS dSYM) and 12 (iOS native) are intentionally omitted — iOS is out of scope.

Each subtask has a brief in `briefs/SUBTASK_<NN>.md` with concrete file paths, interface contracts, and test acceptance criteria. **Implementers must read their subtask's brief before writing code, and must NOT exceed scope of the brief.**

---

## 15. Universal quality gates

Every subtask, before committing:

```bash
pnpm typecheck           # tsc --noEmit, zero errors
pnpm lint                # eslint --max-warnings 0
pnpm format:check        # prettier --check
pnpm test                # vitest run, all packages
```

Subtasks that touch HTTP endpoints must include integration tests using `app.inject()` (Fastify in-process testing).
Subtasks that ship UI must run `pnpm --filter @uh-oh/web build` to verify production build succeeds.
Subtasks must update §14 status column to `[done]` when complete, and commit + push.

Commit format: `<type>(<scope>): <subject>` where type ∈ {feat, fix, refactor, chore, docs, test}, scope is the package (`server`, `web`, `sdk`, `cli`, `types`, `infra`) or the subtask number (`s06`).
