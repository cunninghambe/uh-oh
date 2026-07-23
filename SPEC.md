# uh-oh — v0.1 Spec (FINAL — Android only)

Lightweight self-hosted crash reporting for React Native **Android apps**. Single-operator, multiple projects, production-ready on a single small VPS.

This spec is the contract for implementers. Where ambiguity exists, this document wins; if it disagrees with the code, fix the code or update this doc with a PR.

iOS is **out of scope** for v0.1. The wire format reserves `platform: 'ios'` for future use, but no iOS code (native module, symbolication, SDK bridge) ships.

---

## 1. Problem statement

A single developer ships multiple React Native **Android** apps. They need a self-hosted crash and error reporting service that:

- Captures JS exceptions and Android native crashes from their RN apps
- Groups events into issues by fingerprint
- Symbolicates stack traces server-side (Hermes JS, Android ProGuard)
- Presents issues + breadcrumbs + context in a single-user web dashboard
- Fires a generic outbound webhook per project when new issues appear
- Runs on a single small VPS behind nginx + TLS, with daily SQLite backups

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
- Daily SQLite backup: `sqlite3 .backup` to a dated file in `/var/backups/uh-oh/` plus a tarball of `/var/lib/uh-oh/symbols/`, both integrity-checked, 30-day retention, `OnFailure=` alert unit

**Hardening:**

- Per-IP global rate limit (separate from per-fingerprint); all in-memory rate-limiter maps are TTL-swept and size-capped (long attacker-controlled keys are hashed)
- Client IPs come from `request.ip` with Fastify `trustProxy: 'loopback'`; nginx overwrites `X-Forwarded-For` with `$remote_addr` (spoofed XFF is never trusted)
- Login rate limit: 10/min/IP, then exponential backoff (doubling lockout, capped at 1h) with Retry-After
- Webhook URLs are SSRF-validated at save AND dispatch time: http/https only; literal loopback/private/link-local/metadata IPs rejected; redirects refused (DNS-rebinding via hostnames is a known v0.1 gap)
- Payload size cap (1 MB) — SDK trims breadcrumbs then context then retries once on 413
- Retention: a daily in-process job prunes events older than `UH_OH_RETENTION_DAYS` (default 90; 0 disables) and terminal webhook dispatches older than 7 days; issues are kept
- Structured logs (pino) — JSON, levels, request IDs
- `/metrics` endpoint (Prometheus text format) — `uh_oh_events_ingested_total`, `uh_oh_issues_new_total`, `uh_oh_webhook_failures_total`, `uh_oh_request_duration_seconds` histogram; nginx restricts `/metrics` to localhost
- Security headers on server responses; CSP is owned by nginx, which serves the dashboard static files (the server sets no CSP)
- CORS: ingest open (`Access-Control-Allow-Origin: *` + OPTIONS preflight on `/ingest/:publicKey` only); `/api/*` emits no CORS headers (same-origin only)

### Out of scope (v0.1)

- **iOS in any form** (no native module, no dSYM symbolication, no iOS bridge code)
- Performance / tracing
- Session replay
- Multi-user, orgs, teams, RBAC, billing
- Email/Slack/Discord native integrations (wire those off the generic webhook)
- Alert rules beyond "new issue + per-fingerprint dedupe" (spike detection shipped in v0.8 — §23)
- Search (regex over event payloads). Filter by status + sort is enough for v0.1.
- Runtimes other than RN and JS (Python etc.) — phase 3+. (Browser JS + Node shipped in v0.2 via `@uh-oh/js` — see §16.)
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
  platform TEXT NOT NULL   -- enforced by the Drizzle TS enum ('ios','android','web','node'), no SQL CHECK shipped; ios reserved
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
  status TEXT NOT NULL DEFAULT 'open'   -- open|resolved|ignored|regressed (TS-enforced, no SQL CHECK shipped; 'regressed' is system-set — see §18)
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
  platform: 'ios' | 'android' | 'web' | 'node'; // 'ios' reserved; 'android' from the RN SDK; 'web'/'node' from @uh-oh/js (v0.2, §16)
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

**Context conventions (v0.1):** the wire format has no top-level `environment` or event-id field, so the SDK rides both in `context`: `context.environment` (from `init({ environment })`) and `context.eventId` (the id returned by `captureException`/`captureMessage`). A future wire-format rev may promote them to top-level fields.

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
GET    /api/projects/:id                                         → { project: Project }          [exists]
PATCH  /api/projects/:id         { name?, webhookUrl?, alertDedupeMinutes? }
                                                                 → { project: Project }          [exists]
DELETE /api/projects/:id                                         → 204                           [exists]
POST   /api/projects/:id/rotate-key                              → { project: Project }          [exists]

GET    /api/projects/:id/releases                                → { releases: Release[] }       [exists]
GET    /api/projects/:id/issues?status=&sort=&limit=&offset=     → { issues, total }             [exists]

GET    /api/issues/:id                                           → { issue, latestEvent, breadcrumbs } [exists]
PATCH  /api/issues/:id           { status }                      → { issue }                     [exists]
GET    /api/issues/:id/events?page=&limit=  (or offset=)         → { events, total }             [exists]

GET    /api/events/:id?symbolicate=true|false                    → { event, breadcrumbs, frames? } [exists]

POST   /api/releases/:id/symbols (multipart: file, platform, sourcemap?)
                                                                 → { release }                   [exists]

GET    /healthz                                                  → { ok: true }                  [exists]
GET    /metrics                                                  → Prometheus text format        [exists]

POST   /mcp   (Authorization: Bearer <jwt>)                      → MCP Streamable HTTP, stateless [exists — §17]
GET/DELETE /mcp                                                  → 405 (POST-only, stateless)     [exists — §17]
```

Pagination note: the issues list is **offset-based** (`limit`/`offset`, response `{ issues, total }`); the per-issue events list accepts `page=` (1-indexed) per the original spec, plus `offset=` for symmetry. PATCH `webhookUrl` is SSRF-validated (see §2 Hardening) and returns 400 for private/loopback/metadata targets.

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
  prompts for password, writes token to ~/.config/uh-oh/config.json

uh-oh upload mapping --project <slug> --release <version>+<build> --file mapping.txt
uh-oh upload sourcemap --project <slug> --release <version>+<build> --file index.android.bundle.map
```

Implementation: `commander` for parsing, `node:fs` for file reads, `FormData` + `fetch` for upload. Token and server URL are persisted together in `~/.config/uh-oh/config.json` (dir mode 0700, file chmod'd 0600 after every write; both no-ops on Windows). Uploads pre-check file size against the server's 50 MB cap; 401/403 responses hint to re-run `uh-oh login`.

---

## 12. Edge cases

| #   | Scenario                                   | Behavior                                                                                                                                                                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Native crash before JS thread can report   | xCrash writes report to disk async-signal-safe (tmp+fsync+rename); on next launch, native module hands `{id, payload}` to JS, which ACKs (deletes) each file only after it is durably spooled or sent.                                            |
| 2   | Offline at crash time                      | Spool to AsyncStorage (JS) or native crash store (Android); flush on next `init`, on reconnect (via optional `@react-native-community/netinfo` peer if installed), or via a 30s retry timer that runs only while the spool is non-empty.          |
| 3   | Spool grows unbounded                      | Cap at 100 events; drop oldest. SDK logs to debug.                                                                                                                                                                                                |
| 4   | Same crash 10,000×/min                     | Server token-bucket per `(publicKey, fingerprint)`: cap 10, refill 1/sec. Rate-limited events still bump `issues.event_count` but skip event/breadcrumb rows.                                                                                     |
| 5   | Webhook endpoint down                      | 3 retries at 2s/8s/32s; then mark dispatch `failed` and log.                                                                                                                                                                                      |
| 6   | Webhook dedupe                             | `issues.last_alerted_at + project.alert_dedupe_minutes` check. Always fire on first occurrence.                                                                                                                                                   |
| 7   | Unknown publicKey                          | 401, no echo.                                                                                                                                                                                                                                     |
| 8   | Malformed payload                          | 400 with field path; no partial persist.                                                                                                                                                                                                          |
| 9   | No symbols uploaded                        | Frames returned raw, marked `unsymbolicated: true`. Banner in UI: "Upload <symbol type> for this release."                                                                                                                                        |
| 10  | Corrupt symbol file                        | Cache symbolication failure, surface in UI. Re-symbolicate when a new upload arrives.                                                                                                                                                             |
| 11  | Hermes bytecode offsets without source map | Frames returned as-is; banner.                                                                                                                                                                                                                    |
| 12  | Mis-grouping                               | SDK `setFingerprint` is the v0.1 escape hatch. No server-side merge UI.                                                                                                                                                                           |
| 13  | Payload > 1 MB                             | 413. SDK trims breadcrumbs to last 50, retries once; on second 413 drops event with debug log (a transient non-413 failure after the trim keeps the trimmed event spooled). Other 4xx (except 429) → drop and continue; 5xx/429/network → retain. |
| 14  | Native handler installed twice             | xCrash no-ops on double-install; SDK asserts via flag.                                                                                                                                                                                            |
| 15  | RN reload in dev                           | Breadcrumbs in-memory; cleared on reload (matches Sentry).                                                                                                                                                                                        |
| 16  | Symbol upload race with incoming events    | Events stored raw; symbolication lazy at view-time; cache invalidated on new upload.                                                                                                                                                              |
| 17  | Clock skew                                 | Server `received_at` is authoritative; client `timestamp` is informational.                                                                                                                                                                       |
| 18  | JWT stolen                                 | 24h expiry + jti table; logout deletes jti. No refresh tokens.                                                                                                                                                                                    |
| 19  | Password compromise                        | Rotate `UH_OH_ADMIN_PASSWORD`, restart, all old tokens invalid (because `UH_OH_JWT_SECRET` should also be rotated).                                                                                                                               |
| 20  | TLS cert renewal                           | certbot handles via cron; nginx reload triggered.                                                                                                                                                                                                 |
| 21  | Disk fills                                 | systemd OnFailure unit logs error; basic monitoring deferred.                                                                                                                                                                                     |
| 22  | SDK loaded on iOS                          | All SDK functions no-op; debug message logged. No native module loaded.                                                                                                                                                                           |

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

- New fingerprint → webhook dispatched within 5s, body `{ type:'issue.new', project, issue, event, dispatchId, url? }` (`dispatchId` lets receivers dedupe at-least-once delivery; `url` is omitted when `UH_OH_DASHBOARD_URL` is unset).
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

| #   | Subtask                                                  | Depends on | Status                                  |
| --- | -------------------------------------------------------- | ---------- | --------------------------------------- |
| 1   | Repo + monorepo scaffolding                              | —          | [done]                                  |
| 2   | `@uh-oh/types` Zod schemas                               | 1          | [done]                                  |
| 3   | Server DB layer (Drizzle schema + repos)                 | 1, 2       | [done]                                  |
| 4   | Server ingest endpoint                                   | 3          | [done]                                  |
| 5   | Server webhook dispatcher                                | 3, 4       | [done]                                  |
| 6   | Server auth + JWT middleware (retrofit /api/\*)          | 3, 4       | [done]                                  |
| 7a  | Android ProGuard symbolication                           | 3          | [done]                                  |
| 7c  | Hermes JS source-map symbolication                       | 3          | [done]                                  |
| 8   | Dashboard shell                                          | —          | [done]                                  |
| 9   | Dashboard: projects + issues list + issue detail         | 8          | [done]                                  |
| 10  | Dashboard: login + settings + symbol upload UI           | 6, 7a, 7c  | [done]                                  |
| 11  | SDK JS core (`@uh-oh/react-native`)                      | 2, 4       | [done]                                  |
| 13  | SDK Android native module (xCrash + UEH)                 | 11         | [done] (on-device verification pending) |
| 14  | CLI (`@uh-oh/cli`)                                       | 6          | [done]                                  |
| 15a | Deploy: systemd + UFW + daily backup                     | 6, 16      | [done]                                  |
| 15b | Deploy: nginx vhost + TLS via certbot                    | 15a        | [done]                                  |
| 16  | Hardening: per-IP rate limit, payload caps, metrics, CSP | 6          | [done]                                  |

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

Commit format: `<type>(<scope>): <subject>` where type ∈ {feat, fix, refactor, chore, docs, test}, scope is the package (`server`, `web`, `sdk`, `cli`, `types`, `infra`, `js`) or the subtask number (`s06`).

---

## 16. v0.2 addendum — browser + Node runtimes (`@uh-oh/js`)

Shipped after the v0.1 robustness pass. Adds first-class `platform: 'web'` and `platform: 'node'` support end to end (types, ingest, dashboard) and a new client.

**The client** (`packages/js/src/uh-oh-client.ts`) is a single self-contained, dependency-free TypeScript file (no imports; compiles under strict TS with neither DOM nor Node libs; contains no em-dash characters — one consumer repo lints for that). It mirrors the RN SDK's API and crash-safety posture: `init` (no-op without a DSN), `captureException`, `captureMessage`, `addBreadcrumb`, `setUser`/`setContext`/`setTag`/`setFingerprint`, `flush`, `close`; guarded handler installs; chained listeners; re-entrancy guard; public API never throws.

- Browser: `error` + `unhandledrejection` listeners, fetch keepalive, sendBeacon flush on pagehide/hidden, localStorage pending-queue (`uh-oh:spool`, ~50 events, corrupt-tolerant).
- Node: `uncaughtException` + `unhandledRejection` with bounded flush; exits(1) after capture when it was the only listener; in-memory queue only (max 50, oldest dropped) — **no disk persistence, accepted gap**.
- Queue policy matches the RN spool rules: retain on network error/5xx/429, drop other 4xx, 413 trim-breadcrumbs-then-retry-once.

**Distribution:** consumers vendor the file via `node scripts/vendor-js-client.mjs --out <path>` (GENERATED header; refuses to overwrite non-generated files). A `js-dist` orphan branch (mirroring `sdk-dist`) is the intended future path once published. Google Apps Script consumers use a hand-rolled `UrlFetchApp` reporter instead (platform `'node'`, `device.osName: 'apps-script'`) — the client's runtime requirements (fetch/AbortController) don't exist there.

**Consumer conventions:** env vars `UH_OH_DSN` (server) / `NEXT_PUBLIC_UH_OH_DSN` (browser); Next.js apps wire via `instrumentation.ts` (`register()` guarded to the nodejs runtime + `onRequestError`), `instrumentation-client.ts`, and `app/global-error.tsx`.

**Known v0.2 gaps:** ~~no symbolication for web/node stacks~~ (shipped in v0.3 — §18); ~~no Node disk spool~~ (shipped in v0.4 — §19); RN symbol upload remains Android-only.

---

## 17. MCP addendum — `@uh-oh/mcp` + `/mcp` endpoint

uh-oh is MCP-native: the same tool registry (defined once in `packages/mcp` against a `UhOhBackend` interface) is served two ways.

**Tools (10):** `list_projects`, `create_project`, `update_project` (webhook URL passes SSRF validation), `list_issues` (project by id or slug; status/sort/pagination), `get_issue` (latest event + symbolicated frames + last-20 breadcrumbs), `list_issue_events`, `get_event` (symbolicated), `set_issue_status` (`open|resolved|ignored`), `list_releases`, `get_server_health` (healthz + parsed metrics subset). Read-only tools carry `readOnlyHint: true`; nothing is `destructiveHint`. Outputs are LLM-shaped: compact JSON, nulls dropped, ISO timestamps, frames reduced to `{ function, file, line, col, inApp, status }`, list caps ≤ 100.

**Stdio (primary):** the `uh-oh-mcp` bin (HttpBackend over `/api/*`) — env `UH_OH_SERVER_URL` + `UH_OH_ADMIN_PASSWORD`, auto-login with one re-login on 401, all diagnostics on stderr, stdout reserved for the protocol.

```
claude mcp add uh-oh \
  --env UH_OH_SERVER_URL=https://errors.example.com \
  --env UH_OH_ADMIN_PASSWORD=<admin-password> \
  -- uh-oh-mcp
```

**Streamable HTTP:** `POST /mcp` on the server itself (InProcessBackend, no HTTP hop), stateless with a fresh transport per request, gated by the same JWT middleware as `/api/*`; `GET`/`DELETE` → 405. nginx proxies `location = /mcp` (1 MB body cap). Because JWTs expire in 24h, stdio (auto-login) is the durable path; the HTTP form suits ad-hoc token-scoped access:

```
claude mcp add --transport http uh-oh-remote https://errors.example.com/mcp \
  --header "Authorization: Bearer <jwt>"
```

**Distribution:** `mcp-dist` orphan branch (mirrors `sdk-dist`/`js-dist`), produced by `scripts/build-mcp-dist.mjs`; install via `pnpm add github:cunninghambe/uh-oh#mcp-dist`.

---

## 18. v0.3 addendum — web/node symbolication, regression detection, fleet dashboard

Driven by the first four production consumers (Next.js apps reporting `web` + `node` events).

**Multi-file source maps (web/node).** `POST /api/releases/:id/symbols` with `platform=web|node` accepts one `.map` per call with a `bundlePath` field (path of the JS file relative to the app build; sanitized: no absolute paths, no `..`, ≤512 chars, containment-checked). Stored at `<symbols>/<release-id>/<platform>/<bundlePath>.map`; cap 500 maps/release (409 beyond; same-path re-upload overwrites). `GET /api/releases/:id/symbols` lists `{ maps: [{ platform, bundlePath, size }] }`. At symbolicate time, frames match stored maps by longest segment-boundary suffix of the filename's path component (handles full URLs, bare `/_next/...` paths, and `file:///` URLs); consumers cached per `(releaseId, platform, bundlePath)` with the existing deferred-destroy semantics. Unmatched → `no_symbols`; corrupt → `corrupt_sourcemap`.

**Regression detection.** A new event on a `resolved` issue flips it to `regressed` (system-set; users PATCH only `open|resolved|ignored`; re-resolving re-arms detection). The transition dispatches an immediate `type: 'issue.regressed'` webhook bypassing the dedupe window (recorded per-dispatch via the new `webhook_dispatches.type` column, migration 0003); subsequent events respect the window. Metric: `uh_oh_issues_regressed_total`. `ignored` issues stay ignored.

**Stats.** `GET /api/projects/:id/stats?days=N` → `{ days: [{ date, events }], totalOpenIssues }`; `GET /api/issues/:id/stats?days=N` → `{ days }`. N clamped 1..90 (default 14), UTC-bucketed, zero-filled, ascending.

**Dashboard.** Sort control (lastSeen/eventCount/firstSeen); status tabs Open/Regressed/Resolved/Ignored with regressed badges; platform badge on issue detail; 14-day SVG sparklines on project and issue pages (hidden gracefully if stats are unavailable).

**CLI.** `uh-oh project list`, `uh-oh project create <name>` (prints slug + DSN), `uh-oh project dsn <slug>` (prints DSN + paste-ready `UH_OH_DSN=`/`NEXT_PUBLIC_UH_OH_DSN=` lines), `uh-oh upload next-sourcemaps --project <slug> --release <v+b> --dir <.next> [--dry-run]` (uploads `static/**` maps as `web` and `server/**` maps as `node`, per-platform release resolution), and `uh-oh upload sourcemap --platform web|node --bundle-path <p>` as the generic escape hatch.

**Known v0.3 gaps:** consumer build pipelines don't yet generate/upload/strip source maps (per-app follow-up once a server is deployed); ~~`@uh-oh/mcp` Issue type~~ and ~~per-issue platform on the list payload~~ both closed in v0.4 (§19).

---

## 19. v0.4 addendum — CI upload auth, fleet polish, Node spool, e2e

**Scoped symbol-upload token.** Optional env `UH_OH_SYMBOL_TOKEN` (min 16 chars; boot fails if set shorter). Requests carrying `X-Uh-Oh-Symbol-Token` (constant-time compared, never logged) are authorized on exactly five endpoints — `GET /api/projects`, `GET/POST /api/projects/:id/releases`, `GET/POST /api/releases/:id/symbols` — and rejected everywhere else. This lets deploy pipelines upload source maps without the admin JWT.

**Release upsert.** `POST /api/projects/:id/releases` `{ version, build, platform }` → 201 created / 200 existing (idempotent). Closes the pre-first-event upload gap: release rows previously existed only after ingest.

**Issues carry platform.** Migration 0004 adds `issues.platform` (nullable; backfilled from each issue's latest event; latest-wins on new events). List + detail payloads expose it; the dashboard badges list rows.

**SSRF DNS re-check.** Hostname webhook targets are `dns.lookup`-checked at dispatch time (all addresses; private/loopback/link-local/metadata → permanent failure `blocked_dns:<addr>`; 2s timeout, transient DNS errors fall through to the fetch). TOCTOU caveat documented — this raises the bar, it is not pinning.

**@uh-oh/mcp regressed.** MCP Issue status includes `regressed`; the `list_issues` filter accepts it; `set_issue_status` stays 3-value (regressed is system-set).

**@uh-oh/js 0.3.0 — Node disk spool.** `InitOptions.spoolDir` (Node only): pending queue persists to `<spoolDir>/uh-oh-spool.json` (atomic tmp+rename, ~1s debounce, force-flush on close and on the uncaught-exception path, corrupt-tolerant, same 50-event/500KB caps). Browser ignores the option.

**Vendorable source-map uploader.** `node scripts/vendor-sourcemap-uploader.mjs --out <path>` emits a zero-dependency `uh-oh-upload-sourcemaps.mjs` for consumer deploy pipelines: env `UH_OH_SERVER_URL`/`UH_OH_SYMBOL_TOKEN`/`UH_OH_PROJECT` (missing env → clean no-op, `--require` to enforce), uploads `static/**` as web and `server/**` as node, auto-creates missing releases via the upsert, `--delete-browser-maps` (only after full success), `--dry-run`.

**RN SDK.** `@react-native-community/netinfo` declared as an optional peer (`>=9`) — the runtime guarded-require existed since v0.1's hardening pass.

**Playwright e2e.** 6-test chromium smoke (`packages/web/e2e`) boots the real server (temp SQLite, ephemeral config) + built dashboard via `vite preview` proxy: login errors, project create, ingest→issue→detail→resolve flows. CI runs it as a separate job with report artifacts. Fixed also: the server's `isMain` entry check now uses `pathToFileURL` (the old string comparison silently never matched on Windows).

**Dashboard.** Per-release uploaded-map counts (eager ≤10 rows, lazy beyond); platform badges on issue list rows.

---

## 20. v0.5 addendum — fix dossier + silence detection

The "exceptional" release: uh-oh becomes a deterministic fix-dossier substrate for agents (no LLM calls in the server) plus a dead-man's-switch for the fleet.

**Source context.** At symbolication time, in-app frames that resolve `ok` against a map exposing `sourcesContent` gain `context: { pre, line, post }` (≤5 lines each side, right-trimmed, 300-char cap, tabs preserved; first 8 in-app frames per event). Stored inside `symbolications.resolved` (no migration), cached/invalidated with existing semantics, rendered as collapsible highlighted code frames in the dashboard.

**Impact.** `GET /api/issues/:id/impact` → `{ distinctUsers (null when unknowable), topDevices, topOs, releases, platforms }` (top-5s, deterministic ordering) — indexed JSON1 aggregates, no new tables. Dashboard shows an Impact panel on issue detail.

**Issue bundle.** `GET /api/issues/:id/bundle` — project + issue + impact + symbolicated latest event (with source context) + last-20 breadcrumbs + ≤3 recent-event summaries + symbol availability, deterministically truncated to 64KB (context lines first, then breadcrumbs; always-present `truncated` flags). MCP tools `get_issue_bundle` and `list_top_issues` (volume-ranked open+regressed across all projects, backed by `GET /api/top-issues`) in both backends, plus the `fix_crash` MCP prompt. One tool call = everything an agent needs to fix a crash.

**Monitors.** `POST /ingest/:publicKey/check-in/:slug[?intervalMinutes=N]` (public-key auth, slug `[a-z0-9-]{1,64}`, per-(key,slug) token bucket, 202 `{monitorId}`). First ping auto-creates (interval required; grace `max(5, ceil(interval/4))`); later pings bump `lastCheckInAt` and recover `missed→ok` with a `monitor.recovered` webhook. A 60s in-process sweep flips overdue monitors to `missed` and fires `monitor.missed` once per episode (status transition = dedupe) through the normal dispatcher — migration 0005 creates `monitors` and rebuilds `webhook_dispatches` with nullable `issue_id`/`event_id` + `monitor_id`. JWT CRUD under `/api/projects/:id/monitors` + `/api/monitors/:id`; MCP `list_monitors`; metric `uh_oh_monitor_missed_total`. Dashboard: Monitors section on the project page (status pills, overdue chip, pause/edit/delete, empty state showing the project's real check-in URL).

**Client.** `@uh-oh/js` 0.4.0 adds `checkIn(slug, { intervalMinutes? })` — fire-and-forget, single attempt, no spooling, never throws, silent no-op without a DSN. Copy-paste consumer snippets (Next.js worker, Apps Script sender, curl-for-cron) live in `docs/check-ins.md`.

---

## 21. v0.6 addendum — privacy-first usage analytics

Cookie-less, self-hosted product analytics on the same rails as crash reporting. Plausible-style, not GA-style: **no cookies, no client identifiers, no fingerprinting stored**.

**Privacy model.** The client sends only event payloads. Daily uniques come from a server-side hash `sha256(dailySalt | publicKey | clientIp | userAgent)` truncated to 16 hex chars; salts are crypto-random per UTC day (`usage_salts`, pruned after 2 days) so visitors are uncorrelatable across days (repeat visitors over-count across days — the accepted trade). Raw IP and UA feed the hash and are discarded — never stored, never logged; paths are stripped of query/fragment; referrers reduce to domain only (same-origin → null). Tests prove the store contains no IP/UA/salt.

**Ingest.** `POST /ingest/:publicKey/usage` — public-key auth, `application/json` or `text/plain` (sendBeacon), `{ events: [{ type: 'pageview'|'event', ts?, path?, referrer?, name?, props? }] }`, batch ≤50 (413 beyond), per-event validation drops the event not the batch (`202 { accepted, dropped }`), generous per-key token bucket (200 cap / 20 per s). Storage: `usage_events` (migration 0006) with `(project_id, received_at)` index; pruned by the standard retention window. Metric `uh_oh_usage_events_total`.

**Summary.** `GET /api/projects/:id/usage/summary?days=30` (JWT; days 1..90) → zero-filled ascending `days` (pageviews/visitors/events), `topPages` / `topReferrers` (direct excluded) / `topEvents` (≤10 each, deterministic ordering), `totals`. MCP tool `get_usage_summary` in both backends.

**Client (`@uh-oh/js` 0.5.0).** `trackPageview(path?)`, `trackEvent(name, props?)`, and opt-in `init({ analytics: { auto: true } })` — initial pageview (with raw referrer, first pageview only), History pushState/replaceState + popstate hooks with consecutive-path dedupe, restored cleanly on `close()`. Separate lossy batch queue (cap 20, 5s debounce, sendBeacon on pagehide, no retry/spool — analytics is best-effort by design). Validation mirrors the server; nothing here can throw or mint an identifier.

**Dashboard.** Usage section per project: visitors/pageviews/events headline, dual-series 30-day trend (SVG, shared-scale fitting), top pages/referrers/events bars, 7/30/90-day toggle; hidden entirely when the endpoint is absent.

---

## 22. v0.7 addendum — scoped read access for agent debugging

**Problem.** Everything useful for debugging (issues, events, stats, bundles, usage) sits behind the 24h dashboard JWT, and the `/mcp` endpoint shares that gate. An agent session debugging a consumer app (the motivating case: a bookforge session unable to pull that project's crash events) has no durable, headless way in: JWTs expire daily and minting one requires the dashboard password. The symbol-upload token (§19) already proved the pattern for narrow, long-lived, headless auth; this addendum applies it to reads.

**Scoped read token.** Optional env `UH_OH_READ_TOKEN` (min 16 chars; boot fails if set shorter, mirroring `UH_OH_SYMBOL_TOKEN`). Requests carrying `X-Uh-Oh-Read-Token` (constant-time compared, never logged) are authorized on exactly the read-only surface:

- `GET /api/projects`, `GET /api/projects/:id/{issues,stats,releases,monitors}`, `GET /api/projects/:id/usage/summary`
- `GET /api/issues/:id` and `GET /api/issues/:id/{events,impact,stats,bundle}`
- `GET /api/events/:id`

Everything else — every POST/PATCH/DELETE, auth routes, rotate-key, monitor CRUD, the admin surface — rejects the read token exactly as it rejects no auth. The token never appears in logs or error bodies.

**MCP with a read scope.** `POST /mcp` additionally accepts the read token (same header). A request authorized this way carries a `readonly` auth scope: tools that only read (project/issue/event listing and getters, top issues, stats, bundles, health, usage summary, monitor listing) work; mutating tools (issue status changes, monitor create/edit/delete, anything that writes) return a tool error naming the scope ("read token cannot <tool>; use the JWT-authenticated dashboard or stdio backend"). The stdio backend and JWT-authenticated HTTP path are unchanged. The tool registry gains a per-tool `readonly` flag so the gate is data, not a name-matching heuristic, and the flag is asserted per tool in tests.

**Deployment (the box).** Set `UH_OH_READ_TOKEN` in the server env; register the HTTP MCP endpoint with the machine's agent bridge (hetzner-mcp) so sessions reach it via `mcp_call`, supplying the header from the bridge's service config (add per-service header support to the bridge if it lacks it; it is internal tooling). Bridge restarts disconnect live agent sessions: restart it LAST, verify over plain ssh (which does not depend on the bridge), and confirm `mcp_services` shows uh-oh healthy afterward.

**Acceptance.** With the token set: `curl -H "X-Uh-Oh-Read-Token: ..." /api/projects` lists projects while the same request without the header stays 401 and any write with the header stays 401; an MCP `list_issues` through the bridge returns the bookforge project's real issues; an MCP status-change tool through the read path returns the scope error and changes nothing; a boot with a 15-char token fails with a clear message; the dashboard, JWT flows, ingest, symbol uploads, and stdio MCP behave byte-identically to v0.6. Unit tests cover the route allowlist (each allowed route with the token, one representative rejection per verb class), the constant-time comparison, the per-tool readonly flags, and the scope error shape.

---

## 23. v0.8 addendum — the agent loop: commits, spikes, annotations, fix verification

**Problem.** Agents can read everything (§22) but the loop is open: the triage harness polls on a daily cron, its findings live outside uh-oh (Discord messages, PR descriptions), the next investigation of the same issue starts from zero, and nothing tracks whether a shipped fix actually worked. v0.8 closes the loop while keeping the server deterministic (no LLM calls, no outbound calls to git hosts): releases know their commit, issues accumulate an investigation record, fix attempts are tracked to a verified/failed verdict, and spikes push to agents instead of waiting to be polled. uh-oh becomes the coordination substrate the agent fleet runs on.

**Release ↔ commit.** `projects.repo_url` (nullable, ≤512 chars) editable via `PATCH /api/projects/:id` and the settings UI. `releases.commit_sha` (nullable; must match `/^[0-9a-f]{7,40}$/i`, stored lowercase) accepted by the release upsert (`POST /api/projects/:id/releases`); provided-and-different on an existing row updates it (last write wins). The CLI (`--commit` flag on the upload commands that upsert releases) and the vendored uploader (env-driven like the rest of its config; no flag) send it, resolved in order: `--commit` (CLI only), `UH_OH_COMMIT_SHA` env, `git rev-parse HEAD` (guarded `node:child_process` spawn; whichever source answers first is validated with no fall-through past an invalid value; anything unresolvable → omit with one log line; the uploader stays zero-dependency). uh-oh never contacts a git host: it stores SHAs and the repo URL; the agent holding a checkout computes diffs itself. Release payloads and the impact panel's `releases` entries expose `commitSha`; the issue bundle additionally exposes `project.repoUrl`.

**Spike detection.** Every 5 minutes an in-process sweep (same lifecycle pattern as the monitor sweep) evaluates each issue with status `open|regressed` and `last_seen` within the past hour: `lastHour` = event rows in `[now−1h, now]`; `baselineHourly` = event rows in `[now−25h, now−1h]` ÷ 24. The issue is spiking ⇔ `lastHour ≥ max(10, 5 × baselineHourly)`. Entering the spiking state (migration 0007: `issues.spike_active` 0/1 NOT NULL default 0, `issues.last_spike_at` nullable) sets both columns and dispatches `type: 'issue.spike'` — `{ project, issue, stats: { lastHour, baselineHourly }, dispatchId, url? }` — through the normal dispatcher, bypassing the alert-dedupe window (the state transition is the dedupe, exactly like monitors). The condition clearing resets `spike_active` silently (no webhook). Metric `uh_oh_issue_spikes_total`. Dashboard: spike badge on issue list rows and detail while active.

**Annotations.** Migration 0007 adds `issue_annotations` (id, issue_id FK cascade, author TEXT ≤128 default `'agent'`, kind TEXT ∈ `note|root_cause|fix_plan|verification|system` default `'note'`, body TEXT ≤16KB, created_at). `POST /api/issues/:id/annotations` `{ body, kind?, author? }` → 201 `{ annotation }` (400 on bad kind, 413 over the body cap); `GET /api/issues/:id/annotations?limit=&offset=` → `{ annotations, total }` newest-first. The server writes `kind: 'system'` rows on every fix-attempt transition (audit trail). The issue bundle gains `annotations` (last 10, newest first), and the bundle's truncation order becomes: source-context lines first, then breadcrumbs, then annotations oldest-first — annotations are the most protected content; the always-present `truncated` flags extend to them. Dashboard: annotation timeline on issue detail (kind badges, whitespace-preserved bodies).

**Fix attempts.** Migration 0007 adds `fix_attempts` (id, issue_id FK cascade, pr_url TEXT ≤512, commit_sha nullable same regex as releases, state TEXT ∈ `filed|deployed|verified|failed`, created_at, deployed_at nullable, updated_at, UNIQUE(issue_id, pr_url)). `POST /api/issues/:id/fix-attempts` `{ prUrl, commitSha? }` upserts by (issue, prUrl) into state `filed`. `PATCH /api/fix-attempts/:id` `{ state?, commitSha? }` permits `filed→deployed`, `filed→failed`, `deployed→failed`; `verified` is system-set only; anything else 400. Marking `deployed` stamps `deployed_at` and system-sets the issue `resolved` when it is currently `open|regressed` (re-arming §18 regression detection). From there the verdict is deterministic:

- **failed:** a new event on the issue (the §18 `resolved→regressed` path) also flips the most-recently-deployed attempt to `failed`, and the `issue.regressed` webhook payload gains `fixAttempt` — the receiving agent knows which fix didn't hold and can pull its annotations before retrying.
- **verified:** an hourly sweep flips `deployed` attempts to `verified` when `now − deployed_at ≥ UH_OH_FIX_VERIFY_DAYS` (env, days, default 7, min 1) and the issue has zero events since `deployed_at`, dispatching `type: 'fix.verified'` `{ project, issue, fixAttempt, dispatchId, url? }`.

Metrics `uh_oh_fix_verified_total`, `uh_oh_fix_failed_total`. Issue detail and bundle expose `fixAttempts` (newest first). Dashboard: fix-attempts panel on issue detail (state pills, PR links, short SHAs linked to `<repoUrl>/commit/<sha>` when repo_url is https).

**Similar issues.** `GET /api/issues/:id/similar` → `{ similar }`, ≤10 fleet-wide issues (excluding self) whose title shares the exception-type prefix (title text before the first `':'`; whole-title equality when the title has none), ranked by has-verified-fix desc, annotation count desc, last_seen desc. Each entry: `{ issue: { id, projectId, projectSlug, title, status, platform, lastSeen, eventCount }, fixAttempts, annotationCount }`. Deterministic SQL, no embeddings. "Have we seen this before, and what fixed it" is one call.

**Agent token.** Optional env `UH_OH_AGENT_TOKEN` (min 16 chars; boot fails if set shorter; header `X-Uh-Oh-Agent-Token`, constant-time compared, never logged) — the third scoped token (§19 symbols, §22 read). It authorizes everything the read token authorizes (including the new `GET` annotations/similar routes, which the read token also gains) plus exactly: `PATCH /api/issues/:id`, `POST /api/issues/:id/annotations`, `POST /api/issues/:id/fix-attempts`, `PATCH /api/fix-attempts/:id`. Everything else rejects it as if unauthenticated. `POST /mcp` accepts it with scope `agent`. The registry's per-tool boolean `readonly` flag (§22) generalizes to `scope: 'read' | 'agent' | 'admin'` per tool (readonly ≡ scope `read`; §22 read-token behavior is unchanged): read-token requests run read tools, agent-token requests run read+agent tools, JWT and stdio run all. New tools: `annotate_issue` (agent), `record_fix_attempt` (agent; upsert + state transition in one tool), `list_similar_issues` (read); `set_issue_status` reclassifies from admin to agent scope. Tool count 14 → 17.

**Deployment (the box).** Set `UH_OH_AGENT_TOKEN` in the server env; register an agent-scoped MCP service alongside the read-scoped one in hetzner-mcp; repoint the triage harness at it (retiring `UH_OH_ADMIN_PASSWORD` from the harness env); add commit wiring to the four consumer deploy pipelines; add a box-side webhook receiver that spawns a triage session on `issue.spike` / `issue.regressed` / `fix.verified` (the daily cron remains for slow-burn issues). Box-side only; not acceptance-gated here.

**Acceptance.** Migration 0007 applies cleanly to a v0.7 database. Release upsert with `commitSha` persists it and re-upserts update it; uploader and CLI send it when resolvable and omit it silently otherwise. Spike: an issue receiving ≥10 events in an hour against a quiet baseline flips `spike_active` and dispatches exactly one `issue.spike` until the episode clears; a steady-state noisy issue (baseline ≈ lastHour) never fires. Annotations: POST/GET round-trip with caps enforced; the bundle carries the last 10 with the new truncation order proven by a construction test. Fix attempts: upsert by (issue, prUrl); `deployed` sets the issue resolved; a post-deploy event regresses the issue, fails the attempt, and the regressed webhook carries `fixAttempt`; a quiet verify window flips the attempt to `verified` and dispatches `fix.verified` (sweep test with injected clock); invalid transitions 400. Similar: deterministic ordering asserted on a seeded fleet. Agent token: every granted route accepts it, one representative rejection per verb class elsewhere, boot fails on a 15-char token; the MCP scope matrix is asserted per tool (read token → read tools only; agent token → read+agent; JWT → all; scope errors name the token and the tool). All §15 gates green; dashboard, JWT flows, ingest, symbol uploads, and read-token behavior otherwise byte-identical to v0.7.
