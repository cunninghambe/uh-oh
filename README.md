# uh-oh

**Lightweight self-hosted crash reporting for React Native Android, browser JS, and Node.**

A single Node process + SQLite + a small React dashboard. Designed for anyone who wants to self-host their crash data on a small VPS instead of using a hosted service. RN support is **Android-only** — iOS is reserved in the wire format but no iOS code ships yet. Browser + Node support landed in v0.2 via `@uh-oh/js` (see `SPEC.md` §16).

## What it does

- Captures JS exceptions and unhandled promise rejections via a React Native SDK
- Captures Java uncaught exceptions, native NDK signals, and ANRs via an Android bridge (xCrash + UEH)
- Captures browser (`window` error/unhandledrejection) and Node (`uncaughtException`/`unhandledRejection`) errors via `@uh-oh/js` — a single dependency-free vendorable client (`node scripts/vendor-js-client.mjs --out <path>`)
- Groups events into issues by fingerprint
- Symbolicates Hermes JS and Android ProGuard stacks server-side, on demand (web/node frames render raw for now)
- Single-user JWT-gated dashboard with project + issue + release + symbol-upload UIs
- Fires a generic outbound webhook per project on new issues (wire it to Slack, Discord, email, whatever)
- MCP-native: 10 tools (projects, issues, symbolicated events, status changes, health) via the `uh-oh-mcp` stdio bin or the JWT-gated `POST /mcp` Streamable-HTTP endpoint — triage crashes from Claude Code (see `SPEC.md` §17)
- AsyncStorage-backed event spool on the RN SDK side — events survive offline-at-crash-time and crash-before-network

## What it does NOT do (intentionally)

- **iOS.** Out of scope for v0.1. The wire format reserves `platform: 'ios'` for a future pass but no iOS native module ships.
- **Multi-tenant / orgs / teams / RBAC.** One developer, one password.
- **Session replay.** Privacy non-starter.
- **Performance tracing / spans.** Out of scope for v0.1.
- **Native integrations** (Slack, email, etc) — wire those off the generic webhook.
- **Email password reset** — there's no email layer at all. Rotate the password in the env file and restart the service.

## Architecture

```
RN Android app
  ├── @uh-oh/react-native       JS SDK + native module
  └── AsyncStorage spool         survives offline + restart
        │
        ▼ HTTPS (or HTTP if you're being cavalier)
nginx / Caddy
  └── reverse proxy → uh-oh-server
        │
uh-oh-server (Fastify, single Node process)
  ├── /ingest/:publicKey         Zod-validated, rate-limited, atomic upsert
  ├── /api/*                     JWT-gated CRUD on projects/issues/releases
  ├── /metrics                   Prometheus text format
  ├── webhook dispatcher         in-process queue, retries 3× with backoff
  └── symbolicator               on-demand at view time
        │
        ▼
SQLite at /var/lib/uh-oh/uh-oh.db (WAL mode, nightly backup)
```

## Repo layout

This is a pnpm workspace. Each package is independently testable.

| Package               | What it is                                                                            |
| --------------------- | ------------------------------------------------------------------------------------- |
| `@uh-oh/types`        | Zod schemas + inferred TS types for the wire format. Imported by both server and SDK. |
| `@uh-oh/server`       | Fastify + SQLite + Drizzle. Ingest, API, workers.                                     |
| `@uh-oh/web`          | Vite + React 19 + TanStack Router/Query + Tailwind v4 dashboard.                      |
| `@uh-oh/react-native` | The SDK. JS core + Android native module.                                             |
| `@uh-oh/cli`          | TS CLI for uploading ProGuard mappings + Hermes source maps.                          |

## Spec

The full v0.1 spec lives in [`SPEC.md`](SPEC.md). It's the contract. Anywhere the code disagrees with the spec, either the code is wrong or the spec needs to be updated first — not both at once.

## Installing the SDK in your RN app

The SDK is a private workspace package in this monorepo, so it isn't directly installable. A small build script flattens it into a standalone npm-installable form and force-pushes that to the `sdk-dist` orphan branch:

```bash
# In a consuming React Native project:
pnpm add github:cunninghambe/uh-oh#sdk-dist @react-native-async-storage/async-storage
```

Then in your app:

```ts
import { init, captureException } from '@uh-oh/react-native';

init({
  dsn: process.env.EXPO_PUBLIC_UH_OH_DSN!, // http://<publicKey>@<host>[:port]
  release: '1.0.0+1',
  beforeSend: (event) => event, // your scrubbing goes here
});
```

To republish a new SDK version (uh-oh maintainers only): `node scripts/build-sdk-dist.mjs` from the repo root. Force-pushes the new build to `sdk-dist`. Consumers re-run `pnpm install` to pick it up.

## Deploying the server

See [`infra/README.md`](infra/README.md) for systemd, UFW, nightly SQLite backup, and TLS setup. Tested on Ubuntu 22.04+ with Node 22+.

## Why this exists

Hosted crash reporting is excellent and overkill if you ship a handful of React Native Android apps and want to own your data. uh-oh is what falls out of asking "what's the smallest useful thing for that case." It's not trying to replace Sentry for an org with 50 engineers; it's the version that fits when you'd rather run one process on your own box than pay a per-seat or per-event meter.

## License

MIT — see [`LICENSE`](LICENSE).

## Status

v0.1 is feature-complete per [`SPEC.md`](SPEC.md). One subtask has on-device verification pending (the Android xCrash + UEH bridge — known to compile and link, real-device crash trigger not yet exercised). First production user is [Tideline](https://github.com/cunninghambe/tideline), a community migraine tracker.
