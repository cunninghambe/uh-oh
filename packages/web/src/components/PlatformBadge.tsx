// v0.3 item 3: small badge showing which platform (web/node/android/ios) an event came from.
// Sourced from an EventRow's `platform` field — see Issue.tsx (latest event) for the only
// current caller. Not shown on issue list rows: the list payload (Issue) carries no platform
// field today, and the brief is explicit that we must not fetch per-issue events just to get one.

import type { EventRow } from '../api.js';

export const PlatformBadge = ({ platform }: { platform: EventRow['platform'] }) => (
  <span className="inline-flex items-center rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
    {platform}
  </span>
);
