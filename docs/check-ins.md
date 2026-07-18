# Check-ins (dead-man's-switch monitors)

`checkIn(slug, opts?)` in `@uh-oh/js` (v0.4.0+) sends a fire-and-forget ping
telling the server "this job is still alive." If pings for a slug stop
arriving within its interval + grace period, the monitor flips to `missed`
and a webhook fires. There's no capture path involved — a check-in is a
single best-effort POST, never queued, never retried, never spooled. A late
ping is worthless, so the client just sends once and moves on.

```ts
checkIn(slug: string, opts?: { intervalMinutes?: number }): void
```

- `slug` must match `[a-z0-9-]{1,64}` — anything else is dropped client-side
  (debug log only, never throws).
- `intervalMinutes` is **required on a monitor's first-ever ping** (the
  server 400s without it) and optional after that. Pass it on every ping if
  you don't want to track separately whether the monitor has been created
  yet.
- No dsn / not initialised → silent no-op, same as every other `@uh-oh/js`
  entry point.

The request shape is `POST <origin>/ingest/<publicKey>/check-in/<slug>[?intervalMinutes=N]`,
202 on success. The client never inspects the response — success or failure
looks the same from the caller's side.

Below are copy-paste snippets for the three places check-ins are going out
in practice. Swap in real slugs and DSNs before using.

## Next.js worker / background process

Anywhere you already have a `@uh-oh/js` `init()` call for crash reporting,
add a `checkIn` at the end of each successful tick:

```ts
import { init, checkIn } from '@uh-oh/js';

init({
  dsn: process.env.UH_OH_DSN!, // http(s)://<publicKey>@<host>[:port]
  release: process.env.RELEASE ?? '0.0.0',
});

const TICK_MS = 5 * 60 * 1000;

async function tick() {
  await doWork();
  // Only reached on success - a crash or hang means no ping, which is the
  // point: the monitor goes 'missed' and the webhook fires.
  checkIn('worker-name', { intervalMinutes: 5 });
}

setInterval(() => {
  void tick();
}, TICK_MS);
```

## Google Apps Script (OpeningBell sender)

Self-contained, no `@uh-oh/js` import available in Apps Script. Parses
`UH_OH_DSN` from Script Properties the same way `reportError_` does. Call it
at the end of a successful run, not in a catch block.

```js
function checkIn_(slug, intervalMinutes) {
  var dsn = PropertiesService.getScriptProperties().getProperty('UH_OH_DSN');
  if (!dsn) return;
  var m = /^(https?:\/\/)([^@]+)@(.+)$/.exec(dsn);
  if (!m) return;
  var url = m[1] + m[3] + '/ingest/' + m[2] + '/check-in/' + slug;
  if (intervalMinutes) url += '?intervalMinutes=' + intervalMinutes;
  try {
    UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true });
  } catch (e) {}
}
```

Usage, at the end of a successful send run:

```js
function runSender() {
  // ... existing send logic ...
  checkIn_('opening-bell-sender', 60); // expected to run hourly
}
```

## Plain curl (VPS backup-timer cron job)

The DSN's `<publicKey>` is its URL username, moved into the path (the raw
request carries no userinfo/basic-auth):

```bash
curl -fsS -X POST "https://<host>/ingest/<publicKey>/check-in/<slug>?intervalMinutes=<N>"
```

Example, appended to the end of the existing backup script (only runs if the
backup itself exits 0):

```bash
/usr/local/bin/backup-uh-oh.sh && \
  curl -fsS -X POST "https://errors.example.com/ingest/pk_live_abc123/check-in/vps-backup?intervalMinutes=1440"
```
